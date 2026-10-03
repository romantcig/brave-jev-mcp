/**
 * 过滤层的结构类型。
 *
 * 这里是纯库对外的全部类型：库不引任何宿主模块，Brave 响应按结构重新声明，
 * zod 推导出的 `data` 结构兼容即可直接传入。字段命名规则：镜像 Brave 线上字段
 * 与要进 JSONL 日志的计数键用 snake_case，库内部自己的字段用 camelCase。
 *
 * 依据：PLAN.md §3.2、notes/test-mode-logging.md、01-RESEARCH.md「统计对象」一节。
 */

/**
 * 三档模式（04-CONTEXT 模式与兼容节）：off 只跑本地规则、不调 Jev；test 本地规则
 * 与 Jev 共同过滤——与 on 共用同一过滤实现、裁决真实生效；on 是正式档。
 * 旧配置值 `shadow` 在解析层（config.ts）作为别名映射为 `test`，不进本类型。
 */
export type FilterMode = 'off' | 'test' | 'on';

/**
 * 过滤调用的内部上下文：`params` + `intent` + 可选检索时间。`retrievalTime` 由
 * 宿主在发起 Brave 请求前捕获一次（带时区 ISO 字符串，`localIsoWithOffset` 口径），
 * 经内部形状传入——不进公开 MCP schema、不混入发给 Brave 的查询参数；同一搜索的
 * all、single 回退与 HTTP 重试必须共用同一个值。时间上下文开关关闭、字段未提供
 * 或值非法时，管道省略 state 的时间字段（temporal.ts 的归一口径）。
 */
export type FilterCallContext = {
  params: FilterRequest;
  intent: string;
  /** 宿主捕获的检索时间；开关关闭或未提供 / 非法时省略 state 字段 */
  retrievalTime?: string;
};

/**
 * 适配行从 `RequestParamsSchema.parse` 结果里传进来的查询参数。
 * 只声明库关心的字段；调用方对象带多余字段也能赋值。`intent` 不在这里——
 * 它不属于 Brave 查询参数（不能转发给 Brave），由 `filterLlmContext` 的
 * 第二个实参（`FilterCallContext`）单独携带。
 */
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
 * 单个 JSON 配置文件解析出的配置（EMBED-05；字段与校验见 config.ts）。
 * `blocklist` 是黑名单文本解析出的规范 host 或页面/栏目 URL 集合；`logDir` 是 JSONL 日志目录
 * （Phase 3 消费，本批只解析）；`toolDescriptionFile` 是工具描述的仓库外覆盖文件。
 */
export type FilterConfig = {
  mode: FilterMode;
  /** 超量倍数，默认 1；>1 时只放大来源数与总 token */
  overfetchFactor: number;
  /** 步 4 的结构性农场黑名单；条目命中自身与全部子域（内置表与配置文件的并集） */
  blocklist: ReadonlySet<string>;
  /** 九项 Jev 阈值；坏值逐项回落 `DEFAULT_THRESHOLDS`（EMBED-05） */
  thresholds: JevThresholds;
  /** Jev 客户端配置：钉版模型、超时纯兜底、进程级并发闸初值（02-05 消费）、
   * 请求组织模式（四题全量上下文，FULL_CONTEXT_ROLLOUT_PLAN §3）与时间上下文
   * 开关（TEMPORAL_CONTEXT_SCORING_ROLLOUT_PLAN §3） */
  jev: {
    model: string;
    timeoutMs: number;
    concurrency: number;
    /** 请求组织：single 逐来源一次请求（默认）；all 全候选共享一次请求 */
    contextMode: JevRequestMode;
    /**
     * 时间上下文开关（配置键 `jev.temporal_context`，默认 false）：true 时 state
     * 携带 `retrieval_time` 与每来源 `brave_page_date`，all 模式片段改用冻结的
     * 时间上下文评分新题；false 精确保留旧请求形态与旧评分题（完整功能回退，
     * 关闭即恢复旧题与旧 state）。single（含 all 回退）沿用旧评分题，仅添加
     * 时间字段——单来源新题不在本次试运行范围。
     */
    temporalContext: boolean;
  };
  /** JSONL 日志目录；开头的 `~` 已在解析时展开为本机 home */
  logDir: string;
  /** 工具描述覆盖文件路径；未配置时缺省（用仓库内英文描述） */
  toolDescriptionFile?: string;
};

