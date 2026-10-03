/**
 * test 模式样本落盘（04-02 / SC2+SC3；04-04 R1+R4+R5 返修）：每次 test 搜索一份独立
 * JSON 样本——过滤前完整响应（schema 校验前克隆）+ 最终实际返回 + 过程映射 + Jev
 * 判断与实发派发映射 + 生效配置快照。写入器住纯过滤库（不引任何 MCP 类型），适配层
 * 只交数据。
 *
 * 形状：`createSampleWriter` 是工厂——库不持模块级可变状态（stats.ts 不变式），
 * 程序版本号等进程级只读量住闭包；适配行持惰性单例，先 `allocatePath` 再 `save`
 * （"先分配路径、写入成功后再返回"的顺序契约，实施计划第三节 B）。错误路径走
 * `saveError`：Brave 请求失败存请求与失败信息（pre_filter null）；schema 校验失败
 * 保留可用原始响应与失败阶段；两者的 final_return 都是 null 加显式缺失标记——
 * 绝不当零来源成功、绝不当完整成功样本。
 *
 * 实发口径（04-04 R1 引入，format_version 3 定型；v5 起全量共享一请求）：Jev 段的
 * 实发映射**只信管道交来的 JevDispatchRecord**——捕获于请求派发处，样本写入时绝不
 * 重跑本地规则重建候选（重建可能与实发请求身份不符）。状态四个维度互相独立：
 * `dispatched`（请求已派发，fetch 已调用，不保证服务端已收到）、文本是否进入实发
 * state（`in_state`）、是否提交片段评分题（`score_question_sent`）、收到响应
 * （`answered`）与有效评分（`scored`）分别记录。已派发但失败的请求（HTTP 4xx/5xx、
 * 超时、断连）保留实发 state 作输入证据；skipped（无内容可发）/ breaker_open（熔断
 * 短路）各自带 `not_dispatched_reason`，不再混作同一种"未发送"。回答桩可
 * answered=true 而 dispatched=false——计零请求、载荷保持 null，绝不冒充实发。
 * 历史格式按版本前提读：v1（format_version 1，04-02）的 sent 段是阶梯前重建口径、
 * snippets[].sent 是单一布尔；v2/v3 是逐来源 state 字符串——绝不按 v5 字段名解释。
 *
 * 身份口径（实施计划第三节 C）：来源身份 = Brave 原始索引 `s{n}`（与
 * per_source.src 同源）；片段身份 = `{merged_from}:{index}` 前缀可省、JSON-LD
 * 多段加 `.{part}`（与统计表 SnippetStats 的 index/part/merged_from 同源）。
 * 实发映射的片段表 = 派发记录的候选全量（snippet_keys / snippet_texts）；未派发
 * 请求的来源 in_state=false——被删内容不重复存正文文本，凭身份键回 pre_filter 查。
 *
 * 过程映射（SC2：任一删除项可凭样本定位内容、原因与执行阶段）：outcome 段内嵌
 * 统计表的 sources 投影（keep/drop + 逐片段 kept/reason/身份，reason 词即阶段
 * 判别）与 local 计数（含新颖度指纹明细）——正文不进 outcome，只进 pre_filter。
 *
 * 所有权（B-03 同款约定）：save 构建记录时对 pre_filter / payload / jev /
 * outcome 的引用片段做 structuredClone 深拷贝后**同步**序列化（无异步链）；
 * 调用方在 save 返回后不得再改写传入对象（当前适配行此后只做状态行剥回，
 * 不触碰已序列化引用）。
 *
 * 写入（实施计划第三节"文件组织与读取"）：UTF-8、两空格缩进、文件末尾换行、
 * 字段顺序稳定、正文原样；目标 `log_dir/samples/YYYY-MM-DD/<8位小写十六进制摘要>.json`
 * （摘要取自完整 request_id，同目录内靠概率区分，不作唯一性或防覆盖保证）；
 * **临时文件 + 同目录 rename** 的单次原子
 * 语义——绝不留下可误读为完整成功记录的半截 JSON。写入失败（目录建不出、写
 * 中途失败、rename 失败）返回 status 'failed'，stderr 恰一行可定位告警（含目标
 * 路径），绝不抛错、绝不假装成功；不设自动清理（与 JSONL 日志同策略）。
 *
 * 依据：测试模式与搜索样本记录实施计划.md 第三节、04-CONTEXT.md 落盘契约四节、
 * 测试模式与搜索样本记录审查报告.md R1/R4/R5。
 */

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { CONTEXT_LAYOUT_ID, FILTER_RULES_VERSION } from './version.js';
import { QUESTION_SET_ID } from './jev/questions.js';
import { snippetCountOfState } from './jev/context.js';
import {
  localDateStamp,
  localIsoWithOffset,
  oneLineStderr,
  thresholdSnapshot,
  truncateMessage,
} from './logging.js';
import type {
  FilterConfig,
  FilterMode,
  FilterRequest,
  FilterStats,
  JevAnswer,
  JevDispatchRecord,
  JevPerSourceStats,
  JevQuestion,
  JevRequestMappingEntry,
  JevRequestRecord,
  LocalStats,
  SourceStats,
} from './types.js';

