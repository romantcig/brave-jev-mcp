import { randomUUID } from 'node:crypto';
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
  createSampleWriter,
  filterLlmContext,
  hasJevKey,
  loadFilterConfig,
  logRaisedToStderr,
  resolveToolDescription,
  withAdjustments,
} from '../../filter/index.js';
import type {
  AllocatedSamplePath,
  ClassifyDeps,
  FilterConfig,
  FilterDeps,
  FilteredResponse,
  FilterResult,
  FilterStats,
  LogWriteMeta,
  LogWriter,
  SampleWriter,
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
// 不读 key；mode 非 off 且 key 缺失时按等价 off 处理（EMBED-05：不传 deps，管道记
// no_key 零请求），实例只在 key 可用时创建。缺 key 的 stderr 告警只发一次（WR-02）：
// 缺 key 是进程级持续配置状态，逐请求重复告警是噪音；每次请求仍照常落 no_key 日志、
// on 模式的未判定提示照常存在——降噪不是掩盖。
let jevClassifier: ClassifyDeps | undefined;
let noKeyWarned = false;

const jevDepsFor = (config: FilterConfig): FilterDeps | undefined => {
  if (config.mode === 'off') return undefined;
  if (!hasJevKey(process.env)) {
    if (!noKeyWarned) {
      noKeyWarned = true;
      console.error(
        '[jev-filter] No Jev API key found (TYPESAFE_API_KEY); treating Jev filtering as off.'
      );
    }
    return undefined;
  }
  jevClassifier ??= createJevClassifier(config.jev, process.env);
  return { classify: jevClassifier.classify };
};

// 进程级 JSONL 日志写入器惰性单例（D-16 三档模式都写）：串行链与目录自愈住在
// createLogWriter 闭包里（库无模块级可变状态），适配行只持引用。log_dir、钉版
// 模型与阈值都取自 config（启动时读一次），改配置要重启 MCP——与 config 单例同
// 生命周期。
let logWriter: LogWriter | undefined;

// 进程级样本写入器惰性单例（04-02，test 模式独有）：off / on 完全不创建、不分配
// 路径、不写样本。与 logWriter 同生命周期——路径分配（allocatePath）在请求内
// 完成，进程级状态（程序版本号）住 createSampleWriter 闭包。
let sampleWriter: SampleWriter | undefined;

const sampleWriterFor = (config: FilterConfig): SampleWriter | undefined => {
  if (config.mode !== 'test') return undefined;
  sampleWriter ??= createSampleWriter(config);
  return sampleWriter;
};

/**
 * 仅供测试：清掉配置、分类器、日志与样本写入器的进程级惰性单例与缺 key 告警
 * 标记，让下一次调用重新读环境 / 配置。生产代码不得调用（"读一次"语义靠不清除
 * 保证）。
 */
export const resetFilterStateForTest = (): void => {
  filterConfig = undefined;
  jevClassifier = undefined;
  logWriter = undefined;
  sampleWriter = undefined;
  noKeyWarned = false;
};

export const execute = async (params: QueryParams) => {
  const { adjusted, raised } = applyMinimumValues(params);
  const parsedParams = RequestParamsSchema.parse(adjusted);
  const parsedHeaders = RequestHeadersSchema.parse(params);
  const config = configFor();
  const braveParams = applyOverfetch(parsedParams, config);

  // 逐请求 JSONL 日志（D-16 三档模式都写，错误请求也落账）：写入失败 fail-open，
  // 绝不影响搜索返回（D-14）。
  const writer = (logWriter ??= createLogWriter(config));

  // 样本写入器（04-02，test 模式独有）：off / on 不创建单例、不分配路径、不捕获。
  const samples = sampleWriterFor(config);
  // 每请求唯一 request_id：样本文件名、JSONL 信封、（test 模式的）状态行路径
  // 三处同值——样本与常规 JSONL 日志以同一 request_id 关联（SC3）。
  const requestId = randomUUID();
  // 先分配路径（PRD 写入顺序第一步）；allocatePath 捕获的锚点 Date 同时锚定样本
  // ts 与目录日期（B-01）。
  const samplePath: AllocatedSamplePath | undefined = samples?.allocatePath(requestId);

  // Brave 请求计时（D-10）：计时点在适配行——API.issueRequest 前后，差值回填进
  // stats.brave.latency_ms；Brave 报错时不回填（无 stats，走错误记录）。
  const braveStartedAt = Date.now();
  let response: unknown;
  try {
    response = await API.issueRequest<'llmContext'>('llmContext', braveParams, parsedHeaders);
  } catch (requestError) {
    const message = requestError instanceof Error ? requestError.message : String(requestError);
    // 错误路径样本（04-02）：test 模式存请求与失败信息，final_return 显式标缺失——
    // 绝不当零来源成功。写入失败 fail-open（stderr 一行），不影响原样上抛。
    if (samples !== undefined && samplePath !== undefined) {
      samples.saveError({
        requestId,
        path: samplePath,
        originalParams: { ...params } as Record<string, unknown>,
        braveParams: { ...braveParams } as Record<string, unknown>,
        intent: params.intent,
        stage: 'brave',
        message,
        preFilter: null,
      });
    }
    // Brave 报错（抛错 / 非 2xx 由 issueRequest 统一转 Error）：写一条带 error
    // 标记的日志再原样上抛，保持既有失败行为（stage 'brave'）。
    writer.writeError({
      stage: 'brave',
      message,
      query: params.query,
      intent: params.intent,
      requestId,
    });
    throw requestError;
  }
  const braveLatencyMs = Date.now() - braveStartedAt;
  // 捕获点（SC2）：JSON 解析之后、schema 校验之前对响应做 structuredClone 快照——
  // 此后无人改写 response，克隆只为所有权隔离；off / on 不捕获（undefined）。
  const preFilter: unknown = samples !== undefined ? structuredClone(response) : undefined;
  const { success, data, error } = LlmContextSearchApiResponseSchema.safeParse(response);
  // 成功时接住统计对象：状态行第二块与 JSONL 日志都从它出（LOG-01/LOG-02）；
  // 失败（zod 校验失败，stage 'schema'）无 stats。
  let filtered: FilterResult | undefined;
  let payload: unknown;
  if (success) {
    filtered = await filterLlmContext(
      data,
      { params: parsedParams, intent: params.intent },
      config,
      jevDepsFor(config)
    );
    filtered.stats.brave.latency_ms = braveLatencyMs;
    // test 模式状态行末尾追加 sample 后缀（SC3）：路径已分配、文件即将先写后返；
    // status_line 尚无内容（零删除）时不加后缀——样本照落。第二块与 JSON 块内
    // output.status_line 都从 stats.output.status_line 出（D-08 同源不破）。
    const sampleSuffix = samplePath !== undefined ? ` sample: ${samplePath.absolute}` : '';
    if (sampleSuffix !== '' && typeof filtered.stats.output.status_line === 'string') {
      filtered.stats.output.status_line += sampleSuffix;
    }
    // 第一个 JSON 块在过滤结果之上附加统计摘要（stats.output，含 status_line）：
    // 状态行第二块与 JSON 块内 output.status_line 逐字同源（D-08/LOG-03 红线），
    // 模型也能直接读到幸存规模与 token 估算。闭包封装：写入失败剥后缀后重建。
    const buildPayload = (): unknown =>
      withAdjustments(
        {
          ...filtered!.result,
          output: filtered!.stats.output,
        } as FilteredResponse & { output: FilterStats['output'] },
        raised
      );
    payload = buildPayload();
    // 先写后返（SC3）：样本写成功才带着 sample 后缀返回；写失败剥后缀照常返回
    // 搜索内容、stderr 一行、JSONL 记 failed——绝不返回仿佛文件已存在的路径。
    if (samples !== undefined && samplePath !== undefined) {
      const outcome = samples.save({
        requestId,
        path: samplePath,
        originalParams: { ...params } as Record<string, unknown>,
        braveParams: { ...braveParams } as Record<string, unknown>,
        filterParams: parsedParams,
        intent: params.intent,
        preFilter,
        stats: filtered.stats,
        payload,
        statusLine: filtered.stats.output.status_line ?? null,
      });
      if (outcome.status === 'failed') {
        // 剥后缀：第二块与 JSON 块同源剥除（D-08 不破），返回内容不含 sample 路径
        const line = filtered.stats.output.status_line;
        if (sampleSuffix !== '' && typeof line === 'string' && line.endsWith(sampleSuffix)) {
          filtered.stats.output.status_line = line.slice(0, line.length - sampleSuffix.length);
        }
        payload = buildPayload();
      }
      // JSONL 信封：request_id + 样本指针（saved / failed 都如实记）
      const meta: LogWriteMeta = {
        requestId,
        sample: { path: samplePath.relative, status: outcome.status },
      };
      writer.write(filtered.stats, meta);
    } else {
      writer.write(filtered.stats, { requestId });
    }
  } else {
    payload = z.treeifyError(error);
    const message = error instanceof Error ? error.message : String(error);
    // 错误路径样本（04-02）：schema 校验失败保留可用原始响应（safeParse 前快照）
    // 与失败阶段；final_return 显式标缺失，不当零来源成功。
    if (samples !== undefined && samplePath !== undefined) {
      samples.saveError({
        requestId,
        path: samplePath,
        originalParams: { ...params } as Record<string, unknown>,
        braveParams: { ...braveParams } as Record<string, unknown>,
        intent: params.intent,
        stage: 'schema',
        message,
        preFilter,
      });
    }
    writer.writeError({
      stage: 'schema',
      message,
      query: params.query,
      intent: params.intent,
      requestId,
    });
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
