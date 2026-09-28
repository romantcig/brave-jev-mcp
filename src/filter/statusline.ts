/**
 * 状态行生成（管道步 10）：从统计对象投影出一行英文摘要，追加在工具返回的
 * `content` 末尾作为第二个 text 块，同时写进 `stats.output.status_line`
 * （LOG-03 同源：适配行追加第二块时读的就是这个字段，绝不自创条件）。
 *
 * 口径（03-CONTEXT D-01..D-08）：
 * - 英文单行，形如 `[filter] dropped 4 of 12 sources: 2 rewrite, 1 stale, 1 blocklist; 17 snippets removed`；
 * - 来源按原因计数，原因词直接用 `SourceDropReason` 键原样（含 `budget` 并入
 *   计数；`merged` 不算丢弃——归并是动作不是信息损失）；片段只给一个总数
 *   （幸存来源内被删片段，被丢来源的片段不重复计，与 dev/compare.ts 的
 *   `afterOf` 同式）；
 * - 附加条件（任一成立就附，全都没有返回 undefined）：有来源丢弃 / 有片段删除 /
 *   有付费墙截断 / on 模式有 Jev 未判定来源（D-06 在本文件另行实现）；
 * - shadow 的状态行与 off 逐字相同（D-07）：本函数只读"实际生效链"的结果，
 *   绝不读 `stats.shadow_diff`。
 *
 * 纯函数：不抛错（统计对象字段全部防御式读取）、不引任何 MCP 类型。
 *
 * 依据：03-CONTEXT.md D-01..D-08、03-RESEARCH.md 六问 5 / Code Examples。
 */

import type { FilterStats, SourceDropReason } from './types.js';

/**
 * 从最终统计对象生成状态行；无可报告内容时返回 undefined（不附第二块）。
 * @example 全部幸存且零删除 → undefined
 * @example 有来源丢弃 → `[filter] dropped 1 of 10 sources: 1 stale ...`
 */
export function buildStatusLine(stats: FilterStats): string | undefined {
  // 丢弃计数：按首次出现顺序聚合（Map 插入序），merged 不算丢弃（D-04）
  const reasonCounts = new Map<SourceDropReason, number>();
  let dropped = 0;
  for (const source of stats.sources) {
    if (source.verdict !== 'drop' || source.reason === 'merged') continue;
    dropped += 1;
    const reason: SourceDropReason = source.reason ?? 'empty';
    reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
  }

  // 幸存来源内被删片段总数（A2 口径；被丢来源的片段不重复计）
  let removedSnippets = 0;
  for (const source of stats.sources) {
    if (source.verdict !== 'keep') continue;
    for (const snippet of source.snippets) {
      if (!snippet.kept) removedSnippets += 1;
    }
  }

  // 付费墙是片段级动作不是来源级原因，单独计数（D-05）
  const paywallTruncated = stats.local.paywall_truncated;

  // D-04 附加条件：全都没有不附。
  if (dropped === 0 && removedSnippets === 0 && paywallTruncated === 0) return undefined;

  const parts: string[] = [];
  if (dropped > 0) {
    const reasonList = [...reasonCounts.entries()]
      .map(([reason, count]) => `${count} ${reason}`)
      .join(', ');
    parts.push(`dropped ${dropped} of ${stats.brave.n_sources} sources: ${reasonList}`);
  }
  if (removedSnippets > 0) {
    parts.push(`${removedSnippets} snippets removed`);
  }
  if (paywallTruncated > 0) {
    parts.push(`${paywallTruncated} snippets paywall-truncated`);
  }
  return `[filter] ${parts.join('; ')}`;
}