// ---------------------------------------------------------------------------
// 记录类型（字段顺序即序列化顺序，保持稳定方便阅读与比较）
// ---------------------------------------------------------------------------

/** 成功请求样本的 final_return：实际返回的两块内容（状态行只在第二块，含 sample 后缀）。 */
export type SampleFinalReturn = {
  /** 实际返回的第一块 JSON（精简过滤结果 + 可选 parameter_adjustments） */
  payload: unknown;
  /** 实际返回的第二块状态行文本（含 ` sample: <绝对路径>` 后缀）；无状态行时为 null */
  status_line: string | null;
};

/**
 * 过程映射（SC2）：删除项的内容凭身份回 pre_filter 查，原因与执行阶段从这里出
 * ——reason 词即阶段判别（本地规则 nav/boilerplate/dup/jsonld_meta/paywall_empty、
 * Jev 链 score/novelty、预算 budget、来源级裁决见 SourceDropReason）。
 */
export type SampleOutcome = {
  /** 本地计数（含新颖度指纹明细 novelty[]——只存指纹串，绝不存正文） */
  local: LocalStats;
  /** 统计表 sources 投影：keep/drop + 逐片段 kept/reason/index/part/merged_from，无正文 */
  sources: SourceStats[];
};

/**
 * Jev 实发映射里的一条片段（v2 起形状稳定，v5 语义按请求级映射解释）：配对身份 +
 * 候选内位置 + 互相独立的状态维度 + 候选口径文本。v1 的单一 `sent` 布尔已拆分。
 */
export type SampleJevSentSnippet = {
  /** 片段配对身份：`{merged_from}:{index}`（前缀可省）+ 可选 `.{part}` */
  snippet: string;
  /** 候选内位置（即 snip{i} 题位） */
  position: number;
  /**
   * 文本是否进入实发 state——按所属请求的实发 state 与该来源的映射位置计算；
   * 全量共享请求的实发范围即候选全长（未派发请求的来源恒 false）
   */
  in_state: boolean;
  /**
   * 该片段的 snip{i} 评分题是否随请求提交——按题目映射检查（映射里
   * snip{position} 的全局键存在于实发 questions），不用 score 题总数推断
   */
  score_question_sent: boolean;
  /**
   * 是否取得该片段的有效评分（管道派发处逐题实测：收到且通过校验——有限数且在 [0,2]，
   * 与裁决层口径一致）；缺失 / 错误类型 / 负分 / 非有限一律 false，绝不从数量
   * 推断。评分是否被裁决采用由 score_applied 单独表达。
   */
  scored: boolean;
  /** 实际收到的有限评分，包含越界值便于复查；缺答、错误类型或非有限为 null。 */
  score: number | null;
  /** 该评分是否进入步 7 评分裁决；整组缺答或整源已删时为 false。后续新颖度删除不改变此事实。 */
  score_applied: boolean;
  /**
   * 候选口径文本（与派发记录 snippet_texts 对齐）：进入实发 state 的片段即实发
   * 文本；未进实发 state 的片段凭本字段与身份键回 pre_filter 对齐原文
   */
  text: string;
};

/**
 * Jev 请求级记录（v4 引入；v5 起全量共享请求为唯一形状）：一次逻辑请求的完整事实
 * ——实发共享载荷每请求存一份（一次搜索至多一条），不在每个来源下重复。未派发的
 * 请求（熔断短路、防御拒绝、无派发证据的回答桩）保留事实但载荷为 null，绝不伪造。
 */
