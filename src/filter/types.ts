/**
 * 过滤库的结构类型，不依赖宿主或 MCP 类型。
 * Brave 字段与日志键使用 snake_case，库内部字段使用 camelCase。
 */

/**
 * 合法模式仅 off/test/on；其他值告警并回退 off。
 * off 只跑本地规则；test/on 共用实际 Jev 过滤链，test 额外保存样本。
 */
export type FilterMode = 'off' | 'test' | 'on';

/**
 * 过滤调用上下文。retrievalTime 由宿主在 Brave 请求前捕获，同次搜索和重试共用。
 * 它不进入公开 MCP 参数或 Brave 查询；非法或缺失时省略，不取当前时间补值。
 */
export type FilterCallContext = {
  params: FilterRequest;
  intent: string;
  /** 宿主捕获的检索时间；未提供或非法时省略 state 字段 */
  retrievalTime?: string;
};

/** 库关心的 Brave 查询参数；intent 独立携带，不能转发给 Brave。 */
export type FilterRequest = {
  query: string;
  /** 模型要的来源上限；缺省按 Brave 默认 20 */
  maximum_number_of_urls?: number;
  /** 模型要的总 token 上限；缺省按 Brave 默认 8192 */
  maximum_number_of_tokens?: number;
  maximum_number_of_tokens_per_url?: number;
  /** Brave freshness 参数（pd/pw/pm/py）；缺省不传——统计表按条件 spread 省略键 */
  freshness?: string;
  /** Brave context_threshold_mode（'disabled'|'strict'|'lenient'|'balanced'）；缺省不传 */
  context_threshold_mode?: string;
};

/**
 * 单一配置文件的解析结果，校验规则见 config.ts。
 * toolDescriptionFile 指向仓库外描述覆盖文件。
 */
export type FilterConfig = {
  mode: FilterMode;
  /** 生效的 Jev 阈值；坏值逐项回落 DEFAULT_THRESHOLDS。 */
  thresholds: JevThresholds;
  /** Jev 模型、单次尝试超时与实例并发上限；请求组织和时间上下文没有开关。 */
  jev: {
    model: string;
    timeoutMs: number;
    concurrency: number;
  };
  /** JSONL 日志目录；开头的 `~` 已在解析时展开为本机 home */
  logDir: string;
  /** 工具描述覆盖文件路径；未配置时缺省（用仓库内英文描述） */
  toolDescriptionFile?: string;
};

/** 分类器注入点；缺省时 test/on 记 no_key 并使用本地链。 */
export type FilterDeps = {
  classify?: ClassifyDeps['classify'];
};

/**
 * 本地阶段 1–2 后的候选来源，ID 保留 s{Brave 原始索引}，片段取当前幸存文本。
 * brave_page_date 始终存在；来源无合法日期时为 null。
 */
export type JevCandidate = {
  id: string;
  url: string;
  title: string;
  snippets: string[];
  /** 统一页级日期线索；无日期时为 null，键恒在 */
  brave_page_date: string | null;
};

/**
 * 片段配对身份：原始 index 和可选 JSON-LD part（格式：`{index}[.{part}]`）。
 * 与统计表的同名字段对应。
 */
export type JevCandidateSnippetIdentity = { key: string; text: string };

/**
 * 带片段身份的候选，用于构造请求映射。
 * bravePageDate 是内部字段，对应 state 中的 brave_page_date。
 */
export type JevCandidateDetailed = {
  id: string;
  url: string;
  title: string;
  snippets: JevCandidateSnippetIdentity[];
  /** 统一页级日期线索；无日期时为 null，键恒在 */
  bravePageDate: string | null;
};

// Jev 契约类型由客户端、上下文构造器与管道共用。

/**
 * 单道题：noul 是来源级是/否判定，choice 是片段组合题。
 * choice 的 criteria 是选项标签到 null 的映射，标签按位掩码序生成（none, A, B, AB …）。
 */
export type JevQuestion =
  | { type: 'noul'; instructions: string }
  | { type: 'choice'; instructions: string; criteria: Record<string, null> };

/**
 * 共享请求上下文：sources 按 Brave 原序放入全部候选，不包含预筛删除的内容。
 * sources[i] 的 i 是数组位置，不是来源 ID 中的原始索引。
 * 每来源带 brave_page_date；合法检索时间放在顶层 retrieval_time，否则省略。
 */
