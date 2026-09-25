/**
 * 十步管道的编排骨架与输出重建。
 *
 * 模式：先把 Brave 响应摊成"工作表"（每源每片段带原始索引与裁决），各步只在表上
 * 翻 `kept` / `verdict` / `reason` 或替换文本，**不 sort、不 filter 出新数组**，最后
 * 一次性重建输出——幸存来源与片段因此天然保持 Brave 原序（RULES-08）。
 *
 * 01-01 定型位置与类型，01-02 填了步 1、2，01-03 填了步 3（含付费墙截断）、步 4 与
 * 步 8，01-04 填了步 9（裁回预算，实现在 budget.ts）；02-02 把 `filterLlmContext`
 * 改为 async 并接线步 5（全候选并发派发 + 逐源记账），`runJevStage` 是私有编排件，
 * 不进 barrel。02-03 填了步 6/7 前半（来源级裁决与片段 score），02-04 填了步 7 后半
 * （指纹新颖度与跨源逐字去重，实现在 novelty.ts）；步 10（shadow 状态行）留待
 * Phase 3。末尾做输出重建与 `sources` 精简。后续计划往空位填实现，不改这里的顺序与签名。
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
import { buildQuestions, buildState, SOURCE_QUESTIONS } from './jev/questions.js';
import { applySnippetScores, applySourceVerdicts } from './jev/verdict.js';
import { applyNovelty, type JevSideDeletionFlags } from './jev/novelty.js';
import { canonicalizeUrl, mergeByCanonicalUrl } from './url.js';
import { contentTerms, shingles, tokenize } from './tokenize.js';
import { estimateTokens } from './tokens.js';
import { createFilterStats, createNoKeyJevStats, zeroLocal } from './stats.js';
import type {
  BraveLlmContextGenericItem,
  BraveLlmContextResponse,
  ClassifyDeps,
  ClassifyOutcome,
  FilterConfig,
  FilterDeps,
  FilteredResponse,
  FilterRequest,
  FilterResult,
  FilterStats,
  JevCandidate,
  JevPerSourceStats,
  JevStats,
  JevThresholds,
  ShadowDiff,
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
 *
 * 归因（A2 口径，notes/dedup-and-rewrite-policy.md）：来源被删光且 `jevSideDeletions`
 * 显示其删除含新颖度或跨源 dup → reason 'rewrite'；仅 score 或本地原因 → 维持
 * 'empty'。不传标记时行为与 Phase 1 完全一致（全记 'empty'）。'rewrite' 丢弃
 * 不计进 `empty_dropped`（该计数只收 reason 'empty'）——rewrite 从
 * `stats.sources[].reason` 按原因计数（Phase 3 状态行共同来源）。
 */
