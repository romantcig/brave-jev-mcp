/**
 * test 模式每次搜索保存一份 JSON：原始响应、最终返回、过程映射、Jev 记录与配置。
 * 实发输入只取客户端捕获的证据；错误样本显式标记缺失，不当作零来源成功。
 * 文件经同目录临时文件与 rename 原子写入，失败不影响搜索。
 * 当前格式为 v8；历史样本的读取差异见 FILTERING.md。
 */

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { CONTEXT_LAYOUT_ID, FILTER_RULES_VERSION } from './version.js';
import { QUESTION_SET_ID } from './jev/questions.js';
import { DECISION_RULES_SNAPSHOT } from './jev/threshold.js';
import { snippetCountOfState } from './jev/context.js';
import { snippetKeepThreshold } from './jev/verdict.js';
import {
  localDateStamp,
  localIsoWithOffset,
  oneLineStderr,
  thresholdSnapshot,
  truncateMessage,
} from './logging.js';
import type {
  ChoiceInvalidReason,
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
  JevSnippetGroup,
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

/** 过程映射记录删除原因与执行阶段；正文凭来源和片段身份回 pre_filter 查找。 */
export type SampleOutcome = {
  /** 本地计数（预筛、去重与 GitHub 清洗动作，不存片段正文） */
  local: LocalStats;
  /** 统计表 sources 投影：keep/drop + 逐片段 kept/reason/index/part，无正文 */
  sources: SourceStats[];
};

/** 实发映射中的片段：原始身份、候选位置、组合题状态与候选文本分别记录。 */
export type SampleJevSentSnippet = {
  /** 片段配对身份：`{index}` + 可选 `.{part}` */
  snippet: string;
  /** 本来源实发候选内的位置；组内位置由所属组的 start 推导。 */
  position: number;
  /**
   * 文本是否进入实发 state——按所属请求的实发 state 与该来源的映射位置计算；
   * 全量共享请求的实发范围即候选全长（未派发请求的来源恒 false）
   */
  in_state: boolean;
  /** 所属组合题全局键（来自请求映射；无映射为 null） */
  question: string | null;
  /**
   * 该组合题是否随请求提交——全局键存在于实发 questions 才为 true，
   * 不按题目总数推断
   */
  question_sent: boolean;
  /** 组合题类型（现行全部为 choice） */
  question_type: 'choice';
  /** 组内字母（A 起；无映射为空串） */
  letter: string;
  /** 答案有效并已派生保留概率 */
  valid: boolean;
  /** 本地派生的保留概率（组内含该位字母的选项概率之和）；无效为 null */
  keep_probability: number | null;
  /** 组合题无效原因（仅已回答且该组无效时出现） */
  invalid_reason?: ChoiceInvalidReason;
  /** 该位保留门槛：二/三片组用 group_keep_min，单片组用 single_keep_min */
  threshold: number;
  /** 保留概率是否进入片段裁决；页面层已删时为 false，后续删空来源不改变应用事实。 */
  applied: boolean;
  /** 该片段确实应用了临界裁决时的实际补偿距离（含 0）；原判定删除或不应用时不带。 */
  near_threshold_gap?: number;
  /** 最终是否返回该片段；来源整页删除时也为 drop，缺少过程证据时为 null。 */
  verdict: 'keep' | 'drop' | null;
  /** 最终删除原因，优先记录整页删除原因。 */
  reason?: string;
  /**
   * 候选口径文本（与派发记录 snippet_texts 对齐）：进入实发 state 的片段即实发
   * 文本；未进实发 state 的片段凭本字段与身份键回 pre_filter 对齐原文
   */
  text: string;
};

/**
 * 一次逻辑请求的完整记录，共享载荷只保存一份。
 * 未派发时保留请求事实，state 与 questions 为 null，包括没有派发证据的回答桩。
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

/** 来源身份与所属请求位置的对应关系，载荷通过 request_id 引用请求级记录。 */
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
  /** 是否收到可解析响应；来源裁决是否有效另见 source_verdict_valid。 */
  answered: boolean;
  /**
   * 是否取得有效来源裁决（filler 页面题通过校验并完成裁决）；answered=true
   * 而本值 false = 收到可解析响应但 validation 兜底（状态行提示未完成 Jev 检查）
   */
  source_verdict_valid: boolean;
  snippets: SampleJevSentSnippet[];
};

