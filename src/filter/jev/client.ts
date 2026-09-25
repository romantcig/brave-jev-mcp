/**
 * Jev 直连客户端：纯函数部分（JEV-02：请求构造与响应解析）+ 传输兜底
 * （`createJevClassifier`：超时、进程级并发闸；重试与熔断由 02-05 后续任务填）。
 *
 * 解析对响应做白名单收窄（isRecord + 逐字段 typeof，不 spread 解析结果，
 * V5/T-02-02-1）：未知键忽略、形状不对返回判别联合而非抛错——Jev API 响应跨
 * 信任边界入库，畸形/恶意形状绝不进库内类型。
 *
 * 库不变式：无模块级可变状态（stats.ts 注释）——熔断计数、并发闸等进程级状态
 * 全部住 `createJevClassifier` 返回的闭包里，实例由适配行惰性单例持有（A13）。
 *
 * 响应形状以两份重录夹具实证为准（02-RESEARCH「真实响应形状」）：
 * `{ model: "jev-1.13.0", answers: {...}, usage: { input_tokens, output_tokens } }`；
 * noul 答案 `{ type: 'noul', noul }`（无 confidence 字段），score 答案
 * `{ type: 'score', score, confidence, legend, probabilities }`（后三者不进库内类型）。
 *
 * 依据：notes/jev-api.md、02-RESEARCH.md「Jev 客户端设计」「兜底机制」、
 * src/utils.ts 判别联合先例、src/protocols/rebinding.ts 工厂闭包先例。
 */

import { estimateTokens } from '../tokens.js';
import type {
  ClassifyDeps,
  ClassifyFailKind,
  ClassifyOutcome,
  JevAnswer,
  JevLadderLevel,
  JevQuestion,
  JevState,
} from '../types.js';
import type { FilterConfig } from '../types.js';

/** 发给 Jev 的请求体（与 notes/jev-api.md 的 `{"model","state","questions"}` 同形）。 */
export type JevRequest = {
  model: string;
  state: JevState;
  questions: Record<string, JevQuestion>;
};

/**
 * 解析结果：ok 分支带实际模型版本 ID 与 input_tokens（JEV-02 契约——答案必须能
 * 对账模型与用量）；失败分支 `kind: 'http'`（非 200，带状态码）或 `'shape'`
 * （200 但形状不对）。绝不抛裸错误。
 */
export type ParsedJevResponse =
  | { ok: true; model: string; answers: Record<string, JevAnswer>; input_tokens: number }
  | { ok: false; kind: 'http' | 'shape'; status?: number };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * 构造请求体：state 与题目表原样携带（写时复制，不改入参），模型版本由调用方钉住
 * （生产传 `DEFAULT_JEV_MODEL`，绝不使用 latest 别名——JEV-06）。
 * @example buildRequest(state, questions, 'jev-1.13.0') → { model: 'jev-1.13.0', state, questions }
 */
export function buildRequest(
  state: JevState,
  questions: Record<string, JevQuestion>,
  model: string
): JevRequest {
  return { model, state, questions };
}

/**
 * 收窄 Jev 响应：只认实证形状，白名单外一律忽略或判 'shape'。
 *
 * - 非 200 → `{ ok: false, kind: 'http', status }`（422 超限也在此，重试与否由传输层裁决）。
 * - bodyText 非 JSON、顶层缺 model / answers、usage 缺有限数值 input_tokens
 *   → `{ ok: false, kind: 'shape' }`（JEV-02：input_tokens 是必须带回的契约字段）。
 * - 答案逐键收窄：`type: 'noul'` 缺数值 `noul`、`type: 'score'` 缺数值 `score`
 *   → 整体 'shape'；其余键（未知 type、非对象值）白名单外，忽略不进结果。
 *
 * @param status HTTP 状态码
 * @param bodyText 响应原文
 * @example parseJevResponse(200, '{"model":"jev-1.13.0",...}') → { ok: true, model, answers, input_tokens }
 * @example parseJevResponse(422, '...') → { ok: false, kind: 'http', status: 422 }
 * @example parseJevResponse(200, 'not json') → { ok: false, kind: 'shape' }
 */
