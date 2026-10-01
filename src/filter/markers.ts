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

/** 步 3 样板行剥离的前缀表：命中行整行删。匹配语义见 prefilter.ts 的 matchesPrefix——
 * 独立样板行整行相等、短行前缀带词边界（中文条目阈值更紧）；`Share`/`分享`/`广告`
 * 这类词出现在正文长句行首时不会命中。可增补。 */
export const BOILERPLATE_PREFIXES: readonly string[] = [
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
  // 媒体页内嵌的付费情报服务推广（GlobalData 系媒体网络通用 CTA 块，2026-10 样本）
  'Go deeper with GlobalData',
  'Access deeper industry intelligence',
  // 中文条目
  '分享',
  '广告',
  '相关阅读',
  '点击查看',
  '本站使用 Cookie',
];