/**
 * Jev 判断、请求级载荷与来源级实发映射。
 * n_requests 统计至少派发一次的逻辑请求；n_http_attempts 统计 fetch 次数，包含重试。
 * 回答桩若没有派发证据，即使 answered 也计零请求。
 */
export type SampleJev = {
  status: 'ok' | 'no_key' | 'degraded' | 'breaker_open';
  n_requests: number;
  input_tokens: number;
  latency_ms_total: number;
  /** 真实 HTTP 尝试总数，包含重试。 */
  n_http_attempts: number;
  /** 请求级完整记录；一次搜索至多一条共享请求。 */
  requests: SampleJevRequest[];
  /** 来源级判断原样（含 answers / snippet_judgments / verdict / reason / fail_kind / request_id） */
  per_source: JevPerSourceStats[];
  /** 每个本地保留来源一条，按 Brave 原序；载荷通过 request_id 引用请求级记录。 */
  sent: SampleJevSentSource[];
};

/** 生效的过滤配置与只读运行规则快照，不含认证材料或环境变量。 */
export type SampleConfigSnapshot = {
  /** 三项生效阈值（THRESHOLD_SPECS 投影 snake_case） */
  thresholds: Record<string, number>;
  /** 只读构建规则快照，不代表本次命中；读取时允许缺失，不是可写配置组。 */
  decision_rules?: { near_threshold_max_gap: number };
  /** Jev 客户端配置：模型、单次尝试超时与并发上限。 */
  jev: {
    model: string;
    timeout_ms: number;
    concurrency: number;
  };
  mode: FilterMode;
};

/** 错误路径的缺失标记，避免将未取得结果解释成零来源成功。 */
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
  /** 当前样本格式版本；跨版本读取规则见 FILTERING.md。 */
  format_version: 8;
  request_id: string;
  /** 本地 ISO 带时区偏移（复用 logging.ts 的 localIsoWithOffset 口径） */
  ts: string;
  mode: FilterMode;
  request: {
    /** 模型给的原始参数（钳位前，原样含 intent 键） */
    params: Record<string, unknown>;
    /** 实际发给 Brave 的参数 */
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
  /** 过滤规则的构建标识，独立于包版本。 */
  filter_rules_version: string;
};

// ---------------------------------------------------------------------------
// 写入器
// ---------------------------------------------------------------------------

/** 一次分配同时取得路径和时间，避免跨午夜时目录日期与样本时间戳不一致。 */
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
  /** 实际发给 Brave 的参数 */
  braveParams: Record<string, unknown>;
  /** filterLlmContext 收到的查询参数（候选重导出与阶段 3 同口径） */
  filterParams: FilterRequest;
  intent: string;
  /** schema 校验前克隆的完整响应（所有权已隔离，save 内再深拷贝一层） */
  preFilter: unknown;
  /** 过滤统计（jev 判断、outcome 过程映射的来源） */
  stats: FilterStats;
  /**
   * FilterResult.jev_dispatch 原样交入，供样本读取派发处捕获的来源身份。
   * 不在保存时重跑本地规则；off / no_key 为空表。
   */
  jevDispatch: JevDispatchRecord[];
  /**
   * FilterResult.jev_requests 原样交入，保存每次逻辑请求的载荷、答案和映射。
   * sent[] 通过 request_id 引用；off / no_key 为空表。
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
  /** 实际发给 Brave 的参数 */
  braveParams: Record<string, unknown>;
  intent: string;
  /** 失败阶段：Brave 请求层 / 响应 schema 校验（与 JSONL 错误记录同口径） */
  stage: 'brave' | 'schema';
  /** 失败原因（saveError 内截断到 200 字符，与 writeError 同口径） */
  message: string;
  /** schema 失败时保留的可用原始响应快照（safeParse 前克隆）；Brave 失败为 null */
  preFilter: unknown;
};

/** 可注入文件写入、重命名和规则版本读取，测试各失败阶段与版本记录。 */
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
 * 逐题读取管道记录的保留概率判断，不由候选数量或题数推断。
 * 是否采用该概率由 applied 单独记录。
 */
const snippetJudgmentAt = (
  record: JevDispatchRecord,
  position: number
): { kind: 'keep_probability'; value: number } | null =>
  record.snippet_judgments?.[position] ?? null;

/**
 * 从 JevRequestRecord 与 JevDispatchRecord 构建记录，不重建候选。
 * in_state 与 question_sent 逐位检查实发载荷和题目映射；
 * 没有派发载荷时均为 false，不以候选全长或题目总数代替证据。
 * 门槛按组大小选择（与裁决共用 snippetKeepThreshold），applied 要求页面层未删除来源。
 */
