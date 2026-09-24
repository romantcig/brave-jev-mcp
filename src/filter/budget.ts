/**
 * 预算相关：超量倍数的放大与夹取、步 9 的裁回预算。
 *
 * `applyOverfetch` 在 `execute()` 调 Brave 之前放大请求上限；`trimToBudget`
 * 是管道步 9：把模型请求的上限当作输出上限，在工作表上翻标记裁掉超额部分。
 *
 * 依据：notes/local-rules-design.md §6、PLAN.md §5「超量抓取」、
 * 01-RESEARCH.md「规则 9（步 9）」。
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

/**
 * 步 9 工作表行的最小形状：pipeline 的工作表结构上满足它（多出的字段不参与
 * 裁剪），测试也按它构造。裁剪只翻这些标记，不增删数组元素（RULES-08）。
 */
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

/**
 * 解析步 9 的有效预算：上限缺省按 Brave 默认 urls 20 / tokens 8192（模型不传时
 * Brave 也按此返回）。裁剪一律按模型原始请求值，与 `applyOverfetch` 放大后的
 * 请求参数无关。
 * @example resolveBudget({}) → { maxUrls: 20, maxTokens: 8192 }
 * @example resolveBudget({ maximum_number_of_urls: 5 }) → { maxUrls: 5, maxTokens: 8192 }
 */
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
 * 步 9：把输出裁回模型请求的预算。先按 Brave 序取前 N 个仍幸存的来源，第 N+1 个
 * 及之后整体丢（`reason: 'budget'`）；再算幸存片段的**未取整**估算和，超过
 * `maxTokens` 时从最后一个幸存来源的最后一条幸存片段开始逐条翻
 * `kept: false, reason: 'budget'`——某来源片段删光则该来源也不留空壳（
 * `verdict: 'drop', reason: 'budget'`），继续砍前一源。全程只翻标记、不重排
 * （RULES-08），只在 `verdict === 'keep'` 的来源上做（被丢来源的片段不重复计入）。
 * 每轮循环至少把一条片段翻成已删，有限步内终止，极小预算不会死循环（T-01-04-02）。
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
 * 步 9 之后的输出规模：只数幸存来源与其幸存片段。`chars` 是幸存片段
 * `String.length` 之和；`est_tokens` 是未取整估算和的 `Math.ceil`（保守方向，
 * 与 Phase 2 的 32k 保护同向）。预算比较本身用未取整的和，这里才取整。
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
