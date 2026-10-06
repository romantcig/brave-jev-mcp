/**
 * 七阶段过滤管道与输出重建。
 * 各阶段在保留原始身份的工作表上标记裁决或替换文本，最后按表序重建输出。
 * test 与 on 共用实际 Jev 裁决链；off 使用本地链，幸存来源与片段保持 Brave 原序。
 */

import { parseFilterConfigObject } from './config.js';
import { splitJsonFragment } from './jsonld.js';
import { BOILERPLATE_PREFIXES } from './markers.js';
import { isEmptySource } from './nonArticle.js';
import { stripBoilerplateLines } from './prefilter.js';
import { cleanGitHubBoilerplate } from './githubCleanup.js';
import { cleanXBoilerplate } from './xCleanup.js';
import { cleanDevToBoilerplate } from './devtoCleanup.js';
import { buildContextRequest, projectSourceAnswers } from './jev/context.js';
import { applySnippetJudgments, applySourceVerdicts } from './jev/verdict.js';
import { buildStatusLine } from './statusline.js';
import {
  BRAVE_DEFAULT_MAX_TOKENS,
  BRAVE_DEFAULT_MAX_URLS,
  createFilterStats,
  createNoKeyJevStats,
  summarizeOutput,
} from './stats.js';
import { normalizeRetrievalTime, selectPageDate } from './temporal.js';
import type {
  BraveLlmContextGenericItem,
  BraveLlmContextResponse,
  ClassifyDeps,
  ClassifyOutcome,
  FilterCallContext,
  FilterConfig,
  FilterDeps,
  FilteredResponse,
  FilterResult,
  FilterStats,
  DevToCleanupAction,
  GitHubCleanupAction,
  XCleanupAction,
  JevCandidateDetailed,
  JevDispatchRecord,
  JevPerSourceStats,
  JevQuestion,
  JevRequestRecord,
  JevSnippetGroup,
  JevStats,
  JevState,
  JevThresholds,
  SnippetRemovalReason,
  SnippetStats,
  SourceDropReason,
  SourceMetadata,
  SourceStats,
} from './types.js';

/** 输出元数据的日期前缀匹配，不用于 Jev 页面日期的有效性判断。 */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}/;

/** 工作表里的一条片段。`chars` 不单独存，投影到统计表时按当前文本算。 */
type WorkSnippet = {
  index: number;
  part?: number;
  text: string;
  kept: boolean;
  reason?: SnippetRemovalReason;
  /** 阶段 2 GitHub 界面清洗的动作明细（test/on 生效）；投影到统计表 github_cleanup */
  githubCleanup?: GitHubCleanupAction[];
  /** 阶段 2 X (Twitter) 界面清洗的动作明细（test/on 生效）；投影到统计表 x_cleanup */
  xCleanup?: XCleanupAction[];
  /** 阶段 1 dev.to 目录提纲清理（test/on 生效），在通用 JSON-LD 转换前判定。 */
  devtoCleanup?: DevToCleanupAction[];
  /** 阶段 5 临界规则删除时携带的实际补偿距离（含 0）；原判定删除不带。 */
  nearThresholdGap?: number;
};