export type JevState = {
  query: string;
  intent: string;
  sources: JevCandidate[];
  /** 检索时间（宿主捕获的合法值；缺失或非法时省略，同一搜索全路径同值） */
  retrieval_time?: string;
};

/** 库内答案：noul 为概率，choice 为完整选项概率分布（键为选项标签）。 */
export type JevAnswer =
  | { kind: 'noul'; probability: number }
  | { kind: 'choice'; choice?: string; probabilities: Record<string, number> };

/** 逐片段保留概率判断（本地从 choice 概率分布派生，不是模型原始 score）。 */
export type SnippetJudgment = { kind: 'keep_probability'; value: number };

/** 逐片段判断数组：与实发片段位置等长，null 表示无可用答案，不压缩、不左移。 */
export type SnippetJudgments = Array<SnippetJudgment | null>;

/**
 * choice 概率分布的本地无效原因。形状问题（非对象、非有限、越界值）在客户端解析层
 * 已隔离为缺答；投影层只区分缺答、标签不符与概率和偏离。
 */
export type ChoiceInvalidReason = 'missing' | 'labels' | 'sum';

/** 来源内组合组定义：连续片段 [start, start+size) 组成一道 choice 题。 */
export type JevSnippetGroup = {
  /** 局部题键：`group{start}` */
  key: string;
  /** 组内首个片段在候选中的位置 */
  start: number;
  /** 组大小（1–3） */
  size: number;
  /** 组内各片段位置对应的选项字母（A 起，与片段位置对齐） */
  letters: string[];
};

/** 失败分类；具体重试与熔断策略由客户端处理。 */
export type ClassifyFailKind =
  | 'timeout'
  | 'rate_limited'
  | 'auth'
  | 'validation'
  | 'network'
  | 'breaker_open';

/** 客户端在 fetch 调用处捕获的请求载荷，同次重试复用；消费方不得改写。 */
export type JevDispatchPayload = {
  /** 实发 state（请求派发处的真实发送内容） */
  state: JevState;
  /** 实发题目集合（与 state 一同构成请求体） */
  questions: Record<string, JevQuestion>;
};

/**
 * 分类器返回成功答案或 failed 联合。
 * fetch 已调用时携带 dispatch，包含已派发后失败的请求；熔断短路不带。
 * 派发不保证服务端收到或处理。
 */
export type ClassifyOutcome = (
  | {
      status: 'answered';
      model: string;
      answers: Record<string, JevAnswer>;
      input_tokens: number;
      /** 实发载荷，语义见 JevDispatchPayload。 */
      dispatch?: JevDispatchPayload;
      /** 真实 HTTP 尝试次数，含重试；注入桩省略时按未知处理。 */
      http_attempts?: number;
    }
  | {
      status: 'failed';
      kind: ClassifyFailKind;
      detail?: string;
      /** 已派发但失败时仍保留输入证据。 */
      dispatch?: JevDispatchPayload;
      /** 真实 HTTP 尝试次数；未派发的短路（breaker_open）为 0 */
      http_attempts?: number;
      /** 即使判断失败，仍保留各次响应已知用量之和。 */
      input_tokens?: number;
    }
) & {
  /** 所有 HTTP 尝试均取得用量才为 true；部分已知时 input_tokens 只是已知小计。 */
  usage_complete?: boolean;
  /** 最后一个取得正文的 HTTP 响应状态；没有响应时省略。 */
  http_status?: number;
};

/** 注入的传输实现负责超时、重试、熔断与并发闸。 */
export type ClassifyDeps = {
  classify(req: {
    state: JevState;
    questions: Record<string, JevQuestion>;
  }): Promise<ClassifyOutcome>;
};

/** 三项 Jev 阈值（库内部 camelCase；默认值与出处见 questions.ts 的 `DEFAULT_THRESHOLDS`）。 */
export type JevThresholds = {
  fillerDrop: number;
  groupKeepMin: number;
  singleKeepMin: number;
};

/** per_source 失败种类；熔断短路另用 status `'breaker_open'` 表达，不重复计。 */
export type JevFailKind = Exclude<ClassifyFailKind, 'breaker_open'>;

