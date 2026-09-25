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

/** 环境变量解析出的配置；`blocklist` 是黑名单文本解析出的规范 host 集合（01-03 追加）。 */
export type FilterConfig = {
  mode: FilterMode;
  /** 超量倍数，默认 1；>1 时只放大来源数与总 token */
  overfetchFactor: number;
  /** 步 4 的结构性农场黑名单；条目命中自身与全部子域 */
  blocklist: ReadonlySet<string>;
  /** 十一项 Jev 阈值；坏值逐项回落 `DEFAULT_THRESHOLDS`（EMBED-05），文件覆盖经 `resolveThresholds` */
  thresholds: JevThresholds;
  /** Jev 客户端配置：钉版模型、单后端（JEV-01）、超时纯兜底与进程级并发闸初值（02-05 消费） */
  jev: {
    model: string;
    backend: 'typesafe';
    timeoutMs: number;
    concurrency: number;
  };
};

/** Phase 2 注入 Jev 客户端的位置；`classify` 缺省时 on/shadow 记 no_key 零值对象（SAFE-01 前置）。 */
export type FilterDeps = {
  classify?: ClassifyDeps['classify'];
};

/**
 * Jev 候选集里的一条：本地规则层（步 1–4）后幸存的来源与其幸存片段。
 * `id` 用探测约定 `s{braveIndex}`（与 `.jev.json` 回放夹具的 `results` 键同源）；
 * `snippets` 是幸存片段的当前文本（含步 1 转出的多段与步 2 并入的片段），顺序即表序。
 * 重录 dump 与管道步 5 共用同一口径（02-01）。
 */
export type JevCandidate = {
  id: string;
  url: string;
  title: string;
  snippets: string[];
};

// ---------------------------------------------------------------------------
// Jev 契约类型（02-02）：全部住类型家，防循环导入——jev/ 与 pipeline 都从这里取。
// ---------------------------------------------------------------------------

/** 单道题：noul 是来源级是/否判定，score 是片段级三档打分（criteria 是三档 legend）。 */
export type JevQuestion = {
  type: 'noul' | 'score';
  instructions: string;
  criteria?: readonly string[];
};

/** 单来源 state：官方"context rot"规则——只放问题需要的东西，不放元数据与被删片段。 */
export type JevState = {
  query: string;
  intent: string;
  source: {
    id: string;
    url: string;
    title: string;
    snippets: string[];
  };
};

/**
 * 答案的库内统一形状：noul 读 0–1 概率，score 读连续分值（夹具实证 1.62/1.77，
 * 不是整数档位）。noul 没有 confidence 字段，绝不读（Pitfall 3）。
 */
export type JevAnswer = { kind: 'noul'; probability: number } | { kind: 'score'; score: number };

/** 超限阶梯的级别名（JEV-05；02-05 的 32k 阶梯落地时记账）。 */
export type JevLadderLevel = 'cut_tail' | 'source_only_questions' | 'skipped';

/** ClassifyOutcome 失败分支的 kind 全集；重试白名单与熔断语义由 02-05 的传输层裁决。 */
export type ClassifyFailKind =
  | 'timeout'
  | 'rate_limited'
  | 'auth'
  | 'validation'
  | 'network'
  | 'breaker_open'
  | 'too_large';

/**
 * classify 的返回：answered 带实际模型版本 ID 与 input_tokens（JEV-02），
 * failed 一律 union 不抛（单来源失败按"留"，SAFE-01）。
 */
export type ClassifyOutcome =
  | {
      status: 'answered';
      model: string;
      answers: Record<string, JevAnswer>;
      input_tokens: number;
      ladder?: JevLadderLevel;
    }
  | {
      status: 'failed';
      kind: ClassifyFailKind;
      detail?: string;
    };

/** 传输依赖：管道经 `FilterDeps.classify` 注入；实现持有超时/重试/熔断/并发闸（02-05 的 createJevClassifier）。 */
export type ClassifyDeps = {
  classify(req: {
    state: JevState;
    questions: Record<string, JevQuestion>;
  }): Promise<ClassifyOutcome>;
};

/** 十一项 Jev 阈值（库内部 camelCase；默认值与出处见 questions.ts 的 `DEFAULT_THRESHOLDS`）。 */
export type JevThresholds = {
  offTopicDrop: number;
  listingDrop: number;
  selfDeprecated: number;
  staleDrop: number;
  fillerDrop: number;
  reasoningProtect: number;
  snippetMin: number;
  minFacts: number;
  noveltyMin: number;
  cjkBonus: number;
  cjkShare: number;
};

/** per_source 失败种类；熔断短路另用 status `'breaker_open'` 表达，不重复计。 */
export type JevFailKind = Exclude<ClassifyFailKind, 'breaker_open'>;

/**
 * 统计表里单个来源的 Jev 记账；只存索引、概率、分数、计数与标记，绝不含片段正文
 * （LOG-03）——类型检查即证明。
 */
export type JevPerSourceStats = {
  /** 探测约定 id：`s{braveIndex}`（与回放夹具 `results` 键同源） */
  src: string;
  url: string;
  status: 'answered' | 'failed' | 'skipped' | 'breaker_open';
  /** status `'failed'` 时的失败种类 */
  fail_kind?: JevFailKind;
  /** 生效的超限降级级别（02-05 记账） */
  ladder?: JevLadderLevel;
  /** 来源级十题的 noul 概率（paywalled / rewrite / worth_keeping 也在内） */
  answers?: Record<string, number>;
  /** 片段 score，snip0..snipN 顺序，与 state 片段序对齐 */
  snippet_scores?: number[];
  /** on 链的裁决（02-03 落地；shadow 在 would 层记同一形状） */
  verdict?: 'keep' | 'drop';
  reason?: SourceDropReason;
  model?: string;
  input_tokens?: number;
  latency_ms?: number;
};

/** Jev 阶段的汇总记账（Phase 3 状态行与 JSONL 日志的共同来源）。 */
export type JevStats = {
  /** 实际发出的请求数（无候选 / 熔断短路不虚记） */
  n_requests: number;
  input_tokens: number;
  latency_ms_total: number;
  status: 'ok' | 'no_key' | 'degraded' | 'breaker_open';
  per_source: JevPerSourceStats[];
};

/** shadow 模式的 would 层记账（02-03 落地填充；off 与 on 恒为 null）。 */
export type ShadowDiff = {
  would_drop: string[];
  would_remove_snippets: number;
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
  /** 步 7 后半被事实指纹新颖度删除的片段数（02-04；只进计数，不含指纹内容——LOG-03） */
  novelty_removed: number;
  /** 步 7 后半被跨来源 5-gram 逐字重复删除的片段数（02-04；用户已定决策 5 的独立计数） */
  cross_source_dup_removed: number;
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
 * `jev`：off 模式保持 null（A16），on/shadow 由步 5 填充；`shadow_diff` 由 02-03 在
 * shadow 模式填充，off/on 恒为 null。
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
  jev: JevStats | null;
  output: {
    n_sources: number;
    n_snippets: number;
    chars: number;
    est_tokens: number;
    status_line?: string;
  };
  shadow_diff: ShadowDiff | null;
};

/** `filterLlmContext` 的返回：过滤后的响应加统计对象。 */
export type FilterResult = {
  result: FilteredResponse;
  stats: FilterStats;
};