/** Phase 2 注入 Jev 客户端的位置；`classify` 缺省时 on/test 记 no_key 零值对象（SAFE-01 前置）。 */
export type FilterDeps = {
  classify?: ClassifyDeps['classify'];
};

/**
 * Jev 候选集里的一条：本地规则层（步 1–4）后幸存的来源与其幸存片段。
 * `id` 用探测约定 `s{braveIndex}`（与 `.jev.json` 回放夹具的 `results` 键同源）；
 * `snippets` 是幸存片段的当前文本（含步 1 转出的多段与步 2 并入的片段），顺序即表序。
 * 重录 dump 与管道步 5 共用同一口径（02-01）。
 *
 * `brave_page_date`（时间上下文，TEMPORAL_CONTEXT_SCORING_ROLLOUT_PLAN §4）：该候选
 * 的统一页级日期——从原 Brave 元数据 `age` 选出的合法绝对日期字串；步 2 归并候选
 * 的多个贡献原来源日期不同或部分未知时为 null。开关关闭时不进 state（键省略）。
 */
export type JevCandidate = {
  id: string;
  url: string;
  title: string;
  snippets: string[];
  /** 统一页级日期线索；开关关闭时不进 state，归并冲突或无日期为 null */
  brave_page_date?: string | null;
};

/**
 * 片段配对身份（04-02 样本映射用）：`{merged_from}:{index}` 前缀可省（无并入来源），
 * JSON-LD 多段加 `.{part}`——与统计表 SnippetStats 的 index/part/merged_from 同源。
 * （原住 pipeline.ts，全量上下文映射也要消费，移入类型家避免循环导入。）
 */
export type JevCandidateSnippetIdentity = { key: string; text: string };

/**
 * 候选集的带身份形状（04-02）：JevCandidate 口径 + 片段配对身份。全量请求规划
 * （jev/context.ts）用它保留片段身份映射。`bravePageDate` 是库内部 camelCase 的
 * 统一页级日期（与 JevCandidate 的 `brave_page_date` state 字段同值，命名规则见
 * 文件头）——由管道从原 Brave 元数据选出并在归并冲突时置 null（temporal.ts）。
 */
