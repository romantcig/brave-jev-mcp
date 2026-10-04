/**
 * 样板行前缀，使用 TS 常量随构建发布。
 * 样板行前缀的精确匹配规则见 matchesPrefix。
 */

/** 阶段 2 样板行剥离的前缀表：命中行整行删。匹配语义见 prefilter.ts 的 matchesPrefix——
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
  // 媒体页内嵌的付费情报服务推广标记。
  'Go deeper with GlobalData',
  'Access deeper industry intelligence',
  // 中文条目
  '分享',
  '广告',
  '相关阅读',
  '点击查看',
  '本站使用 Cookie',
];
