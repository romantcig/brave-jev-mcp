/**
 * 非文章页与来源级规则：步 4 feed / 黑名单、步 8 空来源 / 一句话来源、付费墙截断。
 *
 * 全部是无副作用纯函数：不读 `process.env`、不写文件、不改入参，同一输入重复
 * 调用返回深相等结果，可安全并发（RULES-04/concurrency）。坏 URL 一律按"判不出
 * → 不判"处理，方向保守。
 *
 * Task 2 落 truncateAtPaywall；isFeedUrl、isBlocklisted、isEmptySource、isOneLiner
 * 由 Task 3 追加。
 *
 * 依据：notes/non-article-pages.md「处理」表、01-RESEARCH.md「规则 4」「规则 7」「规则 8」。
 */

import { normalizeLine } from './prefilter.js';

/**
 * 付费墙截断：按行扫描，找第一行（normalizeLine 后、忽略大小写）以任一标记开头的行，
 * 保留其之前的文本并 `trimEnd()`。标记只在行首匹配——句中出现（例如一篇讨论付费墙
 * 的文章）不截断，避免误伤（Assumption A15）。只做片段级，不据此判整页。
 * @returns `truncated` 为真时 `text` 是截断后文本（可能为空串，调用方按 `paywall_empty` 删）
 * @example truncateAtPaywall('Para.\nSubscribe to continue reading\nx', markers) → { text: 'Para.', truncated: true }
 * @example truncateAtPaywall('No marker here', markers) → { text: 'No marker here', truncated: false }
 */
export function truncateAtPaywall(
  text: string,
  markers: readonly string[]
): { text: string; truncated: boolean } {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = normalizeLine(lines[i]).toLowerCase();
    const hit = markers.some((marker) => line.startsWith(normalizeLine(marker).toLowerCase()));
    if (!hit) continue;

    return { text: lines.slice(0, i).join('\n').trimEnd(), truncated: true };
  }
  return { text, truncated: false };
}
