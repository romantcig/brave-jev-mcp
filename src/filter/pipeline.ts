/**
 * 十步管道的编排骨架与输出重建。
 *
 * 模式：先把 Brave 响应摊成"工作表"（每源每片段带原始索引与裁决），各步只在表上
 * 翻 `kept` / `verdict` / `reason` 或替换文本，**不 sort、不 filter 出新数组**，最后
 * 一次性重建输出——幸存来源与片段因此天然保持 Brave 原序（RULES-08）。
 *
 * 本计划（01-01）只定型位置与类型：步 1–4、7、9 是空位，步 8 只做"片段删光即丢来源"，
 * 末尾做输出重建与 `sources` 精简。后续计划往空位填实现，不改这里的顺序与签名。
 *
 * 依据：PLAN.md §3.2、notes/local-rules-design.md、01-RESEARCH.md「纯库布局」一节。
 */

import { parseFilterConfig } from './config.js';
import { createFilterStats } from './stats.js';
import type {
  BraveLlmContextGenericItem,
  BraveLlmContextResponse,
  FilterConfig,
  FilterDeps,
  FilteredResponse,
  FilterRequest,
  FilterResult,
  FilterStats,
  SnippetRemovalReason,
  SnippetStats,
  SourceDropReason,
  SourceMetadata,
  SourceStats,
} from './types.js';

/** Brave 文档给的默认上限：模型未传 `maximum_number_of_*` 时按它们理解预算。 */
const BRAVE_DEFAULT_MAX_URLS = 20;
const BRAVE_DEFAULT_MAX_TOKENS = 8192;

/** `age` 元素的 ISO 日期判定：前缀匹配，不数字符（EMBED-01/encoding）。 */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}/;

/** 工作表里的一条片段。`chars` 不单独存，投影到统计表时按当前文本算。 */
type WorkSnippet = {
  index: number;
  part?: number;
  text: string;
  kept: boolean;
  reason?: SnippetRemovalReason;
  truncated?: boolean;
};

