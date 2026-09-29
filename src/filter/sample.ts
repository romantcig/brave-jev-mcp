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
 * 实发口径（04-04 R1，format_version 2）：Jev 段的实发映射**只信管道交来的
 * JevDispatchRecord**——捕获于客户端超限阶梯之后、请求派发处，样本写入时绝不重跑
 * 本地规则重建候选（重建会得到阶梯前 state，与实发不符）。状态四个维度互相独立：
 * `dispatched`（请求已派发，fetch 已调用，不保证服务端已收到）、文本是否进入实发
 * state（`in_state`）、是否提交片段评分题（`score_question_sent`）、是否取得有效
 * 回答（`answered` / 逐片段 `scored`）。已派发但失败的请求（HTTP 4xx/5xx、超时、
 * 断连）保留实发 state 作输入证据；skipped（无内容可发）/ too_large（阶梯砍不动）/
 * breaker_open（熔断短路）各自带 `not_dispatched_reason`，不再混作同一种"未发送"。
 * v1 记录（format_version 1，04-02）的 sent 段是阶梯前重建口径、snippets[].sent 是
 * 单一布尔——按旧语义读，绝不按 v2 字段名解释。
 *
 * 身份口径（实施计划第三节 C）：来源身份 = Brave 原始索引 `s{n}`（与
 * per_source.src 同源）；片段身份 = `{merged_from}:{index}` 前缀可省、JSON-LD
 * 多段加 `.{part}`（与统计表 SnippetStats 的 index/part/merged_from 同源）。
 * 实发映射的片段表 = 派发记录的候选全量（snippet_keys / snippet_texts），阶梯砍掉
 * 的片段 in_state=false——被删内容不重复存正文文本，凭身份键回 pre_filter 查。
 *
 * 过程映射（SC2：任一删除项可凭样本定位内容、原因与执行阶段）：outcome 段内嵌
 * 统计表的 sources 投影（keep/drop + 逐片段 kept/reason/身份，reason 词即阶段
 * 判别）与 local 计数（含新颖度指纹明细）——正文不进 outcome，只进 pre_filter。
 *
 * 所有权（B-03 同款约定）：save 构建记录时对 pre_filter / payload / jev /
 * outcome 的引用片段做 structuredClone 深拷贝后**同步**序列化（无异步链）；
 * 调用方在 save 返回后不得再改写传入对象（当前适配行此后只做状态行后缀剥离并
 * 重建 payload，不触碰已序列化引用）。
 *
 * 写入（实施计划第三节"文件组织与读取"）：UTF-8、两空格缩进、文件末尾换行、
 * 字段顺序稳定、正文原样；目标 `log_dir/samples/YYYY-MM-DD/<request_id>.json`
 * （request_id 为 UUID，多进程唯一）；**临时文件 + 同目录 rename** 的单次原子
 * 语义——绝不留下可误读为完整成功记录的半截 JSON。写入失败（目录建不出、写
 * 中途失败、rename 失败）返回 status 'failed'，stderr 恰一行可定位告警（含目标
 * 路径），绝不抛错、绝不假装成功；不设自动清理（与 JSONL 日志同策略）。
 *
 * 依据：测试模式与搜索样本记录实施计划.md 第三节、04-CONTEXT.md 落盘契约四节、
 * 测试模式与搜索样本记录审查报告.md R1/R4/R5。
 */

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { FILTER_RULES_VERSION } from './version.js';
import { QUESTION_SET_ID } from './jev/questions.js';
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
  JevDispatchRecord,
  JevPerSourceStats,
  LocalStats,
  SourceStats,
} from './types.js';

// ---------------------------------------------------------------------------
// 记录类型（字段顺序即序列化顺序，保持稳定方便阅读与比较）
// ---------------------------------------------------------------------------

