/**
 * 全量共享上下文请求的构造纯逻辑（all-only 清理后的唯一请求组织，
 * ALL_ONLY_FILTER_CLEANUP_PLAN §3.1）：全量 state 与命名空间题目的构造、显式身份
 * 映射与逐来源答案投影。
 *
 * 职责边界（计划 §2.1）：本模块只做请求构造与证据映射——不改阈值、不新增过滤
 * 步骤、不碰 MCP 层；裁决链（verdict.ts）与十步管道（pipeline.ts）不在这里复制。
 * 题意仍以 questions.ts 为唯一来源：来源级四题由 `buildSourceQuestions` 按数组
 * 位置生成（命名空间转换在题库侧完成），片段评分题由 `buildSnippetScoreQuestion`
 * 按（数组位置，片段位置）生成冻结新题。旧的 32K／64K 双限额预检、预算估算与
 * 超限回退已整体退役——本模块不再有预算职责，构造结果直接交给客户端发送。
 *
 * 库不变式：无模块级可变状态、纯函数、写时复制（绝不改入参候选与题目）。
 *
 * 依据：ALL_ONLY_FILTER_CLEANUP_PLAN.md、FULL_CONTEXT_ROLLOUT_PLAN.md、
 * notes/filter-experiments/round-16-shared-context.md。
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

/**
 * 一次 Jev 逻辑请求的完整构造结果：全量 state、命名空间题目表与显式身份映射。
 * 请求组织只有 all 一种——一个或多个候选都用 `state.sources[]`，同一搜索的重试
 * 复用完全相同的构造结果。
 */
export type ContextRequest = {
  state: JevState;
  questions: Record<string, JevQuestion>;
  /** 显式身份映射（FULL_CONTEXT_ROLLOUT_PLAN §4.2），按候选 Brave 原序 */
  entries: JevRequestMappingEntry[];
};

/** 命名空间题键的连接符：`${source.id}__${localQuestionKey}`（计划 §4.1 例 s7__snip2）。 */
export const ALL_QUESTION_KEY_SEPARATOR = '__';

/**
 * 全量全局题键：`s7__snip2`。来源 ID 与局部键原样拼接，不做任何转义——候选 ID
 * 是管道生成的 `s{index}`，局部键是题库固定键，都不含连接符。
 */
export const allQuestionKey = (sourceId: string, localKey: string): string =>
  `${sourceId}${ALL_QUESTION_KEY_SEPARATOR}${localKey}`;

/**
 * 构造一次全量共享上下文请求（唯一请求构造器）：把本地步 1–4 后的全部候选放进
 * 一个共享 state（Brave 原序、来源 ID 不重编号），来源级四题按数组位置生成、每
 * 片段一道冻结时间上下文评分题，建立显式映射。
 *
 * 时间上下文（TEMPORAL_CONTEXT_SCORING_ROLLOUT_PLAN §4/§5）：`retrievalTime` 是
 * 调用方已归一的检索时间（合法值才有，来自宿主发起 Brave 请求前捕获的那一时刻）；
 * 传入时 state 携带 `retrieval_time`、键序在 `sources` 之后，缺失或非法（undefined）
 * 时省略该键、不补"今天"。每来源 `brave_page_date` 键恒在（无日期 / 归并冲突为
 * null，取自候选上的统一页级日期）——日期与新题的生成不再由任何参数是否存在决定。
 *
 * 纯函数：不修改入参候选；state.sources 是候选数组的新引用（元素原样），题目全部
 * 新建。调用方保证 `candidates.length >= 1`——零候选不调用本函数、零次 Jev 请求
 * （§3.1）；单候选同样用 `sources[0]` 与新题，不走特殊模板。
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
 * 逐来源答案投影（计划 §4.2）：从一次逻辑请求的答案按显式映射取出该来源的四题
 * 与片段分数。单来源与全量共用同一份实现——single 的查询函数按局部键恒等
 * 查找，all 按映射换算全局键；缺答、错型、越界一律走现有保守语义，绝不把坏答案
 * 当 0 或删除信号，也不把缺答位之后的答案左移（scoreValidity / scoresReceived 按
 * 题位保留，snippetScores 只在整组齐全时产出）。
 *
 * @param params.sentSnippets 实际带 score 题发送的片段数（single `sent_snippets`；
 *   全量等于候选全长）
 * @param params.answerAt 答案查询（按局部键）
 */
export function projectSourceAnswers(params: {
  sentSnippets: number;
  answerAt: (localKey: string) => JevAnswer | undefined;
}): ProjectedSourceAnswers {
  const answers: Record<string, number> = {};
  // 来源级四题：与既有单来源收集一致——答案存在且为 noul 才收，缺答 / 错型不进表
  for (const key of Object.keys(SOURCE_QUESTIONS)) {
    const answer = params.answerAt(key);
    if (answer?.kind === 'noul') answers[key] = answer.probability;
  }
  // 片段分数：只收实际发送的片段范围（sentSnippets）；逐题有效性与实收值按题位
  // 保留（含越界值），缺答位不压缩、后续不左移；整组齐全才产出 snippetScores
  const scoreValidity: boolean[] = [];
  const scoresReceived: Array<number | null> = [];
  const snippetScores: number[] = [];
  for (let i = 0; i < params.sentSnippets; i += 1) {
    const answer = params.answerAt(`snip${i}`);
    scoreValidity.push(answer?.kind === 'score' && isUsableSnippetScore(answer.score));
    scoresReceived.push(
      answer?.kind === 'score' && Number.isFinite(answer.score) ? answer.score : null
    );
    if (answer?.kind !== 'score') continue;
    snippetScores.push(answer.score);
  }
  const scoresComplete = snippetScores.length === params.sentSnippets;
  const result: ProjectedSourceAnswers = {
    answers,
    scoreValidity,
    scoresReceived,
  };
  if (scoresComplete) result.snippetScores = snippetScores;
  return result;
}

/**
 * 从实发 state 取指定来源的片段数（样本 v4 与投影共用）：按 `sources[arrayIndex]`
 * 读取。来源不存在 / 形状异常返回 undefined——调用方按"未知"处理，绝不猜。
 * src 侧主要消费方是 sample.ts（buildJevSection 算 in_state）。
 */
export const snippetCountOfState = (state: JevState, arrayIndex: number): number | undefined => {
  const source = state.sources[arrayIndex];
  return source === undefined ? undefined : source.snippets.length;
};
