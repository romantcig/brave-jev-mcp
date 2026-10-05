/**
 * 过滤规则与上下文布局的构建标识，独立于包版本和题库哈希。
 * 版本随代码编译固化，避免用运行时的 Git HEAD 误标已加载的旧构建。
 */

/**
 * 本地规则、Jev 裁决或去重等决策语义变化时递增，并在提交中注明。
 * 题干与 criteria 由 QUESTION_SET_ID 单独标识；包版本不能代替规则版本。
 */
export const FILTER_RULES_VERSION = 'filter-rules-23';

/**
 * 上下文结构与题键布局的版本，独立于题意和样本格式。
 * 每来源一道 filler 页面题加组键 group{start} 的组合题；全局键 s{id}__{局部题键}
 * 中的 ID 不是数组下标。
 */
export const CONTEXT_LAYOUT_ID = 'jev-context-4';