/** 成功请求样本的 final_return：实际返回的两块内容（payload 的 output.status_line 带 sample 后缀）。 */
export type SampleFinalReturn = {
  /** 实际返回的第一块 JSON（过滤结果 + output 摘要 + parameter_adjustments） */
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
 * Jev 实发映射里的一条片段（04-04 R1，v2）：配对身份 + 候选内位置 + 三个互相
 * 独立的状态维度 + 候选口径文本。v1 的单一 `sent` 布尔已拆分——"没有有效回答"
 * 与"没发送"不再混同。
 */
export type SampleJevSentSnippet = {
  /** 片段配对身份：`{merged_from}:{index}`（前缀可省）+ 可选 `.{part}` */
  snippet: string;
  /** 候选内位置（即 snip{i} 题位） */
  position: number;
  /**
   * 文本是否进入实发 state（捕获于客户端超限阶梯后、派发前）——cut_tail 砍掉
   * 的尾片段为 false，source_only_questions 级片段全部 true（state 片段保留）
   */
  in_state: boolean;
  /** 该片段的 snip{i} 评分题是否随请求提交（未派发 / 题被阶梯删掉为 false） */
  score_question_sent: boolean;
  /** 是否取得该片段的有效评分回答（answered 且位置在实发收分范围内） */
  scored: boolean;
  /**
   * 候选口径文本（与派发记录 snippet_texts 对齐）：进入实发 state 的片段即实发
   * 文本；被阶梯砍掉的片段凭本字段与身份键回 pre_filter 对齐原文
   */
  text: string;
};

/** Jev 实发映射里的一条来源：实发 state 文本 + 派发状态 + 逐片段映射（v2）。 */
export type SampleJevSentSource = {
  src: string;
  url: string;
  title: string;
  /**
   * 实发 state 的 JSON 文本（客户端超限阶梯处理后、派发前的真实发送内容，
   * 04-04 R1 捕获口径）；未派发（skipped / too_large / breaker_open）为 null
   */
  state: string | null;
  /** 请求是否已派发（fetch 已调用；不保证服务端已收到或已处理） */
  dispatched: boolean;
  /** 未派发原因（skipped = 无内容可发；too_large = 阶梯不可再砍；breaker_open =
   * 熔断短路）；已派发时省略。防御分支（classify 契约外 reject）也省略 */
  not_dispatched_reason?: 'skipped' | 'too_large' | 'breaker_open';
  /** 是否提交了片段评分题（实发 questions 含 score 题即 snip{i}） */
  snip_questions_sent: boolean;
  /** 是否取得有效回答（answered——回答形状校验通过且 answers 可用） */
  answered: boolean;
  snippets: SampleJevSentSnippet[];
};

/** Jev 段：判断（per_source 原样）+ 实发派发映射（v2 捕获口径）。 */
export type SampleJev = {
  status: 'ok' | 'no_key' | 'degraded' | 'breaker_open';
  n_requests: number;
  input_tokens: number;
  latency_ms_total: number;
  /** 来源级判断原样（含 answers / snippet_scores / verdict / reason / fail_kind / ladder / sent_snippets） */
  per_source: JevPerSourceStats[];
  /**
   * 实发派发映射（04-04 R1）：每 keep 来源一条、按表序（Brave 原序）——来自管道
   * 交来的 JevDispatchRecord（客户端阶梯后、派发处捕获），样本写入时绝不重建候选。
   * v1 记录本字段是阶梯前重建口径，读取按 format_version 区分
   */
  sent: SampleJevSentSource[];
};

/** 生效配置快照（只收过滤行为面配置，绝无认证材料与环境变量——T-04-02-4）。 */
export type SampleConfigSnapshot = {
  /** 十一项生效阈值（THRESHOLD_SPECS 投影 snake_case） */
  thresholds: Record<string, number>;
  jev: { model: string; timeout_ms: number; concurrency: number };
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
   * 记录格式版本；字段语义变化时递增。2 = 04-04 R1 返修（jev.sent 为客户端阶梯后
   * 实发捕获口径、sent 片段 in_state/score_question_sent/scored 三维拆分、来源级
   * dispatched / not_dispatched_reason，新增 filter_rules_version）。1 = 04-02
   * 初版（sent 为阶梯前重建口径、snippets[].sent 单一布尔、无 filter_rules_version）
   * ——历史样本绝不按 v2 字段语义解释，读取按本值分支。
   */
  format_version: 2;
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
  /** JSONL 信封 sample.path 用的相对 log_dir 路径：`samples/<日期>/<request_id>.json` */
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
   * 实发派发记录（04-04 R1）：FilterResult.jev_dispatch 原样交入——客户端超限
   * 阶梯后、派发处捕获的真实 state 与题目集合。样本 Jev 段只信它，绝不重跑本地
   * 规则重建候选（off / no_key 为空表）
   */
  jevDispatch: JevDispatchRecord[];
  /** 实际返回第一块 JSON（含 output.status_line 带 sample 后缀） */
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
 * 逐片段 scored 的操作口径（04-04 R1）：answered 且位置在实发收分范围内——
 * snippet_scores 长度即实发片段数（cut_tail / source_only 阶梯下短于候选，
 * snippet_scores 缺失时回退 sent_snippets，再回退候选全长）。非 answered 行
 * score 全部 false——"没有有效回答"绝不写成"没提交评分题"或"没发送"。
 */
const isSnippetScored = (
  row: JevPerSourceStats | undefined,
  position: number,
  candidateLength: number
): boolean => {
  if (row === undefined || row.status !== 'answered') return false;
  const scored = row.snippet_scores?.length ?? row.sent_snippets ?? candidateLength;
  return position < scored;
};

/**
 * Jev 段构建（04-04 R1）：判断原样 + 实发派发映射——**只信管道交来的
 * JevDispatchRecord**（客户端超限阶梯后、派发处捕获），绝不重跑本地规则重建候选
 * （重建得到的是阶梯前 state，与实发不符——R1 的病灶）。被阶梯砍掉的片段从实发
 * state 里消失，凭候选全量表（snippet_keys / snippet_texts）保留身份与原文对齐。
 */
const buildJevSection = (input: SampleInput): SampleJev | null => {
  const jev = input.stats.jev;
  if (jev === null) return null; // test 模式不会出现（no_key 也建零值对象）；防御直调

  const rows = new Map(jev.per_source.map((row) => [row.src, row]));

  return {
    status: jev.status,
    n_requests: jev.n_requests,
    input_tokens: jev.input_tokens,
    latency_ms_total: jev.latency_ms_total,
    per_source: structuredClone(jev.per_source),
    sent: input.jevDispatch.map((record) => {
      // 实发 state（阶梯后）与实发题目集合：未派发为 null——不伪造输入证据
      const stateSnippets = record.state?.source.snippets ?? [];
      const snipQuestionCount =
        record.questions === null
          ? 0
          : Object.values(record.questions).filter((question) => question.type === 'score').length;
      const row = rows.get(record.src);
      return {
        src: record.src,
        url: record.url,
        title: record.title,
        state: record.state === null ? null : JSON.stringify(record.state),
        dispatched: record.dispatched,
        ...(record.not_dispatched_reason !== undefined
          ? { not_dispatched_reason: record.not_dispatched_reason }
          : {}),
        snip_questions_sent: record.snip_questions_sent,
        answered: record.answered,
        snippets: record.snippet_keys.map((key, position) => ({
          snippet: key,
          position,
          in_state: position < stateSnippets.length,
          score_question_sent: position < snipQuestionCount,
          scored: isSnippetScored(row, position, record.snippet_keys.length),
          text: record.snippet_texts[position] ?? '',
        })),
      };
    }),
  };
};

/** 成功样本记录构建：字段顺序即序列化顺序，保持稳定。 */
const buildRecord = (
  config: FilterConfig,
  input: SampleInput,
  programVersion: string,
  rulesVersion: string
): SampleRecord => ({
  format_version: 2,
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
  format_version: 2,
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
      const relative = `samples/${localDateStamp(capturedAt)}/${requestId}.json`;
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