export type SampleJevRequest = {
  request_id: string;
  /** 覆盖的来源 ID（按 state.sources 数组序） */
  source_ids: string[];
  /** 是否已派发（fetch 已调用） */
  dispatched: boolean;
  /** 实发 state 的 JSON 文本（客户端派发处捕获）；未派发为 null */
  state: string | null;
  /** 实发题目集合原样（键为请求级全局键）；未派发为 null */
  questions: Record<string, JevQuestion> | null;
  /** 是否收到可解析响应 */
  answered: boolean;
  /** 服务端回报的模型版本（answered 时） */
  model?: string;
  /** 各次响应的已知用量之和；全部未知才为 null。 */
  input_tokens: number | null;
  /** 所有 HTTP 尝试的用量是否均已取得。 */
  usage_complete: boolean;
  /** 最后一个取得正文的 HTTP 响应状态。 */
  http_status?: number;
  /** 真实 HTTP 尝试次数（含重试）；客户端未提供时省略 */
  http_attempts?: number;
  /** 逻辑请求耗时（毫秒，含重试与退避） */
  latency_ms: number;
  /** 失败分类（failed 时） */
  fail_kind?: string;
  /** 解析后的原始答案（全局键原样；answered 时） */
  answers?: Record<string, JevAnswer>;
  /** 来源与题目映射（构造成功即带） */
  mapping: SampleJevRequestMappingEntry[];
};

/** 请求级映射条目：与 JevRequestMappingEntry 同一来源，天然同形。 */
export type SampleJevRequestMappingEntry = JevRequestMappingEntry;

/**
 * Jev 实发映射里的一条来源（v4 引入；v5 起载荷经 request_id 引用唯一共享请求）：
 * 来源身份 + 所属请求（request_id / array_index）+ 派发状态 + 逐片段映射。实发
 * state / questions 载荷在所属请求条目里，不再逐来源重复（v3 的 state 字符串字段
 * 已随请求级载荷退役）。
 */
export type SampleJevSentSource = {
  src: string;
  url: string;
  title: string;
  /** 所属逻辑请求 ID（jev.requests[] 的 request_id）；无请求（skipped）省略 */
  request_id?: string;
  /** 该来源在所属请求 state 里的位置：state.sources 数组下标（与 src 数字解耦） */
  array_index?: number;
  /** 请求是否已派发（fetch 已调用；不保证服务端已收到或已处理） */
  dispatched: boolean;
  /**
   * 未派发原因（skipped = 无内容可发；breaker_open = 熔断短路）；已派发时省略。
   * 防御分支（classify 契约外 reject）也省略
   */
  not_dispatched_reason?: 'skipped' | 'breaker_open';
  /**
   * 是否收到可解析响应（HTTP 200 且 answers 形状校验通过）——不等于"来源裁决
   * 有效"，后者见 source_verdict_valid（二次复审 R1 余项拆分）
   */
  answered: boolean;
  /**
   * 是否取得有效来源裁决（实际裁决所需的四道题通过校验并完成裁决）；answered=true
   * 而本值 false = 收到可解析响应但 validation 兜底（状态行提示未完成 Jev 检查）
   */
  source_verdict_valid: boolean;
  snippets: SampleJevSentSnippet[];
};

/**
 * Jev 段（v4 引入；v5 起一次搜索至多一条共享请求）：判断（per_source 原样）+
 * 请求级完整载荷 + 实发派发映射（来源级）。n_requests 是实际至少派发一次的逻辑
 * 请求数；n_http_attempts 是真实 fetch 次数（含重试）——两者分开记；回答桩
 * answered 而未派发时 n_requests=0。
 */
export type SampleJev = {
  status: 'ok' | 'no_key' | 'degraded' | 'breaker_open';
  n_requests: number;
  input_tokens: number;
  latency_ms_total: number;
  /** 全部请求的真实 HTTP 尝试总数（含重试；v4 新增） */
  n_http_attempts: number;
  /** 请求级完整记录（实发共享载荷每请求一份；v4 新增，v1–v3 无此键；v5 起一次搜索至多一条） */
  requests: SampleJevRequest[];
  /** 来源级判断原样（含 answers / snippet_scores / verdict / reason / fail_kind / request_id） */
  per_source: JevPerSourceStats[];
  /**
   * 实发派发映射（来源级；v4 引入，v5 起载荷经 request_id 引用唯一共享请求）：
   * 每 keep 来源一条、按表序（Brave 原序）；v1 是阶梯前重建口径、v2/v3 是逐来源
   * state 字符串——历史格式按 format_version 区分读取
   */
  sent: SampleJevSentSource[];
};

