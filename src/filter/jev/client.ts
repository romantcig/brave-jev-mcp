/**
 * Jev 直连客户端的纯函数部分（JEV-02）：请求构造与响应解析。
 *
 * 本文件不发任何网络请求——传输兜底（超时、重试、熔断、并发闸、32k 阶梯）由
 * 02-05 的 `createJevClassifier` 实现，经 `FilterDeps.classify` 注入管道。解析对
 * 响应做白名单收窄（isRecord + 逐字段 typeof，不 spread 解析结果，V5/T-02-02-1）：
 * 未知键忽略、形状不对返回判别联合而非抛错——Jev API 响应跨信任边界入库，畸形
 * /恶意形状绝不进库内类型。
 *
 * 响应形状以两份重录夹具实证为准（02-RESEARCH「真实响应形状」）：
 * `{ model: "jev-1.13.0", answers: {...}, usage: { input_tokens, output_tokens } }`；
 * noul 答案 `{ type: 'noul', noul }`（无 confidence 字段），score 答案
 * `{ type: 'score', score, confidence, legend, probabilities }`（后三者不进库内类型）。
 *
 * 依据：notes/jev-api.md、02-RESEARCH.md「Jev 客户端设计」、src/utils.ts 判别联合先例。
 */

import type { JevAnswer, JevQuestion, JevState } from '../types.js';

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
