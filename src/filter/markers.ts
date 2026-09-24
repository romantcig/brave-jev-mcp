/**
 * 付费墙标记与样板行前缀常量表。
 *
 * 数据表必须是 `.ts` 常量：`tsc` 不拷贝非 `.ts` 资产进 `dist/`（STRUCTURE.md）。
 * 匹配语义见使用方：付费墙标记行首匹配后截断片段（步 3 内最先做），样板前缀
 * 行级剥离（两侧同法归一化后再比）。**老大有新写法随时补**，改动只落在本文件。
 *
 * 依据：notes/non-article-pages.md「标记列表初值」、notes/local-rules-design.md §3、
 * 01-RESEARCH.md「规则 7」「规则 3」。
 */

/** 英文付费墙标记；行首匹配（忽略大小写），命中处截断片段。可增补。 */
export const PAYWALL_MARKERS_EN: readonly string[] = [
  'Premium content',
  'Subscriber only',
  'Subscribers only',
  'This post is for paid subscribers',
  'Subscribe to continue reading',
  'Sign in to read',
  'Members only',
  'Continue reading with a subscription',
];

/** 中文付费墙标记；语义同上。可增补。 */
export const PAYWALL_MARKERS_ZH: readonly string[] = [
  '付费会员专享',
  '以下为付费内容',
  '订阅后阅读全文',
  '会员可见',
  '加入会员查看',
];

/** 步 3 样板行剥离的前缀表：命中行整行删。可增补。 */
export const BOILERPLATE_PREFIXES: readonly string[] = [
  // 注意 `Share` 是 startsWith 语义，`Shared …` 开头的正文行会被误命中；
  // 表项取舍（改全行匹配、加词边界或调词条）由 01-04 的夹具期望文件校准。
  'Continue after ad',
  'Share',
  'Release Time:',
  'READ MORE',
  'Cite this article',
  // 自带 `##` 标记的条目：行与前缀两侧都按同一 normalizeLine 归一化后再比
  '## Frequently Asked Questions',
  'Advertisement',
  'Sponsored',
  'Subscribe to our newsletter',
  'Sign up for our newsletter',
  'We use cookies',
  'This site uses cookies',
  'Accept all cookies',
  'Skip to content',
  'Table of contents',
  'On this page',
  'Related articles',
  'Read next',
  // 中文条目
  '分享',
  '广告',
  '相关阅读',
  '点击查看',
  '本站使用 Cookie',
];
