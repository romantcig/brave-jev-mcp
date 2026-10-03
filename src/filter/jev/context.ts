/**
 * 构造全量共享 state、命名空间题目与显式身份映射，并将答案投影回各来源。
 * 题意统一来自 questions.ts，裁决由 verdict.ts 处理；本模块不修改候选。
 */

import { isUsableSnippetScore } from './verdict.js';
import { buildSnippetScoreQuestion, buildSourceQuestions, SOURCE_QUESTIONS } from './questions.js';
import type {
  JevAnswer,
  JevCandidateDetailed,
  JevQuestion,
  JevRequestMappingEntry,
  JevState,
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

/** 拼接来源 ID 与局部题键，例如 s7__snip2。 */
export const allQuestionKey = (sourceId: string, localKey: string): string =>
  `${sourceId}${ALL_QUESTION_KEY_SEPARATOR}${localKey}`;

/**
 * 将本地步骤后的非空候选按 Brave 原序放入共享 state，不重编号来源 ID。
 * 题目按数组位置生成，映射同时保留 ID 与位置，单候选也用同一形状。
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
    const local = buildSourceQuestions(index);
    for (let snippetIndex = 0; snippetIndex < candidate.snippets.length; snippetIndex += 1) {
      local[`snip${snippetIndex}`] = buildSnippetScoreQuestion(index, snippetIndex);
    }
    const questionKeys: Record<string, string> = {};
    for (const [localKey, question] of Object.entries(local)) {
      const globalKey = allQuestionKey(candidate.id, localKey);
      questions[globalKey] = question;
      questionKeys[localKey] = globalKey;
    }
    entries.push({
      source_id: candidate.id,
      array_index: index,
      snippet_keys: candidate.snippets.map((snippet) => snippet.key),
      question_keys: questionKeys,
    });
  }

  return { state, questions, entries };
}

/** 逐来源答案投影的输出（与 runJevStage 单来源内联收集同形状，裁决层直接消费）。 */
export type ProjectedSourceAnswers = {
  /** 来源级答案：四题的 noul 概率（缺答 / 错型不进表，按现有保守防御） */
  answers: Record<string, number>;
  /** 逐题评分有效性（按实发片段范围对齐；与 JevDispatchRecord.snippet_score_validity 同义） */
  scoreValidity: boolean[];
  /** 按题位保留的实际有限评分（含越界值；缺答 / 错型 / 非有限为 null） */
  scoresReceived: Array<number | null>;
  /** 整组分数（实发片段均有 score 答案时产出；顺序即实发片段位置） */
  snippetScores?: number[];
};

/**
 * 按局部题键投影来源答案，坏答案不作为删除信号。
 * 评分有效性与收到的分数按题位保留，缺答不左移。
 * snippetScores 仅在整组答案均为 score 类型时产出；取值有效性仍逐题检查。
 */
export function projectSourceAnswers(params: {
  snippetCount: number;
  answerAt: (localKey: string) => JevAnswer | undefined;
}): ProjectedSourceAnswers {
  const answers: Record<string, number> = {};
  // 来源级四题：缺答 / 错型不进表（保守防御，不冒充 0）
  for (const key of Object.keys(SOURCE_QUESTIONS)) {
    const answer = params.answerAt(key);
    if (answer?.kind === 'noul') answers[key] = answer.probability;
  }
  // 片段分数：只收当前请求映射的片段范围（snippetCount）；逐题有效性与实收值按
  // 题位保留（含越界值），缺答位不压缩、后续不左移；整组齐全才产出 snippetScores
  const scoreValidity: boolean[] = [];
  const scoresReceived: Array<number | null> = [];
  const snippetScores: number[] = [];
  for (let i = 0; i < params.snippetCount; i += 1) {
    const answer = params.answerAt(`snip${i}`);
    scoreValidity.push(answer?.kind === 'score' && isUsableSnippetScore(answer.score));
    scoresReceived.push(
      answer?.kind === 'score' && Number.isFinite(answer.score) ? answer.score : null
    );
    if (answer?.kind !== 'score') continue;
    snippetScores.push(answer.score);
  }
  const scoresComplete = snippetScores.length === params.snippetCount;
  const result: ProjectedSourceAnswers = {
    answers,
    scoreValidity,
    scoresReceived,
  };
  if (scoresComplete) result.snippetScores = snippetScores;
  return result;
}

/** 从 sources[arrayIndex] 读取片段数；来源不存在时返回 undefined，由调用方按未知处理。 */
export const snippetCountOfState = (state: JevState, arrayIndex: number): number | undefined => {
  const source = state.sources[arrayIndex];
  return source === undefined ? undefined : source.snippets.length;
};