/** 生效配置快照（只收过滤行为面配置，绝无认证材料与环境变量——T-04-02-4）。 */
export type SampleConfigSnapshot = {
  /** 九项生效阈值（THRESHOLD_SPECS 投影 snake_case） */
  thresholds: Record<string, number>;
  /**
   * Jev 客户端配置：钉版模型、超时兜底与并发闸初值。v4 及更早样本还可能有
   * context_mode / temporal_context（均已随 all-only 清理退役，2026-10）——
   * 历史样本按其自身 format_version 的配置面读。
   */
  jev: {
    model: string;
    timeout_ms: number;
    concurrency: number;
  };
  overfetch_factor: number;
  mode: FilterMode;
  /** 结构性黑名单 host 集（排序稳定） */
  blocklist: string[];
};

/** 缺失标记（PRD：不存在的过滤结果明确标为缺失，不当零来源成功）。 */
export type SampleMissingFinalReturn = {
  /** 失败阶段：Brave 请求层 / 响应 schema 校验 */
  stage: 'brave' | 'schema';
  /** 失败原因摘要（≤200 字符，与 writeError 同口径） */
  message: string;
};

/**
 * 样本记录。成功请求：pre_filter / final_return / outcome / jev 齐备；
 * 错误路径（Brave 失败 / schema 失败）：final_return 为 null 且带
 * final_return_missing 显式标记，outcome 省略（无过滤过程），jev 为 null。
 */
export type SampleRecord = {
  /**
   * 记录格式版本。5 = all-only 清理（2026-10）：Jev 请求组织固定全量共享上下文
   * （requests[] 一次搜索至多一条；请求级记录不再有 mode / requested / effective /
   * fallback_reason / planned_estimates）、config_snapshot.jev 只含
   * model/timeout_ms/concurrency、not_dispatched_reason 收缩为
   * skipped | breaker_open。4 = 请求级载荷（requests[]：每逻辑请求一份实发
   * state/questions/answers/映射，来源级 sent[] 经 request_id 引用，不再逐来源
   * 重复整份 state）+ in_state / score_question_sent 按题目映射检查 +
   * config_snapshot.jev.context_mode + jev.n_http_attempts
   * （FULL_CONTEXT_ROLLOUT_PLAN §6.2）。3 = scored 逐题有效性、保留部分评分、
   * score_applied 与来源裁决有效性分离。2 = 实发捕获已准确，但 scored 仍可能由
   * 题数推断；1 = 阶梯前重建。旧样本不能按新版本解释，尤其不能把 v2 的 scored
   * 当成有效评分证据、把 v3 的 sent[].state 当请求级共享载荷、把 v4 的请求级
   * 记录当成可能多请求的组织（v4 的 requests[] 还带 mode 且可能逐来源多条）。
   */
  format_version: 5;
  request_id: string;
  /** 本地 ISO 带时区偏移（复用 logging.ts 的 localIsoWithOffset 口径） */
  ts: string;
  mode: FilterMode;
  request: {
    /** 模型给的原始参数（钳位前，原样含 intent 键） */
    params: Record<string, unknown>;
    /** 补齐与 overfetch 后实际发给 Brave 的参数 */
    brave_params: Record<string, unknown>;
    intent: string;
  };
  /** 过滤前完整响应（schema 校验前克隆，未被管道修改）；Brave 请求失败时为 null */
  pre_filter: unknown;
  /** 成功：实际返回两块；错误路径：null + final_return_missing 显式标缺失 */
  final_return: SampleFinalReturn | null;
  /** 缺失标记（仅 final_return 为 null 的错误路径样本出现） */
  final_return_missing?: SampleMissingFinalReturn;
  /** 过程映射（错误路径无过滤过程，省略） */
  outcome?: SampleOutcome;
  /** Jev 判断与实发映射（错误路径无 Jev 阶段，为 null） */
  jev: SampleJev | null;
  config_snapshot: SampleConfigSnapshot;
  /** 题库版本标识（questions.ts 的 QUESTION_SET_ID，配合 git 历史取得完整题目） */
  question_set_id: string;
  /** 请求组织与题目命名空间布局版本，独立于题意和样本容器格式。 */
  context_layout_id: string;
  /** 过滤程序版本（package.json version——包版本，跨实现变更不变） */
  filter_program_version: string;
  /** 过滤规则版本（version.ts 的 FILTER_RULES_VERSION——可定位真实过滤实现，
   * 04-04 R4；v1 记录无此键） */
  filter_rules_version: string;
};

