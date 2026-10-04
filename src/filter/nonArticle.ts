/**
 * 非文章规则：空来源 / 一句话来源。
 * 纯函数，不修改输入。
 */

import { tokenize } from './tokenize.js';

/** 最小片段形状：调用方（pipeline 工作表）预算好的幸存片段。 */
type SurvivingSnippet = {
  text: string;
};

/** 仅按幸存片段数判空，不依赖 sources 元数据。 */
export function isEmptySource(survivingSnippets: readonly SurvivingSnippet[]): boolean {
  return survivingSnippets.length === 0;
}

/**
 * 恰好一条片段、长度 < maxLength 且不含 query 实词时判为一句话来源。
 * 本规则只使用 query；intent 的匹配由 Jev 评分处理。queryTerms 为空时保守保留。
 */
export function isOneLiner(
  survivingSnippets: readonly SurvivingSnippet[],
  queryTerms: ReadonlySet<string>,
  maxLength: number = 200
): boolean {
  if (queryTerms.size === 0) return false;
  if (survivingSnippets.length !== 1) return false;

  const [snippet] = survivingSnippets;
  if (snippet.text.length >= maxLength) return false;

  const tokens = new Set(tokenize(snippet.text));
  for (const term of queryTerms) {
    if (tokens.has(term)) return false;
  }
  return true;
}
