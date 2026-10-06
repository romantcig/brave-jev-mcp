/**
 * 样板行前缀，使用 TS 常量随构建发布。
 * 样板行前缀的精确匹配规则见 matchesPrefix。
 */

/** 阶段 2 样板行剥离的前缀表：命中行整行删。匹配语义见 prefilter.ts 的 matchesPrefix——
 * 独立样板行整行相等、短行前缀带词边界；`Share` 这类词出现在正文长句行首时不会命中。可增补。 */
export const BOILERPLATE_PREFIXES: readonly string[] = [
  'Continue after ad',
  'Share',
  'Release Time:',
  // 自带 `##` 标记的条目：行与前缀两侧都按同一 normalizeLine 归一化后再比
  '## Frequently Asked Questions',
  'Table of contents',
  'On this page',
  'Related articles',
  'Read next',
  // ⚠️ 观察期条目：站点级付费情报推广标记，7 天实测各命中 1 次且来自同一页面，
  // 未过"页面/路径内频率占 7 成"门槛。后续样本确认全站高频则转正，长期低频则删除。
  'Go deeper with GlobalData',
  'Access deeper industry intelligence',
];