// ---------------------------------------------------------------------------
// 写入器
// ---------------------------------------------------------------------------

/**
 * allocatePath 的返回：路径分配与时间捕获一步完成（B-01 同款约定——save 的 ts
 * 与目录日期取同一个 Date，两次独立取时跨午夜会各差一天）。
 */
export type AllocatedSamplePath = {
  /** 状态行 ` sample: ` 后缀用的绝对路径（可直接访问） */
  absolute: string;
  /** JSONL 信封 sample.path 用的相对 log_dir 路径：`samples/<日期>/<8位十六进制摘要>.json` */
  relative: string;
  /** 分配时刻的 Date（writer 内部锚点，调用方原样传回 save 即可） */
  capturedAt: Date;
};

/** save 的输入：适配层交数据，样本构建与身份映射全部住库内。 */
export type SampleInput = {
  requestId: string;
  path: AllocatedSamplePath;
  /** 模型给的原始参数（钳位前） */
  originalParams: Record<string, unknown>;
  /** 补齐与 overfetch 后实际发给 Brave 的参数 */
  braveParams: Record<string, unknown>;
  /** filterLlmContext 收到的查询参数（候选重导出与步 5 同口径） */
  filterParams: FilterRequest;
  intent: string;
  /** schema 校验前克隆的完整响应（所有权已隔离，save 内再深拷贝一层） */
  preFilter: unknown;
  /** 过滤统计（jev 判断、outcome 过程映射的来源） */
  stats: FilterStats;
  /**
   * 实发派发来源级记录（04-04 R1）：FilterResult.jev_dispatch 原样交入——请求派发
   * 处捕获的来源级证据。样本 Jev 段只信它，绝不重跑本地规则重建候选
   * （off / no_key 为空表）
   */
  jevDispatch: JevDispatchRecord[];
  /**
   * 请求级记录（v4，FULL_CONTEXT_ROLLOUT_PLAN §6.1）：FilterResult.jev_requests
   * 原样交入——每逻辑请求一份实发 state / questions / answers / 映射。来源级
   * sent[] 的载荷经 request_id 引用这里，不再逐来源重复（off / no_key 为空表）
   */
  jevRequests: JevRequestRecord[];
  /** 实际返回第一块 JSON（含输出规模，不重复携带状态行） */
  payload: unknown;
  /** 实际返回第二块状态行文本（含 sample 后缀）；无状态行为 null */
  statusLine: string | null;
};

/** save / saveError 的返回：适配行据此决定状态行后缀去留与 JSONL 信封指针。 */
export type SampleWriteStatus = { status: 'saved' | 'failed' };

/** saveError 的输入：错误路径样本（Brave 失败 / schema 失败）。 */
export type SampleErrorInput = {
  requestId: string;
  path: AllocatedSamplePath;
  /** 模型给的原始参数（钳位前） */
  originalParams: Record<string, unknown>;
  /** 补齐与 overfetch 后实际发给 Brave 的参数 */
  braveParams: Record<string, unknown>;
  intent: string;
  /** 失败阶段：Brave 请求层 / 响应 schema 校验（与 JSONL 错误记录同口径） */
  stage: 'brave' | 'schema';
  /** 失败原因（saveError 内截断到 200 字符，与 writeError 同口径） */
  message: string;
  /** schema 失败时保留的可用原始响应快照（safeParse 前克隆）；Brave 失败为 null */
  preFilter: unknown;
};

/** 测试注入点（照 createJevClassifier 的 hooks 先例）：缺省直连 node:fs 实现。
 * `writeFile` 抛错 = 写中途失败；`rename` 抛错 = 已写完整临时文件但原子替换失败；
 * `readFilterRulesVersion` 覆盖过滤规则版本读取（04-04 R4 区分能力测试注入）。 */
export type SampleWriterHooks = {
  writeFile?: (path: string, data: string) => void;
  rename?: (from: string, to: string) => void;
  readFilterRulesVersion?: () => string;
};

