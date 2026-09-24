/**
 * 非文章页与来源级规则：步 4 feed / 黑名单、步 8 空来源 / 一句话来源、付费墙截断。
 *
 * 【RED 桩】本文件先落 Task 2 的 truncateAtPaywall 签名，函数体抛 "not implemented"；
 * 步 4 / 步 8 的 isFeedUrl、isBlocklisted、isEmptySource、isOneLiner 由 Task 3 追加。
 *
 * 依据：notes/non-article-pages.md「处理」表、01-RESEARCH.md「规则 4」「规则 7」「规则 8」。
 */

export function truncateAtPaywall(
  _text: string,
  _markers: readonly string[]
): { text: string; truncated: boolean } {
  throw new Error('truncateAtPaywall: not implemented (RED stub)');
}
