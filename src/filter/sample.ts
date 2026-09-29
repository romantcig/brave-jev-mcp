/**
 * test 模式样本落盘（04-02 / SC2+SC3）：每次 test 搜索一份独立 JSON 样本——
 * 过滤前完整响应（schema 校验前克隆）+ 最终实际返回 + 过程映射 + Jev 判断与
 * 稳定身份映射 + 生效配置快照。写入器住纯过滤库（不引任何 MCP 类型），适配层
 * 只交数据。
 *
 * 形状：`createSampleWriter` 是工厂——库不持模块级可变状态（stats.ts 不变式），
 * 程序版本号等进程级只读量住闭包；适配行持惰性单例，先 `allocatePath` 再 `save`
 * （"先分配路径、写入成功后再返回"的顺序契约，实施计划第三节 B）。
 *
 * 身份口径（实施计划第三节 C）：来源身份 = Brave 原始索引 `s{n}`（与
 * per_source.src 同源）；片段身份 = `{merged_from}:{index}` 前缀可省、JSON-LD
 * 多段加 `.{part}`（与统计表 SnippetStats 的 index/part/merged_from 同源）。
 * Jev 实发映射按候选记录每片段身份、文本与 sent 标记——候选口径取
 * `collectJevCandidatesDetailed`（与步 5 同一纯函数同一输入，天然同口径），
 * answered 行的 snippet_scores 长度即实发片段数（cut_tail / source_only 阶梯下
 * 短于候选，snippet_scores 缺失时回退 sent_snippets），未发送的片段标
 * sent:false，不伪造判断。被删内容不重复存正文，凭身份键回 pre_filter 查。
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
 * 依据：测试模式与搜索样本记录实施计划.md 第三节、04-CONTEXT.md 落盘契约四节。
 */

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { buildState, QUESTION_SET_ID } from './jev/questions.js';
import { localDateStamp, localIsoWithOffset, oneLineStderr, thresholdSnapshot } from './logging.js';
import { collectJevCandidatesDetailed } from './pipeline.js';
import type {
  BraveLlmContextResponse,
  FilterConfig,
  FilterMode,
  FilterRequest,
  FilterStats,
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

/** Jev 实发映射里的一条片段：配对身份 + 候选内位置 + 是否落在实发片段题范围 + 文本。 */
export type SampleJevSentSnippet = {
  /** 片段配对身份：`{merged_from}:{index}`（前缀可省）+ 可选 `.{part}` */
  snippet: string;
  /** 候选内位置（即 snip{i} 题位） */
  position: number;
  /**
   * 是否落在实发片段题范围内（cut_tail / source_only 阶梯砍掉的部分为 false——
   * 没有片段题就没有片段级判断）；failed / skipped / breaker_open 行无可对齐
   * 判断，一律 false
   */
  sent: boolean;
  /** 实发（构造 state 时的）片段文本 */
  text: string;
};

/** Jev 实发映射里的一条来源：实发 state 的 JSON 文本 + 逐片段映射。 */
export type SampleJevSentSource = {
  src: string;
  url: string;
  title: string;
  /** 实发 state 的 JSON 文本（buildState 构造口径，与步 5 同一函数同一输入） */
  state: string;
  snippets: SampleJevSentSnippet[];
};

/** Jev 段：判断（per_source 原样）+ 实发 state 还原映射。 */
export type SampleJev = {
  status: 'ok' | 'no_key' | 'degraded' | 'breaker_open';
  n_requests: number;
  input_tokens: number;
  latency_ms_total: number;
  /** 来源级判断原样（含 answers / snippet_scores / verdict / reason / fail_kind / ladder / sent_snippets） */
  per_source: JevPerSourceStats[];
  /** 实发 state 还原映射（候选口径 = collectJevCandidatesDetailed，与步 5 同一纯函数同一输入） */
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
  /** 记录格式版本；字段语义变化时递增 */
  format_version: 1;
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
  /** 过滤程序版本（package.json version） */
  filter_program_version: string;
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
  /** 实际返回第一块 JSON（含 output.status_line 带 sample 后缀） */
  payload: unknown;
  /** 实际返回第二块状态行文本（含 sample 后缀）；无状态行为 null */
  statusLine: string | null;
};

/** save / saveError 的返回：适配行据此决定状态行后缀去留与 JSONL 信封指针。 */
export type SampleWriteStatus = { status: 'saved' | 'failed' };

/** 样本写入器：路径分配 + 成功/错误两种落盘入口。 */
export type SampleWriter = {
  /** 分配样本路径（"先分配路径"顺序契约的第一步）。 */
  allocatePath(requestId: string): AllocatedSamplePath;
  /** 成功请求：构建完整样本并原子落盘。 */
  save(input: SampleInput): SampleWriteStatus;
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
 * 片段是否落在实发片段题范围内（sent 的操作口径）：answered 行的 snippet_scores
 * 长度即实发片段数（cut_tail / source_only 阶梯下短于候选——snippet_scores 缺失
 * 时回退 sent_snippets，再回退候选全长）；其余状态（failed / skipped /
 * breaker_open）没有可对齐的片段级判断，一律 false——未发送（无可对齐判断）的
 * 片段绝不伪造判断。
 */
const isSnippetSent = (
  row: JevPerSourceStats | undefined,
  position: number,
  candidateLength: number
): boolean => {
  if (row === undefined || row.status !== 'answered') return false;
  const sent = row.snippet_scores?.length ?? row.sent_snippets ?? candidateLength;
  return position < sent;
};

/** Jev 段构建：判断原样 + 实发 state 映射（候选重导出与步 5 同一纯函数同一输入）。 */
const buildJevSection = (config: FilterConfig, input: SampleInput): SampleJev | null => {
  const jev = input.stats.jev;
  if (jev === null) return null; // test 模式不会出现（no_key 也建零值对象）；防御直调

  const candidates = collectJevCandidatesDetailed(
    input.preFilter as BraveLlmContextResponse,
    { params: input.filterParams, intent: input.intent },
    config
  );
  const rows = new Map(jev.per_source.map((row) => [row.src, row]));

  return {
    status: jev.status,
    n_requests: jev.n_requests,
    input_tokens: jev.input_tokens,
    latency_ms_total: jev.latency_ms_total,
    per_source: structuredClone(jev.per_source),
    sent: candidates.map((candidate) => {
      const row = rows.get(candidate.id);
      // 实发 state 的文本还原：与步 5 的 dispatch 同一 buildState、同一输入——
      // 记录的是构造时（阶梯前）state；阶梯砍尾范围由 snippets[].sent 表达
      const state = buildState(
        candidate.id,
        candidate.url,
        candidate.title,
        candidate.snippets.map((snippet) => snippet.text),
        input.filterParams.query,
        input.intent
      );
      return {
        src: candidate.id,
        url: candidate.url,
        title: candidate.title,
        state: JSON.stringify(state),
        snippets: candidate.snippets.map((snippet, position) => ({
          snippet: snippet.key,
          position,
          sent: isSnippetSent(row, position, candidate.snippets.length),
          text: snippet.text,
        })),
      };
    }),
  };
};

/** 成功样本记录构建：字段顺序即序列化顺序，保持稳定。 */
const buildRecord = (config: FilterConfig, input: SampleInput, programVersion: string): SampleRecord => ({
  format_version: 1,
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
  jev: buildJevSection(config, input),
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
});

/** 样本序列化：UTF-8、两空格缩进、文件末尾换行、字段顺序稳定、正文原样。 */
const serializeRecord = (record: SampleRecord): string => `${JSON.stringify(record, null, 2)}\n`;

/**
 * 原子落盘：目录自愈（mkdirSync recursive）→ 临时文件单次整写 → 同目录 rename。
 * 任何一步失败：尽力清掉临时文件（清不掉就留着——`.tmp` 后缀不会被误读为完整
 * 样本）、stderr 恰一行可定位告警（oneLineStderr 先例）、返回 failed，绝不抛错。
 */
const writeSampleFile = (path: AllocatedSamplePath, content: string): SampleWriteStatus => {
  const tmpPath = `${path.absolute}.tmp`;
  try {
    mkdirSync(dirname(path.absolute), { recursive: true });
    writeFileSync(tmpPath, content, 'utf8');
    renameSync(tmpPath, path.absolute);
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
 * 创建样本写入器（04-02）：`allocatePath` 先分配路径并捕获锚点 Date，`save`
 * 构建完整记录（深拷贝所有权隔离）后经临时文件 + rename 原子落盘。写入失败
 * fail-open（stderr 一行 + status 'failed'），搜索返回不受影响——适配行据此剥掉
 * 状态行后缀再返回，绝不假装样本已存在。
 * @param config 过滤配置（取 logDir、模式、阈值、jev 组与黑名单；适配行持单例）
 */
export function createSampleWriter(config: FilterConfig): SampleWriter {
  const programVersion = readProgramVersion();

  return {
    allocatePath(requestId: string): AllocatedSamplePath {
      const capturedAt = new Date();
      const relative = `samples/${localDateStamp(capturedAt)}/${requestId}.json`;
      return { absolute: join(config.logDir, relative), relative, capturedAt };
    },
    save(input: SampleInput): SampleWriteStatus {
      return writeSampleFile(input.path, serializeRecord(buildRecord(config, input, programVersion)));
    },
  };
}
