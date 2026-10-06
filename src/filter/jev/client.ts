/**
 * Jev 请求构造、响应解析与直连传输。
 * 响应按字段白名单收窄，坏答案逐题隔离；失败以判别联合返回。
 * 并发闸、重试与熔断状态保存在分类器闭包中，由宿主共享实例。
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

/** 发给 Jev 的请求体。 */
export type JevRequest = {
  model: string;
  state: JevState;
  questions: Record<string, JevQuestion>;
};

/** 成功解析携带模型版本、答案与 input_tokens；失败区分 HTTP 状态和响应形状。 */
export type ParsedJevResponse =
  | { ok: true; model: string; answers: Record<string, JevAnswer>; input_tokens: number }
  | { ok: false; kind: 'http' | 'shape'; status?: number };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** choice 概率分布：非数组键值对象，每值有限且在 [0,1]。 */
const isProbabilityDistribution = (value: unknown): value is Record<string, number> =>
  isRecord(value) &&
  Object.values(value).every(
    (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1
  );

/** 原样携带 state 与题目表，不修改入参；模型版本由调用方钉住。 */
export function buildRequest(
  state: JevState,
  questions: Record<string, JevQuestion>,
  model: string
): JevRequest {
  return { model, state, questions };
}

/**
 * 非 200 返回 http 失败；JSON、顶层字段或 input_tokens 不合法返回 shape 失败。
 * 答案逐键收窄：忽略未知类型或形状不符的题目，保留其他有效答案。
 * choice 的标签齐全性与概率和由投影层对照实发 criteria 校验；单题取值范围
 * 由裁决层进一步校验，重试策略由传输层处理。
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
    } else if (value.type === 'choice') {
      if (!isProbabilityDistribution(value.probabilities)) continue; // 逐题隔离：坏答案不拖垮其他题
      answers[key] = {
        kind: 'choice',
        ...(typeof value.choice === 'string' ? { choice: value.choice } : {}),
        probabilities: value.probabilities,
      };
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

// 传输与失败处理

/** TypeSafe Jev 直连端点。 */
export const JEVI_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';

/** 含首次请求在内的最大尝试次数。 */
export const RETRY_ATTEMPTS = 3;

/** 首次重试前的退避毫秒数。 */
export const RETRY_BACKOFF_BASE_MS = 500;

/** 退避倍率：500 → 1000 …（与封顶、随机抖动一同构成 `backoffDelayMs`）。 */
export const RETRY_BACKOFF_MULTIPLIER = 2;

/** 单次普通退避的上限毫秒数，随后再施加随机抖动。 */
export const RETRY_BACKOFF_CAP_MS = 5000;

/**
 * Retry-After 超过此等待上限时停止重试，避免阻塞整次搜索。
 * 它与普通退避上限独立，调整其中一个不影响另一个。
 */
export const RETRY_AFTER_MAX_MS = 5000;

/** 退避的随机抖动比例上限。 */
export const RETRY_JITTER_RATIO = 0.25;

/** 连续瞬态失败达到该次数时开启熔断。 */
export const BREAKER_THRESHOLD = 3;

/** 熔断开启时长（毫秒）；到期直接闭合，不做半开探测。 */
export const BREAKER_OPEN_MS = 60000;

/** 仅瞬态传输失败计入熔断，避免将认证或请求参数错误当作服务不可用。 */
const TRANSIENT_FAILURE_KINDS: ReadonlySet<ClassifyFailKind> = new Set([
  'timeout',
  'rate_limited',
  'network',
]);

/** 密钥只从 env 读取到闭包内存，不落盘，也不主动拼入错误详情。 */
const KEY_ENV_NAME = 'TYPESAFE_API_KEY';

/** 读 key 原值；未设或全空白返回空串（调用方已用 hasJevKey 预检）。 */
const readKey = (env: Record<string, string | undefined>): string => {
  const value = env[KEY_ENV_NAME];
  return typeof value === 'string' && value.trim() !== '' ? value : '';
};

/** 密钥存在且非空白时返回 true；宿主据此决定是否创建分类器。 */
export function hasJevKey(env: Record<string, string | undefined>): boolean {
  return readKey(env) !== '';
}

/** AbortSignal.timeout 触发的 reject 名（Node 实测 'TimeoutError'；手动 abort 为 'AbortError'），二者都按超时记。 */
const ABORT_ERROR_NAMES: ReadonlySet<string> = new Set(['AbortError', 'TimeoutError']);

/**
 * 第 attempt 次失败后的退避：min(500 × 2^(attempt-1), 5000) × (1 - 0.25 × random)。
 * 测试可注入固定随机数。
 */
const backoffDelayMs = (attempt: number, random: () => number): number => {
  const capped = Math.min(
    RETRY_BACKOFF_BASE_MS * RETRY_BACKOFF_MULTIPLIER ** (attempt - 1),
    RETRY_BACKOFF_CAP_MS
  );
  return capped * (1 - RETRY_JITTER_RATIO * random());
};

/**
 * 解析 Retry-After 的等待毫秒数，只认标准"秒数"格式（可含小数）。
 * 头缺失、空、非数或负数 → undefined（用普通退避）。
 * 不解析 `retry-after-ms` 与 HTTP-date。
 */
export const parseRetryAfterMs = (response: Response): number | undefined => {
  const raw = response.headers.get('retry-after');
  if (raw === null || raw.trim() === '') return undefined;
  const seconds = Number(raw.trim());
  if (!Number.isFinite(seconds)) return undefined;
  return seconds >= 0 ? seconds * 1000 : undefined;
};

/** HTTP 失败详情仅保留状态码与正文前 200 字符。 */
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
  /** 当前时间戳：用于熔断窗口；缺省 Date.now。 */
  now?: () => number;
  /** 退避睡眠；缺省 `setTimeout`。测试注入立即 resolve 以做下限断言。 */
  sleep?: (ms: number) => Promise<void>;
  /** 退避抖动用的随机数（`[0,1)`）；缺省 `Math.random`，测试注入固定值。 */
  random?: () => number;
};

