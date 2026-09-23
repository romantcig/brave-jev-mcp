/**
 * 预算相关：超量倍数的放大与夹取。
 *
 * 步 9「裁回预算」的 `trimToBudget` 由 01-04 计划在本文件补上；本计划只落
 * `applyOverfetch`，它在 `execute()` 调 Brave 之前放大请求上限。
 *
 * 依据：notes/local-rules-design.md §6、PLAN.md §5「超量抓取」。
 */

import type { FilterConfig } from './types.js';

/**
 * Brave 接口上限。与 `src/tools/llm_context/schemas/input.ts` 里
 * `maximum_number_of_urls` 的 `.max(50)`、`maximum_number_of_tokens` 的 `.max(32768)`
 * 同源；上游改数字时这里要跟着改，否则放大后的值会被 Brave 拒绝。
 */
export const BRAVE_MAX_URLS = 50;
export const BRAVE_MAX_TOKENS = 32768;

type OverfetchableParams = {
  maximum_number_of_urls?: number;
  maximum_number_of_tokens?: number;
};

/**
 * 按超量倍数放大来源数与总 token 上限。
 * - 倍数为 1 时返回**入参同一引用**：默认配置下适配行零行为差异。
 * - 倍数 > 1 时返回新对象：只在原值存在时放大（向下取整）并夹到 Brave 上限，
 *   不凭空添加键；`maximum_number_of_tokens_per_url` 与其余字段原样保留。
 * - 永不修改入参。
 * @returns 倍数为 1 时是 `params` 本身；否则是放大后的新对象
 * @example applyOverfetch(p, { mode: 'off', overfetchFactor: 1 }) === p
 * @example applyOverfetch({ maximum_number_of_urls: 5 }, { mode: 'off', overfetchFactor: 2 }).maximum_number_of_urls === 10
 * @example applyOverfetch({ maximum_number_of_urls: 50 }, { mode: 'off', overfetchFactor: 2 }).maximum_number_of_urls === 50
 */
export function applyOverfetch<T extends OverfetchableParams>(params: T, config: FilterConfig): T {
  const factor = config.overfetchFactor;
  if (factor === 1) return params;

  const scaled: OverfetchableParams = {};

  if (params.maximum_number_of_urls !== undefined) {
    scaled.maximum_number_of_urls = Math.min(
      BRAVE_MAX_URLS,
      Math.floor(params.maximum_number_of_urls * factor)
    );
  }

  if (params.maximum_number_of_tokens !== undefined) {
    scaled.maximum_number_of_tokens = Math.min(
      BRAVE_MAX_TOKENS,
      Math.floor(params.maximum_number_of_tokens * factor)
    );
  }

  return { ...params, ...scaled };
}
