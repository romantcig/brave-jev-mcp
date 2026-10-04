/**
 * 跨来源片段严格逐字去重。
 * 按 Brave 原序遍历已保留来源的幸存片段，仅当文本与先前其他保留来源中已保留的完整片段严格相等（===）时删除。
 * 纯本地规则，不依赖 Jev 答案、题干或事实指纹。
 */

import type { FilterStats, SnippetRemovalReason, SourceDropReason } from './types.js';

/** 工作表里的一条片段（最小形状）。 */
export type DedupSnippetRow = {
  index: number;
  text: string;
  kept: boolean;
  reason?: SnippetRemovalReason;
};

/** 工作表里的一个来源（最小形状）。 */
export type DedupSourceRow = {
  index: number;
  url: string;
  snippets: DedupSnippetRow[];
  verdict: 'keep' | 'drop';
  reason?: SourceDropReason;
};

/**
 * 按 Brave 原序执行跨来源完整文本去重：
 * 1. 仅当前来源之前的其他已保留来源中幸存的非空片段文本作为参照。
 * 2. 只有当前片段与参照集合中的文本严格全等（===）时才删除。
 * 3. 被删片段标记 kept=false、reason='dup'，递增 stats.local.cross_source_dup_removed。
 * 4. 当前来源幸存的非空片段文本在该来源处理完成后才加入跨来源参照集，避免混入页内删除。
 * 5. 返回发生过跨源去重删除的来源索引集合，供后续空来源/一句话来源归因判定。
 */
export function applyCrossSourceDedup(
  table: DedupSourceRow[],
  stats: FilterStats
): ReadonlySet<number> {
  const crossSourceDeleted = new Set<number>();
  const seenTexts = new Set<string>();

  for (const sourceRow of table) {
    if (sourceRow.verdict !== 'keep') continue;

    const sourceIndex = sourceRow.index;
    const survivingTextsInSource: string[] = [];

    for (const snippet of sourceRow.snippets) {
      if (!snippet.kept) continue;

      // 严格全等匹配：大小写、空白、标点、缩进不同均视为不同文本
      if (seenTexts.has(snippet.text)) {
        snippet.kept = false;
        snippet.reason = 'dup';
        stats.local.cross_source_dup_removed += 1;
        crossSourceDeleted.add(sourceIndex);
        continue;
      }

      // 空文本交给空来源流程，不作为重复参照
      if (snippet.text !== '') {
        survivingTextsInSource.push(snippet.text);
      }
    }

    // 同来源片段处理完后，再加入跨来源参照集
    for (const text of survivingTextsInSource) {
      seenTexts.add(text);
    }
  }

  return crossSourceDeleted;
}
