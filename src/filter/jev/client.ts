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

import type { ClassifyDeps, ClassifyFailKind, JevAnswer, JevQuestion, JevState } from '../types.js';
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

/**
 * 创建 Jev 分类器：工厂闭包形态（照 src/protocols/rebinding.ts 先例）——进程级
 * 状态（并发信号量；熔断计数由后续任务填）全部住闭包，库无模块级可变状态。
 * 每个实例独立：测试每用例新建实例互不污染。
 *
 * 并发闸（JEV-04，Responsibility Map 划定层级）：上限 `config.jev.concurrency`
 * （默认 12，02-02 config 解析坏值回落），一波全发、超出排队等待，**跨管道调用
 * 生效**——管道只做全候选并发派发，不建双闸。名额在 classify 全程持有（后续
 * 重试任务不加闸、不重复取名额）。
 *
 * 超时（SAFE-01）：每次请求用 `AbortSignal.timeout(config.jev.timeoutMs)`
 * （默认 15000），不手写 Promise.race。超时 / 传输异常按错误名区分 kind：
 * abort 类 → 'timeout'，其余 → 'network'。
 *
 * HTTP 状态映射（Task 1 单次尝试，重试白名单由后续任务加）：401 → 'auth'、
 * 422 → 'validation'、429/529 → 'rate_limited'、其余状态 → 'network'；200 但
 * 形状坏 → 'validation'（与回放传输同口径）。失败一律返回 failed 联合不抛
 * （SAFE-01：单来源失败按"留"）。detail 只含状态码与 body 前 200 字符摘要，
 * 绝不拼接鉴权头或 key 值（T-02-05-1）。
 *
 * @param config `FilterConfig['jev']`（model / backend / timeoutMs / concurrency）
 * @param env key 来源（生产传 `process.env`；测试传显式对象）
 * @returns `{ classify }`——管道经 `FilterDeps.classify` 注入
 */
export function createJevClassifier(
  config: FilterConfig['jev'],
  env: Record<string, string | undefined>
): ClassifyDeps {
  const key = readKey(env);
  const { model, timeoutMs, concurrency } = config;

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
    // 熔断短路（后续任务）将在此处之前返回，不占名额；本任务直接取名额。
    await acquire();
    try {
      const request = buildRequest(state, questions, model);
      let response: Response;
      try {
        response = await fetch(JEVI_ENDPOINT, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${key}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(request),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        const name = (error as { name?: string } | null)?.name;
        return {
          status: 'failed',
          kind: name !== undefined && ABORT_ERROR_NAMES.has(name) ? 'timeout' : 'network',
          ...(error instanceof Error && error.message !== ''
            ? { detail: error.message.slice(0, 200) }
            : {}),
        };
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
        };
      }
      if (parsed.kind === 'shape') {
        // 200 但形状坏：与回放传输同口径，按校验失败记（不重试，重试必然再坏）
        return { status: 'failed', kind: 'validation', detail: `200 ${bodyText.slice(0, 200)}` };
      }
      const kind: ClassifyFailKind =
        status === 401
          ? 'auth'
          : status === 422
            ? 'validation'
            : status === 429 || status === 529
              ? 'rate_limited'
              : 'network';
      // detail 只含状态码与 body 摘要——鉴权头与 key 永不出现在错误面（T-02-05-1）
      return { status: 'failed', kind, detail: `${status} ${bodyText.slice(0, 200)}` };
    } finally {
      release();
    }
  };

  return { classify };
}