/** 样本写入器：路径分配 + 成功/错误两种落盘入口。 */
export type SampleWriter = {
  /** 分配样本路径（"先分配路径"顺序契约的第一步）。 */
  allocatePath(requestId: string): AllocatedSamplePath;
  /** 成功请求：构建完整样本并原子落盘。 */
  save(input: SampleInput): SampleWriteStatus;
  /** 错误路径：缺失标记样本（final_return null + final_return_missing）。 */
  saveError(input: SampleErrorInput): SampleWriteStatus;
};

/** 读过滤程序版本（package.json version）：src/ 与 dist/ 相对深度一致，两种布局
 * 都能解析到仓库根；读不到（理论上不可能）回落 'unknown'，绝不抛错。 */
const readProgramVersion = (): string => {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8')
    );
    const version = (parsed as { version?: unknown } | null)?.version;
    return typeof version === 'string' ? version : 'unknown';
  } catch {
    return 'unknown';
  }
};

/**
 * 逐片段 scored 的操作口径（二次复审 R1 余项定稿）：**实测**——管道在派发处逐题
 * 记录的评分有效性（收到且通过校验：有限数且在 [0,2]，与裁决层口径一致），绝不从候选
 * 数、提交题数或 snippet_scores 长度推断（旧口径把"漏答 / 负分保守保留"伪装成
 * "已评分"）。是否被评分裁决采用由 score_applied 另记。
 */
const isSnippetScored = (record: JevDispatchRecord, position: number): boolean =>
  record.snippet_score_validity?.[position] === true;

/**
 * Jev 段构建（v4 引入；v5 全量共享语义）：**只信管道交来的 JevRequestRecord 与
 * JevDispatchRecord**（请求派发处捕获），绝不重跑本地规则重建候选（重建可能与
 * 实发请求身份不符——R1 的病灶）。请求级 requests[] 每逻辑请求存一份实发载荷；
 * 来源级 sent[] 经 request_id / array_index 引用请求，in_state 与
 * score_question_sent 按题目映射对实发载荷逐位检查——不拿整份 questions 的
 * score 题总数或候选全长推断，无实发载荷（未派发）即 false，绝不冒充。
 */
const buildJevSection = (input: SampleInput): SampleJev | null => {
  const jev = input.stats.jev;
  if (jev === null) return null; // test 模式不会出现（no_key 也建零值对象）；防御直调
  const rows = new Map(jev.per_source.map((row) => [row.src, row]));
  const requestsById = new Map(input.jevRequests.map((record) => [record.request_id, record]));

  const requests: SampleJevRequest[] = input.jevRequests.map((record) => ({
    request_id: record.request_id,
    source_ids: [...record.source_ids],
    dispatched: record.dispatched,
    // 实发载荷：未派发为 null——不伪造输入证据
    state: record.state === null ? null : JSON.stringify(record.state),
    questions: record.questions === null ? null : structuredClone(record.questions),
    answered: record.answered,
    ...(record.model !== undefined ? { model: record.model } : {}),
    input_tokens: record.input_tokens,
    usage_complete: record.usage_complete,
    ...(record.http_status !== undefined ? { http_status: record.http_status } : {}),
    ...(record.http_attempts !== undefined ? { http_attempts: record.http_attempts } : {}),
    latency_ms: record.latency_ms,
    ...(record.fail_kind !== undefined ? { fail_kind: record.fail_kind } : {}),
    ...(record.answers !== undefined ? { answers: structuredClone(record.answers) } : {}),
    mapping: structuredClone(record.mapping),
  }));

  const sent: SampleJevSentSource[] = input.jevDispatch.map((record) => {
    const request =
      record.request_id !== undefined ? requestsById.get(record.request_id) : undefined;
    const mappingEntry =
      request !== undefined
        ? request.mapping.find((entry) => entry.source_id === record.src)
        : undefined;
    // 实发 state 中该来源的片段数（in_state 依据）：全量共享请求的实发范围即
    // 候选全长；请求未派发（state null）或映射缺失按 0 处理
    const stateSnippetCount =
      request?.state != null && mappingEntry !== undefined
        ? (snippetCountOfState(request.state, mappingEntry.array_index) ?? 0)
        : 0;
    // 该片段的 snip 题是否随请求提交：映射里 snip{position} 的全局键必须存在于
    // 实发 questions，绝不按 score 题总数推断
    const hasSentQuestions = request?.questions != null;
    const sentQuestions = hasSentQuestions
      ? (request?.questions as Record<string, JevQuestion>)
      : null;
    const scoreQuestionSent = (position: number): boolean => {
      if (sentQuestions === null || mappingEntry === undefined) return false;
      const globalKey = mappingEntry.question_keys[`snip${position}`];
      return globalKey !== undefined && Object.hasOwn(sentQuestions, globalKey);
    };
    const row = rows.get(record.src);
    return {
      src: record.src,
      url: record.url,
      title: record.title,
      ...(record.request_id !== undefined ? { request_id: record.request_id } : {}),
      ...(record.array_index !== undefined ? { array_index: record.array_index } : {}),
      dispatched: record.dispatched,
      ...(record.not_dispatched_reason !== undefined
        ? { not_dispatched_reason: record.not_dispatched_reason }
        : {}),
      answered: record.answered,
      source_verdict_valid: record.source_verdict_valid,
      snippets: record.snippet_keys.map((key, position) => ({
        snippet: key,
        position,
        in_state: position < stateSnippetCount,
        score_question_sent: scoreQuestionSent(position),
        scored: isSnippetScored(record, position),
        score: record.snippet_scores_received?.[position] ?? null,
        score_applied:
          isSnippetScored(record, position) &&
          row?.verdict === 'keep' &&
          row.snippet_scores !== undefined &&
          row.snippet_scores.length === record.snippet_keys.length,
        text: record.snippet_texts[position] ?? '',
      })),
    };
  });

  return {
    status: jev.status,
    n_requests: jev.n_requests,
    input_tokens: jev.input_tokens,
    latency_ms_total: jev.latency_ms_total,
    n_http_attempts: jev.n_http_attempts,
    requests,
    per_source: structuredClone(jev.per_source),
    sent,
  };
};

