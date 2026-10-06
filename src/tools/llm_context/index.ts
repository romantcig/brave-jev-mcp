import { randomUUID } from 'node:crypto';
import type { TextContent, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import API from '../../BraveAPI/index.js';
import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  RequestParamsSchema,
  RequestHeadersSchema,
  LlmContextInputSchema,
  LlmContextUnfilteredInputSchema,
  type LlmContextInput,
} from './schemas/input.js';
import { LlmContextSearchApiResponseSchema } from './schemas/output.js';
import {
  applyMinimumValues,
  compactResponse,
  createJevClassifier,
  createLogWriter,
  createSampleWriter,
  filterLlmContext,
  hasJevKey,
  JEV_KEY_SETUP_HINT,
  loadFilterConfig,
  localIsoWithOffset,
  logRaisedToStderr,
  resolveToolDescription,
  withAdjustments,
} from '../../filter/index.js';
import type {
  AllocatedSamplePath,
  ClassifyDeps,
  FilterConfig,
  FilterDeps,
  FilterResult,
  LogSamplePointer,
  LogWriteMeta,
  LogWriter,
  SampleWriter,
} from '../../filter/index.js';

export const name = 'brave_llm_context';

export const annotations: ToolAnnotations = {
  title: 'Brave LLM Context',
  openWorldHint: true,
};

const intentDescription = `
    Required: \`intent\` — one English sentence stating what you want to find. If the query
    concerns a versioned product, name the current version and its defining mechanism in
    \`intent\` (e.g. "current Sanity Studio (v6, sanity.config.ts based)").
`;

const descriptionFor = (filtering: boolean) =>
  `
    Search the web with Brave and return pre-extracted, relevance-ranked content chunks
    (prose, tables, code blocks, structured data). Use the returned content directly when
    it answers the question; fetch the page only when you need the full context or must verify.

${filtering ? intentDescription : ''}

    For routine calls, omit the four search budget parameters; the server applies the defaults
    shown in their descriptions. Increase a budget only when previous results show that more
    source coverage or passage detail is needed. \`query\` supports site:.

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

    When relaying results, cite the URL returned with each content item.
    Source age, when available, is included with that item; it is not a verified publication date.
`.trim();

export const description = descriptionFor(true);
export const unfilteredDescription = descriptionFor(false);

type QueryParams = Omit<LlmContextInput, 'intent'> & { intent?: string };

// 配置延迟到首次使用时读取并复用。工具模块先于 dotenv 求值，
// 在模块顶层读环境会漏掉 .env 中的值；改配置后需重启 MCP。
let filterConfig: FilterConfig | undefined;

const configFor = (): FilterConfig => {
  filterConfig ??= loadFilterConfig(process.env);
  return filterConfig;
};

// 跨请求共享分类器的并发与熔断状态，off 或缺密钥时不创建实例。
// 缺密钥只告警一次；各次搜索仍记录 no_key，并在状态行报告 [error] 错误。
let jevClassifier: ClassifyDeps | undefined;
let noKeyWarned = false;

const jevDepsFor = (config: FilterConfig): FilterDeps | undefined => {
  if (config.mode === 'off') return undefined;
  if (!hasJevKey(process.env)) {
    if (!noKeyWarned) {
      noKeyWarned = true;
      console.error(
        `[jev-filter] Jev filtering is enabled but TYPESAFE_API_KEY is missing or blank; returning sources without Jev checks. ${JEV_KEY_SETUP_HINT}`
      );
    }
    return undefined;
  }
  jevClassifier ??= createJevClassifier(config.jev, process.env);
  return { classify: jevClassifier.classify };
};

// 三种模式共用进程级日志写入器，生命周期与配置一致。
let logWriter: LogWriter | undefined;

