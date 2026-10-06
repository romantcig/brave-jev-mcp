/**
 * 非文章规则：空来源判定。
 * 纯函数，不修改输入。
 */

/** 最小片段形状：调用方（pipeline 工作表）预算好的幸存片段。 */
type SurvivingSnippet = {
  text: string;
};

/** 仅按幸存片段数判空，不依赖 sources 元数据。 */
export function isEmptySource(survivingSnippets: readonly SurvivingSnippet[]): boolean {
  return survivingSnippets.length === 0;
}
