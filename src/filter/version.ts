/**
 * 过滤规则与上下文布局的构建标识，独立于包版本和题库哈希。
 * 版本随代码编译固化，避免用运行时的 Git HEAD 误标已加载的旧构建。
 */

/**
 * 本地规则、Jev 裁决或去重等决策语义变化时递增，并在提交中注明。
 * 题干与 criteria 由 QUESTION_SET_ID 单独标识；包版本不能代替规则版本。
 */
export const FILTER_RULES_VERSION = 'filter-rules-19';

/**
 * 上下文结构与题键布局的版本，独立于题意和样本格式。
 * state.sources 按数组位置生成题目；全局键 s{id}__{局部题键} 中的 ID 不是数组下标。
 */
export const CONTEXT_LAYOUT_ID = 'jev-context-3';
