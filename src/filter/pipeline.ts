/**
 * 十步管道的编排骨架与输出重建。
 *
 * 模式：先把 Brave 响应摊成"工作表"（每源每片段带原始索引与裁决），各步只在表上
 * 翻 `kept` / `verdict` / `reason` 或替换文本，**不 sort、不 filter 出新数组**，最后
 * 一次性重建输出——幸存来源与片段因此天然保持 Brave 原序（RULES-08）。
 *
 * 01-01 定型位置与类型，01-02 填了步 1、2，01-03 填了步 3（含付费墙截断）、步 4 与
 * 步 8，01-04 填了步 9（裁回预算，实现在 budget.ts）；步 10 仍是空位，末尾做输出
 * 重建与 `sources` 精简。后续计划往空位填实现，不改这里的顺序与签名。
 *
 * 依据：PLAN.md §3.2、notes/local-rules-design.md、01-RESEARCH.md「纯库布局」一节。
 */

import { parseFilterConfig } from './config.js';
import {
  BRAVE_DEFAULT_MAX_TOKENS,
  BRAVE_DEFAULT_MAX_URLS,
  summarizeOutput,
  trimToBudget,
} from './budget.js';
import { splitJsonFragment } from './jsonld.js';
import { BOILERPLATE_PREFIXES, PAYWALL_MARKERS_EN, PAYWALL_MARKERS_ZH } from './markers.js';
import {
  isBlocklisted,
  isEmptySource,
  isFeedUrl,
  isOneLiner,
  truncateAtPaywall,
} from './nonArticle.js';
import {
  isNearDuplicate,
  isShortWithoutTerms,
  SHINGLE_N,
  SHORT_SNIPPET_MAX,
  stripBoilerplateLines,
} from './prefilter.js';
import { canonicalizeUrl, mergeByCanonicalUrl } from './url.js';
import { contentTerms, shingles, tokenize } from './tokenize.js';
import { estimateTokens } from './tokens.js';
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
  JevCandidate,
  SnippetRemovalReason,
  SnippetStats,
  SourceDropReason,
  SourceMetadata,
  SourceStats,
} from './types.js';

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
  /** 步 2 从同页来源并入时记原来源索引；此时 `index` 是它在原来源里的片段索引 */
  mergedFrom?: number;
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
      canonical: canonicalizeUrl(url),
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
 * 步 1 JSON-LD 分流：逐源逐片段按 Brave 序调 `splitJsonFragment`。
 * 转出的多段原地占据原片段位置（同一 `index`、`part` 从 0 递增），不重排；
 * 整片删的只翻 `kept`，片段行仍留在表里供统计投影。普通文本不计数。
 */
const splitJsonLd = (table: WorkSource[], stats: FilterStats): void => {
  for (const source of table) {
    source.snippets = source.snippets.flatMap((snippet): WorkSnippet[] => {
      if (!snippet.kept) return [snippet];

      const verdict = splitJsonFragment(snippet.text, source.title);
      switch (verdict.action) {
        case 'converted':
          stats.local.jsonld_converted += 1;
          return verdict.parts.map((text, part) => ({
            index: snippet.index,
            part,
            text,
            kept: true,
          }));
        case 'dropped_meta':
          stats.local.jsonld_dropped += 1;
          return [{ ...snippet, kept: false, reason: 'jsonld_meta' }];
        case 'kept_raw':
          stats.local.jsonld_kept_raw += 1;
          return [snippet];
        case 'not_json':
          return [snippet];
      }
    });
  }
};

/** 步 3 付费墙截断用的标记全集：中英两表合并，每进程算一次。 */
const PAYWALL_MARKERS: readonly string[] = [...PAYWALL_MARKERS_EN, ...PAYWALL_MARKERS_ZH];

/**
 * 步 3 片段预筛（含付费墙截断）：顺序固定为付费墙截断 → 样板行剥离 → 短且无实词 →
 * 页内逐字重复（RULES-03/ordering）。被删片段留在原位只翻 `kept`；重复判定按原序
 * 只与同来源内**已幸存**片段比，保留先出现者。`snippets_prefiltered` 记 nav 与
 * boilerplate 两类之和，`dup_removed` 单独记，`paywall_truncated` 只记截断后保留的。
 */
