/**
 * 过滤层的结构类型。
 *
 * 这里是纯库对外的全部类型：库不引任何宿主模块，Brave 响应按结构重新声明，
 * zod 推导出的 `data` 结构兼容即可直接传入。字段命名规则：镜像 Brave 线上字段
 * 与要进 JSONL 日志的计数键用 snake_case，库内部自己的字段用 camelCase。
 *
 * 依据：PLAN.md §3.2、notes/shadow-mode-logging.md、01-RESEARCH.md「统计对象」一节。
 */

/** 三档模式：off 只跑本地规则；shadow 让 Jev 判断但不真丢；on 让 Jev 裁决生效。 */
export type FilterMode = 'off' | 'shadow' | 'on';

/**
 * 适配行从 `RequestParamsSchema.parse` 结果里传进来的查询参数。
 * 只声明库关心的字段；调用方对象带多余字段也能赋值。`intent` 不在这里——
 * 它不属于 Brave 查询参数（不能转发给 Brave），由 `filterLlmContext` 的
 * 第二个实参 `{ params, intent }` 单独携带。
 */
export type FilterRequest = {
  query: string;
  /** 模型要的来源上限；缺省按 Brave 默认 20 */
  maximum_number_of_urls?: number;
  /** 模型要的总 token 上限；缺省按 Brave 默认 8192 */
  maximum_number_of_tokens?: number;
  maximum_number_of_tokens_per_url?: number;
};

/** 环境变量解析出的配置；`blocklist` 字段由 01-03 计划追加。 */
export type FilterConfig = {
  mode: FilterMode;
  /** 超量倍数，默认 1；>1 时只放大来源数与总 token */
  overfetchFactor: number;
};

/** Phase 2 注入 Jev 客户端的位置；Phase 1 没有实现，只钉住形状。 */
export type FilterDeps = {
  classify?: unknown;
};

/** 来源被整体丢弃的原因。前五个 Phase 1 可产生，其余 Phase 2。 */
export type SourceDropReason =
  | 'feed'
  | 'blocklist'
  | 'empty'
  | 'budget'
  | 'merged'
  | 'off_topic'
  | 'listing'
  | 'self_deprecated'
  | 'stale'
  | 'filler'
  | 'rewrite';

/** 单个片段被移除的原因。前六个 Phase 1 可产生，其余 Phase 2。 */
export type SnippetRemovalReason =
  | 'jsonld_meta'
  | 'nav'
  | 'boilerplate'
  | 'dup'
  | 'paywall_empty'
  | 'budget'
  | 'score'
  | 'novelty';

/** `grounding.generic[]` 的一条：一个来源与它的片段。 */
export type BraveLlmContextGenericItem = {
  url: string;
  title: string;
  snippets: string[];
};

/** `sources` 表里一条元数据；Brave 会附带 site_name / favicon / thumbnail 等，统一按 unknown 容忍。 */
export type SourceMetadata = {
  title?: string;
  hostname?: string;
  /** 典型形状是四元数组：人类可读日期、ISO 日期、相对时间、ISO 时间戳；可能为空数组 */
  age?: string[];
  [k: string]: unknown;
};

/** Brave LLM Context 响应，按结构重新声明；`map` / `poi` 库不解读，原样透传。 */
export type BraveLlmContextResponse = {
  grounding: {
    generic: BraveLlmContextGenericItem[];
    map?: unknown;
    poi?: unknown;
  };
  sources: Record<string, SourceMetadata>;
};

/** 过滤后的响应：与输入同形，`sources` 每条已精简为 title / hostname / age。 */
export type FilteredResponse = {
  grounding: {
    generic: BraveLlmContextGenericItem[];
    map: unknown;
    poi?: unknown;
  };
  sources: Record<string, Record<string, unknown>>;
};

/** 本地规则层的计数器；全部从 0 起，随管道推进递增。 */
export type LocalStats = {
  jsonld_converted: number;
  jsonld_dropped: number;
  jsonld_kept_raw: number;
  url_merged: number;
  snippets_prefiltered: number;
  dup_removed: number;
  paywall_truncated: number;
  feed_hits: number;
  blocklist_hits: number;
  empty_dropped: number;
  budget_dropped_sources: number;
  budget_trimmed_snippets: number;
};

/** 统计表里单个片段的裁决；只有索引、标记与字符数，不含正文（LOG-03）。 */
export type SnippetStats = {
  index: number;
  /** JSON-LD 转出的多段用 part 区分，同一 index 下 0..k */
  part?: number;
  kept: boolean;
  reason?: SnippetRemovalReason;
  truncated?: boolean;
  /** 步 2 从同页来源并入的片段：原来源的 Brave 索引；此时 `index` 是它在原来源里的片段索引 */
  merged_from?: number;
  chars: number;
};

/** 统计表里单个来源的裁决；按 Brave 原序、带原始索引。 */
export type SourceStats = {
  index: number;
  url: string;
  canonical_url: string;
  hostname?: string;
  verdict: 'keep' | 'drop';
  reason?: SourceDropReason;
  snippets: SnippetStats[];
};

/**
 * 统计对象：Phase 3 的状态行与 JSONL 日志的共同来源，直接序列化即可。
 * `jev` 与 `shadow_diff` 在 Phase 1 恒为 null，Phase 2 填实。
 */
export type FilterStats = {
  mode: FilterMode;
  request: {
    query: string;
    intent: string;
    max_urls: number;
    max_tokens: number;
    per_url_tokens?: number;
    overfetch_factor: number;
  };
  brave: {
    n_sources: number;
    n_snippets: number;
    chars: number;
  };
  local: LocalStats;
  sources: SourceStats[];
  jev: null;
  output: {
    n_sources: number;
    n_snippets: number;
    chars: number;
    est_tokens: number;
    status_line?: string;
  };
  shadow_diff: null;
};

/** `filterLlmContext` 的返回：过滤后的响应加统计对象。 */
export type FilterResult = {
  result: FilteredResponse;
  stats: FilterStats;
};
