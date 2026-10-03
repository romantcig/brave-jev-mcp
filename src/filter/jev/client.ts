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

import type {
  ClassifyDeps,
  ClassifyFailKind,
  ClassifyOutcome,
  JevAnswer,
  JevDispatchPayload,
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
 * - 答案逐键收窄（逐题隔离，all-only 唯一语义）：`type: 'noul'` 缺数值 `noul`、
 *   `type: 'score'` 缺数值 `score` → 只忽略该题，不拖垮同一响应里其他来源的有效答案，
 *   由来源级校验防御。顶层协议错误（形状、缺字段）仍整体失败。其余键（未知 type、
 *   非对象值）白名单外，忽略不进结果。
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
      if (typeof value.noul !== 'number') continue; // 逐题隔离：坏答案不拖垮其他题
      answers[key] = { kind: 'noul', probability: value.noul };
    } else if (value.type === 'score') {
      if (typeof value.score !== 'number') continue; // 逐题隔离：坏答案不拖垮其他题
      answers[key] = { kind: 'score', score: value.score };
    }
    // 其余 type 不在协议白名单内：忽略该键，不抛、不收进结果
  }

  return { ok: true, model: body.model, answers, input_tokens: body.usage.input_tokens };
}

/** 用量是独立的响应事实：即使 HTTP 或答案校验失败，也保留可取得的非负有限值。 */
const responseInputTokens = (bodyText: string): number | undefined => {
  try {
    const body: unknown = JSON.parse(bodyText);
    if (!isRecord(body) || !isRecord(body.usage)) return undefined;
    const value = body.usage.input_tokens;
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
  } catch {
    return undefined;
  }
};

// ---------------------------------------------------------------------------
// 传输兜底（02-05）：仅 TypeSafe 直连单后端（JEV-01）。
// ---------------------------------------------------------------------------

/** Jev 直连端点（notes/jev-api.md 实录）；后端集合只有 typesafe，无第二端点。 */
export const JEVI_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';

/** 重试总尝试次数（SAFE-03；每次尝试各自持有超时信号）。 */
export const RETRY_ATTEMPTS = 3;

/** 首次重试前的退避毫秒数。 */
export const RETRY_BACKOFF_BASE_MS = 500;

/** 退避倍率：500 → 1000 …（与封顶、随机抖动一同构成 `backoffDelayMs`）。 */
export const RETRY_BACKOFF_MULTIPLIER = 2;

/**
 * 单次退避封顶毫秒数（PLAN 第 5 节"兜底"行：500 × 2^(n-1) 封顶 5s，再随机减最多
 * 25%）。
 */
export const RETRY_BACKOFF_CAP_MS = 5000;

/**
 * Retry-After 要求等待超过该上限就放弃该源按"留"（PLAN 第 5 节"兜底"行：搜索在
 * 同步等 Jev，官方 SDK 最多照办 60 s 的等待会卡住整次搜索）。与退避封顶是两条
 * 独立决策，数值当前相同但分开声明（审查 R9），调其中一个不连带另一个。
 */
export const RETRY_AFTER_MAX_MS = 5000;

/** 退避的随机抖动上限比例：`(1 - 0.25 × random)`（PLAN 第 5 节"兜底"行）。 */
export const RETRY_JITTER_RATIO = 0.25;

/** 连续瞬态失败达到该次数即开熔断（SAFE-02 / A7）。 */
export const BREAKER_THRESHOLD = 3;

/** 熔断开启时长毫秒数（SAFE-02：60s；到期直接闭合不做半开探测）。 */
export const BREAKER_OPEN_MS = 60000;

/** 计入熔断连续计数的失败 kind：瞬态传输类。auth / validation 是确定性请求
 * 问题，不计入（避免配置错误伪装成熔断——本计划 flagged 微决策）。 */
const TRANSIENT_FAILURE_KINDS: ReadonlySet<ClassifyFailKind> = new Set([
  'timeout',
  'rate_limited',
  'network',
]);