/** 工作表里的一个来源。`url` 永远是 Brave 原始 URL。 */
type WorkSource = {
  index: number;
  url: string;
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
 * 阶段 1 先清理 dev.to 目录提纲（仅 test/on），再逐源逐片段进行通用 JSON-LD 分流。
 * 转出的多段原地占据原片段位置（同一 `index`、`part` 从 0 递增），不重排；
 * 整片删的只翻 `kept`，片段行仍留在表里供统计投影。普通文本不计数。
 */
const splitJsonLd = (table: WorkSource[], stats: FilterStats, cleanPlatform: boolean): void => {
  for (const source of table) {
    const originalTexts = source.snippets.map((snippet) => snippet.text);
    source.snippets = source.snippets.flatMap((snippet, index): WorkSnippet[] => {
      if (!snippet.kept) return [snippet];

      if (cleanPlatform) {
        const cleaned = cleanDevToBoilerplate(
          snippet.text,
          source.url,
          source.title,
          originalTexts.filter((_, otherIndex) => otherIndex !== index)
        );
        if (cleaned.actions.length > 0) {
          stats.local.devto_cleanup_actions += cleaned.actions.length;
          stats.local.snippets_prefiltered += 1;
          return [
            { ...snippet, kept: false, reason: 'boilerplate', devtoCleanup: cleaned.actions },
          ];
        }
      }

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

/**
 * 阶段 2 固定顺序：样板行剥离。
 * 样板剥离内部依次为 GitHub / X 清洗、前缀行、标题重复行；平台清洗仅 test/on 应用。
 * 空片段和样板删除合计入 snippets_prefiltered。
 */
const prefilterSnippets = (
  table: WorkSource[],
  stats: FilterStats,
  cleanPlatform: boolean
): void => {
  for (const source of table) {
    if (source.verdict !== 'keep') continue;

    const survivorTexts: string[] = [];
    for (const snippet of source.snippets) {
      if (!snippet.kept) continue;

      // 空串或纯空白：直接删（nav），不进样板剥离以外的任何判定
      if (snippet.text.trim() === '') {
        snippet.kept = false;
        snippet.reason = 'nav';
        stats.local.snippets_prefiltered += 1;
        continue;
      }

      // GitHub 清洗：样板行剥离阶段内的专门子步，
      // 位于通用前缀/标题/引用剥离之前——先剥平台专属界面行，剩余文本再走通用
      // 子步。清空的 About 回声记 dup，其余记 boilerplate；动作明细进统计表。
      if (cleanPlatform) {
        const github = cleanGitHubBoilerplate(snippet.text, source.url, survivorTexts);
        if (github.actions.length > 0) {
          snippet.githubCleanup = github.actions;
          stats.local.github_cleanup_actions += github.actions.length;
          if (github.text === '') {
            snippet.kept = false;
            const duplicate = github.actions.some((action) => action.rule === 'about_echo');
            snippet.reason = duplicate ? 'dup' : 'boilerplate';
            if (duplicate) stats.local.dup_removed += 1;
            else stats.local.snippets_prefiltered += 1;
            continue;
          }
          snippet.text = github.text;
        }

        const xClean = cleanXBoilerplate(snippet.text, source.url);
        if (xClean.actions.length > 0) {
          snippet.xCleanup = xClean.actions;
          stats.local.x_cleanup_actions += xClean.actions.length;
          if (xClean.text === '') {
            snippet.kept = false;
            snippet.reason = 'boilerplate';
            stats.local.snippets_prefiltered += 1;
            continue;
          }
          snippet.text = xClean.text;
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

      survivorTexts.push(snippet.text);
    }
  }
};

/**
 * 阶段 6 删除空来源：所有片段被前序步骤剥光的来源。
 * 删除只更新工作表标记，不移除行。
 * 删除归因为 empty，并计入 empty_dropped。
 */
const dropEmptySources = (table: WorkSource[], stats: FilterStats): void => {
  for (const source of table) {
    if (source.verdict !== 'keep') continue;

    const surviving = source.snippets.filter((snippet) => snippet.kept);
    if (!isEmptySource(surviving)) continue;

    source.verdict = 'drop';
    source.reason = 'empty';
    stats.local.empty_dropped += 1;
  }
};

/**
 * 本地阶段 1–2：dev.to 目录提纲清理与 JSON-LD 分流 → 片段预筛。
 * 候选导出与实际过滤共用此顺序。
 */
const runLocalRules = (table: WorkSource[], stats: FilterStats, config: FilterConfig): void => {
  splitJsonLd(table, stats, config.mode !== 'off'); // 阶段 1：站点提纲清理与 JSON-LD 分流
  prefilterSnippets(table, stats, config.mode !== 'off'); // 阶段 2：片段预筛
};

/**
 * 精简元数据，只保留字符串 title / hostname 和首个日期前缀匹配的 age。
 * 无匹配日期时省略 age，非对象输入返回空对象；不修改入参。
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
    ...(snippet.githubCleanup !== undefined ? { github_cleanup: snippet.githubCleanup } : {}),
    ...(snippet.xCleanup !== undefined ? { x_cleanup: snippet.xCleanup } : {}),
    ...(snippet.devtoCleanup !== undefined ? { devto_cleanup: snippet.devtoCleanup } : {}),
    ...(snippet.nearThresholdGap !== undefined
      ? { near_threshold_gap: snippet.nearThresholdGap }
      : {}),
    chars: snippet.text.length,
  }));

  return {
    index: source.index,
    url: source.url,
    title: source.title,
    ...(hostname !== undefined ? { hostname } : {}),
    verdict: source.verdict,
    ...(source.reason !== undefined ? { reason: source.reason } : {}),
    snippets,
  };
};

/**
 * 管道跑完后把工作表的最终裁决与输出规模写回统计对象。
 * `output.*` 由 summarizeOutput 从工作表算（幸存片段 `String.length` 之和）。
 */
const finalizeStats = (stats: FilterStats, table: WorkSource[]): void => {
  stats.sources = table.map(projectSource);
  stats.output = summarizeOutput(table);
};

/** 把适配行传入的请求归一成统计表的 `request` 摘要，上限缺省填 Brave 默认值。 */
const toStatsRequest = (request: FilterCallContext): FilterStats['request'] => {
  const { params } = request;
  return {
    query: params.query,
    intent: request.intent,
    max_urls: params.maximum_number_of_urls ?? BRAVE_DEFAULT_MAX_URLS,
    max_tokens: params.maximum_number_of_tokens ?? BRAVE_DEFAULT_MAX_TOKENS,
    ...(params.maximum_number_of_tokens_per_url !== undefined
      ? { per_url_tokens: params.maximum_number_of_tokens_per_url }
      : {}),
    // 可选请求字段仅在有值时记录，省略与显式 undefined 在对象比较中不同。
    ...(params.freshness !== undefined ? { freshness: params.freshness } : {}),
    ...(params.context_threshold_mode !== undefined
      ? { context_threshold_mode: params.context_threshold_mode }
      : {}),
  };
};

/**
 * 过滤入口：接收已通过宿主校验的 Brave 响应，返回过滤结果、统计与派发记录。
 * 网络只发生在注入的 classify 中；缺省配置为 off，本函数不读配置文件或环境。
 * test/on 共用 Jev 链，缺少 classify 时记 no_key 并使用本地链。
 * request.retrievalTime 来自宿主发起 Brave 请求前的取时，非法或缺失时省略，不补当前时间。
 */
export async function filterLlmContext(
  data: BraveLlmContextResponse,
  request: FilterCallContext,
  config: FilterConfig = parseFilterConfigObject({}),
  deps?: FilterDeps
): Promise<FilterResult> {
  const table = buildWorkTable(data);
  const stats = createFilterStats(config.mode, toStatsRequest(request), data);
  // 阶段 3 填充派发证据，off / no_key 保持空表。
  let dispatches: JevDispatchRecord[] = [];
  // 请求级记录每次逻辑调用一条，off / no_key 保持空表。
  let requests: JevRequestRecord[] = [];

  runLocalRules(table, stats, config);
  if (config.mode === 'off') {
    // off：整段跳过 Jev（stats.jev 保持 null），只跑本地链
    runOffChain(table, stats);
  } else if (deps?.classify === undefined) {
    // 缺少分类器时走本地链，幸存内容保持 Brave 原序。
    stats.jev = createNoKeyJevStats();
    runOffChain(table, stats);
  } else {
    // 阶段 3 Jev 请求派发：非空候选组织一次全量共享请求（§3.1）——test 与 on 共用
    // 此分支；裁决消费与记账形状完全一致
    const judged = await runJevStage(table, request, deps.classify, stats, config);
    dispatches = judged.dispatches;
    requests = judged.requests;
    // 组映射按来源 ID 索引，供片段裁决按组大小选择门槛；映射与请求构造同源。
    const groupsBySource = new Map<string, readonly JevSnippetGroup[]>();
    for (const record of judged.requests) {
      for (const entry of record.mapping) {
        groupsBySource.set(entry.source_id, entry.snippet_groups);
      }
    }
    runOnChain(table, judged.rows, groupsBySource, config.thresholds, stats);
    // 来源裁决完成后再记有效性，复用实际校验结果；非裁决题缺答不应冒充校验失败。
    for (const record of dispatches) {
      const row = judged.rows.get(record.src);
      record.source_verdict_valid =
        row?.status === 'answered' && row.verdict !== undefined && row.fail_kind !== 'validation';
    }
  }
  const result = rebuildOutput(table, data);
  finalizeStats(stats, table);
  // 状态行必须在 finalizeStats 后写入，后者会整体替换 stats.output。
  stats.output.status_line = buildStatusLine(stats);

  return { result, stats, jev_dispatch: dispatches, jev_requests: requests };
}

/**
 * 片段身份：原片段 index + 可选 JSON-LD part（格式：`{index}[.{part}]`）。
 * 与统计表的身份字段同源，用于样本配对。
 */
const snippetKeyOf = (snippet: WorkSnippet): string =>
  `${snippet.index}${snippet.part !== undefined ? `.${snippet.part}` : ''}`;

/**
 * 收集 keep 且仍有片段的来源，ID 为 s{原始索引}，文本取工作表当前值。
 * 候选与片段均按 Brave 原序，只读工作表。
 * 页面日期直接对每个来源调用 selectPageDate(source.meta)。
 */
const jevCandidatesFromTable = (table: WorkSource[]): JevCandidateDetailed[] => {
  const candidates: JevCandidateDetailed[] = [];
  for (const source of table) {
    if (source.verdict !== 'keep') continue;
    const surviving = source.snippets.filter((snippet) => snippet.kept);
    if (surviving.length < 1) continue;
    const snippets = surviving.map((snippet) => ({
      key: snippetKeyOf(snippet),
      text: snippet.text,
    }));
    const bravePageDate = selectPageDate(source.meta);
    candidates.push({
      id: `s${source.index}`,
      url: source.url,
      title: source.title,
      snippets,
      bravePageDate,
    });
  }
  return candidates;
};

/**
 * 阶段 3：零候选不调用 Jev，非空候选共用一次请求；并发和重试由客户端负责。
 * 按显式映射投影答案，失败来源保守保留，空来源记 skipped。
 * requests 保存完整载荷，stats 只存无正文摘要；派发、回答和用量完整性分别记账。
 * 返回逐来源裁决 rows、来源派发证据 dispatches 和请求记录 requests。
 */
const runJevStage = async (
  table: WorkSource[],
  request: FilterCallContext,
  classify: ClassifyDeps['classify'],
  stats: FilterStats,
  config: FilterConfig
): Promise<{
  rows: Map<string, JevPerSourceStats>;
  dispatches: JevDispatchRecord[];
  requests: JevRequestRecord[];
}> => {
  // 检索时间归一一次（§3.1）：合法值进 state.retrieval_time，缺失或非法省略——
  // 同一搜索的请求与重试共用同一值，绝不隐式读取系统时间（回放必须显式携带日志原 ts）
  const retrievalTime = normalizeRetrievalTime(request.retrievalTime);
  const jev: JevStats = {
    n_requests: 0,
    input_tokens: 0,
    latency_ms_total: 0,
    status: 'ok',
    per_source: [],
    n_http_attempts: 0,
    requests: [],
  };
  // 候选需携带原片段身份和当前文本，供派发记录配对。
  const candidates = jevCandidatesFromTable(table);

  // 先按表序为 keep 来源建立 skipped 占位，再覆盖候选来源。
  // Map 插入顺序保留 Brave 原序；无内容可发与有候选但熔断未发分别记录。
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
        snippet_judgments: null,
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
    snippet_judgments: null,
    source_verdict_valid: false,
    snippet_keys: candidate.snippets.map((snippet) => snippet.key),
    snippet_texts: candidate.snippets.map((snippet) => snippet.text),
  });

  // 一次搜索零条或一条逻辑请求记录。
  const requestRecords: JevRequestRecord[] = [];
  let requestSeq = 0;
  const nextRequestId = (): string => `j${(requestSeq += 1)}`;

  /**
   * 计时并独立记录回答、派发与用量完整性，分别汇总逻辑请求和 HTTP 尝试。
   * classify 意外 reject 时按网络失败处理；没有 dispatch 证据不虚记请求。
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
      // 请求已派发（fetch 已调用；含已派发但失败）——实发载荷只信这里；
      // n_requests 仅在此计一（§3.3：无 dispatch 的 answered 计零请求）
      record.dispatched = true;
      record.state = outcome.dispatch.state;
      record.questions = outcome.dispatch.questions;
      jev.n_requests += 1;
    }
    if (outcome.status === 'answered') {
      record.answered = true;
      record.model = outcome.model;
      record.answers = outcome.answers;
    } else {
      // 未派发短路（breaker_open）：零 fetch 不计 n_requests；注入面契约外 reject
      // 无派发证据同样不计——绝不冒充实发
      record.fail_kind = outcome.kind;
    }
    if (outcome.input_tokens !== undefined) {
      record.input_tokens = outcome.input_tokens;
      jev.input_tokens += outcome.input_tokens;
    }
    // 用量完整性只信 outcome 的如实回报；缺少信息按不完整处理，不由 answered 推定
    record.usage_complete = outcome.usage_complete ?? false;
    if (outcome.http_status !== undefined) record.http_status = outcome.http_status;
    if (outcome.http_attempts !== undefined) {
      record.http_attempts = outcome.http_attempts;
      jev.n_http_attempts += outcome.http_attempts;
    }
    return outcome;
  };

  if (candidates.length > 0) {
    // 唯一请求构造器（§3.1）：完整候选数组进同一次共享请求；构造结果与检索时间
    // 即本次搜索的固定请求身份，重试属于同一逻辑请求
    const { state, questions, entries } = buildContextRequest(
      candidates,
      request.params.query,
      request.intent,
      retrievalTime
    );
    const record: JevRequestRecord = {
      request_id: nextRequestId(),
      source_ids: entries.map((entry) => entry.source_id),
      dispatched: false,
      state: null,
      questions: null,
      answered: false,
      input_tokens: null,
      usage_complete: false,
      latency_ms: 0,
      mapping: entries,
    };
    requestRecords.push(record);
    const outcome = await runRequest(record, state, questions);

    if (outcome.status === 'answered') {
      // 按显式映射分配全量答案，不能用键序、URL 或压缩位置猜来源。
      for (const entry of entries) {
        const candidate = candidates.find((item) => item.id === entry.source_id);
        if (candidate === undefined) continue; // 映射与候选同源，防御分支
        const projected = projectSourceAnswers({
          snippetCount: entry.snippet_keys.length,
          groups: entry.snippet_groups,
          answerAt: (key) => outcome.answers[entry.question_keys[key]],
        });
        rows.set(entry.source_id, {
          src: entry.source_id,
          url: candidate.url,
          status: 'answered',
          answers: projected.answers,
          snippet_judgments: projected.judgments,
          ...(projected.invalidGroups !== undefined
            ? { snippet_validation: projected.invalidGroups }
            : {}),
          // 请求用量和耗时只记一次，通过 request_id 关联，避免按来源重复累计。
          // model 留在来源行中供日志去重。
          model: outcome.model,
          request_id: record.request_id,
        });
        dispatchMap.set(entry.source_id, {
          ...dispatchBase(candidate),
          request_id: record.request_id,
          array_index: entry.array_index,
          // 生产分类器只要 answered 必然已派发，恒记 true
          dispatched: true,
          answered: true,
          snippet_judgments: projected.judgments,
        });
      }
    } else if (outcome.dispatch !== undefined) {
      // 已派发但失败（网络 / 超时 / 4xx / 5xx）：覆盖来源记未完成 Jev 判断，
      // 不拆成逐来源请求；已派发失败不可能是熔断短路（零 fetch），但 TS 无法从
      // dispatch 收窄 kind，显式排除
      for (const entry of entries) {
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
    } else {
      // 未派发失败：契约内只有熔断短路（派发前，零 HTTP）；契约外 reject 映射的
      // network 原因未知——省略 not_dispatched_reason，不伪造派发证据
      for (const entry of entries) {
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
  }
  // 零候选：零次 Jev 逻辑调用与 HTTP（占位行已全部 skipped，requests 保持空表）

  jev.per_source = [...rows.values()];
  jev.status = jev.per_source.some((row) => row.status === 'breaker_open')
    ? 'breaker_open'
    : jev.per_source.some((row) => row.status === 'failed')
      ? 'degraded'
      : 'ok';
  // 日志只存无正文请求摘要，完整载荷交给样本。
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
  // 占位与覆盖流程保证每个 keep 来源都有记录，按插入序输出。
  const dispatches = [...rows.values()].map((row) => dispatchMap.get(row.src)!);
  return { rows, dispatches, requests: requestRecords };
};

/**
 * test/on 共用：阶段 4 来源裁决 → 阶段 5 片段保留概率裁决 → 阶段 6 删除空来源。
 * 裁决实际修改工作表，统计同步回写；组映射提供组大小以选择片段门槛。
 */
const runOnChain = (
  table: WorkSource[],
  judged: ReadonlyMap<string, JevPerSourceStats>,
  groupsBySource: ReadonlyMap<string, readonly JevSnippetGroup[]>,
  thresholds: JevThresholds,
  stats: FilterStats
): void => {
  applySourceVerdicts(table, judged, thresholds, stats);
  applySnippetJudgments(table, judged, groupsBySource, thresholds, stats);
  dropEmptySources(table, stats);
};

/** off 或缺少 classify 时：执行阶段 6 删除空来源。 */
const runOffChain = (table: WorkSource[], stats: FilterStats): void => {
  dropEmptySources(table, stats);
};

/**
 * 跑本地阶段 1–2 后收集带身份候选，供开发冒烟与请求构造核对。
 * 不修改输入；实际样本使用客户端派发证据，不在保存时重新调用此函数。
 */
export function collectJevCandidatesDetailed(
  data: BraveLlmContextResponse,
  request: FilterCallContext,
  config: FilterConfig
): JevCandidateDetailed[] {
  const table = buildWorkTable(data);
  const stats = createFilterStats('off', toStatsRequest(request), data);
  runLocalRules(table, stats, config);

  return jevCandidatesFromTable(table);
}
