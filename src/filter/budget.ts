/**
 * 超量抓取参数放大与步 9 输出预算裁剪。
 * 放大发生在 Brave 请求前，裁剪使用原始请求上限并保留 Brave 原序。
 */

import type { FilterConfig, SnippetRemovalReason, SourceDropReason } from './types.js';

/**
 * Brave 接口上限。与 `src/tools/llm_context/schemas/input.ts` 里
 * `maximum_number_of_urls` 的 `.max(50)`、`maximum_number_of_tokens` 的 `.max(32768)`
 * 同源；上游改数字时这里要跟着改，否则放大后的值会被 Brave 拒绝。
 */
export const BRAVE_MAX_URLS = 50;
export const BRAVE_MAX_TOKENS = 32768;

/**
 * Brave 文档给的缺省上限：模型未传 `maximum_number_of_*` 时按它们理解预算。
 * 步 9 的裁剪与统计表的 request 摘要共用这一份。
 */
export const BRAVE_DEFAULT_MAX_URLS = 20;
export const BRAVE_DEFAULT_MAX_TOKENS = 8192;

type OverfetchableParams = {
  maximum_number_of_urls?: number;
  maximum_number_of_tokens?: number;
};

/**
 * 按倍数放大已有的来源数与总 token 上限，向下取整并夹到 Brave 上限，不增加缺省键。
 * 倍数为 1 返回原引用，否则返回新对象；每来源上限与其他字段原样保留。
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

/** 裁剪需要的最小工作表形状；只改标记，不增删数组元素。 */
export type BudgetSnippetRow = {
  index: number;
  text: string;
  kept: boolean;
  reason?: SnippetRemovalReason;
};

export type BudgetSourceRow = {
  index: number;
  url: string;
  snippets: BudgetSnippetRow[];
  verdict: 'keep' | 'drop';
  reason?: SourceDropReason;
};

/** 步 9 关心的请求上限子集；其余字段（query 等）与裁剪无关。 */
export type BudgetRequest = {
  maximum_number_of_urls?: number;
  maximum_number_of_tokens?: number;
};

/** 按原始请求解析预算，缺项使用 Brave 默认值；不能使用放大后的请求。 */
export function resolveBudget(request: BudgetRequest): { maxUrls: number; maxTokens: number } {
  return {
    maxUrls: request.maximum_number_of_urls ?? BRAVE_DEFAULT_MAX_URLS,
    maxTokens: request.maximum_number_of_tokens ?? BRAVE_DEFAULT_MAX_TOKENS,
  };
}

/** 按原序找最后一个仍幸存的来源；没有时返回 undefined。 */
const lastSurvivingSource = (table: BudgetSourceRow[]): BudgetSourceRow | undefined => {
  for (let i = table.length - 1; i >= 0; i--) {
    if (table[i].verdict === 'keep') return table[i];
  }
  return undefined;
};

/** 按原序找来源里最后一条幸存片段；没有时返回 undefined。 */
const lastKeptSnippet = (source: BudgetSourceRow): BudgetSnippetRow | undefined => {
  for (let i = source.snippets.length - 1; i >= 0; i--) {
    if (source.snippets[i].kept) return source.snippets[i];
  }
  return undefined;
};

/**
 * 先保留 Brave 原序前 N 个幸存来源，再从末源末片段向前删除超出 token 预算的内容。
 * 片段删空时整源也记 budget，不留空壳；只处理 keep 来源，不重排。
 * 每轮至少删除一条片段，因此极小预算也能终止。
 */
export function trimToBudget(
  table: BudgetSourceRow[],
  request: BudgetRequest,
  estimate: (text: string) => number
): void {
  const { maxUrls, maxTokens } = resolveBudget(request);

  let surviving = 0;
  for (const source of table) {
    if (source.verdict !== 'keep') continue;
    surviving += 1;
    if (surviving > maxUrls) {
      source.verdict = 'drop';
      source.reason = 'budget';
    }
  }

  let total = 0;
  for (const source of table) {
    if (source.verdict !== 'keep') continue;
    for (const snippet of source.snippets) {
      if (snippet.kept) total += estimate(snippet.text);
    }
  }

  while (total > maxTokens) {
    const source = lastSurvivingSource(table);
    if (source === undefined) return;

    const snippet = lastKeptSnippet(source);
    if (snippet === undefined) {
      source.verdict = 'drop';
      source.reason = 'budget';
      continue;
    }

    snippet.kept = false;
    snippet.reason = 'budget';
    total -= estimate(snippet.text);
    if (!source.snippets.some((row) => row.kept)) {
      source.verdict = 'drop';
      source.reason = 'budget';
    }
  }
}

/**
 * 输出规模只统计幸存内容；chars 使用 String.length，est_tokens 将估算总和向上取整。
 * 预算判断使用未取整的总和。
 */
export function summarizeOutput(
  table: BudgetSourceRow[],
  estimate: (text: string) => number
): { n_sources: number; n_snippets: number; chars: number; est_tokens: number } {
  let nSources = 0;
  let nSnippets = 0;
  let chars = 0;
  let estimateSum = 0;

  for (const source of table) {
    if (source.verdict !== 'keep') continue;
    nSources += 1;
    for (const snippet of source.snippets) {
      if (!snippet.kept) continue;
      nSnippets += 1;
      chars += snippet.text.length;
      estimateSum += estimate(snippet.text);
    }
  }

  return { n_sources: nSources, n_snippets: nSnippets, chars, est_tokens: Math.ceil(estimateSum) };
}
