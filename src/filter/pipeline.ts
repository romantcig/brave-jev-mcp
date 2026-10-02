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
 * （指纹新颖度与跨源逐字去重，实现在 novelty.ts）；步 10（状态行）在 Phase 3 落地。
 * 04-01 起单链化：test 与 on 共用同一条 Jev 过滤链（runJevStage + runOnChain，裁决
 * 真实生效），off 短路走本地链；旧影子双链（would 层、shadow_diff / shadow_evidence）
 * 退役，历史字段仅为读旧记录保留。
 *
 * 依据：PLAN.md §3.2、notes/local-rules-design.md、04-CONTEXT.md「模式与兼容」、
 * 测试模式与搜索样本记录实施计划.md 第二节。
 */

import { parseFilterConfigObject } from './config.js';
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
import { cleanGitHubBoilerplate } from './githubCleanup.js';
import { buildQuestions, buildState } from './jev/questions.js';
import { planAllRequest, projectSourceAnswers, snippetCountOfState } from './jev/context.js';
import { applySnippetScores, applySourceVerdicts } from './jev/verdict.js';
import { applyNovelty, type JevSideDeletionFlags } from './jev/novelty.js';
import { canonicalizeUrl, mergeByCanonicalUrl } from './url.js';
import { buildStatusLine } from './statusline.js';
import { contentTerms, shingles, tokenize } from './tokenize.js';
import { estimateTokens } from './tokens.js';
import { createFilterStats, createNoKeyJevStats } from './stats.js';
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
  GitHubCleanupAction,
  JevCandidate,
  JevCandidateDetailed,
  JevDispatchRecord,
  JevFallbackReason,
  JevPerSourceStats,
  JevQuestion,
  JevRequestMode,
  JevRequestRecord,
  JevStats,
  JevState,
  JevThresholds,
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
  /** 步 3 GitHub 界面清洗的动作明细（test/on 生效）；投影到统计表 github_cleanup */
  githubCleanup?: GitHubCleanupAction[];
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
 * 步 3 片段预筛（含付费墙截断）：顺序固定为付费墙截断 → 样板行剥离（GitHub 界面
 * 清洗 → 前缀行 → 标题重复行 → 引用块，GitHub 子步仅 test/on 生效、off 不应用——
 * 清洗属 Jev 过滤链的文本准备，见 stripBoilerplateLines 与 githubCleanup.ts）→
 * 短且无实词 → 页内逐字重复（RULES-03/ordering）。被删片段留在原位只翻 `kept`；
 * 重复判定按原序只与同来源内**已幸存**片段比，保留先出现者。`snippets_prefiltered`
 * 记 nav 与 boilerplate 两类之和，`dup_removed` 单独记，`paywall_truncated` 只记
 * 截断后保留的，`github_cleanup_actions` 记 GitHub 清洗动作数（清洗后为空的片段
 * 整片删走 boilerplate 语义）。
 */
const prefilterSnippets = (
  table: WorkSource[],
  stats: FilterStats,
  terms: ReadonlySet<string>,
  cleanGitHub: boolean
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

      // GitHub 平台界面行清洗（filter-rules-9）：样板行剥离阶段内的专门子步，
      // 位于通用前缀/标题/引用剥离之前——先剥平台专属界面行，剩余文本再走通用
      // 子步。清洗后为空按既有 boilerplate 整片删语义处理；动作明细进统计表。
      if (cleanGitHub) {
        const github = cleanGitHubBoilerplate(snippet.text, source.url);
        if (github.actions.length > 0) {
          snippet.githubCleanup = github.actions;
          stats.local.github_cleanup_actions += github.actions.length;
          if (github.text === '') {
            snippet.kept = false;
            snippet.reason = 'boilerplate';
            stats.local.snippets_prefiltered += 1;
            continue;
          }
          snippet.text = github.text;
        }
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
 * 黑名单，方向保守）。host 规范化不包含端口；栏目规则另检查原始 URL 路径。
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
    if (isBlocklisted(host, config.blocklist, source.url)) {
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
  // 步 3 片段预筛：付费墙截断 → 样板剥离（GitHub 清洗仅 test/on）→ 短无实词 →
  // 页内逐字重复（顺序固定）
  prefilterSnippets(table, stats, terms, config.mode !== 'off');
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
    ...(snippet.githubCleanup !== undefined ? { github_cleanup: snippet.githubCleanup } : {}),
    ...(snippet.mergedFrom !== undefined ? { merged_from: snippet.mergedFrom } : {}),
    chars: snippet.text.length,
  }));

  return {
    index: source.index,
    url: source.url,
    title: source.title,
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
    // D-10：请求带 freshness / context_threshold_mode 才记键——条件 spread 省略
    // undefined（deepEqual 把显式 undefined 键判不等），照 per_url_tokens 先例
    ...(params.freshness !== undefined ? { freshness: params.freshness } : {}),
    ...(params.context_threshold_mode !== undefined
      ? { context_threshold_mode: params.context_threshold_mode }
      : {}),
    overfetch_factor: config.overfetchFactor,
  };
};

