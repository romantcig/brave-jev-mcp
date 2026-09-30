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
  /** 十一项 Jev 阈值；坏值逐项回落 `DEFAULT_THRESHOLDS`（EMBED-05） */
  thresholds: JevThresholds;
  /** Jev 客户端配置：钉版模型、超时纯兜底与进程级并发闸初值（02-05 消费） */
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

/** Phase 2 注入 Jev 客户端的位置；`classify` 缺省时 on/test 记 no_key 零值对象（SAFE-01 前置）。 */
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
export type ClassifyOutcome =
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
    }
  | {
      status: 'failed';
      kind: ClassifyFailKind;
      detail?: string;
      /** 实发派发载荷（04-04 R1）：已派发但失败的请求保留输入证据 */
      dispatch?: JevDispatchPayload;
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
  /** status `'failed'` 时的失败种类；`'answered'` 行也可带 `'validation'`——
   *  回答已收到但关键答案缺失/越界，来源防御式保留（T-02-03-1；A-04 状态行口径） */
  fail_kind?: JevFailKind;
  /** 生效的超限降级级别（02-05 记账） */
  ladder?: JevLadderLevel;
  /** 来源级十题的 noul 概率（paywalled / rewrite / worth_keeping 也在内） */
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
   * Jev 实发派发记录（04-04 R1）：每 keep 来源一条，捕获于客户端超限阶梯之后、
   * 请求派发处，按表序（Brave 原序）排列——样本层如实落盘的唯一来源，样本写入时
   * **绝不**重跑本地规则重建候选。含实发 state 正文，**绝不进 FilterStats /
   * JSONL 日志**（LOG-03 红线：JSONL 无正文，本字段住在 FilterResult 上就是证明）。
   * off / no_key 模式为空表。
   */
  jev_dispatch: JevDispatchRecord[];
};

/**
 * Jev 实发派发记录（04-04 R1）：一次来源级请求的派发事实与输入证据。
 * 状态维度互相独立——`dispatched`（请求已派发）、文本是否进入 state（实发 state
 * 的片段数）、`snip_questions_sent`（是否提交片段评分题）、`answered`（是否收到
 * 可解析响应）分别表达，failed / skipped / too_large / breaker_open 不再混作同一种
 * "未发送"。已派发但失败的请求保留实发 state 作输入证据。
 */
export type JevDispatchRecord = {
  /** 探测约定 id：`s{braveIndex}`（与 per_source.src 同源） */
  src: string;
  url: string;
  title: string;
  /**
   * 请求是否已派发（fetch 已调用；不保证服务端已收到或已处理——重试、断连、
   * 非零退出都可能发生）。too_large / breaker_open / skipped 一律 false。
   */
  dispatched: boolean;
  /** 实发 state（超限阶梯处理后的真实发送内容）；未派发为 null */
  state: JevState | null;
  /** 实发题目集合；未派发为 null */
  questions: Record<string, JevQuestion> | null;
  /** 是否提交了片段评分题（实发 questions 含 score 题即 snip{i}） */
  snip_questions_sent: boolean;
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
   * 来源级裁决有效：从 applySourceVerdicts 完成后的真实裁决读取；六道关键题通过
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