// 样本写入器仅 test 创建；每次请求单独分配路径，版本等只读状态留在闭包。
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
  // 关闭或缺密钥时没有意图输入；内部日志和样本使用空串表达缺省。
  const intent = params.intent ?? '';
  const { adjusted, raised } = applyMinimumValues(params);
  const parsedParams = RequestParamsSchema.parse(adjusted);
  const parsedHeaders = RequestHeadersSchema.parse(params);
  const config = configFor();
  const braveParams = parsedParams;

  // 三种模式均记录 JSONL，错误请求也落账；日志失败不影响搜索。
  const writer = (logWriter ??= createLogWriter(config));

  // 仅 test 模式准备样本写入器。
  const samples = sampleWriterFor(config);
  // 样本、日志和状态行路径使用同一请求身份关联。
  const requestId = randomUUID();
  // 先分配路径，同一个 Date 锚定样本时间戳与目录日期。
  const samplePath: AllocatedSamplePath | undefined = samples?.allocatePath(requestId);

  // 在 Brave 请求前捕获检索时间；test 复用样本锚点，确保两处同源。
  // 只传给过滤库，同次 Jev 请求与重试共用，不进入 Brave 参数。
  const retrievalTime = localIsoWithOffset(
    samplePath !== undefined ? samplePath.capturedAt : new Date()
  );

  // 在 Brave 请求前后计时；失败路径无过滤统计，转入错误记录。
  const braveStartedAt = Date.now();
  let response: unknown;
  try {
    response = await API.issueRequest<'llmContext'>('llmContext', braveParams, parsedHeaders);
  } catch (requestError) {
    const message = requestError instanceof Error ? requestError.message : String(requestError);
    // 错误样本显式标记结果缺失；保存状态写入同 request_id 的错误日志。
    // 保存失败不能覆盖原始搜索错误。
    let sample: LogSamplePointer | undefined;
    if (samples !== undefined && samplePath !== undefined) {
      const outcome = samples.saveError({
        requestId,
        path: samplePath,
        originalParams: { ...params } as Record<string, unknown>,
        braveParams: { ...braveParams } as Record<string, unknown>,
        intent,
        stage: 'brave',
        message,
        preFilter: null,
      });
      sample = { path: samplePath.relative, status: outcome.status };
    }
    // Brave 报错（抛错 / 非 2xx 由 issueRequest 统一转 Error）：写一条带 error
    // 标记的日志再原样上抛，保持既有失败行为（stage 'brave'）。
    writer.writeError({
      stage: 'brave',
      message,
      query: params.query,
      intent,
      requestId,
      sample,
    });
    throw requestError;
  }
  const braveLatencyMs = Date.now() - braveStartedAt;
  // test 在 schema 校验前深拷贝响应，保存独立的原始快照。
  const preFilter: unknown = samples !== undefined ? structuredClone(response) : undefined;
  const { success, data, error } = LlmContextSearchApiResponseSchema.safeParse(response);
  // 状态行和 JSONL 共用成功统计；schema 失败时无统计对象。
  let filtered: FilterResult | undefined;
  let payload: unknown;
  if (success) {
    filtered = await filterLlmContext(
      data,
      { params: parsedParams, intent, retrievalTime },
      config,
      jevDepsFor(config)
    );
    filtered.stats.brave.latency_ms = braveLatencyMs;
    // 先按保存成功构造状态行，再将同一值写入样本，确保样本与实际返回一致。
    // 零删除也提供样本入口；写入失败时移除该后缀或纯样本状态行。
    // 展示路径使用正斜杠，避免 Windows 反斜杠被当作转义符。
    const displaySamplePath = samplePath?.absolute.replaceAll('\\', '/');
    const sampleSuffix =
      displaySamplePath !== undefined
        ? ` sample for filter debugging - original results, filtered results, Jev decisions: ${displaySamplePath}`
        : '';
    const baseLine = filtered.stats.output.status_line;
    const hadLine = typeof baseLine === 'string';
    const savedLine =
      hadLine === true
        ? `${baseLine}${sampleSuffix}`
        : samplePath !== undefined
          ? `[filter] sample for filter debugging - original results, filtered results, Jev decisions: ${displaySamplePath}`
          : undefined;
    if (savedLine !== undefined) {
      filtered.stats.output.status_line = savedLine;
    }
    // 展示层合并重复元数据，规模统计只进日志；状态行单独返回一次。
    // 样本仍保存实际发出的精简载荷，过滤输入与 stats 均不改动。
    payload = compactResponse(withAdjustments(filtered.result, raised));
    // 保存完成后返回；失败时移除样本路径并记录 failed，搜索内容仍正常返回。
    if (samples !== undefined && samplePath !== undefined) {
      const outcome = samples.save({
        requestId,
        path: samplePath,
        originalParams: { ...params } as Record<string, unknown>,
        braveParams: { ...braveParams } as Record<string, unknown>,
        filterParams: parsedParams,
        intent,
        preFilter,
        stats: filtered.stats,
        // 样本使用客户端捕获的派发记录，避免重建输入与实发内容不一致。
        jevDispatch: filtered.jev_dispatch,
        // 请求级记录原样交入——实发载荷每请求一份（全量共享请求，一次搜索零或一条）
        jevRequests: filtered.jev_requests,
        payload,
        statusLine: filtered.stats.output.status_line ?? null,
      });
      if (outcome.status === 'failed') {
        // 写入失败后移除样本后缀；原本无状态行时删除该键。
        if (hadLine) {
          filtered.stats.output.status_line = baseLine;
        } else {
          delete filtered.stats.output.status_line;
        }
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
    // schema 失败时保留校验前响应快照，显式标记结果缺失，并把实际保存状态写入错误日志。
    let sample: LogSamplePointer | undefined;
    if (samples !== undefined && samplePath !== undefined) {
      const outcome = samples.saveError({
        requestId,
        path: samplePath,
        originalParams: { ...params } as Record<string, unknown>,
        braveParams: { ...braveParams } as Record<string, unknown>,
        intent,
        stage: 'schema',
        message,
        preFilter,
      });
      sample = { path: samplePath.relative, status: outcome.status };
    }
    writer.writeError({
      stage: 'schema',
      message,
      query: params.query,
      intent,
      requestId,
      sample,
    });
  }

  logRaisedToStderr(raised);

  // 状态行直接取 stats.output.status_line，存在时追加为第二个 text 块。
  const statusLine = filtered?.stats.output.status_line;
  return {
    content: [
      { type: 'text', text: JSON.stringify(payload) } as TextContent,
      ...(statusLine !== undefined ? [{ type: 'text', text: statusLine } as TextContent] : []),
    ],
    isError: !success,
  };
};

// 配置和工具定义均在启动注册时确定；修改配置或密钥后需重启 MCP。
const toolDefinitionFor = () => {
  const config = configFor();
  const filtering = config.mode !== 'off' && hasJevKey(process.env);
  return {
    // 自定义描述用于 Jev 模式，避免关闭时残留对 intent 的要求。
    description: filtering
      ? resolveToolDescription(description, config.toolDescriptionFile)
      : unfilteredDescription,
    inputSchema: filtering ? LlmContextInputSchema : LlmContextUnfilteredInputSchema,
  };
};

export const register = (mcpServer: McpServer) => {
  mcpServer.registerTool(name, { title: name, ...toolDefinitionFor(), annotations }, execute);
};

export default {
  name,
  get description() {
    return toolDefinitionFor().description;
  },
  annotations,
  get inputSchema() {
    return toolDefinitionFor().inputSchema.shape;
  },
  execute,
  register,
};