/**
 * 过滤层入口：Brave 响应 + 请求 → 过滤后的响应 + 统计对象。
 *
 * 自 02-02 起异步（步 5 要 `await` 注入的 classify），仍不发任何网络请求——
 * 网络只发生在注入的 classify 实现里。`config` 省略时取全默认（不读文件、不看
 * 环境——配置载体是单一 JSON 文件，读一次的责任在适配行）。
 * 模式分叉（04-01 单链语义）：off 整段跳过 Jev（`stats.jev` 保持 null）；test 与
 * on 注入 classify 后**共用同一条过滤链**——runJevStage 并发派发（步 5）接
 * runOnChain（步 6 → 步 7 → 步 8），裁决真实生效，不维护两套实现；未注入 classify
 * 时记 no_key 零值对象且零请求（SAFE-01 语义前置）。调用方不 `await` 会在 tsc 处
 * 报类型错——tsx 不查类型，`npm run build` 是唯一漏改闸（Pitfall 1）。
 *
 * @param data Brave LLM Context 响应（已过上游 zod 校验）
 * @param request `params` 是 `RequestParamsSchema.parse` 的结果，`intent` 单独携带
 * @param config 过滤配置；省略时为全默认配置（mode off）
 * @param deps Phase 2 注入点：`classify` 缺省时 on/test 记 no_key
 * @returns `{ result, stats }` 的 Promise；`result` 与输入同形，`stats` 是本次调用新建的对象
 */
export async function filterLlmContext(
  data: BraveLlmContextResponse,
  request: { params: FilterRequest; intent: string },
  config: FilterConfig = parseFilterConfigObject({}),
  deps?: FilterDeps
): Promise<FilterResult> {
  const table = buildWorkTable(data);
  const stats = createFilterStats(config.mode, toStatsRequest(request, config), data);
  // 步 8 只看 query 实词（步 3 已用 query ∪ intent 过滤过）
  const queryTerms = contentTerms(request.params.query);
  // 实发派发记录（04-04 R1）：Jev 分支由步 5 填充，off / no_key 保持空表
  let dispatches: JevDispatchRecord[] = [];
  // 请求级记录（六题全量上下文，计划 §6.1）：每逻辑请求一条，off / no_key 空表
  let requests: JevRequestRecord[] = [];

  runLocalRules(table, stats, contentTerms(request.params.query, request.intent), config);
  if (config.mode === 'off') {
    // off：整段跳过 Jev（stats.jev 保持 null），只跑本地链
    runOffChain(table, undefined, config.thresholds, stats, queryTerms);
  } else if (deps?.classify === undefined) {
    // no_key（on/test 未注入 classify）：全部来源未判定 → 无论证段保护、去重同
    // Brave 原序（PLAN §3.2 明文设计，用户已定决策 3——off 期望文件的重标注是
    // 设计意图不是回归；no_key 等价 off 口径，SAFE-01 前置语义）
    stats.jev = createNoKeyJevStats();
    runOffChain(table, undefined, config.thresholds, stats, queryTerms);
  } else {
    // 步 5 Jev 请求派发：按 config.jev.contextMode 选择 single / all 组织（计划 §3）
    // ——test 与 on 共用此分支；裁决消费与记账形状完全一致
    const judged = await runJevStage(table, request, deps.classify, stats, config);
    dispatches = judged.dispatches;
    requests = judged.requests;
    runOnChain(table, judged.rows, config.thresholds, stats, queryTerms);
    // 来源裁决完成后再记有效性，复用实际校验结果；非裁决题缺答不应冒充校验失败。
    for (const record of dispatches) {
      const row = judged.rows.get(record.src);
      record.source_verdict_valid =
        row?.status === 'answered' && row.verdict !== undefined && row.fail_kind !== 'validation';
    }
  }
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
  const result = rebuildOutput(table, data);
  finalizeStats(stats, table);
  // 步 10 状态行：从最终统计对象投影（D-01..D-08）。落点必须在 finalizeStats
  // 之后——它整体替换 stats.output，写在之前会被吞掉（03-RESEARCH Pitfall 1）。
  stats.output.status_line = buildStatusLine(stats);

  return { result, stats, jev_dispatch: dispatches, jev_requests: requests };
}