const prefilterSnippets = (
  table: WorkSource[],
  stats: FilterStats,
  terms: ReadonlySet<string>
): void => {
  for (const source of table) {
    if (source.verdict !== 'keep') continue;

    const survivorShingles: Set<string>[] = [];
    for (const snippet of source.snippets) {
      if (!snippet.kept) continue;

      // 空串或纯空白：不进样板剥离以外的任何判定，按"短且无实词"处理
      if (snippet.text.trim() === '') {
        snippet.kept = false;
        snippet.reason = 'nav';
        stats.local.snippets_prefiltered += 1;
        continue;
      }

      const paywall = truncateAtPaywall(snippet.text, PAYWALL_MARKERS);
      if (paywall.truncated) {
        snippet.truncated = true;
        if (paywall.text === '') {
          snippet.kept = false;
          snippet.reason = 'paywall_empty';
          continue;
        }
        snippet.text = paywall.text;
        stats.local.paywall_truncated += 1;
      }

      const stripped = stripBoilerplateLines(snippet.text, BOILERPLATE_PREFIXES, source.title);
      if (stripped.emptied) {
        snippet.kept = false;
        snippet.reason = 'boilerplate';
        stats.local.snippets_prefiltered += 1;
        continue;
      }
      snippet.text = stripped.text;

      if (isShortWithoutTerms(snippet.text, terms, SHORT_SNIPPET_MAX)) {
        snippet.kept = false;
        snippet.reason = 'nav';
        stats.local.snippets_prefiltered += 1;
        continue;
      }

      const shingleSet = shingles(tokenize(snippet.text), SHINGLE_N);
      if (survivorShingles.some((survivor) => isNearDuplicate(shingleSet, survivor))) {
        snippet.kept = false;
        snippet.reason = 'dup';
        stats.local.dup_removed += 1;
        continue;
      }
      survivorShingles.push(shingleSet);
    }
  }
};

/**
 * 步 4 的规范 host：小写、去 `www.` 前缀；解析失败返回 `null`（不判 feed 也不判
 * 黑名单，方向保守）。黑名单与 feed 判定只看 host，端口不参与。
 */