/** 逐来源 Jev 统计，只含身份、概率、分数、计数与标记，不含正文。 */
export type JevPerSourceStats = {
  /** 探测约定 id：`s{braveIndex}`（与回放夹具 `results` 键同源） */
  src: string;
  url: string;
  status: 'answered' | 'failed' | 'skipped' | 'breaker_open';
  /** 失败种类；answered 也可能带 validation，表示收到响应但来源裁决无效。 */
  fail_kind?: JevFailKind;
  /** 来源题概率，键随当次题库（现行只有 filler）；读取历史记录时允许额外旧键。 */
  answers?: Record<string, number>;
  /** 逐片段保留概率，与实发片段序等长；null 表示无可用答案，不压缩 */
  snippet_judgments?: SnippetJudgments;
  /** 组合题无效原因（局部组键 → 原因）；无效组覆盖的片段保守保留 */
  snippet_validation?: Record<string, ChoiceInvalidReason>;
  /** 来源级裁决。 */
  verdict?: 'keep' | 'drop';
  reason?: SourceDropReason;
  /** 临界规则删除时携带的实际补偿距离（含 0）；原判定删除不带此键。 */
  near_threshold_gap?: number;
  model?: string;
  input_tokens?: number;
  latency_ms?: number;
  /** 所属逻辑请求 ID；共享请求覆盖的来源引用同一值，未构造请求时省略。 */
  request_id?: string;
};

/** 请求级记录里的来源与题目映射条目（§4.2 显式映射）。 */
export type JevRequestMappingEntry = {
  /** 探测约定 id：`s{braveIndex}` */
  source_id: string;
  /** 该来源在请求 state 里的位置：`state.sources` 数组下标 */
  array_index: number;
  /** 候选片段配对身份（与 JevDispatchRecord.snippet_keys 同源同序） */
  snippet_keys: string[];
  /** 局部题键（filler、group{start}）→ 请求级全局题键 */
  question_keys: Record<string, string>;
  /** 实发组合组定义（与 question_keys 的组键对应，按起始位置升序） */
  snippet_groups: JevSnippetGroup[];
};

/**
 * 请求级完整记录，仅供样本保存，不进入 FilterStats 或 JSONL。
 * dispatched、answered、usage_complete 是独立事实；已派发失败仍保留载荷。
 * input_tokens 是各次响应的已知小计，全部未知才为 null；
 * usage_complete 表示所有 HTTP 尝试均取得用量。
 */
export type JevRequestRecord = {
  /** 本次搜索内唯一请求 ID（`j1`、`j2` …按派发顺序分配） */
  request_id: string;
  /** 覆盖的来源 ID（按 state.sources 数组序） */
  source_ids: string[];
  /** 是否已派发（fetch 已调用；breaker_open / 防御短路一律 false） */
  dispatched: boolean;
  /** 实发 state（客户端派发处捕获，含已派发但失败的请求）；未派发为 null */
  state: JevState | null;
  /** 实发题目集合（与 state 一同构成请求体）；未派发为 null */
  questions: Record<string, JevQuestion> | null;
  /** 是否收到可解析响应（HTTP 200 且 answers 形状校验通过） */
  answered: boolean;
  /** 服务端回报的模型版本（answered 时） */
  model?: string;
  /** 各次响应的已知用量之和；全部未知才为 null。 */
  input_tokens: number | null;
  /** 所有 HTTP 尝试的用量是否均已取得。 */
  usage_complete: boolean;
  /** 最后一个取得正文的 HTTP 响应状态。 */
  http_status?: number;
  /** 真实 HTTP 尝试次数（含重试）；客户端未提供时省略，绝不伪称 */
  http_attempts?: number;
  /** 逻辑请求耗时（毫秒，含重试与退避的 classify 全程） */
  latency_ms: number;
  /** 失败分类（failed 时） */
  fail_kind?: ClassifyFailKind;
  /** 解析后的原始答案，键为请求级全局题键（answered 时） */
  answers?: Record<string, JevAnswer>;
  /** 来源与题目映射（构造成功即带，含未派发的规划结果） */
  mapping: JevRequestMappingEntry[];
};

/** JevStats.requests 的无正文摘要，仅保留请求身份与计数。 */
export type JevRequestSummary = Omit<
  JevRequestRecord,
  'state' | 'questions' | 'answers' | 'mapping' | 'model'