/**
 * 片段配对身份（04-02 样本映射用）：`{merged_from}:{index}` 前缀可省（无并入来源），
 * JSON-LD 多段加 `.{part}`——与统计表 SnippetStats 的 index/part/merged_from 同源，
 * 与旧证据类型的 snippetKey 同格式。
 */
const snippetKeyOf = (snippet: WorkSnippet): string =>
  `${snippet.mergedFrom !== undefined ? `${snippet.mergedFrom}:` : ''}${snippet.index}` +
  `${snippet.part !== undefined ? `.${snippet.part}` : ''}`;

/** 带身份候选 → 纯文本候选（探测/重录与步 5 派发的既有消费形状）。 */
const toPlainCandidates = (detailed: JevCandidateDetailed[]): JevCandidate[] =>
  detailed.map(({ id, url, title, snippets }) => ({
    id,
    url,
    title,
    snippets: snippets.map((snippet) => snippet.text),
  }));

/**
 * 工作表 → Jev 候选集：`verdict === 'keep'` 且幸存片段 ≥ 1 的来源。`id` 取
 * `s{source.index}`（与探测脚本 `s0..s11` 约定一致），`url` / `title` 用工作表
 * 原值，`snippets` 取幸存片段的当前文本（含步 1 转出的多段与步 2 并入的片段）
 * 及其配对身份，顺序即表序（Brave 原序）。只读表，不翻标记、不重排（RULES-08）。
 */
const jevCandidatesFromTable = (table: WorkSource[]): JevCandidateDetailed[] => {
  const candidates: JevCandidateDetailed[] = [];
  for (const source of table) {
    if (source.verdict !== 'keep') continue;
    const snippets = source.snippets
      .filter((snippet) => snippet.kept)
      .map((snippet) => ({ key: snippetKeyOf(snippet), text: snippet.text }));
    if (snippets.length < 1) continue;
    candidates.push({ id: `s${source.index}`, url: source.url, title: source.title, snippets });
  }
  return candidates;
};

/**
 * 步 5：Jev 请求派发，按配置 `config.jev.contextMode` 选择请求组织
 * （FULL_CONTEXT_ROLLOUT_PLAN §3）：single 逐来源一次请求、全候选一波并发
 * （Promise.allSettled——管道编排层不持进程级状态与限流；进程级并发闸按
 * Responsibility Map 由 02-05 的 `createJevClassifier` 闭包持有并消费
 * `config.jev.concurrency`，本处不建双闸）；all 全候选共享一次逻辑请求。两者只在
 * 请求组织与证据映射处分支，步 6–10 的裁决链不复制（runOnChain 消费同一 rows 形状）。
 *
 * 回退规则（计划 §3 表格）：all 且零候选 → 零请求；单候选 → 走 single
 * （single_candidate）；规划双限额超限 → 整批回退 single（同一批冻结候选，不重新
 * 预筛，over_budget）；客户端防御在派发前拒绝（too_large 未派发）→ 单次回退 single
 * （client_too_large），不递归；熔断短路 → 零 HTTP，全部来源行记 breaker_open，
 * 不回退。已派发后的网络失败**不**自动放大成一批 single 请求（§5.2）。
 *
 * 记账口径（SAFE-01/JEV-04/计划 §6.1）：
 * - `n_requests` = 实际至少派发一次的逻辑分类请求数（answered 或已派发后失败各计
 *   一）；无候选、预检拒绝（未派发 too_large）、熔断短路不虚记。N 来源一次全量
 *   请求记 1，绝不冒充 N 次 HTTP；
 * - `n_http_attempts` = 全部请求的真实 fetch 次数（含重试），与 n_requests 分开记；
 * - `latency_ms_total` = 逻辑请求耗时之和（每次 classify 全程），不冒充过滤阶段
 *   墙钟耗时；
 * - answered → per_source 记六题概率与 snippet_scores、model、input_tokens、
 *   request_id；failed 且非熔断短路 → 记 fail_kind；失败来源什么都不动（按"留"，
 *   SAFE-01）；keep 但幸存片段为 0 的来源 → per_source 记 'skipped' 且无请求。
 * - 请求级完整事实（实发载荷、映射、答案、预算）在 `requests`，经
 *   FilterResult.jev_requests 交样本层；stats.jev.requests 只留无正文摘要（LOG-03）。
 *
 * @returns `{ rows, dispatches, requests }`：rows 为逐源 judged 结果映射（键 = src
 * id `s{index}`）——步 6/7 的裁决消费入口；dispatches 为来源级派发证据（每 keep
 * 来源一条、按表序）；requests 为请求级记录（按派发顺序，single N 条 / all 1 条）。
 */