/** 成功样本记录构建：字段顺序即序列化顺序，保持稳定。 */
const buildRecord = (
  config: FilterConfig,
  input: SampleInput,
  programVersion: string,
  rulesVersion: string
): SampleRecord => ({
  format_version: 5,
  request_id: input.requestId,
  ts: localIsoWithOffset(input.path.capturedAt),
  mode: config.mode,
  request: {
    params: { ...input.originalParams },
    brave_params: { ...input.braveParams },
    intent: input.intent,
  },
  pre_filter: structuredClone(input.preFilter),
  final_return: {
    payload: structuredClone(input.payload),
    status_line: input.statusLine,
  },
  outcome: {
    local: structuredClone(input.stats.local),
    sources: structuredClone(input.stats.sources),
  },
  jev: buildJevSection(input),
  config_snapshot: {
    thresholds: thresholdSnapshot(config),
    jev: {
      model: config.jev.model,
      timeout_ms: config.jev.timeoutMs,
      concurrency: config.jev.concurrency,
    },
    overfetch_factor: config.overfetchFactor,
    mode: config.mode,
    blocklist: [...config.blocklist].sort(),
  },
  question_set_id: QUESTION_SET_ID,
  context_layout_id: CONTEXT_LAYOUT_ID,
  filter_program_version: programVersion,
  filter_rules_version: rulesVersion,
});

/** 错误路径样本记录构建：final_return null + 显式缺失标记，无 outcome、jev null。 */
const buildErrorRecord = (
  config: FilterConfig,
  input: SampleErrorInput,
  programVersion: string,
  rulesVersion: string
): SampleRecord => ({
  format_version: 5,
  request_id: input.requestId,
  ts: localIsoWithOffset(input.path.capturedAt),
  mode: config.mode,
  request: {
    params: { ...input.originalParams },
    brave_params: { ...input.braveParams },
    intent: input.intent,
  },
  pre_filter: input.preFilter === null ? null : structuredClone(input.preFilter),
  final_return: null,
  final_return_missing: {
    stage: input.stage,
    message: truncateMessage(input.message),
  },
  jev: null,
  config_snapshot: {
    thresholds: thresholdSnapshot(config),
    jev: {
      model: config.jev.model,
      timeout_ms: config.jev.timeoutMs,
      concurrency: config.jev.concurrency,
    },
    overfetch_factor: config.overfetchFactor,
    mode: config.mode,
    blocklist: [...config.blocklist].sort(),
  },
  question_set_id: QUESTION_SET_ID,
  context_layout_id: CONTEXT_LAYOUT_ID,
  filter_program_version: programVersion,
  filter_rules_version: rulesVersion,
});