/**
 * key 环境变量：只认官方 SDK（typesafe-sdk-js / typesafe-sdk-python）同名的
 * `TYPESAFE_API_KEY`（老大 2026-09-27 定）。key 只从 env 参数读进闭包内存，
 * 绝不落盘、绝不进错误面（T-02-05-1）。
 */
const KEY_ENV_NAME = 'TYPESAFE_API_KEY';

/** 读 key 原值；未设或全空白返回空串（调用方已用 hasJevKey 预检）。 */
const readKey = (env: Record<string, string | undefined>): string => {
  const value = env[KEY_ENV_NAME];
  return typeof value === 'string' && value.trim() !== '' ? value : '';
};

/**
 * 判定环境里是否配置了 Jev key（存在且非空白）。
 * 适配行用它实现 no_key 语义（EMBED-05）：缺失且 mode 非 off → 不创建实例、
 * stderr 一行、管道记 no_key 零请求（等价 off）。
 * @example hasJevKey({}) === false
 * @example hasJevKey({ TYPESAFE_API_KEY: 'k' }) === true
 * @example hasJevKey({ TYPESAFE_API_KEY: '  ' }) === false
 */
export function hasJevKey(env: Record<string, string | undefined>): boolean {
  return readKey(env) !== '';
}

/** AbortSignal.timeout 触发的 reject 名（Node 实测 'TimeoutError'；手动 abort 为 'AbortError'），二者都按超时记。 */
const ABORT_ERROR_NAMES: ReadonlySet<string> = new Set(['AbortError', 'TimeoutError']);

/**
 * 第 attempt 次尝试失败后的退避毫秒数：`min(500 × 2^(attempt-1), 5000)`，再乘
 * `(1 - 0.25 × random)`（PLAN 第 5 节"兜底"行：封顶 5s、随机减最多 25%）。
 * `random` 由 hooks 注入，测试用固定值做精确断言。
 */
const backoffDelayMs = (attempt: number, random: () => number): number => {
  const capped = Math.min(
    RETRY_BACKOFF_BASE_MS * RETRY_BACKOFF_MULTIPLIER ** (attempt - 1),
    RETRY_BACKOFF_CAP_MS
  );
  return capped * (1 - RETRY_JITTER_RATIO * random());
};

/**
 * 解析 Retry-After 的等待毫秒数：先 `retry-after-ms`（毫秒，可小数），再
 * `retry-after`（秒数，或 HTTP 日期——按 `now` 换算成距现在的毫秒数）。
 * 头缺失、空、非数或换算成负数 → undefined（用普通退避）。
 */
export const parseRetryAfterMs = (response: Response, now: () => number): number | undefined => {
  const header = (name: string): string | null => {
    const value = response.headers.get(name);
    return value !== null && value.trim() !== '' ? value.trim() : null;
  };

  const msHeader = header('retry-after-ms');
  if (msHeader !== null) {
    const ms = Number(msHeader);
    return Number.isFinite(ms) && ms >= 0 ? ms : undefined;
  }

  const secondsHeader = header('retry-after');
  if (secondsHeader === null) return undefined;

  // 纯数字（含小数）= 秒数；解析不了再按 HTTP 日期试
  const seconds = Number(secondsHeader);
  if (Number.isFinite(seconds)) return seconds >= 0 ? seconds * 1000 : undefined;

  const date = Date.parse(secondsHeader);
  if (!Number.isFinite(date)) return undefined;
  const delta = date - now();
  return delta >= 0 ? delta : undefined;
};

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

/** 测试注入的时钟、睡眠与随机数（缺省用全局实现）。 */
export type JevClassifierHooks = {
  /** 单调时钟：熔断窗口计时与 Retry-After 日期换算用；缺省 `Date.now`。 */
  now?: () => number;
  /** 退避睡眠；缺省 `setTimeout`。测试注入立即 resolve 以做下限断言。 */
  sleep?: (ms: number) => Promise<void>;
  /** 退避抖动用的随机数（`[0,1)`）；缺省 `Math.random`，测试注入固定值。 */
  random?: () => number;
};