const runJevStage = async (
  table: WorkSource[],
  request: { params: FilterRequest; intent: string },
  classify: ClassifyDeps['classify'],
  stats: FilterStats,
  config: FilterConfig
): Promise<{
  rows: Map<string, JevPerSourceStats>;
  dispatches: JevDispatchRecord[];
  requests: JevRequestRecord[];
}> => {
  const jev: JevStats = {
    n_requests: 0,
    input_tokens: 0,
    latency_ms_total: 0,
    status: 'ok',
    per_source: [],
    n_http_attempts: 0,
    requests: [],
  };
  // 带身份候选（04-04 R1）：派发记录需要片段配对身份与候选口径文本，plain 形状给不出
  const candidates = jevCandidatesFromTable(table);

  // 先按表序给每个 keep 来源立 skipped 占位行，候选来源派发后覆盖——per_source
  // 天然保持 Brave 原序（RULES-08），顺序由 Map 的插入序保证；无候选的来源
  // （本地规则删光、未调 Jev）预置 skipped 派发记录（04-04 R1：与候选来源的
  // "未派发"区分开——skipped 是无内容可发，too_large / breaker_open 是有内容没发）
  const rows = new Map<string, JevPerSourceStats>();
  const dispatchMap = new Map<string, JevDispatchRecord>();
  const candidateIds = new Set(candidates.map((candidate) => candidate.id));
  for (const source of table) {
    if (source.verdict !== 'keep') continue;
    const src = `s${source.index}`;
    rows.set(src, { src, url: source.url, status: 'skipped' });
    if (!candidateIds.has(src)) {
      dispatchMap.set(src, {
        src,
        url: source.url,
        title: source.title,
        dispatched: false,
        answered: false,
        snippet_score_validity: null,
        snippet_scores_received: null,
        source_verdict_valid: false,
        not_dispatched_reason: 'skipped',
        snippet_keys: [],
        snippet_texts: [],
      });
    }
  }

  /** 一条来源级派发记录的公共投影（src/url/title/候选身份与文本，派发与否都带）。 */
  const dispatchBase = (candidate: JevCandidateDetailed): JevDispatchRecord => ({
    src: candidate.id,
    url: candidate.url,
    title: candidate.title,
    dispatched: false,
    answered: false,
    snippet_score_validity: null,
    snippet_scores_received: null,
    source_verdict_valid: false,
    snippet_keys: candidate.snippets.map((snippet) => snippet.key),
    snippet_texts: candidate.snippets.map((snippet) => snippet.text),
  });

  // 请求级记录（计划 §6.1）：每逻辑请求一条、按派发顺序；ID 在本次搜索内唯一
  const requestRecords: JevRequestRecord[] = [];
  let requestSeq = 0;
  const nextRequestId = (): string => `j${(requestSeq += 1)}`;

  /**
   * 一次 classify 调用与请求级账目的公共路径（single / all 共用）：计时、实发载荷
   * 捕获、answered / dispatched / usage_complete 独立记、n_requests 与
   * n_http_attempts 汇总。classify 契约是返回 failed 而非 reject；真 reject 按
   * 网络失败记账（防御注入面），此时无实发载荷。
   */
  const runRequest = async (
    record: JevRequestRecord,
    state: JevState,
    questions: Record<string, JevQuestion>
  ): Promise<ClassifyOutcome> => {
    const startedAt = Date.now();
    let outcome: ClassifyOutcome;
    try {
      outcome = await classify({ state, questions });
    } catch {
      outcome = { status: 'failed', kind: 'network' };
    }
    record.latency_ms = Date.now() - startedAt;
    jev.latency_ms_total += record.latency_ms;

    if (outcome.dispatch !== undefined) {
      // 请求已派发（fetch 已调用；含已派发但失败）——实发载荷只信这里
      record.dispatched = true;
      record.state = outcome.dispatch.state;
      record.questions = outcome.dispatch.questions;
    }
    if (outcome.status === 'answered') {
      record.answered = true;
      record.model = outcome.model;
      record.answers = outcome.answers;
      jev.n_requests += 1;
    } else {
      record.fail_kind = outcome.kind;
      if (outcome.dispatch !== undefined) {
        // 已派发但失败：真实消耗了一次逻辑调用（计入 n_requests）
        jev.n_requests += 1;
      }
      // 未派发短路（too_large / breaker_open）：预检拒绝不计 n_requests
    }
    if (outcome.input_tokens !== undefined) {
      record.input_tokens = outcome.input_tokens;
      jev.input_tokens += outcome.input_tokens;
    }
    record.usage_complete = outcome.usage_complete ?? outcome.status === 'answered';
    if (outcome.http_status !== undefined) record.http_status = outcome.http_status;
    if (outcome.http_attempts !== undefined) {
      record.http_attempts = outcome.http_attempts;
      jev.n_http_attempts += outcome.http_attempts;
    }
    return outcome;
  };

  const requestedMode = config.jev.contextMode;
  // single 回退原因（requested=all 时每个 single 请求携带；配置 single 恒 undefined）
  let singleFallbackReason: JevFallbackReason | undefined;
  let useAll = false;

  // —— all 组织（计划 §3 表格）：仅多候选且规划通过才发一次全量请求 ——
  if (requestedMode === 'all' && candidates.length > 1) {
    const planResult = planAllRequest(candidates, request.params.query, request.intent);
    if (planResult.ok) {
      useAll = true;
      const plan = planResult.plan;
      const record: JevRequestRecord = {
        request_id: nextRequestId(),
        mode: 'all',
        requested: 'all',
        effective: 'all',
        source_ids: plan.entries.map((entry) => entry.source_id),
        dispatched: false,
        state: null,
        questions: null,
        answered: false,
        input_tokens: null,
        usage_complete: false,
        latency_ms: 0,
        mapping: plan.entries,
        planned_estimates: plan.estimates,
      };
      requestRecords.push(record);
      const outcome = await runRequest(record, plan.state, plan.questions);

      if (outcome.status === 'answered') {
        // 投影（计划 §4.2）：按显式映射把全量答案分回各来源行，不按键序、URL 或
        // 压缩位置猜；全量无阶梯，实发片段范围即候选全长（仍从实发 state 防御读取）
        const sentQuestions = outcome.dispatch?.questions ?? plan.questions;
        const sentState = outcome.dispatch?.state;
        for (const entry of plan.entries) {
          const candidate = candidates.find((item) => item.id === entry.source_id);
          if (candidate === undefined) continue; // 映射与候选同源，防御分支
          const nSnippets = entry.snippet_keys.length;
          const sentStateSnippetCount =
            sentState !== undefined
              ? (snippetCountOfState(sentState, entry.array_index) ?? nSnippets)
              : nSnippets;
          const projected = projectSourceAnswers({
            sentStateSnippetCount,
            sentSnippets: nSnippets,
            localQuestionAt: (key) => plan.localQuestions[entry.source_id]?.[key],
            sentQuestionAt: (key) => sentQuestions[entry.question_keys[key]],
            answerAt: (key) => outcome.answers[entry.question_keys[key]],
          });
          rows.set(entry.source_id, {
            src: entry.source_id,
            url: candidate.url,
            status: 'answered',
            answers: projected.answers,
            ...(projected.snippetScores !== undefined
              ? { snippet_scores: projected.snippetScores }
              : {}),
            // 请求级维度（input_tokens / latency_ms）不逐来源复制（§6.1：N 行同值
            // 会被误加成 N 倍）——经 request_id 关联请求记录；model 保留供
            // model_reported 去重投影
            model: outcome.model,
            request_id: record.request_id,
          });
          dispatchMap.set(entry.source_id, {
            ...dispatchBase(candidate),
            request_id: record.request_id,
            array_index: entry.array_index,
            dispatched: outcome.dispatch !== undefined,
            answered: true,
            snippet_score_validity: projected.scoreValidity,
            snippet_scores_received: projected.scoresReceived,
          });
        }
      } else if (outcome.dispatch !== undefined) {
        // 已派发但失败（网络 / 超时 / 4xx / 5xx）：覆盖来源记未完成 Jev 判断，
        // 绝不自动放大成一批新的 single 请求（计划 §5.2）；已派发失败不可能是
        // 熔断短路（零 fetch），但 TS 无法从 dispatch 收窄 kind，显式排除
        for (const entry of plan.entries) {
          const candidate = candidates.find((item) => item.id === entry.source_id);
          if (candidate === undefined) continue;
          rows.set(entry.source_id, {
            src: entry.source_id,
            url: candidate.url,
            status: 'failed',
            ...(outcome.kind !== 'breaker_open' ? { fail_kind: outcome.kind } : {}),
            request_id: record.request_id,
          });
          dispatchMap.set(entry.source_id, {
            ...dispatchBase(candidate),
            request_id: record.request_id,
            array_index: entry.array_index,
            dispatched: true,
            answered: false,
          });
        }
      } else if (outcome.kind === 'too_large') {
        // 客户端防御在派发前拒绝（规划层已预检，正常不触达）：单次回退 single，
        // 同一批冻结候选；请求记录保留（未派发，fail_kind 如实）
        singleFallbackReason = 'client_too_large';
        useAll = false;
      } else {
        // 熔断短路（派发前）：零 HTTP，全部覆盖来源行记 breaker_open，不回退
        for (const entry of plan.entries) {
          const candidate = candidates.find((item) => item.id === entry.source_id);
          if (candidate === undefined) continue;
          rows.set(entry.source_id, {
            src: entry.source_id,
            url: candidate.url,
            status: outcome.kind === 'breaker_open' ? 'breaker_open' : 'failed',
            ...(outcome.kind !== 'breaker_open' ? { fail_kind: outcome.kind } : {}),
            request_id: record.request_id,
          });
          dispatchMap.set(entry.source_id, {
            ...dispatchBase(candidate),
            request_id: record.request_id,
            array_index: entry.array_index,
            dispatched: false,
            answered: false,
            ...(outcome.kind === 'breaker_open'
              ? { not_dispatched_reason: 'breaker_open' as const }
              : {}),
          });
        }
      }
    } else {
      // 规划双限额超限：整批回退 single（over_budget），不构造可发请求
      singleFallbackReason = 'over_budget';
    }
  } else if (requestedMode === 'all' && candidates.length === 1) {
    singleFallbackReason = 'single_candidate';
  }
  // 零候选 + all：零请求、不构造空题目请求，与 single 同态（占位行已全部 skipped）

  // —— single 组织：requested=single，或 all 的单候选 / 超限 / 防御回退 ——
  if (!useAll) {
    const dispatch = async (candidate: JevCandidateDetailed): Promise<void> => {
      const state = buildState(
        candidate.id,
        candidate.url,
        candidate.title,
        candidate.snippets.map((snippet) => snippet.text),
        request.params.query,
        request.intent
      );
      const questions = buildQuestions(state.source.snippets);
      const record: JevRequestRecord = {
        request_id: nextRequestId(),
        mode: 'single',
        requested: requestedMode,
        effective: 'single',
        ...(singleFallbackReason !== undefined ? { fallback_reason: singleFallbackReason } : {}),
        source_ids: [candidate.id],
        dispatched: false,
        state: null,
        questions: null,
        answered: false,
        input_tokens: null,
        usage_complete: false,
        latency_ms: 0,
        mapping: [
          {
            source_id: candidate.id,
            array_index: 0,
            snippet_keys: candidate.snippets.map((snippet) => snippet.key),
            // single 的局部键即请求级键（恒等映射）
            question_keys: Object.fromEntries(Object.keys(questions).map((key) => [key, key])),
          },
        ],
      };
      requestRecords.push(record);
      const outcome = await runRequest(record, state, questions);
      const latencyMs = record.latency_ms;

      const answered = outcome.status === 'answered';
      if (outcome.dispatch !== undefined || answered) {
        // 派发记录：生产客户端必带实发载荷（已派发）；注入面（重录回放 / 测试桩）
        // 的 answered 不带载荷——按"已取得回答但无实发证据"如实记（dispatched=false、
        // 载荷在请求级也为 null），answered 独立取自 outcome，绝不互相冒充（04-04 R1）
        const dispatchRecord = dispatchBase(candidate);
        dispatchRecord.request_id = record.request_id;
        dispatchRecord.array_index = 0;
        dispatchRecord.dispatched = outcome.dispatch !== undefined;
        dispatchRecord.answered = answered;
        if (outcome.status === 'answered') {
          const sentQuestions = outcome.dispatch?.questions ?? questions;
          // single 请求的实发 state 一定是单来源形状（联合收窄；客户端只可能
          // 原样返回该来源 state——阶梯砍尾只动 snippets 数组）
          const sentStateSnippetCount =
            outcome.dispatch !== undefined && 'source' in outcome.dispatch.state
              ? outcome.dispatch.state.source.snippets.length
              : candidate.snippets.length;
          const projected = projectSourceAnswers({
            sentStateSnippetCount,
            sentSnippets: outcome.sent_snippets ?? candidate.snippets.length,
            localQuestionAt: (key) => questions[key],
            sentQuestionAt: (key) => sentQuestions[key],
            answerAt: (key) => outcome.answers[key],
          });
          dispatchRecord.snippet_score_validity = projected.scoreValidity;
          dispatchRecord.snippet_scores_received = projected.scoresReceived;
          dispatchMap.set(candidate.id, dispatchRecord);

          rows.set(candidate.id, {
            src: candidate.id,
            url: candidate.url,
            status: 'answered',
            answers: projected.answers,
            ...(projected.snippetScores !== undefined
              ? { snippet_scores: projected.snippetScores }
              : {}),
            model: outcome.model,
            input_tokens: outcome.input_tokens,
            latency_ms: latencyMs,
            request_id: record.request_id,
            ...(outcome.ladder !== undefined ? { ladder: outcome.ladder } : {}),
            // 升降级生效时记录实际发送的片段数（04-02 样本映射对齐用；与 ladder 同
            // 条件出现——snippet_scores 缺失时它是对齐实发范围的唯一依据）
            ...(outcome.ladder !== undefined && outcome.sent_snippets !== undefined
              ? { sent_snippets: outcome.sent_snippets }
              : {}),
          });
        } else {
          dispatchMap.set(candidate.id, dispatchRecord);
        }
      } else {
        // 未派发：too_large（阶梯不可再砍）/ breaker_open（熔断短路）；防御分支
        // （契约外 reject 映射的 network）原因未知——省略 not_dispatched_reason
        const dispatchRecord = dispatchBase(candidate);
        dispatchRecord.request_id = record.request_id;
        dispatchRecord.array_index = 0;
        if (outcome.kind === 'too_large') {
          dispatchRecord.not_dispatched_reason = 'too_large';
        } else if (outcome.kind === 'breaker_open') {
          dispatchRecord.not_dispatched_reason = 'breaker_open';
        }
        dispatchMap.set(candidate.id, dispatchRecord);
      }

      if (answered) {
        // n_requests / input_tokens 已在 runRequest 记账
      } else if (outcome.kind === 'breaker_open') {
        // 熔断短路：不发真实请求，不计 n_requests（SAFE-02 记账口径）
        rows.set(candidate.id, {
          src: candidate.id,
          url: candidate.url,
          status: 'breaker_open',
          latency_ms: latencyMs,
          request_id: record.request_id,
        });
      } else {
        rows.set(candidate.id, {
          src: candidate.id,
          url: candidate.url,
          status: 'failed',
          fail_kind: outcome.kind,
          // 阶梯 ④（JEV-05）：too_large = 该来源不问 Jev，per_source 记 'skipped'
          ...(outcome.kind === 'too_large' ? { ladder: 'skipped' as const } : {}),
          latency_ms: latencyMs,
          request_id: record.request_id,
        });
      }
    };

    await Promise.allSettled(candidates.map(dispatch));
  }

  jev.per_source = [...rows.values()];
  jev.status = jev.per_source.some((row) => row.status === 'breaker_open')
    ? 'breaker_open'
    : jev.per_source.some((row) => row.status === 'failed')
      ? 'degraded'
      : 'ok';
  // 请求级摘要（无正文——LOG-03）：JSONL 只留身份、模式与计数，正文走样本
  jev.requests = requestRecords.map((record) => {
    const {
      state: _state,
      questions: _questions,
      answers: _answers,
      mapping: _mapping,
      model: _model,
      ...summary
    } = record;
    return summary;
  });
  stats.jev = jev;
  // 实发派发记录按表序（rows 插入序 = Brave 原序）输出：每个 keep 来源恰一条
  // （候选来源派发后覆盖、无候选来源预置 skipped）——不变式由上方构造保证，
  // 非空断言安全（llm_context 适配行 `filtered!` 同款先例）
  const dispatches = [...rows.values()].map((row) => dispatchMap.get(row.src)!);
  return { rows, dispatches, requests: requestRecords };
};

