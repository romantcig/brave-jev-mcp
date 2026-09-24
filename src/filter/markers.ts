/**
 * 付费墙标记与样板行前缀常量表。
 *
 * 【RED 桩】常量先给空数组：让 prefilter.test.ts / nonArticle.test.ts 能加载并在
 * "命中即删 / 命中即截断"的正例断言处失败，GREEN 提交再填入真实表。
 *
 * 依据：notes/non-article-pages.md「标记列表初值」、01-RESEARCH.md「规则 7」「规则 3」。
 */

export const PAYWALL_MARKERS_EN: readonly string[] = [];

export const PAYWALL_MARKERS_ZH: readonly string[] = [];

export const BOILERPLATE_PREFIXES: readonly string[] = [];
