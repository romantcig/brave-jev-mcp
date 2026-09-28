import type { TextContent, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import API from '../../BraveAPI/index.js';
import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  RequestParamsSchema,
  RequestHeadersSchema,
  LlmContextInputSchema,
  type LlmContextInput as QueryParams,
} from './schemas/input.js';
import { LlmContextSearchApiResponseSchema } from './schemas/output.js';
import {
  applyMinimumValues,
  applyOverfetch,
  createJevClassifier,
  createLogWriter,
  filterLlmContext,
  hasJevKey,
  loadFilterConfig,
  logRaisedToStderr,
  resolveToolDescription,
  withAdjustments,
} from '../../filter/index.js';
import type {
  ClassifyDeps,
  FilterConfig,
  FilterDeps,
  FilteredResponse,
  FilterResult,
  FilterStats,
} from '../../filter/index.js';

export const name = 'brave_llm_context';

export const annotations: ToolAnnotations = {
  title: 'Brave LLM Context',
  openWorldHint: true,
};

export const description = `
    Search the web with Brave and return pre-extracted, relevance-ranked content chunks
    (prose, tables, code blocks, structured data). Use the returned content directly when
    it answers the question; fetch the page only when you need the full context or must verify.

    Required: \`intent\` — one English sentence stating what you want to find. If the query
    concerns a versioned product, name the current version and its defining mechanism in
    \`intent\` (e.g. "current Sanity Studio (v6, sanity.config.ts based)").

    Recommended values for routine calls (\`query\` supports site:):
        count: 10
        maximum_number_of_urls: 5
        maximum_number_of_tokens: 4000
        maximum_number_of_tokens_per_url: 800 (= 4000 / 5; without it one source can take the whole budget)

    Search rules:
        - Unfamiliar subject: first search the subject name plus the core question for an overview,
          then verify details as needed; do not search for a given detail directly — check whether
          it surfaces naturally in the sources.
        - Keep only keywords directly relevant to the current question in \`query\`; do not pack
          context and qualifiers into one query.
        - Set \`freshness\` (pd / pw / pm / py) when recency matters; never hardcode a year in \`query\`.
        - Two consecutive searches with heavily overlapping results mean the direction is exhausted:
          change the keyword strategy.
        - Search serially; go parallel only when confident of each query.

    When relaying results, cite the source URLs from the "sources" map.
`.trim();

// 进程级配置惰性单例（EMBED-05）：第一次需要时解析 `JEV_FILTER_CONFIG_FILE`，之后
// 复用——启动时读一次，改配置要重启 MCP。惰性而不是模块求值时读，因为模块求值
// 早于 dotenv：入口 `src/config.ts` 先 import 工具模块（求值链包含本文件），之后
// 才执行 `dotenv.config()`——模块求值时读 .env 里的变量会读到空。
let filterConfig: FilterConfig | undefined;

const configFor = (): FilterConfig => {
  filterConfig ??= loadFilterConfig(process.env);
  return filterConfig;
};

// 进程级 Jev 分类器惰性单例（A13）：熔断计数与并发闸住 createJevClassifier 闭包，
// 跨请求复用——库自身无模块级可变状态（stats.ts 不变式）。mode 为 off 时不创建、
// 不读 key；mode 非 off 且 key 缺失时按等价 off 处理（EMBED-05：stderr 一行、
// 不传 deps，管道记 no_key 零请求），实例只在 key 可用时创建。
let jevClassifier: ClassifyDeps | undefined;

const jevDepsFor = (config: FilterConfig): FilterDeps | undefined => {
  if (config.mode === 'off') return undefined;
  if (!hasJevKey(process.env)) {
    console.error(
      '[jev-filter] No Jev API key found (TYPESAFE_API_KEY); treating Jev filtering as off.'
    );
    return undefined;
  }
  jevClassifier ??= createJevClassifier(config.jev, process.env);
  return { classify: jevClassifier.classify };
};

// 进程级 JSONL 日志写入器惰性单例（D-16 三档模式都写）：串行链与目录自愈住在
// createLogWriter 闭包里（库无模块级可变状态），适配行只持引用。log_dir 取自
// config（启动时读一次），改配置要重启 MCP——与 config 单例同生命周期。
let logWriter: ((stats: FilterStats) => void) | undefined;

/**
 * 仅供测试：清掉配置、分类器与日志写入器的进程级惰性单例，让下一次调用重新读
 * 环境 / 配置。生产代码不得调用（"读一次"语义靠不清除保证）。
 */
export const resetFilterStateForTest = (): void => {
  filterConfig = undefined;
  jevClassifier = undefined;
  logWriter = undefined;
};

export const execute = async (params: QueryParams) => {
  const { adjusted, raised } = applyMinimumValues(params);
  const parsedParams = RequestParamsSchema.parse(adjusted);
  const parsedHeaders = RequestHeadersSchema.parse(params);
  const config = configFor();
  const braveParams = applyOverfetch(parsedParams, config);

  const response = await API.issueRequest<'llmContext'>('llmContext', braveParams, parsedHeaders);
  const { success, data, error } = LlmContextSearchApiResponseSchema.safeParse(response);
  // 成功时接住统计对象：状态行第二块与 JSONL 日志都从它出（LOG-01/LOG-02）；
  // 失败（Brave 报错 / zod 校验失败）无 stats。
  let filtered: FilterResult | undefined;
  let payload: unknown;
  if (success) {
    filtered = await filterLlmContext(
      data,
      { params: parsedParams, intent: params.intent },
      config,
      jevDepsFor(config)
    );
    // 第一个 JSON 块在过滤结果之上附加统计摘要（stats.output，含 status_line）：
    // 状态行第二块与 JSON 块内 output.status_line 逐字同源（D-08/LOG-03 红线），
    // 模型也能直接读到幸存规模与 token 估算。
    const enriched: FilteredResponse & { output: FilterStats['output'] } = {
      ...filtered.result,
      output: filtered.stats.output,
    };
    payload = withAdjustments(enriched, raised);
  } else {
    payload = z.treeifyError(error);
  }

  // 逐请求 JSONL 日志（D-16 三档模式都写；本批先在成功路径落账，错误请求的
  // 记录形状随后补）。写入失败 fail-open，绝不影响搜索返回（D-14）。
  if (filtered !== undefined) {
    logWriter ??= createLogWriter(config.logDir);
    logWriter(filtered.stats);
  }

  logRaisedToStderr(raised);

  // 状态行作为第二个 text 块追加在末尾（D-08）：追加条件与 buildStatusLine 返回值
  // 同源——直接读 stats.output.status_line（步 10 写入点），绝不自创条件。
  const statusLine = filtered?.stats.output.status_line;
  return {
    content: [
      { type: 'text', text: JSON.stringify(payload) } as TextContent,
      ...(statusLine !== undefined ? [{ type: 'text', text: statusLine } as TextContent] : []),
    ],
    isError: !success,
  };
};

export const register = (mcpServer: McpServer) => {
  mcpServer.registerTool(
    name,
    {
      title: name,
      description: resolveToolDescription(description, configFor().toolDescriptionFile),
      inputSchema: LlmContextInputSchema,
      annotations: annotations,
    },
    execute
  );
};

export default {
  name,
  description,
  annotations,
  inputSchema: LlmContextInputSchema.shape,
  execute,
  register,
};