/**
 * on 链：步 6 来源级裁决 → 步 7 前半 score 删除 → 步 7 后半跨源 dup 与指纹新颖度
 * → 步 8 空来源/一句话来源。test 与 on 共用这一份实现（04-01 单链语义，不许写
 * 平行版本）；裁决真实生效——drop 的来源从输出消失、低分片段被删。
 *
 * `stats` 承载计数与 per_source 回写（test 与 on 的过滤统计一致）。
 */
const runOnChain = (
  table: WorkSource[],
  judged: ReadonlyMap<string, JevPerSourceStats>,
  thresholds: JevThresholds,
  stats: FilterStats,
  queryTerms: ReadonlySet<string>
): void => {
  applySourceVerdicts(table, judged, thresholds, stats);
  applySnippetScores(table, judged, thresholds, stats);
  const jevSideDeletions = applyNovelty(table, judged, thresholds, stats);
  dropEmptySources(table, stats, queryTerms, jevSideDeletions);
};

/**
 * off 链：步 7 后半（Brave 原序的跨源逐字去重与指纹新颖度）→ 步 8。off 模式与
 * no_key（on/test 未注入 classify）等价 off 口径时走这条链；test 与 on 的正式
 * 过滤走 runOnChain——两者不再共用一条链下的双分支（04-01 起旧影子正本路径退役）。
 */