export function parseJevResponse(status: number, bodyText: string): ParsedJevResponse {
  if (status !== 200) return { ok: false, kind: 'http', status };

  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return { ok: false, kind: 'shape' };
  }
  if (!isRecord(body)) return { ok: false, kind: 'shape' };
  if (typeof body.model !== 'string') return { ok: false, kind: 'shape' };
  if (!isRecord(body.usage)) return { ok: false, kind: 'shape' };
  if (typeof body.usage.input_tokens !== 'number' || !Number.isFinite(body.usage.input_tokens)) {
    return { ok: false, kind: 'shape' };
  }
  if (!isRecord(body.answers)) return { ok: false, kind: 'shape' };

  const answers: Record<string, JevAnswer> = {};
  for (const [key, value] of Object.entries(body.answers)) {
    if (!isRecord(value)) continue; // 白名单外：忽略该键
    if (value.type === 'noul') {
      if (typeof value.noul !== 'number') return { ok: false, kind: 'shape' };
      answers[key] = { kind: 'noul', probability: value.noul };
    } else if (value.type === 'score') {
      if (typeof value.score !== 'number') return { ok: false, kind: 'shape' };
      answers[key] = { kind: 'score', score: value.score };
    }
    // 其余 type 不在协议白名单内：忽略该键，不抛、不收进结果
  }

  return { ok: true, model: body.model, answers, input_tokens: body.usage.input_tokens };
}

// ---------------------------------------------------------------------------
// 传输兜底（02-05）：仅 TypeSafe 直连单后端（JEV-01）。
// ---------------------------------------------------------------------------

/** Jev 直连端点（notes/jev-api.md 实录）；后端集合只有 typesafe，无第二端点。 */
export const JEVI_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';

/** 重试总尝试次数（SAFE-03 / A5 落定；探测脚本的 6 次口径不适用于服务器）。 */
export const RETRY_ATTEMPTS = 3;

/** 首次重试前的退避毫秒数（A5）。 */
export const RETRY_BACKOFF_BASE_MS = 500;

/** 退避倍率：500 → 1000 → 2000 …（A5）。 */
export const RETRY_BACKOFF_MULTIPLIER = 2;

/** 单次退避封顶毫秒数（A5；影子期可调）。 */
export const RETRY_BACKOFF_CAP_MS = 4000;

/** 32k 限额：state + 最长单题（token，notes/jev-api.md；JEV-05）。 */
const LADDER_LIMIT_32K = 32000;

/** 64k 限额：state + 全部问题（token，notes/jev-api.md；JEV-05）。 */
const LADDER_LIMIT_64K = 64000;

/** 估算余量：估算公式不保证偏高，按 15% 放大保守侧（notes/jev-api.md）。 */
const LADDER_TOKEN_MARGIN = 1.15;

/** 片段级 score 题的键形态（`snip{i}`）。 */
const SNIP_KEY_PATTERN = /^snip\d+$/;

/**
 * key 环境变量读取顺序（A9 落定）：探测脚本现名 `jev_API_KEY` →
 * `TYPESAFE_API_KEY`，原样沿用不发明新名。key 只从 env 参数读进闭包内存，
 * 绝不落盘、绝不进错误面（T-02-05-1）。
 */
const KEY_ENV_NAMES = ['jev_API_KEY', 'TYPESAFE_API_KEY'] as const;

/**
 * 判定环境里是否配置了 Jev key：按 A9 顺序找第一个存在且非空白的值。
 * 适配行用它实现 no_key 语义（EMBED-05）：缺失且 mode 非 off → 不创建实例、
 * stderr 一行、管道记 no_key 零请求（等价 off）。
 * @example hasJevKey({}) === false
 * @example hasJevKey({ jev_API_KEY: 'k' }) === true
 * @example hasJevKey({ TYPESAFE_API_KEY: 'k' }) === true
 * @example hasJevKey({ jev_API_KEY: '  ' }) === false
 */
export function hasJevKey(env: Record<string, string | undefined>): boolean {
  for (const name of KEY_ENV_NAMES) {
    const value = env[name];
    if (typeof value === 'string' && value.trim() !== '') return true;
  }
  return false;
}