/**
 * 创建 Jev 分类器：工厂闭包形态（照 src/protocols/rebinding.ts 先例）——进程级
 * 状态（并发信号量、熔断计数）全部住闭包，库无模块级可变状态。每个实例独立：
 * 测试每用例新建实例互不污染。
 *
 * 并发闸（JEV-04，Responsibility Map 划定层级）：上限 `config.jev.concurrency`
 * （默认 12），一波全发、超出排队等待，**跨管道调用生效**——管道只做全候选并发
 * 派发，不建双闸。名额在 classify 全程持有（重试不加闸、不重复取名额）；释放时
 * 直接把名额交给队首等待者（**交接**，不先减后加），否则新调用会插队使在途数
 * 超过上限。
 *
 * 熔断（SAFE-02）：**进闸之前与出闸之后各查一次**——熔断打开时已在队列里的请求
 * 醒来后照样会发，故出闸后复查，命中则释放名额并返回 `breaker_open`（零 fetch、
 * 不计 n_requests，与短路同口径）。
 *
 * 超时（SAFE-01）：每次尝试各自套 `AbortSignal.timeout(config.jev.timeoutMs)`，
 * 不手写 Promise.race。
 *
 * 重试（SAFE-03，2026-09-27 定）：
 * - **超时（含读正文阶段）不重试**，立即 `timeout` 失败；fetch 的其他异常重试
 *   （`network`）。
 * - HTTP：408 重试（`timeout`）、429/529 重试（`rate_limited`）、其余 5xx 重试
 *   （`network`）；401/403 不重试（`auth`）、422 与其他 4xx 不重试（`validation`）、
 *   200 但形状坏不重试（`validation`）。
 * - 总尝试次数 `RETRY_ATTEMPTS`(3)；退避 `min(500×2^(n-1), 5000)` 再随机减最多
 *   25%（`hooks.random`）。可重试响应上的 **Retry-After** 优先：解析值 ≤ 5s 就用它
 *   代替本次退避；> 5s 则不再重试、立即按该状态的 kind 失败（计入熔断）。
 * - 计入熔断的 kind 只有瞬态类（timeout / rate_limited / network）。
 *
 * 请求体（all-only，§3.1）：完整载荷只构造一次，重试原样复用——同一搜索的重试
 * 复用完全相同的 body、检索时间和题目，属于同一逻辑请求。32K／64K 预检、估算与
 * 超限阶梯已整体退役；输入限额交给 Jev 服务的 HTTP 拒绝（413／422 按 validation
 * 处理）与既有保守保留语义兜底。
 *
 * http_attempts（计划 §3.3）：所有返回点带真实 HTTP 尝试次数——重试循环内是当前
 * attempt，熔断短路与注入桩可不带或为 0；管道按未知处理。
 *
 * 实发派发捕获（04-04 R1）：请求体定形后（fetch 调用前）捕获实发
 * state 与题目集合，随所有从重试循环返回的 outcome（answered 或已派发后失败）
 * 以 `dispatch` 交回——样本记录的"实发内容"只信这里，绝不重建。未派发的短路
 * （breaker_open，进闸前后）不带 dispatch——请求从未离开进程。
 *
 * 失败一律返回 failed 联合不抛（SAFE-01：单来源失败按"留"）。detail 只含状态码与
 * body 前 200 字符摘要，绝不拼接鉴权头或 key 值（T-02-05-1）。
 *
 * @param config `FilterConfig['jev']`（model / timeoutMs / concurrency）
 * @param env key 来源（生产传 `process.env`；测试传显式对象）
 * @param hooks 可选时钟 / 睡眠 / 随机数注入（测试用）
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
  const now = hooks?.now ?? Date.now;
  const random = hooks?.random ?? Math.random;

  // 进程级并发闸（JEV-04）：active < concurrency 直接进，否则排队等唤醒。
  let active = 0;
  const waiters: Array<() => void> = [];
  const acquire = async (): Promise<void> => {
    if (active < concurrency) {
      active += 1;
      return;
    }
    await new Promise<void>((resolve) => waiters.push(resolve));
  };
  /** 名额交接：有等待者时把名额直接交给队首（计数不变），没有才减计数。 */
  const release = (): void => {
    const next = waiters.shift();
    if (next !== undefined) {
      next();
      return;
    }
    active -= 1;
  };

  // 熔断状态（SAFE-02）：连续瞬态失败计数跨请求累计；任一 answered 清零；
  // 连续达 BREAKER_THRESHOLD → openUntil = now + BREAKER_OPEN_MS；到期直接闭合
  // 不做半开探测。同波在途请求无取消逻辑（无 AbortController 广播）。
  let consecutiveFailures = 0;
  let openUntil = 0;

  /** 瞬态失败记账：只有 timeout / rate_limited / network 计入熔断连续计数——
   * auth / validation 是确定性请求问题，计入会让配置错误伪装成熔断。 */
  const recordFailure = (kind: ClassifyFailKind): void => {
    if (!TRANSIENT_FAILURE_KINDS.has(kind)) return;
    consecutiveFailures += 1;
    if (consecutiveFailures >= BREAKER_THRESHOLD) {
      openUntil = now() + BREAKER_OPEN_MS;
    }
  };

  /** 熔断窗口检查：open 期返回短路结果；到期则闭合、计数清零并返回 undefined。
   * 短路零 fetch——http_attempts 恒 0（FULL_CONTEXT_ROLLOUT_PLAN §6.1）。 */
  const breakerShortCircuit = (): ClassifyOutcome | undefined => {
    if (openUntil === 0) return undefined;
    if (now() < openUntil) {
      return {
        status: 'failed',
        kind: 'breaker_open',
        detail: 'circuit open after consecutive transient failures',
        http_attempts: 0,
      };
    }
    openUntil = 0;
    consecutiveFailures = 0;
    return undefined;
  };

  /** 异常按名判超时：AbortSignal 触发的 AbortError / TimeoutError 都算。 */
  const kindOfThrow = (error: unknown): ClassifyFailKind => {
    const name = (error as { name?: string } | null)?.name;
    return name !== undefined && ABORT_ERROR_NAMES.has(name) ? 'timeout' : 'network';
  };

  const throwFailure = (kind: ClassifyFailKind, error: unknown): ClassifyOutcome => ({
    status: 'failed',
    kind,
    ...(error instanceof Error && error.message !== ''
      ? { detail: error.message.slice(0, 200) }
      : {}),
  });

  const classify: ClassifyDeps['classify'] = async ({ state, questions }) => {
    // 熔断短路（进闸前）：open 期直接返回，零 fetch 且不占并发名额
    const beforeQueue = breakerShortCircuit();
    if (beforeQueue !== undefined) return beforeQueue;

    await acquire();
    try {
      // 熔断复查（出闸后）：排队期间熔断可能已打开——醒来后照样发就失去了熔断意义
      const afterQueue = breakerShortCircuit();
      if (afterQueue !== undefined) return afterQueue;

      // 请求体只构造一次（§3.1）：完整载荷原样发送，同一搜索的重试复用完全相同的
      // body、检索时间和题目
      const body = JSON.stringify(buildRequest(state, questions, model));

      // 实发派发捕获（04-04 R1）：请求体已定形、即将派发——从这里到本闭包的所有
      // 返回点都属"请求已派发"（fetch 已调用；每次重试复用同一 body，实发内容
      // 不变）。样本层据此如实记录，绝不重跑本地规则重建。
      const dispatch: JevDispatchPayload = { state, questions };
      let knownInputTokens = 0;
      let attemptsWithUsage = 0;
      let responseStatus: number | undefined;
      /** 统一给返回结果附上实发载荷与真实 HTTP 尝试数；不修改入参（写时复制约定）。 */
      const withDispatch = (outcome: ClassifyOutcome, attempts: number): ClassifyOutcome => ({
        ...outcome,
        dispatch,
        http_attempts: attempts,
        ...(attemptsWithUsage > 0 ? { input_tokens: knownInputTokens } : {}),
        usage_complete: attemptsWithUsage === attempts,
        ...(responseStatus !== undefined ? { http_status: responseStatus } : {}),
      });

      /** 非 200 状态的 kind 映射；`retryable` 决定是否进入退避重试。 */
      const statusOutcome = (
        status: number
      ): { kind: ClassifyFailKind; retryable: boolean } | undefined => {
        if (status === 401 || status === 403) return { kind: 'auth', retryable: false };
        if (status === 408) return { kind: 'timeout', retryable: true };
        if (status === 429 || status === 529) return { kind: 'rate_limited', retryable: true };
        if (status >= 500 && status <= 599) return { kind: 'network', retryable: true };
        return { kind: 'validation', retryable: false };
      };

      // 重试循环（SAFE-03）：每次尝试独立超时信号；超时不重试
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
          const kind = kindOfThrow(error);
          if (kind === 'timeout' || attempt >= RETRY_ATTEMPTS) {
            recordFailure(kind);
            return withDispatch(throwFailure(kind, error), attempt);
          }
          await sleep(backoffDelayMs(attempt, random));
          continue;
        }

        // 读正文也纳入重试与熔断口径：此处断连/超时原先会裸抛，绕过两者
        let bodyText: string;
        try {
          bodyText = await response.text();
        } catch (error) {
          const kind = kindOfThrow(error);
          if (kind === 'timeout' || attempt >= RETRY_ATTEMPTS) {
            recordFailure(kind);
            return withDispatch(throwFailure(kind, error), attempt);
          }
          await sleep(backoffDelayMs(attempt, random));
          continue;
        }

        const status = response.status;
        responseStatus = status;
        const inputTokens = responseInputTokens(bodyText);
        if (inputTokens !== undefined) {
          knownInputTokens += inputTokens;
          attemptsWithUsage += 1;
        }
        // 全量响应按题隔离坏值（all-only 唯一解析语义）
        const parsed = parseJevResponse(status, bodyText);
        if (parsed.ok) {
          // 任一成功清零连续失败计数（SAFE-02）
          consecutiveFailures = 0;
          return withDispatch(
            {
              status: 'answered',
              model: parsed.model,
              answers: parsed.answers,
              input_tokens: parsed.input_tokens,
            },
            attempt
          );
        }

        // 200 但形状坏：确定性，不重试（重试必然再坏）
        if (parsed.kind === 'shape')
          return withDispatch(httpFailure('validation', status, bodyText), attempt);

        const mapped = statusOutcome(status);
        if (mapped === undefined || !mapped.retryable) {
          // auth / validation 不计熔断（确定性请求问题）
          return withDispatch(httpFailure(mapped?.kind ?? 'validation', status, bodyText), attempt);
        }

        // Retry-After 优先于普通退避；要求等超上限就干脆不再重试
        const retryAfterMs = parseRetryAfterMs(response, now);
        if (retryAfterMs !== undefined && retryAfterMs > RETRY_AFTER_MAX_MS) {
          recordFailure(mapped.kind);
          return withDispatch(httpFailure(mapped.kind, status, bodyText), attempt);
        }
        if (attempt >= RETRY_ATTEMPTS) {
          recordFailure(mapped.kind);
          return withDispatch(httpFailure(mapped.kind, status, bodyText), attempt);
        }
        await sleep(retryAfterMs !== undefined ? retryAfterMs : backoffDelayMs(attempt, random));
      }
    } finally {
      release();
    }
  };

  return { classify };
}