const dropEmptySources = (
  table: WorkSource[],
  stats: FilterStats,
  queryTerms: ReadonlySet<string>,
  jevSideDeletions?: ReadonlyMap<number, JevSideDeletionFlags>
): void => {
  for (const source of table) {
    if (source.verdict !== 'keep') continue;

    const surviving = source.snippets.filter((snippet) => snippet.kept);
    if (!isEmptySource(surviving) && !isOneLiner(surviving, queryTerms)) continue;

    const flags = jevSideDeletions?.get(source.index);
    const emptiedByJev = flags !== undefined && (flags.novelty || flags.crossSourceDup);
    source.verdict = 'drop';
    source.reason = emptiedByJev ? 'rewrite' : 'empty';
    if (!emptiedByJev) {
      stats.local.empty_dropped += 1;
    }
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
 * 自 02-02 起异步（步 5 要 `await` 注入的 classify），仍不发任何网络请求——
 * 网络只发生在注入的 classify 实现里。`config` 省略时在**调用时**读 `process.env`。
 * 模式分叉：off 整段跳过 Jev（`stats.jev` 保持 null）；on/shadow 注入 classify 后
 * 对全部候选来源并发派发（步 5），未注入时记 no_key 零值对象且零请求（SAFE-01
 * 语义前置）；on 在正本上应用裁决（步 6 + 步 7 前半，02-03），shadow 在拷贝上跑
 * would 链只记 `shadow_diff`、输出仍是本地规则结果（VERDICT-05）。调用方不
 * `await` 会在 tsc 处报类型错——tsx 不查类型，`npm run build` 是唯一漏改闸
 * （Pitfall 1）。
 *
 * @param data Brave LLM Context 响应（已过上游 zod 校验）
 * @param request `params` 是 `RequestParamsSchema.parse` 的结果，`intent` 单独携带
 * @param config 过滤配置；省略时 `parseFilterConfig(process.env)`
 * @param deps Phase 2 注入点：`classify` 缺省时 on/shadow 记 no_key
 * @returns `{ result, stats }` 的 Promise；`result` 与输入同形，`stats` 是本次调用新建的对象
 */
export async function filterLlmContext(
  data: BraveLlmContextResponse,
  request: { params: FilterRequest; intent: string },
  config: FilterConfig = parseFilterConfig(process.env),
  deps?: FilterDeps
): Promise<FilterResult> {
  const table = buildWorkTable(data);
  const stats = createFilterStats(config.mode, toStatsRequest(request, config), data);

  runLocalRules(table, stats, contentTerms(request.params.query, request.intent), config);
  // 步 5 Jev 每源一次请求：off 模式跳过；on/shadow 注入 classify 后全候选一波并发
  // 派发（进程级并发闸住 02-05 的 createJevClassifier，管道编排层不持状态与限流）
  let judged: ReadonlyMap<string, JevPerSourceStats> | undefined;
  let jevSideDeletions: ReadonlyMap<number, JevSideDeletionFlags> = new Map();
  if (config.mode !== 'off' && deps?.classify !== undefined) {
    judged = await runJevStage(table, request, config, deps.classify, stats);
    if (config.mode === 'on') {
      // 步 6 来源级裁决：固定顺序（off_topic → listing → self_deprecated → stale →
      // filler），p >= 门槛 + CJK 加成即丢、命中即停；失败来源按"留"（SAFE-01）
      applySourceVerdicts(table, judged, config.thresholds, stats);
      // 步 7 前半：片段 score 删除（score < snippetMin 严格小于才删）
      applySnippetScores(table, judged, config.thresholds, stats);
      // 步 7 后半（on）：跨源逐字 dup 与事实指纹新颖度，is_primary 播种、正本应用
      jevSideDeletions = applyNovelty(table, judged, 'on', config.thresholds, stats);
    } else {
      // shadow：正本完全不动（输出即本地规则结果，VERDICT-05）；步 7 后半只进
      // would 层——wouldChain 在拷贝上按 is_primary 播种跑 applyNovelty，删除计数
      // 并入 would_remove_snippets
      stats.shadow_diff = wouldChain(
        table,
        judged,
        config.thresholds,
        stats,
        contentTerms(request.params.query)
      );
    }
  } else {
    // off 与 no_key（on/shadow 未注入 classify）：全部来源未判定 → Brave 序播种、
    // 无 Jev 答案即无论证段保护（PLAN §3.2 明文设计，用户已定决策 3——off 期望
    // 文件的重标注是设计意图不是回归；no_key 等价 off 口径，SAFE-01 前置语义）
    if (config.mode !== 'off') stats.jev = createNoKeyJevStats();
    jevSideDeletions = applyNovelty(table, judged, config.mode, config.thresholds, stats);
  }
  dropEmptySources(table, stats, contentTerms(request.params.query), jevSideDeletions); // 步 8：空来源与一句话来源（含 rewrite 归因）
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
 * 工作表 → Jev 候选集：`verdict === 'keep'` 且幸存片段 ≥ 1 的来源。`id` 取
 * `s{source.index}`（与探测脚本 `s0..s11` 约定一致），`url` / `title` 用工作表
 * 原值，`snippets` 取幸存片段的当前文本（含步 1 转出的多段与步 2 并入的片段），
 * 顺序即表序（Brave 原序）。只读表，不翻标记、不重排（RULES-08）。
 */
const jevCandidatesFromTable = (table: WorkSource[]): JevCandidate[] => {
  const candidates: JevCandidate[] = [];
  for (const source of table) {
    if (source.verdict !== 'keep') continue;
    const snippets = source.snippets
      .filter((snippet) => snippet.kept)
      .map((snippet) => snippet.text);
    if (snippets.length < 1) continue;
    candidates.push({ id: `s${source.index}`, url: source.url, title: source.title, snippets });
  }
  return candidates;
};

/**
 * 步 5：Jev 每源一次请求，对全部候选来源一波并发派发（Promise.allSettled——管道
 * 编排层不持进程级状态与限流；进程级并发闸按 Responsibility Map 由 02-05 的
 * `createJevClassifier` 闭包持有并消费 `config.jev.concurrency`，本处不建双闸）。
 *
 * 记账口径（SAFE-01/JEV-04）：
 * - 候选来源（keep 且幸存片段 ≥ 1）构造 state 与题目后并发调 `classify`，每次
 *   调用计 latency；answered → per_source 记十键概率与 snippet_scores（snip0..N
 *   顺序）、model、input_tokens，`n_requests` 加一；
 * - failed 且 kind 非 `breaker_open` → `n_requests` 加一、记 fail_kind；失败来源
 *   什么都不动（按"留"，SAFE-01——删除裁决留给 02-03）；
 * - failed kind `breaker_open` → 不计 `n_requests`（02-05 熔断短路的落点）；
 * - keep 但幸存片段为 0 的来源（本地规则删光，步 8 会丢）→ per_source 记
 *   status `'skipped'` 且不计请求（JEV-04"无候选不调 Jev"）；本地规则已丢的来源
 *   不进 per_source——Jev 从不问它们。
 * - 聚合：input_tokens / latency_ms_total 求和；status 任一 per_source
 *   `'breaker_open'` → `'breaker_open'`，否则任一 failed → `'degraded'`，否则 `'ok'`。
 *
 * `config` 在本计划只随签名占位（模型 / 超时 / 并发都由注入的 classify 实现自持，
 * 02-05 落地后其消费点在 createJevClassifier 入口），保留参数避免 02-05 再改签名。
 *
 * @returns 逐源 judged 结果映射（键 = src id `s{index}`，值 = per_source 行对象
 * 引用）——步 6/7 的裁决消费入口；shadow 的 would 层共用同一映射。
 */
const runJevStage = async (
  table: WorkSource[],
  request: { params: FilterRequest; intent: string },
  config: FilterConfig,
  classify: ClassifyDeps['classify'],
  stats: FilterStats
): Promise<Map<string, JevPerSourceStats>> => {
  const jev: JevStats = {
    n_requests: 0,
    input_tokens: 0,
    latency_ms_total: 0,
    status: 'ok',
    per_source: [],
  };
  const sourceKeys = Object.keys(SOURCE_QUESTIONS);
  const candidates = jevCandidatesFromTable(table);

  // 先按表序给每个 keep 来源立 skipped 占位行，候选来源派发后覆盖——per_source
  // 天然保持 Brave 原序（RULES-08），顺序由 Map 的插入序保证
  const rows = new Map<string, JevPerSourceStats>();
  for (const source of table) {
    if (source.verdict !== 'keep') continue;
    rows.set(`s${source.index}`, { src: `s${source.index}`, url: source.url, status: 'skipped' });
  }

  const dispatch = async (candidate: JevCandidate): Promise<void> => {
    const state = buildState(
      candidate.id,
      candidate.url,
      candidate.title,
      candidate.snippets,
      request.params.query,
      request.intent
    );
    const questions = buildQuestions(candidate.snippets.length);
    const startedAt = Date.now();

    let outcome: ClassifyOutcome;
    try {
      outcome = await classify({ state, questions });
    } catch {
      // classify 契约是返回 failed 而非 reject；真 reject 按网络失败记账（防御注入面）
      outcome = { status: 'failed', kind: 'network' };
    }
    const latencyMs = Date.now() - startedAt;
    jev.latency_ms_total += latencyMs;

    if (outcome.status === 'answered') {
      jev.n_requests += 1;
      jev.input_tokens += outcome.input_tokens;

      const answers: Record<string, number> = {};
      for (const key of sourceKeys) {
        const answer = outcome.answers[key];
        if (answer?.kind === 'noul') answers[key] = answer.probability;
      }
      const snippetScores: number[] = [];
      for (let i = 0; i < candidate.snippets.length; i += 1) {
        const answer = outcome.answers[`snip${i}`];
        if (answer?.kind === 'score') snippetScores.push(answer.score);
      }

      rows.set(candidate.id, {
        src: candidate.id,
        url: candidate.url,
        status: 'answered',
        answers,
        snippet_scores: snippetScores,
        model: outcome.model,
        input_tokens: outcome.input_tokens,
        latency_ms: latencyMs,
        ...(outcome.ladder !== undefined ? { ladder: outcome.ladder } : {}),
      });
    } else if (outcome.kind === 'breaker_open') {
      // 熔断短路：不发真实请求，不计 n_requests（SAFE-02 记账口径）
      rows.set(candidate.id, {
        src: candidate.id,
        url: candidate.url,
        status: 'breaker_open',
        latency_ms: latencyMs,
      });
    } else {
      jev.n_requests += 1;
      rows.set(candidate.id, {
        src: candidate.id,
        url: candidate.url,
        status: 'failed',
        fail_kind: outcome.kind,
        // 阶梯 ④（JEV-05）：too_large = 该来源不问 Jev，per_source 记 'skipped'
        ...(outcome.kind === 'too_large' ? { ladder: 'skipped' as const } : {}),
        latency_ms: latencyMs,
      });
    }
  };

  await Promise.allSettled(candidates.map(dispatch));

  jev.per_source = [...rows.values()];
  jev.status = jev.per_source.some((row) => row.status === 'breaker_open')
    ? 'breaker_open'
    : jev.per_source.some((row) => row.status === 'failed')
      ? 'degraded'
      : 'ok';
  stats.jev = jev;
  return rows;
};

/**
 * shadow would 链会整体丢弃的来源原因集合：Jev 侧五道丢弃 + 改写（02-04 起
 * novelty/跨源 dup 删光记 'rewrite'）。`empty` 不在其中——本地规则也会丢的
 * 空来源不算 would 差异，只有"被 Jev 片段删除间接清空"的来源单独加回。
 */
const WOULD_DROP_REASONS: ReadonlySet<SourceDropReason> = new Set([
  'off_topic',
  'listing',
  'self_deprecated',
  'stale',
  'filler',
  'rewrite',
]);

/**
 * shadow 模式的 would 层（VERDICT-05）：在拷贝工作表上跑完整 on 链（步 6 来源级
 * 裁决 + 步 7 前半 score 删除 + 步 8 空来源），只取 would 记账——正本完全不动，
 * shadow 输出即本地规则结果。拷贝是"来源逐个展开、snippets 逐条展开"的一层浅
 * 拷贝（其余字段只读共享，本链只翻拷贝上的标记，不重排）。
 *
 * 记账口径（notes/shadow-mode-logging.md shadow_diff 字段）：
 * - `would_drop`：拷贝上 verdict 为 drop 且 reason 属于 Jev 侧丢弃的来源 src id，
 *   加上"本地规则后幸存片段非空、却被 Jev 片段删除间接清空（score 删光后
 *   幸存数为 0，步 8 记 'empty'）"的来源——正本上它们不会被步 8 丢，是 Jev
 *   造成的真实差异；oneLiner 等正本同样会丢的来源不算。
 * - `would_remove_snippets`：拷贝上由 score（02-03）与 novelty / 跨源 dup（02-04）
 *   造成的片段删除数；novelty/dup 计数从一次性载体取——片段 reason 'dup' 与步 3
 *   页内去重同键，按行数统计会混入本地删除。
 *
 * 裁决回写照常落 `stats.jev.per_source`（would 层 verdict/reason 记账进
 * per_source 但不回写正本）；步 8 的 empty 计数用一次性载体接住，不污染
 * 正本 `stats.local`（正本随后自己跑步 8）。
 */
const wouldChain = (
  table: WorkSource[],
  judged: ReadonlyMap<string, JevPerSourceStats>,
  thresholds: JevThresholds,
  stats: FilterStats,
  queryTerms: ReadonlySet<string>
): ShadowDiff => {
  const copy = table.map((source) => ({
    ...source,
    snippets: source.snippets.map((snippet) => ({ ...snippet })),
  }));
  // 本地规则后的幸存片段数（Jev 侧删除前口径），供"间接清空"判定
  const survivingBeforeJev = new Map<string, number>();
  for (const source of copy) {
    survivingBeforeJev.set(`s${source.index}`, source.snippets.filter((s) => s.kept).length);
  }

  applySourceVerdicts(copy, judged, thresholds, stats);
  applySnippetScores(copy, judged, thresholds, stats);
  // score 删除后的幸存片段数快照（dropEmptySources 只翻来源标记、不动片段）；
  // 快照在新颖度之前——"间接清空"分支只收 score 删光（novelty/dup 删光走 rewrite）
  const survivingAfterScores = new Map<string, number>();
  for (const source of copy) {
    survivingAfterScores.set(`s${source.index}`, source.snippets.filter((s) => s.kept).length);
  }

  // 步 7 后半（02-04）：拷贝上按 is_primary 播种跑跨源 dup 与新颖度（would 链与
  // on 链共用同一实现，无平行实现）；计数走一次性载体不污染正本 stats.local
  const noveltyStats: FilterStats = { ...stats, local: { ...zeroLocal } };
  const jevSideDeletions = applyNovelty(copy, judged, 'on', thresholds, noveltyStats);

  const throwawayStats: FilterStats = { ...stats, local: { ...zeroLocal } };
  dropEmptySources(copy, throwawayStats, queryTerms, jevSideDeletions);

  const wouldDrop: string[] = [];
  let wouldRemoveSnippets = 0;
  for (const source of copy) {
    const id = `s${source.index}`;
    if (source.verdict === 'drop') {
      if (source.reason !== undefined && WOULD_DROP_REASONS.has(source.reason)) {
        wouldDrop.push(id);
      } else if (
        source.reason === 'empty' &&
        (survivingBeforeJev.get(id) ?? 0) > 0 &&
        (survivingAfterScores.get(id) ?? 0) === 0
      ) {
        // 被 Jev 片段删除间接清空：本地规则后有片段幸存、score 删光后被步 8 丢
        wouldDrop.push(id);
      }
    }
    wouldRemoveSnippets += source.snippets.filter(
      (snippet) => !snippet.kept && snippet.reason === 'score'
    ).length;
  }
  // novelty / 跨源 dup 的删除数从一次性载体取（片段上的 reason 'dup' 与步 3
  // 页内去重同键，按片段行数统计会混入本地删除）
  wouldRemoveSnippets +=
    noveltyStats.local.novelty_removed + noveltyStats.local.cross_source_dup_removed;

  return { would_drop: wouldDrop, would_remove_snippets: wouldRemoveSnippets };
};

/**
 * Jev 候选集收集（02-01）：对输入跑一遍本地规则层（步 1–4），收集幸存来源与其
 * 幸存片段。重录 dump（`dev/dump_local_rules.ts`）与管道步 5 共用同一候选口径——
 * 录好的答案因此与生产 state 逐源逐片段对齐（02-02 起两口径统一走
 * `jevCandidatesFromTable`）。
 *
 * 纯函数：`buildWorkTable` 建工作表、一次性 stats 只作步 1–4 计数载体（用后即弃，
 * 不返回）、不改输入。
 */
export function collectJevCandidates(
  data: BraveLlmContextResponse,
  request: { params: FilterRequest; intent: string },
  config: FilterConfig
): JevCandidate[] {
  const table = buildWorkTable(data);
  const stats = createFilterStats('off', toStatsRequest(request, config), data);
  runLocalRules(table, stats, contentTerms(request.params.query, request.intent), config);

  return jevCandidatesFromTable(table);
}
