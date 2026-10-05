/**
 * 构造全量共享 state、页面题与组合题、显式身份映射，并将答案投影回各来源。
 * 题意统一来自 questions.ts，裁决由 verdict.ts 处理；本模块不修改候选。
 */

import {
  choiceCriteria,
  buildPageFillerQuestion,
  buildSnippetGroupQuestion,
  PAGE_QUESTION_KEY,
  snippetGroupsOf,
} from './questions.js';
import type {
  ChoiceInvalidReason,
  JevAnswer,
  JevCandidateDetailed,
  JevQuestion,
  JevRequestMappingEntry,
  JevSnippetGroup,
  JevState,
  SnippetJudgments,
} from '../types.js';

/** 一次逻辑请求的 state、题目表和身份映射。 */
export type ContextRequest = {
  state: JevState;
  questions: Record<string, JevQuestion>;
  /** 按候选 Brave 原序排列的显式身份映射。 */
  entries: JevRequestMappingEntry[];
};

/** 全局题键连接符：来源 ID 与局部题键均不含此字符序列。 */
export const ALL_QUESTION_KEY_SEPARATOR = '__';

/** 拼接来源 ID 与局部题键，例如 s7__filler。 */
export const allQuestionKey = (sourceId: string, localKey: string): string =>
  `${sourceId}${ALL_QUESTION_KEY_SEPARATOR}${localKey}`;

/**
 * 将本地步骤后的非空候选按 Brave 原序放入共享 state，不重编号来源 ID。
 * 每来源一道页面题；片段按三片一组生成组合题（尾部两片/一片降档），
 * 映射同时保留 ID、位置、组定义与题键，单候选也用同一形状。
 * retrievalTime 由调用方归一，缺失时省略，不补当前时间；页面日期未知时为 null。
 * 新建 state 来源对象、片段数组和题目表，不改入参；调用方负责跳过零候选。
 */
export function buildContextRequest(
  candidates: readonly JevCandidateDetailed[],
  query: string,
  intent: string,
  retrievalTime?: string
): ContextRequest {
  const state: JevState = {
    query,
    intent,
    sources: candidates.map((candidate) => ({
      id: candidate.id,
      url: candidate.url,
      title: candidate.title,
      snippets: candidate.snippets.map((snippet) => snippet.text),
      // 键恒在（string | null，与冻结请求逐字一致）
      brave_page_date: candidate.bravePageDate ?? null,
    })),
    // 调用方传入合法检索时间时出现；键序在 sources 之后（冻结请求同序）
    ...(retrievalTime !== undefined ? { retrieval_time: retrievalTime } : {}),
  };

  const questions: Record<string, JevQuestion> = {};
  const entries: JevRequestMappingEntry[] = [];
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    const localQuestions: Record<string, JevQuestion> = {
      [PAGE_QUESTION_KEY]: buildPageFillerQuestion(index),
    };
    const groups = snippetGroupsOf(candidate.snippets.length);
    for (const group of groups) {
      localQuestions[group.key] = buildSnippetGroupQuestion(index, group.start, group.size);
    }
    const questionKeys: Record<string, string> = {};
    for (const [localKey, question] of Object.entries(localQuestions)) {
      const globalKey = allQuestionKey(candidate.id, localKey);
      questions[globalKey] = question;
      questionKeys[localKey] = globalKey;
    }
    entries.push({
      source_id: candidate.id,
      array_index: index,
      snippet_keys: candidate.snippets.map((snippet) => snippet.key),
      question_keys: questionKeys,
      snippet_groups: groups,
    });
  }

  return { state, questions, entries };
}

/** choice 概率分布的概率和本地接受范围：|sum-1| 严格小于该值才有效。 */
export const CHOICE_SUM_TOLERANCE = 0.06;

/** 逐来源答案投影的输出，由 runJevStage 交给裁决层消费。 */
export type ProjectedSourceAnswers = {
  /** 页面题概率（缺答 / 错型不进表；范围校验由裁决层按 validation 处理） */
  answers: Record<string, number>;
  /** 逐片段保留概率（与实发片段等长；该位无可用答案为 null，不压缩） */
  judgments: SnippetJudgments;
  /** 无效组合组（局部组键 → 原因）；仅统计实发且无效的组 */
  invalidGroups?: Record<string, ChoiceInvalidReason>;
};

/**
 * 校验单组 choice 答案：缺答 / 错型按 missing（形状问题已在解析层隔离），
 * 标签与实发 criteria 不齐或多余按 labels（缺失概率不补 0），概率和偏离按 sum。
 */
const checkChoiceAnswer = (
  answer: JevAnswer | undefined,
  size: number
):
  | { ok: true; probabilities: Record<string, number> }
  | { ok: false; reason: ChoiceInvalidReason } => {
  if (answer === undefined || answer.kind !== 'choice') return { ok: false, reason: 'missing' };
  const probabilities = answer.probabilities;
  const expectedKeys = Object.keys(choiceCriteria(size));
  if (
    Object.keys(probabilities).length !== expectedKeys.length ||
    !expectedKeys.every((key) => Object.hasOwn(probabilities, key))
  ) {
    return { ok: false, reason: 'labels' };
  }
  const sum = Object.values(probabilities).reduce((total, value) => total + value, 0);
  return Math.abs(sum - 1) < CHOICE_SUM_TOLERANCE
    ? { ok: true, probabilities }
    : { ok: false, reason: 'sum' };
};

/**
 * 按显式映射投影来源答案：页面题取 noul 概率；逐组校验 choice 答案后
 * 按边缘概率解码（p(j) = 含字母 j 的全部选项概率之和），坏组只影响本组、
 * 覆盖位保守记 null，不左移位置。边缘概率为本地派生值，不冒充模型原始分数。
 */
export function projectSourceAnswers(params: {
  snippetCount: number;
  groups: readonly JevSnippetGroup[];
  answerAt: (localKey: string) => JevAnswer | undefined;
}): ProjectedSourceAnswers {
  const judgments: SnippetJudgments = Array.from({ length: params.snippetCount }, () => null);
  const invalidGroups: Record<string, ChoiceInvalidReason> = {};
  for (const group of params.groups) {
    const checked = checkChoiceAnswer(params.answerAt(group.key), group.size);
    if (!checked.ok) {
      invalidGroups[group.key] = checked.reason;
      continue;
    }
    for (let k = 0; k < group.size; k += 1) {
      const letter = group.letters[k];
      let value = 0;
      for (const [label, probability] of Object.entries(checked.probabilities)) {
        if (label.includes(letter)) value += probability;
      }
      judgments[group.start + k] = { kind: 'keep_probability', value };
    }
  }

  const answers: Record<string, number> = {};
  const pageAnswer = params.answerAt(PAGE_QUESTION_KEY);
  if (pageAnswer?.kind === 'noul') answers[PAGE_QUESTION_KEY] = pageAnswer.probability;

  const result: ProjectedSourceAnswers = { answers, judgments };
  if (Object.keys(invalidGroups).length > 0) result.invalidGroups = invalidGroups;
  return result;
}

/** 从 sources[arrayIndex] 读取片段数；来源不存在时返回 undefined，由调用方按未知处理。 */
export const snippetCountOfState = (state: JevState, arrayIndex: number): number | undefined => {
  const source = state.sources[arrayIndex];
  return source === undefined ? undefined : source.snippets.length;
};