/** 样本序列化：UTF-8、两空格缩进、文件末尾换行、字段顺序稳定、正文原样。 */
const serializeRecord = (record: SampleRecord): string => `${JSON.stringify(record, null, 2)}\n`;

/**
 * 原子落盘：目录自愈（mkdirSync recursive）→ 临时文件单次整写 → 同目录 rename。
 * `content` 是懒构建 thunk（04-04 辅助边界）：记录构建与序列化挪进本函数 try 内
 * ——构建异常（如输入契约扩展后出现不可序列化引用）与写入失败同口径消化：
 * stderr 一行 + 返回 failed，绝不外抛反噬搜索。任何一步失败：尽力清掉临时文件
 * （清不掉就留着——`.tmp` 后缀不会被误读为完整样本）、绝不抛错、绝不假装成功。
 */
const writeSampleFile = (
  path: AllocatedSamplePath,
  content: () => string,
  hooks: SampleWriterHooks
): SampleWriteStatus => {
  const tmpPath = `${path.absolute}.tmp`;
  // 缺省实现包一层箭头：统一两参签名（writeFileSync 的 options 重载不外泄）
  const writeFile =
    hooks.writeFile ?? ((filePath: string, data: string) => writeFileSync(filePath, data, 'utf8'));
  const rename = hooks.rename ?? ((from: string, to: string) => renameSync(from, to));
  try {
    mkdirSync(dirname(path.absolute), { recursive: true });
    writeFile(tmpPath, content());
    rename(tmpPath, path.absolute);
    return { status: 'saved' };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    try {
      unlinkSync(tmpPath);
    } catch {
      // 半截临时文件清不掉就让 `.tmp` 留在原地——不会被视为完整成功记录
    }
    console.error(
      `[jev-filter] Unable to write sample '${oneLineStderr(path.absolute)}': ${oneLineStderr(reason)}; search result is unaffected.`
    );
    return { status: 'failed' };
  }
};

/**
 * 创建样本写入器（04-02）：`allocatePath` 先分配路径并捕获锚点 Date，`save` 构建
 * 完整记录（深拷贝所有权隔离）、`saveError` 构建缺失标记样本，都经临时文件 +
 * rename 原子落盘；记录构建与序列化同在 try 内（构建异常与写入失败同口径
 * fail-open，04-04 辅助边界）。写入失败 fail-open（stderr 一行 + status
 * 'failed'），搜索返回不受影响——适配行据此剥掉状态行后缀再返回，绝不假装样本
 * 已存在。
 * R5（04-04）：相对 log_dir 时 `allocatePath.absolute` 用 `path.resolve` 按**进程
 * 工作目录**基准转绝对（与写入时的解析基准一致——相对路径的 writeFileSync 同以
 * cwd 解析）；JSONL 信封的相对指针（`relative`）继续相对日志目录保存。
 *
 * @param config 过滤配置（取 logDir、模式、阈值、jev 组与黑名单；适配行持单例）
 * @param hooks 测试注入的文件写入 / 重命名 / 规则版本读取（缺省直连 node:fs 与
 *   version.ts 的 FILTER_RULES_VERSION）
 */
export function createSampleWriter(config: FilterConfig, hooks?: SampleWriterHooks): SampleWriter {
  const programVersion = readProgramVersion();
  const rulesVersion = hooks?.readFilterRulesVersion?.() ?? FILTER_RULES_VERSION;
  const resolvedHooks: SampleWriterHooks = hooks ?? {};

  return {
    allocatePath(requestId: string): AllocatedSamplePath {
      const capturedAt = new Date();
      // 文件名采用 8 位小写十六进制摘要；完整 request_id 仍在样本和日志中关联。
      // 复用 SHA-256 摘要，不直接截 UUID 前缀。
      const hash = createHash('sha256').update(requestId).digest('hex').slice(0, 8);
      const relative = `samples/${localDateStamp(capturedAt)}/${hash}.json`;
      return { absolute: resolve(config.logDir, relative), relative, capturedAt };
    },
    save(input: SampleInput): SampleWriteStatus {
      return writeSampleFile(
        input.path,
        () => serializeRecord(buildRecord(config, input, programVersion, rulesVersion)),
        resolvedHooks
      );
    },
    saveError(input: SampleErrorInput): SampleWriteStatus {
      return writeSampleFile(
        input.path,
        () => serializeRecord(buildErrorRecord(config, input, programVersion, rulesVersion)),
        resolvedHooks
      );
    },
  };
}