const canonicalHostOf = (raw: string): string | null => {
  try {
    return new URL(raw).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
};

/**
 * 步 4：feed URL 与结构性黑名单，接在步 3 之后。feed 先判（更便宜也更具体），
 * 黑名单兜底；命中者整体丢弃，输出的 `sources` 表随输出重建自动清掉。
 */
const dropNonArticles = (table: WorkSource[], config: FilterConfig, stats: FilterStats): void => {
  for (const source of table) {
    if (source.verdict !== 'keep') continue;

    const host = canonicalHostOf(source.url);
    if (host === null) continue;

    if (isFeedUrl(source.url)) {
      source.verdict = 'drop';
      source.reason = 'feed';
      stats.local.feed_hits += 1;
      continue;
    }
    if (isBlocklisted(host, config.blocklist)) {
      source.verdict = 'drop';
      source.reason = 'blocklist';
      stats.local.blocklist_hits += 1;
    }
  }
};

/**
 * 步 8：空来源与一句话来源，接在片段级之后。片段删光（或本就没有片段、
 * `sources` 元数据缺条目）的来源整体丢弃；只剩一条短片段的来源按**只看 query
 * 实词**（不含 intent——步 3 已用并集过滤过）判定，不含则丢、含则留。
 * 被丢来源只翻 `verdict`，不从工作表数组里移除（RULES-05/ordering）。
 */
const dropEmptySources = (
  table: WorkSource[],
  stats: FilterStats,
  queryTerms: ReadonlySet<string>
): void => {
  for (const source of table) {
    if (source.verdict !== 'keep') continue;

    const surviving = source.snippets.filter((snippet) => snippet.kept);
    if (!isEmptySource(surviving) && !isOneLiner(surviving, queryTerms)) continue;

    source.verdict = 'drop';
    source.reason = 'empty';
    stats.local.empty_dropped += 1;
  }
};

/**
 * 本地规则层（步 1–4）的固定顺序编排：JSON-LD 分流 → URL 规范化归并 → 片段预筛
 * （付费墙截断 → 样板剥离 → 短无实词 → 页内逐字重复）→ feed URL 与结构性黑名单。
 * 从 `filterLlmContext` 抽出，供重录 dump 的 `collectJevCandidates` 复用同一候选口径
 * （02-01）；`terms` 由调用方传 `contentTerms(query, intent)`。
 */
const runLocalRules = (
  table: WorkSource[],
  stats: FilterStats,
  terms: ReadonlySet<string>,
  config: FilterConfig
): void => {
  splitJsonLd(table, stats); // 步 1：JSON-LD 分流
  stats.local.url_merged += mergeByCanonicalUrl(table); // 步 2：URL 规范化归并
  // 步 3 片段预筛：付费墙截断 → 样板剥离 → 短无实词 → 页内逐字重复（顺序固定）
  prefilterSnippets(table, stats, terms);
  dropNonArticles(table, config, stats); // 步 4：feed URL 与结构性黑名单
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
    ...(snippet.mergedFrom !== undefined ? { merged_from: snippet.mergedFrom } : {}),
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
 * 管道跑完后把工作表的最终裁决与输出规模写回统计对象。
 * `output.*` 由 summarizeOutput 从工作表算（幸存片段 `String.length` 之和、
 * 未取整估算和的 `Math.ceil`），token 口径与步 9 的裁剪判定一致。
 */
const finalizeStats = (stats: FilterStats, table: WorkSource[]): void => {
  stats.sources = table.map(projectSource);
  stats.output = summarizeOutput(table, estimateTokens);
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

  runLocalRules(table, stats, contentTerms(request.params.query, request.intent), config);
  // 步 5 Jev 每源一次请求：Phase 2；off 模式跳过
  // 步 6 来源级裁决：Phase 2；off 模式无事可做
  // 步 7 片段级 score 与事实指纹新颖度：Phase 2；off 模式按 Brave 序播种，本阶段一律保留
  dropEmptySources(table, stats, contentTerms(request.params.query)); // 步 8：空来源与一句话来源
  // 步 9 裁回预算：只在超量倍数 > 1 时执行——此时抓取量被放大、Brave 返回的内容超出
  // 模型原始请求，需要按原始请求值（与 applyOverfetch 放大后的参数无关）从末源末片段
  // 往回砍、不重排。倍数为 1 时 Brave 已按请求上限返回、过滤层只删不加，而估算公式
  // 是为 Jev 32k 保护标定的、对普通网页文本偏高（审查问题 6），再按估算裁只会误砍。
  // 计数按裁决累加（reason 'budget' 只有本步会写）。
  if (config.overfetchFactor !== 1) {
    trimToBudget(table, request.params, estimateTokens);
  }
  stats.local.budget_dropped_sources += table.filter(
    (source) => source.verdict === 'drop' && source.reason === 'budget'
  ).length;
  stats.local.budget_trimmed_snippets += table.reduce(
    (sum, source) =>
      sum +
      source.snippets.filter((snippet) => !snippet.kept && snippet.reason === 'budget').length,
    0
  );
  // 步 10 状态行：Phase 3

  const result = rebuildOutput(table, data);
  finalizeStats(stats, table);

  return { result, stats };
}

/**
 * Jev 候选集收集（02-01）：对输入跑一遍本地规则层（步 1–4），收集幸存来源与其
 * 幸存片段。重录 dump（`dev/dump_local_rules.ts`）与管道步 5 共用同一候选口径——
 * 录好的答案因此与生产 state 逐源逐片段对齐。
 *
 * 纯函数：`buildWorkTable` 建工作表、一次性 stats 只作步 1–4 计数载体（用后即弃，
 * 不返回）、不改输入。候选条件：来源 `verdict === 'keep'` 且幸存片段 ≥ 1；
 * `id` 取 `s{source.index}`（与探测脚本 `s0..s11` 约定一致），`url` / `title` 用
 * 工作表原值，`snippets` 取幸存片段的当前文本（含步 1 转出的多段与步 2 并入的
 * 片段），顺序即表序（Brave 原序）。
 */
export function collectJevCandidates(
  data: BraveLlmContextResponse,
  request: { params: FilterRequest; intent: string },
  config: FilterConfig
): JevCandidate[] {
  const table = buildWorkTable(data);
  const stats = createFilterStats('off', toStatsRequest(request, config), data);
  runLocalRules(table, stats, contentTerms(request.params.query, request.intent), config);

  const candidates: JevCandidate[] = [];
  for (const source of table) {
    if (source.verdict !== 'keep') continue;
    const snippets = source.snippets.filter((snippet) => snippet.kept).map((snippet) => snippet.text);
    if (snippets.length < 1) continue;
    candidates.push({ id: `s${source.index}`, url: source.url, title: source.title, snippets });
  }
  return candidates;
}