/**
 * 创建可跨搜索共享的分类器；并发闸和熔断计数按实例隔离。
 * 一次 classify 在排队后持有一个名额直到结束，重试不重复取名额。
 * 请求体只构造一次；失败返回 failed，由管道保守保留相关来源。
 * env 提供密钥，hooks 可注入时钟、睡眠和随机数供测试使用。
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

  // 名额不足时排队；同一实例的所有搜索共用此闸。
  let active = 0;
  const waiters: Array<() => void> = [];
  const acquire = async (): Promise<void> => {
    if (active < concurrency) {
      active += 1;
      return;
    }
    await new Promise<void>((resolve) => waiters.push(resolve));
  };
  /** 有等待者时直接交接名额，不先减计数，避免新请求插队突破并发上限。 */
  const release = (): void => {
    const next = waiters.shift();
    if (next !== undefined) {
      next();
      return;
    }
    active -= 1;
  };

  // 连续瞬态失败跨请求累计，成功响应清零；熔断不会取消已在途的请求。
  let consecutiveFailures = 0;
  let openUntil = 0;

  /** 只统计瞬态失败，认证或请求参数错误不计入熔断。 */
  const recordFailure = (kind: ClassifyFailKind): void => {
    if (!TRANSIENT_FAILURE_KINDS.has(kind)) return;
    consecutiveFailures += 1;
    if (consecutiveFailures >= BREAKER_THRESHOLD) {
      openUntil = now() + BREAKER_OPEN_MS;
    }
  };

  /** 熔断期内返回零 HTTP 尝试的短路结果；到期闭合并清零计数。 */
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

      // 请求体只构造一次，重试复用相同的正文、检索时间和题目。
      const body = JSON.stringify(buildRequest(state, questions, model));

      // 捕获即将派发的载荷，供样本记录使用；不在保存时重建候选。
      // 重试循环的结果附带此载荷，前面的熔断短路不带。
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
        // 429 表示上游限流，按当前传输策略立即返回：
        // 单次尝试即按 rate_limited 失败，不读 Retry-After，照旧计入熔断。
        if (status === 429) return { kind: 'rate_limited', retryable: false };
        if (status === 529) return { kind: 'rate_limited', retryable: true };
        if (status >= 500 && status <= 599) return { kind: 'network', retryable: true };
        return { kind: 'validation', retryable: false };
      };

      // 每次尝试独立计时；AbortSignal 超时不重试，HTTP 408 按状态策略重试。
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

        // 读取正文也可能断连或超时，按与 fetch 相同的重试和熔断策略处理。
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

        const parsed = parseJevResponse(status, bodyText);
        if (parsed.ok) {
          // 成功响应清零连续失败计数。
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

        // 响应顶层形状错误按 validation 返回，不重试。
        if (parsed.kind === 'shape')
          return withDispatch(httpFailure('validation', status, bodyText), attempt);

        const mapped = statusOutcome(status);
        if (mapped === undefined || !mapped.retryable) {
          // auth / validation 不计熔断（确定性请求问题）
          return withDispatch(httpFailure(mapped?.kind ?? 'validation', status, bodyText), attempt);
        }

        // 仅可重试状态会走到这里；Retry-After 优先于普通退避，要求等超上限就干脆不再重试
        const retryAfterMs = parseRetryAfterMs(response);
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