const runOffChain = (
  table: WorkSource[],
  judged: ReadonlyMap<string, JevPerSourceStats> | undefined,
  thresholds: JevThresholds,
  stats: FilterStats,
  queryTerms: ReadonlySet<string>
): void => {
  const jevSideDeletions = applyNovelty(table, judged, thresholds, stats);
  dropEmptySources(table, stats, queryTerms, jevSideDeletions);
};

/**
 * Jev 候选集收集（02-01）：对输入跑一遍本地规则层（步 1–4），收集幸存来源与其
 * 幸存片段。重录 dump（`dev/dump_local_rules.ts`）与管道步 5 共用同一候选口径——
 * 录好的答案因此与生产 state 逐源逐片段对齐（02-02 起两口径统一走
 * `jevCandidatesFromTable`）。
 *
 * 纯函数：`buildWorkTable` 建工作表、一次性 stats 只作步 1–4 计数载体（用后即弃，
 * 不返回）、不改输入。04-02 v1 曾经 `collectJevCandidatesDetailed` 供样本层重建
 * 实发映射（片段配对身份只有工作表知道，字符串数组签名给不出）；04-04 R1 起样本层
 * 只信管道交来的 JevDispatchRecord，不再重建候选。
 */
export function collectJevCandidates(
  data: BraveLlmContextResponse,
  request: { params: FilterRequest; intent: string },
  config: FilterConfig
): JevCandidate[] {
  return toPlainCandidates(collectJevCandidatesDetailed(data, request, config));
}

/**
 * 带身份版候选集收集（04-02）：与 `collectJevCandidates` 完全同一口径（同一纯函数
 * 链、同一输入），只是片段带 `key` 配对身份（`{merged_from}:{index}` 前缀可省、
 * JSON-LD 多段加 `.{part}`）。04-02 v1 曾供样本层重建实发 state 映射；04-04 R1 起
 * 样本层只信管道交来的 JevDispatchRecord（重建会得到阶梯前 state，与实发不符），
 * 本函数无样本层消费方，除作内部 plain 版包装与候选口径核对备用外，开发冒烟脚本
 * （dev/full-context-smoke.mjs）也使用它构造带身份的候选并进行请求规划。
 */
export function collectJevCandidatesDetailed(
  data: BraveLlmContextResponse,
  request: { params: FilterRequest; intent: string },
  config: FilterConfig
): JevCandidateDetailed[] {
  const table = buildWorkTable(data);
  const stats = createFilterStats('off', toStatsRequest(request, config), data);
  runLocalRules(table, stats, contentTerms(request.params.query, request.intent), config);

  return jevCandidatesFromTable(table);
}