/** 按 A9 顺序读 key 原值；缺失返回空串（调用方已用 hasJevKey 预检）。 */
const readKey = (env: Record<string, string | undefined>): string => {
  for (const name of KEY_ENV_NAMES) {
    const value = env[name];
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return '';
};

/** AbortSignal.timeout 触发的 reject 名（Node 实测 'TimeoutError'；手动 abort 为 'AbortError'），二者都按超时记。 */
const ABORT_ERROR_NAMES: ReadonlySet<string> = new Set(['AbortError', 'TimeoutError']);

/** 第 attempt 次尝试失败后的退避毫秒数：500 × 2^(attempt-1) 封顶 4000（A5）。 */
const backoffDelayMs = (attempt: number): number =>
  Math.min(RETRY_BACKOFF_BASE_MS * RETRY_BACKOFF_MULTIPLIER ** (attempt - 1), RETRY_BACKOFF_CAP_MS);

/** HTTP 失败的 detail：只含状态码与 body 前 200 字符摘要（T-02-05-1）。 */
const httpFailure = (
  kind: ClassifyFailKind,
  status: number,
  bodyText: string
): ClassifyOutcome => ({
  status: 'failed',
  kind,
  detail: `${status} ${bodyText.slice(0, 200)}`,
});

/**
 * 超限阶梯（JEV-05，A12 判据映射）：发送前用 `estimateTokens` 加 15% 余量对两条
 * 限额做保护（超限直接 422，不是截断——必须自己降级）。
 *
 * - ② 32k（state + 最长单题）超 → 从尾片段开始逐个砍（Brave 序），每砍一片段
 *   同时删对应 `snip{i}` 题，重算直到满足或片段砍光（ladder `cut_tail`）。
 * - ③ 64k（state + 全部问题）超 → 去掉全部 snip 题（来源级题与 state 片段保留，
 *   ladder `source_only_questions`——深于 cut_tail，直接覆盖）。
 * - ④ 仅来源级题仍超 32k（state 本身不可再砍）→ 返回 null：该来源不问 Jev
 *   （too_large；per_source 的 ladder `'skipped'` 由管道按 kind 记账）。
 *
 * 估算只复用 `../tokens.js` 的 `estimateTokens`（01-04 明文，不复制实现）。
 * 写时复制：绝不改入参 state / questions（砍尾 slice 拷贝、删题浅拷贝）。
 * 阶梯只影响该来源的请求内容。
 */
const applyOversizeLadder = (
  state: JevState,
  questions: Record<string, JevQuestion>,
  ladder: { value?: JevLadderLevel }
): { state: JevState; questions: Record<string, JevQuestion> } | null => {
  let workState = state;
  let workQuestions = questions;

  const over32k = (current: JevState, currentQuestions: Record<string, JevQuestion>): boolean => {
    const estState = estimateTokens(JSON.stringify(current));
    let longestQuestion = 0;
    for (const question of Object.values(currentQuestions)) {
      longestQuestion = Math.max(longestQuestion, estimateTokens(JSON.stringify(question)));
    }
    return (estState + longestQuestion) * LADDER_TOKEN_MARGIN > LADDER_LIMIT_32K;
  };

  // ② 32k：砍尾片段 + 对应 snip 题，重算直到满足或砍光
  while (over32k(workState, workQuestions) && workState.source.snippets.length > 0) {
    const snippets = workState.source.snippets.slice(0, -1);
    workQuestions = { ...workQuestions };
    delete workQuestions[`snip${snippets.length}`];
    workState = { ...workState, source: { ...workState.source, snippets } };
    ladder.value = 'cut_tail';
  }

  // ③ 64k：去掉全部 snip 题（来源级题保留；state 片段保留）
  if (
    (estimateTokens(JSON.stringify(workState)) +
      Object.values(workQuestions).reduce(
        (sum, question) => sum + estimateTokens(JSON.stringify(question)),
        0
      )) *
      LADDER_TOKEN_MARGIN >
    LADDER_LIMIT_64K
  ) {
    workQuestions = Object.fromEntries(
      Object.entries(workQuestions).filter(([name]) => !SNIP_KEY_PATTERN.test(name))
    );
    ladder.value = 'source_only_questions';
  }

  // ④ 仅来源级题仍超 32k（state 本身不可再砍）→ 该来源不问 Jev
  if (over32k(workState, workQuestions)) return null;

  return { state: workState, questions: workQuestions };
};

/** 测试注入的时钟与睡眠（02-05 A5/A7）：缺省用全局实现。 */
export type JevClassifierHooks = {
  /** 单调时钟：熔断窗口计时（Task 3）用；缺省 `Date.now`。 */
  now?: () => number;
  /** 退避睡眠；缺省 `setTimeout`。测试注入立即 resolve 以做下限断言。 */
  sleep?: (ms: number) => Promise<void>;
};

/**
 * 创建 Jev 分类器：工厂闭包形态（照 src/protocols/rebinding.ts 先例）——进程级
 * 状态（并发信号量；熔断计数由 Task 3 填）全部住闭包，库无模块级可变状态。
 * 每个实例独立：测试每用例新建实例互不污染。
 *
 * 并发闸（JEV-04，Responsibility Map 划定层级）：上限 `config.jev.concurrency`
 * （默认 12，02-02 config 解析坏值回落），一波全发、超出排队等待，**跨管道调用
 * 生效**——管道只做全候选并发派发，不建双闸。名额在 classify 全程持有（重试不
 * 加闸、不重复取名额）。
 *
 * 超时（SAFE-01）：每次尝试各自套 `AbortSignal.timeout(config.jev.timeoutMs)`
 * （默认 15000），不手写 Promise.race。abort 类错误 → 'timeout'，其余抛错 →
 * 'network'。
 *
 * 重试（SAFE-03）：白名单只有 HTTP 429 / 529 与 fetch 网络异常（含超时）——
 * `RETRY_ATTEMPTS`（3）次尝试、退避 500ms 起倍率 2 封顶 4s。401 / 422 绝不重试
 * （422 重试必然再 422，Pitfall 7）；其余状态与 200 形状坏同样快速失败。
 *
 * 超限阶梯（JEV-05）：发送前按 `applyOversizeLadder` 降级；不可再砍 → 不发请求
 * 直接 failed 'too_large'。answered outcome 带实际生效的 ladder 级别名（未降级
 * 不记）；too_large 的 per_source ladder `'skipped'` 由管道按 kind 记账。
 *
 * HTTP 状态映射：401 → 'auth'、422 → 'validation'、429/529 → 'rate_limited'、
 * 其余状态 → 'network'；200 但形状坏 → 'validation'（与回放传输同口径）。失败
 * 一律返回 failed 联合不抛（SAFE-01：单来源失败按"留"）。detail 只含状态码与
 * body 前 200 字符摘要，绝不拼接鉴权头或 key 值（T-02-05-1）。
 *
 * @param config `FilterConfig['jev']`（model / backend / timeoutMs / concurrency）
 * @param env key 来源（生产传 `process.env`；测试传显式对象）
 * @param hooks 可选时钟 / 睡眠注入（测试用）
 * @returns `{ classify }`——管道经 `FilterDeps.classify` 注入
 */
export function createJevClassifier(
  config: FilterConfig['jev'],
  env: Record<string, string | undefined>,
  hooks?: JevClassifierHooks
): ClassifyDeps {
  const key = readKey(env);
  const { model, timeoutMs, concurrency } = config;
  const sleep =
    hooks?.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  // 进程级并发闸（JEV-04）：active < concurrency 直接进，否则排队等唤醒。
  let active = 0;
  const waiters: Array<() => void> = [];
  const acquire = async (): Promise<void> => {
    if (active >= concurrency) {
      await new Promise<void>((resolve) => waiters.push(resolve));
    }
    active += 1;
  };
  const release = (): void => {
    active -= 1;
    waiters.shift()?.();
  };

  const classify: ClassifyDeps['classify'] = async ({ state, questions }) => {
    // 熔断短路（Task 3）将在此处之前返回，不占名额；本任务直接取名额。
    await acquire();
    try {
      // 超限阶梯（JEV-05）：发送前降级；null = 不可再砍，不发请求
      const ladder: { value?: JevLadderLevel } = {};
      const prepared = applyOversizeLadder(state, questions, ladder);
      if (prepared === null) {
        return {
          status: 'failed',
          kind: 'too_large',
          detail:
            'estimated state + longest question exceeds the 32k limit even with all snippets cut',
        };
      }
      const sendState = prepared.state;
      const sendQuestions = prepared.questions;
      const body = JSON.stringify(buildRequest(sendState, sendQuestions, model));

      // 重试循环（SAFE-03）：白名单 429 / 529 / 网络异常，每次尝试独立超时信号
      for (let attempt = 1; ; attempt += 1) {
        let response: Response;
        try {
          response = await fetch(JEVI_ENDPOINT, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${key}`,
              'Content-Type': 'application/json',
            },
            body,
            signal: AbortSignal.timeout(timeoutMs),
          });
        } catch (error) {
          const name = (error as { name?: string } | null)?.name;
          const kind: ClassifyFailKind =
            name !== undefined && ABORT_ERROR_NAMES.has(name) ? 'timeout' : 'network';
          if (attempt >= RETRY_ATTEMPTS) {
            return {
              status: 'failed',
              kind,
              ...(error instanceof Error && error.message !== ''
                ? { detail: error.message.slice(0, 200) }
                : {}),
            };
          }
          await sleep(backoffDelayMs(attempt));
          continue;
        }

        const status = response.status;
        const bodyText = await response.text();
        const parsed = parseJevResponse(status, bodyText);
        if (parsed.ok) {
          return {
            status: 'answered',
            model: parsed.model,
            answers: parsed.answers,
            input_tokens: parsed.input_tokens,
            ...(ladder.value !== undefined ? { ladder: ladder.value } : {}),
          };
        }
        if (parsed.kind === 'shape') {
          // 200 但形状坏：确定性，不重试（重试必然再坏）
          return httpFailure('validation', status, bodyText);
        }
        if (status === 401) {
          return httpFailure('auth', status, bodyText);
        }
        if (status === 422) {
          return httpFailure('validation', status, bodyText);
        }
        if (status === 429 || status === 529) {
          if (attempt >= RETRY_ATTEMPTS) {
            return httpFailure('rate_limited', status, bodyText);
          }
          await sleep(backoffDelayMs(attempt));
          continue;
        }
        // 白名单外状态（500 等）：确定性失败，不烧限额
        return httpFailure('network', status, bodyText);
      }
    } finally {
      release();
    }
  };

  return { classify };
}