export type JevCandidateDetailed = {
  id: string;
  url: string;
  title: string;
  snippets: JevCandidateSnippetIdentity[];
  /** 统一页级日期线索；无日期或归并冲突为 null，未提取时省略 */
  bravePageDate?: string | null;
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

/**
 * 单来源 state：官方"context rot"规则——只放问题需要的东西，不放元数据与被删片段。
 *
 * 时间上下文（TEMPORAL_CONTEXT_SCORING_ROLLOUT_PLAN §4）：开关开启时 `source` 携带
 * `brave_page_date`（string | null，键恒在），state 顶层携带 `retrieval_time`（值
 * 非法 / 未提供时省略）；片段评分题沿用旧模板（single 新题不在试运行范围）。开关
 * 关闭时两个键都不出现——哪怕内部调用携带了时间（完整功能回退）。
 */
export type JevSingleState = {
  query: string;
  intent: string;
  source: {
    id: string;
    url: string;
    title: string;
    snippets: string[];
    /** 页面日期线索（开关开启时键恒在，无日期 / 归并冲突为 null） */
    brave_page_date?: string | null;
  };
  /** 检索时间（开关开启且提供了合法值时出现；同一搜索全路径同值） */
  retrieval_time?: string;
};

/**
 * 全量共享 state（四题全量上下文，FULL_CONTEXT_ROLLOUT_PLAN §4.1）：本地步 1–4 完成
 * 后进入 Jev 的全部候选来源与片段放进同一个 state。`sources` 按候选 Brave 原序排列，
 * 来源 ID 继续用 `s{braveIndex}` 不重编号——`sources[i]` 的 i 是当前数组位置，**不
 * 等于来源 ID 的数字**（前面来源被删不重排）。元素形状与 `JevCandidate` 同构
 * （id / url / title / 幸存片段文本），不放原始响应、被预筛删除的段落或其他字段。
 *
 * 时间上下文（TEMPORAL_CONTEXT_SCORING_ROLLOUT_PLAN §4）：开关开启时每个来源带
 * `brave_page_date`（string | null，键恒在，与冻结请求一致）、state 顶层带
 * `retrieval_time`（合法值才有）；片段 score 题改用冻结的时间上下文新题（§5）。
 * 预算检查在完整日期与新题全部加入后才做——不能先按旧短题估预算、临发时替换。
 */
export type JevAllState = {
  query: string;
  intent: string;
  sources: JevCandidate[];
  /** 检索时间（开关开启且提供了合法值时出现；同一搜索全路径同值） */
  retrieval_time?: string;
};

/**
 * 请求 state 的显式联合：单来源（`.source`）与全量（`.sources`）。收窄一律用
 * `'source' in state` / `'sources' in state`，绝不用 any 绕过形状差异；客户端据此
 * 路由单来源阶梯与全量防御两条路径。
 */
export type JevState = JevSingleState | JevAllState;

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
 * 实发派发载荷（04-04 R1）：捕获于客户端超限阶梯**之后**、请求派发（fetch 调用）
 * 处的请求体内容——真实发送的 state 与题目集合，绝不重跑本地规则重建。
 * 每次重试复用同一请求体，载荷全程不变；写时复制，消费方不得改写。
 */
export type JevDispatchPayload = {
  /** 实发 state（超限阶梯处理后的真实发送内容） */
  state: JevState;
  /** 实发题目集合（与 state 一同构成请求体） */
  questions: Record<string, JevQuestion>;
};

/**
 * classify 的返回：answered 带实际模型版本 ID 与 input_tokens（JEV-02），
 * failed 一律 union 不抛（单来源失败按"留"，SAFE-01）。
 *
 * `dispatch`（04-04 R1）：请求已派发（fetch 已调用）时携带实发载荷——含已派发
 * 但失败的请求（HTTP 4xx/5xx、超时、网络错误都算"已派发"，输入证据必须保留）；
 * 未派发的短路（too_large / breaker_open）不带。术语口径：派发 ≠ 服务端已收到。
 */
export type ClassifyOutcome = (
  | {
      status: 'answered';
      model: string;
      answers: Record<string, JevAnswer>;
      input_tokens: number;
      ladder?: JevLadderLevel;
      /**
       * 升降级后实际发给 Jev 的片段数（`cut_tail` 砍尾后比 state 少，
       * `source_only_questions` 不发片段题为 0）；未降级时省略，视为"全部发送"。
       * 管道据此只收 `snip0..snip{n-1}` 的分数并按位置对齐（JEV-05）。
       */
      sent_snippets?: number;
      /** 实发派发载荷（04-04 R1，见类型注释） */
      dispatch?: JevDispatchPayload;
      /**
       * 真实 HTTP 尝试次数（含重试；生产客户端必带）。注入桩可不带——管道按
       * "未知"处理，绝不伪称为零或一（FULL_CONTEXT_ROLLOUT_PLAN §6.1）。
       */
      http_attempts?: number;
    }
  | {
      status: 'failed';
      kind: ClassifyFailKind;
      detail?: string;
      /** 实发派发载荷（04-04 R1）：已派发但失败的请求保留输入证据 */
      dispatch?: JevDispatchPayload;
      /** 真实 HTTP 尝试次数；未派发的短路（too_large / breaker_open）为 0 */
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

/** 传输依赖：管道经 `FilterDeps.classify` 注入；实现持有超时/重试/熔断/并发闸（02-05 的 createJevClassifier）。 */
export type ClassifyDeps = {
  classify(req: {
    state: JevState;
    questions: Record<string, JevQuestion>;
  }): Promise<ClassifyOutcome>;
};

/** 九项 Jev 阈值（库内部 camelCase；默认值与出处见 questions.ts 的 `DEFAULT_THRESHOLDS`）。 */
export type JevThresholds = {
  offTopicDrop: number;
  listingDrop: number;
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
  /** status `'failed'` 时的失败种类；`'answered'` 行也可带 `'validation'`——
   *  回答已收到但关键答案缺失/越界，来源防御式保留（T-02-03-1；A-04 状态行口径） */
  fail_kind?: JevFailKind;
  /** 生效的超限降级级别（02-05 记账） */
  ladder?: JevLadderLevel;
  /** 来源级答案的 noul 概率，键随当次题库（当前四题；历史记录含 v3 十题与
   *  2026-10-03 退役的 self_deprecated / stale 旧键，按额外字段读取） */
  answers?: Record<string, number>;
  /** 片段 score，snip0..snipN 顺序，与 state 片段序对齐 */
  snippet_scores?: number[];
  /**
   * 升降级生效时实际带片段题发送的片段数（与 ladder 同条件出现；未降级省略——
   * 片段题数即候选全长）。样本记录（04-02）在 snippet_scores 缺失时（回答收到
   * 但分数不全）用它对齐实发片段范围——绝不让样本映射靠原始序号猜。
   */
  sent_snippets?: number;
  /** 来源级裁决（02-03 落地；test 与 on 同一记账形状） */
  verdict?: 'keep' | 'drop';
  reason?: SourceDropReason;
  model?: string;
  input_tokens?: number;
  latency_ms?: number;
  /**
   * 该来源判断所属逻辑请求的 ID（FULL_CONTEXT_ROLLOUT_PLAN §6.1：投影后的每来源行
   * 引用请求 ID）。all 模式下 N 行引用同一请求；no_key / 未派发无请求时省略。
   */
  request_id?: string;
};

/** Jev 请求组织模式：single 逐来源一次请求（默认），all 全候选共享一次请求。 */
export type JevRequestMode = 'single' | 'all';

/** requested ≠ effective 的回退原因（FULL_CONTEXT_ROLLOUT_PLAN §3 表格）。 */
export type JevFallbackReason = 'single_candidate' | 'over_budget' | 'client_too_large';

/** 双限额的估算值（进请求级记录 planned_estimates，供样本对账）。 */
export type AllBudgetEstimates = {
  /** 全量 state 的 token 估算（未取整浮点，与单来源阶梯同口径） */
  state_tokens: number;
  /** 最长单题的 token 估算 */
  longest_question_tokens: number;
  /** 全部题目估算之和 */
  total_questions_tokens: number;
  /** (state + 最长单题) × 1.15 的估算值（≤ 32k 可发，等号可发） */
  single_limit_estimate: number;
  /** (state + 全部题目) × 1.15 的估算值（≤ 64k 可发，等号可发） */
  total_limit_estimate: number;
};

/** 请求级记录里的来源与题目映射条目（§4.2 显式映射）。 */
export type JevRequestMappingEntry = {
  /** 探测约定 id：`s{braveIndex}` */
  source_id: string;
  /**
   * 该来源在请求 state 里的位置：all 为 `state.sources` 数组下标；single 恒 0
   * （state 是单来源形状，无数组，位置仅作占位）
   */
  array_index: number;
  /** 候选片段配对身份（与 JevDispatchRecord.snippet_keys 同源同序） */
  snippet_keys: string[];
  /** 局部题键（四题、snip{i}）→ 请求级全局题键（single 为恒等映射） */
  question_keys: Record<string, string>;
};

/**
 * 一次 Jev 逻辑请求的完整事实（FULL_CONTEXT_ROLLOUT_PLAN §6.1）。带正文
 * （state / questions / answers / mapping），住 `FilterResult.jev_requests` 供样本
 * v4 落盘——**绝不进 FilterStats / JSONL**（LOG-03 红线，同 jev_dispatch 先例）。
 * 状态维度互相独立：`dispatched`（fetch 已调用）、`answered`（收到可解析响应）、
 * `usage_complete`（input_tokens 真实取得）分别表达；已派发但失败的请求保留实发
 * state / questions 作输入证据。`input_tokens` 保留各次响应的已知小计，全部未知
 * 才为 null；usage_complete 表示所有 HTTP 尝试都取得了用量。
 */
export type JevRequestRecord = {
  /** 本次搜索内唯一请求 ID（`j1`、`j2` …按派发顺序分配） */
  request_id: string;
  /** 实际请求组织：single 一来源一请求；all 全候选共享一请求 */
  mode: JevRequestMode;
  /** 配置要求的组织模式 */
  requested: JevRequestMode;
  /** 实际生效的组织模式 */
  effective: JevRequestMode;
  /** requested ≠ effective 时的回退原因；一致时省略 */
  fallback_reason?: JevFallbackReason;
  /** 覆盖的来源 ID（all 按 state.sources 数组序；single 单元素） */
  source_ids: string[];
  /** 是否已派发（fetch 已调用；too_large / breaker_open / 防御短路一律 false） */
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
  /** 派发前的双限额规划估算（all 模式；§6.1"规划预算"对账） */
  planned_estimates?: AllBudgetEstimates;
};

/** JevStats.requests 的摘要行：JevRequestRecord 去掉正文（state/questions/answers/
 * mapping/model）——JSONL 只放身份、模式与计数，不放正文（LOG-03）。 */
export type JevRequestSummary = Omit<
  JevRequestRecord,
  'state' | 'questions' | 'answers' | 'mapping' | 'model'
>;

/** Jev 阶段的汇总记账（Phase 3 状态行与 JSONL 日志的共同来源）。 */
export type JevStats = {
  /**
   * 实际至少派发一次的逻辑分类请求数（FULL_CONTEXT_ROLLOUT_PLAN §6.1）：answered
   * 或已派发后失败各计一；无候选、预检拒绝（too_large 未派发）、熔断短路不虚记。
   * N 来源一次全量请求记 1，不冒充 N 次 HTTP。
   */
  n_requests: number;
  input_tokens: number;
  /** 逻辑请求耗时之和（每次 classify 全程），不冒充整个过滤阶段的墙钟耗时 */
  latency_ms_total: number;
  status: 'ok' | 'no_key' | 'degraded' | 'breaker_open';
  per_source: JevPerSourceStats[];
  /** 全部请求的真实 HTTP 尝试总数（含重试；与 n_requests 分开记） */
  n_http_attempts: number;
  /** 请求级摘要（无正文，LOG-03 允许的身份与计数面），按派发顺序排列 */
  requests: JevRequestSummary[];
};

/**
 * 旧影子模式的 would 层记账（02-03 落地）。历史日志读取兼容：旧 shadow 记录按旧
 * 影子语义（返回 off、计算 would）读，新记录不再产生——`FilterStats.shadow_diff`
 * 恒为 null，字段仅为读旧记录保留（04-CONTEXT：勿机械改名继续维护旧影子行为）。
 */
export type ShadowDiff = {
  would_drop: string[];
  would_remove_snippets: number;
  would_restore: string[];
  would_restore_snippets: number;
};

/**
 * 链侧删除动作的证据（C-02/F-02 口径：能定位来源、片段、阶段与原因，新颖度差异
 * 带判定当时的逐片段数值）。只存身份、原因与计数，绝不存片段正文（LOG-03）。
 * 历史日志读取兼容：旧 shadow 记录按旧影子语义读——`chain: 'would'`（on 链拷贝）
 * 解释 `would_drop` / `would_remove_snippets`；`chain: 'actual'`（shadow 的 off
 * 正本链）解释 `would_restore` / `would_restore_snippets`。新记录不再产生本类型
 * 的条目（旧影子双链已退役），类型仅为读旧记录保留。
 */
export type WouldActionEvidence = {
  /** 证据所属链：would = on 链拷贝；actual = shadow 的 off 正本链 */
  chain: 'would' | 'actual';
  /** 探测约定 id：`s{braveIndex}` */
  src: string;
  /**
   * 片段配对身份，与管道 snippetKey 同格式：`{merged_from}:{index}`（无并入来源
   * 时省略前缀），JSON-LD 多段加 `.{part}`；来源级动作（整源丢弃）省略本键
   */
  snippet?: string;
  /** 触发阶段：actual 链只可能是后三种（off 链无 Jev 来源裁决与 score 删除） */
  stage: 'source_verdict' | 'snippet_score' | 'novelty' | 'cross_source_dup' | 'empty_source';
  /** 原因词：来源级 SourceDropReason 或片段级 SnippetRemovalReason，键原样不变形 */
  reason: string;
  /**
   * 仅 novelty 删除带：判定当时的逐片段指纹总数与 novel 数——与信封 thresholds
   * 快照的 min_facts / novelty_min 对照即得"该删不该删"；来源级聚合数（local.
   * novelty）不能代回逐片段条件（C-02）。跨源 dup / score / 来源级动作不带
   */
  fp_count?: number;
  novel_count?: number;
};

/**
 * 来源被整体丢弃的原因。前五个 Phase 1 可产生，其余 Phase 2。
 * `self_deprecated` / `stale` 已退役（2026-10-03 题库精简删除其门槛题，filter-rules-11），
 * 新运行不再产生；历史样本 / JSONL 中有真实 drop 记录，类型与回显仍需消费旧记录形状
 * （`ShadowDiff` / `WouldActionEvidence` 同先例），成员仅为读历史记录保留。
 */
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

/**
 * 单个片段被移除的原因。前六个 Phase 1 可产生，其余 Phase 2。
 * `time_mismatch` 已退役（2026-10-03 片段级时间题机制整体移除，filter-rules-12），
 * 新运行不再产生；历史样本 / JSONL 中有真实移除记录，类型与回显仍需消费旧记录
 * 形状（`SourceDropReason` 的 self_deprecated / stale 同先例），成员仅为读历史
 * 记录保留。
 */
export type SnippetRemovalReason =
  | 'jsonld_meta'
  | 'nav'
  | 'boilerplate'
  | 'dup'
  | 'paywall_empty'
  | 'budget'
  | 'score'
  | 'time_mismatch'
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
  /**
   * 步 3 付费墙截断后仍保留片段的截断动作数（D-05/IN-06 口径）：记的是步 3 的
   * **动作**，含后来整源被丢的来源里的截断；状态行 removed 段与 sources 投影记的
   * 是**最终幸存**来源的片段删除——两个指标分母不同、含义不同，不互相换算。
   */
  paywall_truncated: number;
  feed_hits: number;
  blocklist_hits: number;
  empty_dropped: number;
  budget_dropped_sources: number;
  budget_trimmed_snippets: number;
  /** 步 7 后半被事实指纹新颖度删除的片段数（02-04） */
  novelty_removed: number;
  /** 步 7 后半被跨来源 5-gram 逐字重复删除的片段数（02-04；用户已定决策 5 的独立计数） */
  cross_source_dup_removed: number;
  /**
   * 步 3 GitHub 平台界面文字清洗的动作总数（filter-rules-9；删行与剥按钮后缀
   * 各计一条，整片清空片段的动作也计入——明细在逐片段 SnippetStats.github_cleanup，
   * 两处口径一致可对账）。
   */
  github_cleanup_actions: number;
  /**
   * 步 7 后半的新颖度指纹明细（D-10）：只为发生过指纹新颖度删除的来源记条目，
   * `fp_total` 是该来源被删片段指纹的并集大小，`novel` 是其中对幸存指纹并集而言
   * 首次出现 novel 的指纹串——测试模式审核"这个来源为什么被删"的证据。只存指纹串
   * 本身，绝不存片段正文（LOG-03 允许的记录面：URL、标题、指纹与概率）。
   */
  novelty: NoveltySourceDetail[];
};

/**
 * 新颖度明细的一个来源条目（D-10 笔记草案形状）。`src` 取探测约定 `s{index}`；
 * 跨来源 dup 删除不建条目——明细只指新颖度指纹通道。
 */
export type NoveltySourceDetail = {
  src: string;
  fp_total: number;
  novel: string[];
};

/**
 * GitHub 平台界面清洗的动作规则名（filter-rules-9 五条首批；实现见 githubCleanup.ts）。
 */
export type GitHubCleanupRule =
  | 'repo_nav'
  | 'copy_branch_button'
  | 'search_block'
  | 'tag_compare'
  | 'reactions_unavailable';

/**
 * GitHub 平台界面清洗的单条动作（filter-rules-9）：只记规则与行号，绝不记正文
 * （LOG-03）——内容凭行号回 pre_filter 原文对齐（行号相对进入清洗时的片段文本，
 * 即步 3 付费墙截断之后）。
 */
export type GitHubCleanupAction = {
  rule: GitHubCleanupRule;
  /** 命中行号（1 起） */
  line: number;
  /** 行内局部剥除（分支复制按钮后缀，前文分支文本保留）；整行删除省略 */
  partial?: boolean;
};

/** cleanGitHubBoilerplate 的返回：清洗后文本（未命中为原文本）与逐动作清单。 */
export type GitHubCleanupResult = {
  text: string;
  actions: GitHubCleanupAction[];
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
  /**
   * 步 3 GitHub 平台界面清洗的动作明细（filter-rules-9；test/on 生效、off 不应用）。
   * 可选键向后兼容：旧记录无此键，新记录对旧读取方是未知键（样本 format_version
   * 不因此递增）。整片清空（reason 'boilerplate'）与局部剥离都带。
   */
  github_cleanup?: GitHubCleanupAction[];
  chars: number;
};

/** 统计表里单个来源的裁决；按 Brave 原序、带原始索引。 */
export type SourceStats = {
  index: number;
  url: string;
  title: string;
  canonical_url: string;
  hostname?: string;
  verdict: 'keep' | 'drop';
  reason?: SourceDropReason;
  snippets: SnippetStats[];
};

/**
 * 统计对象：Phase 3 的状态行与 JSONL 日志的共同来源，直接序列化即可。
 * `jev`：off 模式保持 null（A16），on/test 由步 5 填充；`shadow_diff` 恒为 null——
 * 旧影子双链退役后新记录不再产生，字段仅为读旧记录保留。
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
    /** Brave freshness 参数（pd/pw/pm/py）；请求未带时省略键（D-10 条件 spread） */
    freshness?: string;
    /** Brave context_threshold_mode；请求未带时省略键（D-10 条件 spread） */
    context_threshold_mode?: string;
  };
  brave: {
    n_sources: number;
    n_snippets: number;
    chars: number;
    /** Brave 请求耗时（毫秒）；适配行在 API.issueRequest 前后计时后回填（D-10） */
    latency_ms?: number;
    /** 过滤前全部片段文本的 token 估算（Math.ceil）；与 output.est_tokens 同一
     * estimateTokens 同一口径——只算片段文本（D-10/TOOLS-04） */
    est_tokens: number;
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
  /**
   * 旧影子差异记账：新记录恒为 null（旧影子双链已退役），字段仅为读旧记录保留——
   * 旧 shadow 记录按旧影子语义（返回 off、计算 would）读，不重解释。
   */
  shadow_diff: ShadowDiff | null;
  /**
   * 链侧删除动作的逐条证据（R-06/C-02、F-02 返修）：旧影子双链的 would 链与正本
   * off 链的删除动作都在这里，chain 字段区分。新记录不再产生本字段（键省略）；
   * 旧记录按旧影子语义读，审核脚本对缺键的更旧记录按"证据不足"读。
   */
  shadow_evidence?: WouldActionEvidence[];
};

/** `filterLlmContext` 的返回：过滤后的响应加统计对象。 */
export type FilterResult = {
  result: FilteredResponse;
  stats: FilterStats;
  /**
   * Jev 实发派发来源级记录（04-04 R1）：每 keep 来源一条，按表序（Brave 原序）排列
   * ——样本层如实落盘的唯一来源级证据，样本写入时**绝不**重跑本地规则重建候选。
   * off / no_key 模式为空表。
   */
  jev_dispatch: JevDispatchRecord[];
  /**
   * Jev 请求级记录（四题全量上下文，FULL_CONTEXT_ROLLOUT_PLAN §6.1）：每逻辑请求
   * 一条、按派发顺序，带实发 state / questions / answers / 映射正文（single 模式
   * N 条、all 模式 1 条）。样本 v4 的载荷只信这里；**绝不进 FilterStats / JSONL**
   * （LOG-03 红线）。off / no_key 为空表。
   */
  jev_requests: JevRequestRecord[];
};

/**
 * Jev 实发派发的来源级记录（04-04 R1 引入；全量上下文接入后瘦身为**纯来源级
 * 证据**）：一次逻辑请求覆盖哪些来源、每个来源的片段身份与逐题有效性。实发
 * state / questions / answers 全量载荷在 `FilterResult.jev_requests` 每请求存一份
 * （§6.1：不在每个来源下重复整份载荷），来源行经 `request_id` 关联；single 模式
 * 一请求一来源，关系不变。状态维度互相独立——`dispatched`（请求已派发）、
 * `answered`（收到可解析响应）与逐片段评分有效性分别表达，failed / skipped /
 * too_large / breaker_open 不再混作同一种"未发送"。已派发但失败的请求保留请求级
 * 实发载荷作输入证据。
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
  /**
   * 该来源在所属请求 state 里的位置：all 为 `state.sources` 数组下标；single 恒 0
   * （state 为单来源形状）。映射消费方不得把它与 src 的数字混用（§9 审查项）
   */
  array_index?: number;
  /**
   * 请求是否已派发（fetch 已调用；不保证服务端已收到或已处理——重试、断连、
   * 非零退出都可能发生）。too_large / breaker_open / skipped 一律 false。
   */
  dispatched: boolean;
  /**
   * 是否收到可解析响应（HTTP 200 且 answers 形状校验通过）——不含"来源裁决有效"
   * 之义，后者见 source_verdict_valid（二次复审 R1 余项拆分）
   */
  answered: boolean;
  /**
   * 逐片段评分有效性，按实发片段范围 snip0..snip{n-1} 对齐：该题实际收到且通过
   * 校验的评分（有限数且在三档评分范围 [0,2] 内，与裁决层共用校验）。缺失 / 错误类型 /
   * 负分 / 非有限一律 false——绝不从候选数或提交题数推断（二次复审 R1 余项）。
   * null = 未派发或未收到可解析响应
   */
  snippet_score_validity: boolean[] | null;
  /** 按题位保留实际收到的有限评分（含越界值供复查）；缺答/错误类型/非有限为 null。
   * 整体 null 表示没有可解析响应；部分缺答不压缩数组、不丢弃其他题的值。 */
  snippet_scores_received: Array<number | null> | null;
  /**
   * 来源级裁决有效：从 applySourceVerdicts 完成后的真实裁决读取；四道关键题通过
   * 校验且已产生裁决，不是 validation 兜底。仅作观察的题缺失不令此值变为 false。
   */
  source_verdict_valid: boolean;
  /** 未派发原因；已派发时省略。防御分支（classify 契约外 reject）也省略 */
  not_dispatched_reason?: 'skipped' | 'too_large' | 'breaker_open';
  /** 候选片段配对身份（`{merged_from}:{index}` 前缀可省、多段加 `.{part}`），
   * 与实发 state 片段按位置前缀对齐（阶梯只砍尾，前缀保持） */
  snippet_keys: string[];
  /** 候选口径片段文本（与 snippet_keys 对齐；被阶梯砍掉的片段凭本表对齐原文） */
  snippet_texts: string[];
};
