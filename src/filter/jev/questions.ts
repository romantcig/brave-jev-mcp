/**
 * Jev 题库、阈值默认值与客户端默认配置。
 * 每来源一道模板垃圾页面题；同来源连续片段按最多三片组成一道 choice 组合题。
 * 配置解析见 config.ts，坏值回落到本模块的默认值。
 */

import { createHash } from 'node:crypto';
import type { JevQuestion, JevSnippetGroup } from '../types.js';

/** 页面题局部键；全局键为 `${sourceId}__filler`。 */
export const PAGE_QUESTION_KEY = 'filler';

/** 组合题组内字母，从 A 递增；每组重新开始。 */
const GROUP_LETTERS = 'ABC';

/** 组合题固定组大小；尾部不足时按剩余片数降为 2 或 1。 */
export const GROUP_MAX_SIZE = 3;

/** 页面题：模板拼凑且无作者论证时整页删除，论证豁免已合入题意。 */
export const pageFillerInstructions = (arrayIndex: number): string =>
  `Judge the text of \`sources[${arrayIndex}]\`. This source mostly repeats the topic name ` +
  'and generic phrasing without specific facts, or is a template article assembled from ' +
  "headlines, AND it lacks the author's own evaluation, criticism, comparison, or argument " +
  'with stated reasons.';

/** 多片组合题的保留/丢弃标准片段。 */
const GROUP_RETAIN =
  'Retain snippets containing specific facts, technical explanations, architectural ' +
  'comparisons, or practical examples usable in answering `intent`. Discard navigation, ' +
  'boilerplate, off-direction content, and mere mentions of the subject without usable ' +
  'information. ';

/** 多片组合题的时间上下文片段。 */
const GROUP_TIME =
  'Assess time-bound claims using `sources`: an earlier prediction replaced by a confirmed ' +
  'event is obsolete, but still-applicable technical explanations, architectural ' +
  'comparisons, or practical examples remain useful.';

/** 单片组合题的专用片段。 */
const SINGLE_BODY =
  'Keep A if it provides specific information usable in answering `intent`. Discard ' +
  'navigation, boilerplate, off-direction content, mere topic mentions, and obsolete ' +
  'predictions replaced by confirmed events in `sources`. Retain still-applicable ' +
  'explanations, comparisons, and examples.';

/**
 * 按组大小生成 choice 选项标签映射：按位掩码从 0 递增（空掩码为 none），
 * 不改为字母排序。值均为 null，含义由题干表达。
 */
export const choiceCriteria = (size: number): Record<string, null> => {
  const letters = GROUP_LETTERS.slice(0, size);
  const criteria: Record<string, null> = {};
  for (let mask = 0; mask < 2 ** size; mask += 1) {
    let label = '';
    for (let k = 0; k < size; k += 1) {
      if ((mask & (1 << k)) !== 0) label += letters[k];
    }
    criteria[label === '' ? 'none' : label] = null;
  }
  return criteria;
};

/** 多片组合题题干：显式字母引用＋保留/丢弃标准＋时间上下文＋独立逐片判断。 */
export const groupInstructions = (sourceIndex: number, startIndex: number, size: number): string =>
  GROUP_LETTERS.slice(0, size)
    .split('')
    .map((letter, k) => `${letter}=\`sources[${sourceIndex}].snippets[${startIndex + k}]\``)
    .join('; ') +
  '. ' +
  GROUP_RETAIN +
  GROUP_TIME +
  ' Evaluate each snippet independently. Select exactly the letters of all snippets to retain, or none.';

/** 单片组合题题干：与多片同一组映射与解码结构，仅题干收短。 */
export const singleInstructions = (sourceIndex: number, startIndex: number): string =>
  `A=\`sources[${sourceIndex}].snippets[${startIndex}]\`. ` + SINGLE_BODY;

/** 按数组位置构造页面模板垃圾题（noul）。 */
export const buildPageFillerQuestion = (arrayIndex: number): JevQuestion => ({
  type: 'noul',
  instructions: pageFillerInstructions(arrayIndex),
});

/** 按数组位置、片段起始位置与组大小构造组合题（choice）。 */
export const buildSnippetGroupQuestion = (
  sourceIndex: number,
  startIndex: number,
  size: number
): JevQuestion => ({
  type: 'choice',
  instructions:
    size === 1
      ? singleInstructions(sourceIndex, startIndex)
      : groupInstructions(sourceIndex, startIndex, size),
  criteria: choiceCriteria(size),
});

/** 按片段数把候选片段切成组定义：三片一组，尾部两片/一片降档；组键为 `group{start}`。 */
export const snippetGroupsOf = (snippetCount: number): JevSnippetGroup[] => {
  const groups: JevSnippetGroup[] = [];
  for (let start = 0; start < snippetCount; start += GROUP_MAX_SIZE) {
    const size = Math.min(GROUP_MAX_SIZE, snippetCount - start);
    groups.push({
      key: `group${start}`,
      start,
      size,
      letters: GROUP_LETTERS.slice(0, size).split(''),
    });
  }
  return groups;
};

/**
 * 基础阈值默认值：fillerDrop 用于页面删除，groupKeepMin / singleKeepMin
 * 分别用于二/三片组与单片组的保留概率。最终删留由 threshold.ts 的纯判定决定，
 * 包含阈值附近的临界删除；客户端不舍入概率。
 */
export const DEFAULT_THRESHOLDS = Object.freeze({
  fillerDrop: 0.8,
  groupKeepMin: 0.25,
  singleKeepMin: 0.5,
} as const);

/** 钉住模型版本；切换版本前需跑样本回归，避免 latest 别名随发布漂移。 */
export const DEFAULT_JEV_MODEL = 'jev-1.13.0';

/** 单次尝试的超时毫秒数。 */
export const DEFAULT_JEV_TIMEOUT_MS = 15000;

/** 分类器实例共享的并发名额上限。 */
export const DEFAULT_JEV_CONCURRENCY = 12;

/**
 * 题库标识：页面题、一/二/三片组合题完整模板及各档选项顺序的规范化 JSON 哈希前 12 位。
 * 组合模板用 (0, 0) 实例化即可覆盖全部固定文字；自由变量只有下标。
 * 阈值与解码规则由配置快照与规则版本表达，不进入本哈希。
 */
export const QUESTION_SET_ID = createHash('sha256')
  .update(
    JSON.stringify([
      pageFillerInstructions(0),
      singleInstructions(0, 0),
      groupInstructions(0, 0, 2),
      groupInstructions(0, 0, 3),
      choiceCriteria(1),
      choiceCriteria(2),
      choiceCriteria(3),
    ])
  )
  .digest('hex')
  .slice(0, 12);