const buildJevSection = (input: SampleInput, config: FilterConfig): SampleJev | null => {
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
    // 该位所属组合题是否随请求提交：映射组的全局键必须存在于实发 questions
    const sentQuestions = request?.questions ?? null;
    const groupOf = (position: number): JevSnippetGroup | undefined =>
      mappingEntry?.snippet_groups.find(
        (group) => group.start <= position && position < group.start + group.size
      );
    const row = rows.get(record.src);
    const sourceOutcome = input.stats.sources.find((source) => `s${source.index}` === record.src);
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
      snippets: record.snippet_keys.map((key, position) => {
        const group = groupOf(position);
        const globalKey =
          group !== undefined ? (mappingEntry?.question_keys[group.key] ?? null) : null;
        const questionSent =
          globalKey !== null && sentQuestions !== null && Object.hasOwn(sentQuestions, globalKey);
        const judgment = snippetJudgmentAt(record, position);
        const valid = judgment !== null;
        const snippetOutcome = sourceOutcome?.snippets.find(
          (snippet) =>
            `${snippet.index}${snippet.part !== undefined ? `.${snippet.part}` : ''}` === key
        );
        const verdict =
          sourceOutcome?.verdict === 'drop'
            ? 'drop'
            : snippetOutcome !== undefined
              ? snippetOutcome.kept
                ? 'keep'
                : 'drop'
              : null;
        const reason =
          sourceOutcome?.verdict === 'drop' ? sourceOutcome.reason : snippetOutcome?.reason;
        return {
          snippet: key,
          position,
          in_state: position < stateSnippetCount,
          question: globalKey,
          question_sent: questionSent,
          question_type: 'choice' as const,
          letter: group !== undefined ? (group.letters[position - group.start] ?? '') : '',
          valid,
          keep_probability: judgment?.value ?? null,
          ...(valid
            ? {}
            : row?.status === 'answered' && group !== undefined
              ? { invalid_reason: row.snippet_validation?.[group.key] ?? ('missing' as const) }
              : {}),
          threshold:
            group !== undefined
              ? snippetKeepThreshold(group.size, config.thresholds)
              : config.thresholds.singleKeepMin,
          applied:
            valid &&
            questionSent &&
            position < stateSnippetCount &&
            row?.verdict === 'keep' &&
            row.snippet_judgments?.length === record.snippet_keys.length,
          ...(snippetOutcome?.near_threshold_gap !== undefined
            ? { near_threshold_gap: snippetOutcome.near_threshold_gap }
            : {}),
          verdict,
          ...(reason !== undefined ? { reason } : {}),
          text: record.snippet_texts[position] ?? '',
        };
      }),
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
  format_version: 8,
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
  jev: buildJevSection(input, config),
  config_snapshot: {
    thresholds: thresholdSnapshot(config),
    decision_rules: { ...DECISION_RULES_SNAPSHOT },
    jev: {
      model: config.jev.model,
      timeout_ms: config.jev.timeoutMs,
      concurrency: config.jev.concurrency,
    },
    mode: config.mode,
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
  format_version: 8,
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
    decision_rules: { ...DECISION_RULES_SNAPSHOT },
    jev: {
      model: config.jev.model,
      timeout_ms: config.jev.timeoutMs,
      concurrency: config.jev.concurrency,
    },
    mode: config.mode,
  },
  question_set_id: QUESTION_SET_ID,
  context_layout_id: CONTEXT_LAYOUT_ID,
  filter_program_version: programVersion,
  filter_rules_version: rulesVersion,
});

/** 样本序列化：UTF-8、两空格缩进、文件末尾换行、字段顺序稳定、正文原样。 */
const serializeRecord = (record: SampleRecord): string => `${JSON.stringify(record, null, 2)}\n`;

/**
 * 同目录临时文件整写后 rename，避免半截 JSON 被读取为成功样本。
 * content 延迟到 try 内构建，使序列化错误与写入失败一样返回 failed 并告警。
 * 失败时尽力清理临时文件；残留的 .tmp 不作为完整样本。
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
 * 先 allocatePath，再保存完整样本或错误样本，最后由宿主返回结果。
 * 保存时深拷贝并同步序列化；失败返回 failed，宿主据此移除状态行样本后缀。
 * 绝对路径按进程工作目录解析，与实际写入一致；日志指针始终相对 logDir。
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
