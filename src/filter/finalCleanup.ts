/** 最终幸存片段的有限清理：只返回同一来源内的整片删除动作，不修改正文或输入。 */
import { codeRegionFlags } from './prefilter.js';
import type { FinalCleanupAction, JevCandidateSnippetIdentity } from './types.js';

/** 代码中的符号与空白可能有意义，整片排除，包括波浪号围栏和 Tab 缩进。 */
const hasCode = (text: string): boolean =>
  text.includes('`') || codeRegionFlags(text.split(/\r?\n/)).some(Boolean);

/** 仅归一标题标记、有限加粗与空白；大小写、数字、否定、单位和标点原样保留。 */
const normalizeProse = (text: string): string =>
  text
    .replace(/^\s*#{1,6}\s+/gm, '')
    .replace(/(?<!\w)\*\*(\S(?:.*?\S)?)\*\*(?!\w)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();

/** 恰好两行：重复页面标题的一级标题，随后只有空 Key takeaways 栏目。 */
const isEmptyTakeaways = (text: string, title: string): boolean => {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length !== 2 || !lines[0].startsWith('# ')) return false;
  const heading = lines[0].slice(2).trim();
  const section = lines[1]
    .replace(/^#{1,6}\s+/, '')
    .replace(/^\*\*(.*?)\*\*$/, '$1')
    .trim();
  const repeatsTitle =
    title === heading || title.startsWith(`${heading} - `) || title.startsWith(`${heading} | `);
  return repeatsTitle && section.toLowerCase() === 'key takeaways';
};

/**
 * 输入必须为同一工作表来源中经语义裁决后的幸存片段，顺序为原片段顺序。
 * 长文本优先建立最终代表，同长保留较早片段；仅动作选择排序，不重排输出。
 * 长度下限 40 个码元只约束匹配，不是效果或费用指标。
 */
export function cleanFinalSnippets(
  snippets: readonly JevCandidateSnippetIdentity[],
  title: string
): FinalCleanupAction[] {
  const actions: FinalCleanupAction[] = [];
  const candidates: Array<{ key: string; text: string; position: number }> = [];
  snippets.forEach((snippet, position) => {
    if (hasCode(snippet.text)) return;
    if (isEmptyTakeaways(snippet.text, title)) {
      actions.push({ rule: 'empty_takeaways', snippet: snippet.key });
      return;
    }
    const text = normalizeProse(snippet.text);
    if (text.length >= 40) candidates.push({ key: snippet.key, text, position });
  });
  candidates.sort((a, b) => b.text.length - a.text.length || a.position - b.position);
  const representatives: typeof candidates = [];
  for (const candidate of candidates) {
    const escaped = candidate.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const contains = new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, 'u');
    const cover = representatives.find((representative) => contains.test(representative.text));
    if (cover !== undefined) {
      actions.push({
        rule: 'same_source_exact_coverage',
        snippet: candidate.key,
        covered_by: cover.key,
      });
    } else representatives.push(candidate);
  }
  return actions;
}