>;

/** 状态行与 JSONL 共用的 Jev 汇总统计。 */
export type JevStats = {
  /**
   * 至少派发一次的逻辑请求数；多个来源共享一次请求只计 1。
   * 零候选、熔断短路或无派发证据的回答不计请求。
   */
  n_requests: number;
  input_tokens: number;
  /** 逻辑请求耗时之和（每次 classify 全程），不冒充整个过滤阶段的墙钟耗时 */
  latency_ms_total: number;
  status: 'ok' | 'no_key' | 'degraded' | 'breaker_open';
  per_source: JevPerSourceStats[];
  /** 全部请求的真实 HTTP 尝试总数（含重试；与 n_requests 分开记） */
  n_http_attempts: number;
  /** 按请求顺序排列的无正文摘要。 */
  requests: JevRequestSummary[];
};

/** 整源删除原因。 */
export type SourceDropReason = 'empty' | 'filler';

/** 片段删除原因。 */
export type SnippetRemovalReason =
  | 'jsonld_meta'
  | 'nav'
  | 'boilerplate'
  | 'dup'
  | 'keep_probability'
  | 'time_mismatch';

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
  snippets_prefiltered: number;
  dup_removed: number;
  empty_dropped: number;
  /** GitHub 清洗动作总数，包含清空片段的动作；与逐片段 github_cleanup 明细对应。 */
  github_cleanup_actions: number;
  /** X 清洗动作总数，包含清空片段的动作；与逐片段 x_cleanup 明细对应。 */
  x_cleanup_actions: number;
  /** dev.to 目录提纲清理动作数；与逐片段 devto_cleanup 明细对应。 */
  devto_cleanup_actions: number;
};

/** GitHub 清洗动作规则名。 */
export type GitHubCleanupRule =
  | 'repo_nav'
  | 'copy_branch_button'
  | 'search_block'
  | 'tag_compare'
  | 'reactions_unavailable'
  | 'pr_uh_oh'
  | 'compare_commit_menu'
  | 'pr_loading_placeholder'
  | 'repo_topics'
  | 'about_echo';

/**
 * GitHub 清洗动作，仅记录规则与进入清洗时的片段行号，不含正文。
 * 行号对应进入清洗时的文本。
 */
export type GitHubCleanupAction = {
  rule: GitHubCleanupRule;
  /** 命中行号（1 起） */
  line: number;
  /** 行内局部剥除（按钮或菜单后缀，保留分支与提交标识）；整行删除省略 */
  partial?: boolean;
};

/** cleanGitHubBoilerplate 的返回：清洗后文本（未命中为原文本）与逐动作清单。 */
export type GitHubCleanupResult = {
  text: string;
  actions: GitHubCleanupAction[];
};

/**
 * X (Twitter) 清洗动作规则名。
 */
export type XCleanupRule = 'show_more_button' | 'related_trending_heading' | 'auth_sidebar_card';

/**
 * X 清洗动作，仅记录规则与进入清洗时的片段行号，不含正文。
 */
export type XCleanupAction = {
  rule: XCleanupRule;
  /** 命中行号（1 起） */
  line: number;
};

/** cleanXBoilerplate 的返回：清洗后文本（未命中为原文本）与逐动作清单。 */
export type XCleanupResult = {
  text: string;
  actions: XCleanupAction[];
};

/** dev.to 的整片清理动作，不使用 JSON 字符串内部的行号。 */
export type DevToCleanupAction = {
  rule: 'article_outline';
};

/** cleanDevToBoilerplate 的返回：清洗后文本与整片动作清单。 */
export type DevToCleanupResult = {
  text: string;
  actions: DevToCleanupAction[];
};

/** 逐片段裁决统计，仅含身份、标记与字符数。 */
export type SnippetStats = {
  index: number;
  /** JSON-LD 转出的多段用 part 区分，同一 index 下 0..k */
  part?: number;
  kept: boolean;
  reason?: SnippetRemovalReason;
  /**
   * test/on 的 GitHub 清洗明细；整片清空或局部剥离均可带此键。
   * 可选字段，读取旧记录时允许缺失。
   */
  github_cleanup?: GitHubCleanupAction[];
  /**
   * test/on 的 X 清洗明细；整片清空或局部剥离均可带此键。
   */
  x_cleanup?: XCleanupAction[];
  /** test/on 的 dev.to 整片清理明细。 */
  devto_cleanup?: DevToCleanupAction[];
  /** 临界规则删除时携带的实际补偿距离（含 0）；原判定删除不带此键。 */
  near_threshold_gap?: number;
  chars: number;
};