/** 工作表里的一个来源。`url` 永远是 Brave 原始 URL；`canonical` 只用作归并键。 */
type WorkSource = {
  index: number;
  url: string;
  canonical: string;
  title: string;
  meta: SourceMetadata | undefined;
  snippets: WorkSnippet[];
  verdict: 'keep' | 'drop';
  reason?: SourceDropReason;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** 只在 `sources` 表确有该 URL 且是对象时返回元数据；`Object.hasOwn` 避开原型链。 */
const lookupMeta = (
  sources: BraveLlmContextResponse['sources'] | undefined,
  url: string
): SourceMetadata | undefined => {
  if (!isRecord(sources) || !Object.hasOwn(sources, url)) return undefined;
  const meta: unknown = sources[url];
  return isRecord(meta) ? (meta as SourceMetadata) : undefined;
};

/** 把 Brave 响应摊成工作表；逐层用 typeof / Array.isArray 收窄，不 spread 解析结果。 */
const buildWorkTable = (data: BraveLlmContextResponse): WorkSource[] => {
  const items = Array.isArray(data?.grounding?.generic) ? data.grounding.generic : [];

  return items.map((item, index) => {
    const url = typeof item?.url === 'string' ? item.url : '';
    const title = typeof item?.title === 'string' ? item.title : '';
    const texts = Array.isArray(item?.snippets) ? item.snippets : [];

    return {
      index,
      url,
      // 01-02 落地 canonicalizeUrl 之前，归并键暂等于原始 URL
      canonical: url,
      title,
      meta: lookupMeta(data?.sources, url),
      snippets: texts.map((text, snippetIndex) => ({
        index: snippetIndex,
        text: typeof text === 'string' ? text : '',
        kept: true,
      })),
      verdict: 'keep' as const,
    };
  });
};

/**
 * 步 8（本计划部分）：片段删光的来源整体丢弃，输出时同步从 `sources` 表消失。
 * "只剩一条短片段且不含 query 实词"的一句话来源规则依赖分词，由 01-03 在本步补上。
 */
const dropEmptySources = (table: WorkSource[], stats: FilterStats): void => {
  for (const source of table) {
    if (source.verdict !== 'keep') continue;
    if (source.snippets.some((snippet) => snippet.kept)) continue;

    source.verdict = 'drop';
    source.reason = 'empty';
    stats.local.empty_dropped += 1;
  }
};

/**
 * 精简 `sources` 表里一条元数据：只留 `title` / `hostname` / `age`。
 * - 非对象入参返回 `{}`；`title` / `hostname` 仅在为 string 时写入。
 * - `age` 只取首个匹配 `^\d{4}-\d{2}-\d{2}` 的元素写成单元素数组；找不到就省略 `age` 键，
 *   绝不产出 `age: [undefined]`。
 * - 写时复制：每次返回新对象，不修改传入的元数据。
 * @returns 精简后的新对象
 * @example trimSourceMeta({ title: 'T', hostname: 'h', age: ['Wed', '2026-09-16', '1 week ago'] }) → { title: 'T', hostname: 'h', age: ['2026-09-16'] }
 * @example trimSourceMeta({ title: 'T', age: [] }) → { title: 'T' }
 * @example trimSourceMeta(null) → {}
 */
export function trimSourceMeta(meta: unknown): Record<string, unknown> {
  if (!isRecord(meta)) return {};

  const out: Record<string, unknown> = {};
  if (typeof meta.title === 'string') out.title = meta.title;
  if (typeof meta.hostname === 'string') out.hostname = meta.hostname;

  const iso = Array.isArray(meta.age)
    ? meta.age.find((entry): entry is string => typeof entry === 'string' && ISO_DATE.test(entry))
    : undefined;
  if (iso !== undefined) out.age = [iso];

  return out;
}

/**
 * 从工作表重建输出：只收幸存来源与其幸存片段，顺序即工作表顺序（Brave 原序）；
 * `sources` 键的插入顺序与 `grounding.generic` 一致；`map` / `poi` 原样透传。
 * 过滤后为空就是 `generic: []`、`sources: {}`，不补回。
 */
export function rebuildOutput(
  table: WorkSource[],
  data: BraveLlmContextResponse
): FilteredResponse {
  const survivors = table.filter((source) => source.verdict === 'keep');

  const generic: BraveLlmContextGenericItem[] = survivors.map((source) => ({
    url: source.url,
    title: source.title,
    snippets: source.snippets.filter((snippet) => snippet.kept).map((snippet) => snippet.text),
  }));

  const sources = Object.fromEntries(
    survivors.map((source) => [source.url, trimSourceMeta(source.meta)])
  );

  const grounding: BraveLlmContextResponse['grounding'] | undefined = data?.grounding;
  const result: FilteredResponse = {
    grounding: {
      generic,
      map: isRecord(grounding) && Object.hasOwn(grounding, 'map') ? grounding.map : [],
    },
    sources,
  };
  if (isRecord(grounding) && Object.hasOwn(grounding, 'poi')) {
    result.grounding.poi = grounding.poi;
  }

  return result;
}

/** 工作表 → 统计表投影：去掉正文，只留索引、标记与字符数。 */
const projectSource = (source: WorkSource): SourceStats => {
  const hostname = typeof source.meta?.hostname === 'string' ? source.meta.hostname : undefined;
  const snippets: SnippetStats[] = source.snippets.map((snippet) => ({
    index: snippet.index,
    ...(snippet.part !== undefined ? { part: snippet.part } : {}),
    kept: snippet.kept,
    ...(snippet.reason !== undefined ? { reason: snippet.reason } : {}),
    ...(snippet.truncated !== undefined ? { truncated: snippet.truncated } : {}),
    chars: snippet.text.length,
  }));

  return {
    index: source.index,
    url: source.url,
    canonical_url: source.canonical,
    ...(hostname !== undefined ? { hostname } : {}),
    verdict: source.verdict,
    ...(source.reason !== undefined ? { reason: source.reason } : {}),
    snippets,
  };
};

/**
 * 输出规模的 token 估算占位：按 4 字符一 token 粗估。
 * 01-04 计划的 `tokens.ts` 会换成 notes/jev-api.md 的无分词器公式，这里不另写一份。
 */
const estimateOutputTokens = (chars: number): number => Math.ceil(chars / 4);

/** 管道跑完后把工作表的最终裁决与输出规模写回统计对象。 */
const finalizeStats = (stats: FilterStats, table: WorkSource[], result: FilteredResponse): void => {
  stats.sources = table.map(projectSource);

  const chars = result.grounding.generic.reduce(
    (sum, item) => sum + item.snippets.reduce((inner, text) => inner + text.length, 0),
    0
  );
  stats.output = {
    n_sources: result.grounding.generic.length,
    n_snippets: result.grounding.generic.reduce((sum, item) => sum + item.snippets.length, 0),
    chars,
    est_tokens: estimateOutputTokens(chars),
  };
};

/** 把适配行传入的请求归一成统计表的 `request` 摘要，上限缺省填 Brave 默认值。 */
const toStatsRequest = (
  request: { params: FilterRequest; intent: string },
  config: FilterConfig
): FilterStats['request'] => {
  const { params } = request;
  return {
    query: params.query,
    intent: request.intent,
    max_urls: params.maximum_number_of_urls ?? BRAVE_DEFAULT_MAX_URLS,
    max_tokens: params.maximum_number_of_tokens ?? BRAVE_DEFAULT_MAX_TOKENS,
    ...(params.maximum_number_of_tokens_per_url !== undefined
      ? { per_url_tokens: params.maximum_number_of_tokens_per_url }
      : {}),
    overfetch_factor: config.overfetchFactor,
  };
};

/**
 * 过滤层入口：Brave 响应 + 请求 → 过滤后的响应 + 统计对象。
 *
 * 同步纯函数，不发任何网络请求；`config` 省略时在**调用时**读 `process.env`。
 * Phase 1 三种模式走同一路径，只在 `stats.mode` 记录；Phase 2 通过 `deps.classify`
 * 注入 Jev 客户端后才在步 5–7 分叉。
 *
 * @param data Brave LLM Context 响应（已过上游 zod 校验）
 * @param request `params` 是 `RequestParamsSchema.parse` 的结果，`intent` 单独携带
 * @param config 过滤配置；省略时 `parseFilterConfig(process.env)`
 * @param _deps Phase 2 注入点；Phase 1 未使用
 * @returns `{ result, stats }`；`result` 与输入同形，`stats` 是本次调用新建的对象
 */
export function filterLlmContext(
  data: BraveLlmContextResponse,
  request: { params: FilterRequest; intent: string },
  config: FilterConfig = parseFilterConfig(process.env),
  _deps?: FilterDeps
): FilterResult {
  const table = buildWorkTable(data);
  const stats = createFilterStats(config.mode, toStatsRequest(request, config), data);

  // 步 1 JSON-LD 分流：空位，01-02 计划填（jsonld.ts）
  // 步 2 URL 规范化归并：空位，01-02 计划填（url.ts）
  // 步 3 片段预筛：空位，01-03 计划填（prefilter.ts、tokenize.ts）
  // 步 4 feed URL 与结构性黑名单：空位，01-03 计划填（nonArticle.ts、blocklist.ts）
  // 步 5 Jev 每源一次请求：Phase 2；off 模式跳过
  // 步 6 来源级裁决：Phase 2；off 模式无事可做
  // 步 7 片段级 score 与事实指纹新颖度：Phase 2；off 模式按 Brave 序播种，本阶段一律保留
  dropEmptySources(table, stats); // 步 8：空来源规则（一句话来源规则由 01-03 补）
  // 步 9 裁回预算：空位，01-04 计划填（budget.ts 的 trimToBudget）
  // 步 10 状态行：Phase 3

  const result = rebuildOutput(table, data);
  finalizeStats(stats, table, result);

  return { result, stats };
}