/** 统计表里单个来源的裁决；按 Brave 原序、带原始索引。 */
export type SourceStats = {
  index: number;
  url: string;
  title: string;
  hostname?: string;
  verdict: 'keep' | 'drop';
  reason?: SourceDropReason;
  snippets: SnippetStats[];
};

/** Brave 原始规模统计。 */
export type BraveStats = {
  n_sources: number;
  n_snippets: number;
  chars: number;
  /** 宿主测得的 Brave 请求耗时，单位毫秒。 */
  latency_ms?: number;
};

/** 过滤后输出规模统计。 */
export type OutputStats = {
  n_sources: number;
  n_snippets: number;
  chars: number;
  status_line?: string;
};

/**
 * 状态行与 JSONL 共用的统计对象。off 的 jev 为 null，test/on 由阶段 3 Jev 填充。
 */
export type FilterStats = {
  mode: FilterMode;
  request: {
    query: string;
    intent: string;
    max_urls: number;
    max_tokens: number;
    per_url_tokens?: number;
    /** Brave freshness 参数；请求未带时省略。 */
    freshness?: string;
    /** Brave context_threshold_mode；请求未带时省略。 */
    context_threshold_mode?: string;
  };
  brave: BraveStats;
  local: LocalStats;
  sources: SourceStats[];
  jev: JevStats | null;
  output: OutputStats;
};

/** `filterLlmContext` 的返回：过滤后的响应加统计对象。 */
export type FilterResult = {
  result: FilteredResponse;
  stats: FilterStats;
  /**
   * 每个 keep 来源的派发证据，按 Brave 原序排列；off / no_key 为空表。
   * 样本直接使用它，不重新运行本地规则构造。
   */
  jev_dispatch: JevDispatchRecord[];
  /**
   * 一次搜索零条或一条带载荷的逻辑请求记录，供样本保存。
   * 不进入 FilterStats 或 JSONL；off / no_key 为空表。
   */
  jev_requests: JevRequestRecord[];
};

/**
 * 来源与共享请求的对应关系、片段身份及保留概率判断，通过 request_id 关联完整载荷。
 * 派发、响应和逐片段有效性分别记录；无内容可发与熔断未发分别标记。
 */
export type JevDispatchRecord = {
  /** 探测约定 id：`s{braveIndex}`（与 per_source.src 同源） */
  src: string;
  url: string;
  title: string;
  /**
   * 所属逻辑请求 ID（jev_requests 中的 request_id）；构造出请求即带——含规划后
   * 未派发的请求（熔断短路等），此时按 not_dispatched_reason 解释
   */
  request_id?: string;
  /** 来源在 state.sources 中的数组位置，不能与 src 中的原始索引混用。 */
  array_index?: number;
  /**
   * 请求是否已派发（fetch 已调用；不保证服务端已收到或已处理——重试、断连、
   * 非零退出都可能发生）。breaker_open / skipped 一律 false。
   */
  dispatched: boolean;
  /** 是否收到可解析响应；来源裁决是否有效另见 source_verdict_valid。 */
  answered: boolean;
  /**
   * 逐片段保留概率（与候选片段位置等长，null 表示无可用答案）。
   * 未派发或未收到可解析响应时为 null。
   */
  snippet_judgments: SnippetJudgments | null;
  /**
   * 来源级裁决有效：从 applySourceVerdicts 完成后的真实裁决读取；页面题通过
   * 校验且已产生裁决，不是 validation 兜底。
   */
  source_verdict_valid: boolean;
  /** 未派发原因；已派发时省略。防御分支（classify 契约外 reject）也省略 */
  not_dispatched_reason?: 'skipped' | 'breaker_open';
  /** 候选片段配对身份（`{index}`、多段加 `.{part}`），与实发 state 片段按位置对齐 */
  snippet_keys: string[];
  /** 候选口径片段文本（与 snippet_keys 对齐） */
  snippet_texts: string[];
};
