/**
 * 六题全量上下文的请求组织纯逻辑（FULL_CONTEXT_ROLLOUT_PLAN §4/§5）：全量 state
 * 与命名空间题目的构造、双限额预算规划、显式身份映射与逐来源答案投影。
 *
 * 职责边界（计划 §2.1）：本模块只做请求构造与证据映射——不改阈值、不新增过滤
 * 步骤、不碰 MCP 层；裁决链（verdict.ts）与十步管道（pipeline.ts）不在这里复制。
 * 题意仍以 questions.ts 为唯一来源：本模块对每个候选拨 `buildQuestions` 生成同一
 * 套局部题目，再做命名空间转换——题干引用 `\bsource\b` → `sources[i]`（i 是该
 * 来源在全量 state.sources 里的数组位置，不是来源 ID 数字），与第十六 / 十九轮
 * A 阶段的转换口径逐字一致（dev/filter-round16-quality.ts、filter-round19-retest.ts）。
 *
 * 预算口径（计划 §5.1）：复用 `../tokens.js` 的 `estimateTokens` 与 1.15 余量，
 * 两条限额都要检查、边界含等号：
 * - `(state + 最长单题) × 1.15 ≤ 32,000`（官方模型页 jev-1.13.0）
 * - `(state + 全部题目) × 1.15 ≤ 64,000`
 * 计算对象是最终全量 state 与命名空间转换后的完整题目，不是逐来源各自检查。
 *
 * 库不变式：无模块级可变状态、纯函数、写时复制（绝不改入参候选与题目）。
 *
 * 依据：FULL_CONTEXT_ROLLOUT_PLAN.md、notes/filter-experiments/round-16-shared-context.md。
 */

import { estimateTokens } from '../tokens.js';
import { isUsableSnippetScore } from './verdict.js';
import { buildQuestions, SOURCE_QUESTIONS } from './questions.js';
import type {
  JevAllState,
  JevAnswer,
  JevCandidate,
  JevCandidateDetailed,
  JevQuestion,
  JevRequestMappingEntry,
  JevSingleState,
  JevState,
} from '../types.js';

/** 32k 限额：state + 最长单题（token；官方模型页 jev-1.13.0）。 */
export const ALL_LIMIT_32K = 32000;

/** 64k 限额：state + 全部题目（token；官方模型页 jev-1.13.0）。 */
export const ALL_LIMIT_64K = 64000;

/** 预算估算余量：与单来源阶梯同一保守系数（client.ts 的 LADDER_TOKEN_MARGIN 口径）。 */
export const ALL_TOKEN_MARGIN = 1.15;

/** 双限额的估算值（进请求级记录 planned_estimates，供样本对账）。 */
export type AllBudgetEstimates = {
  /** 全量 state 的 token 估算（未取整浮点，与单来源阶梯同口径） */
  state_tokens: number;
  /** 最长单题的 token 估算 */
  longest_question_tokens: number;
  /** 全部题目估算之和 */
  total_questions_tokens: number;
  /** (state + 最长单题) × 1.15 的估算值（≤ 32k 可发，等号可发） */
  single_limit_estimate: number;
  /** (state + 全部题目) × 1.15 的估算值（≤ 64k 可发，等号可发） */
  total_limit_estimate: number;
};

/** 超限的限额；两个都超时报 single（先查 32k）。 */
export type AllBudgetViolation = 'single' | 'total';

/** 双限额校验结果：ok 带估算值；超限带超的哪条与估算值。 */
export type AllBudgetCheck =
  | { ok: true; estimates: AllBudgetEstimates }
  | { ok: false; violation: AllBudgetViolation; estimates: AllBudgetEstimates };

/** 全量请求规划的成功分支：state / questions / 映射 / 局部题集 / 估算值。 */
export type AllRequestPlan = {
  state: JevAllState;
  questions: Record<string, JevQuestion>;
  /** 显式身份映射（FULL_CONTEXT_ROLLOUT_PLAN §4.2），按候选 Brave 原序 */
  entries: JevRequestMappingEntry[];
  /** 每来源的局部题集（sourceId → buildQuestions 原样输出），投影时用 */
  localQuestions: Record<string, Record<string, JevQuestion>>;
  estimates: AllBudgetEstimates;
};

/** planAllRequest 的结果：规划成功或双限额超限（含估算值供记账）。 */
export type AllPlanResult =
  | { ok: true; plan: AllRequestPlan }
  | {
      ok: false;
      reason: 'over_budget';
      violation: AllBudgetViolation;
      estimates: AllBudgetEstimates;
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
 * 题干引用转换：只把指向目标来源的 `\bsource\b` 换成 `sources[i]`（i 为数组位置）
 * ——`source.snippets[2]` → `sources[1].snippets[2]`、总指令里的 `` `source` `` →
 * `` `sources[1]` ``。不加范围限制提示词、不加新总指令、不改其他任何字（计划 §4.1：
 * 与第十六 / 十九轮 A 阶段口径一致；dev/filter-round16-quality.ts 同一正则）。
 * `sources` 复数与 `source's` 之外的单字 `source` 之外的词不受影响（\b 边界）。
 */
const toNamespaceInstructions = (instructions: string, arrayIndex: number): string =>
  instructions.replace(/\bsource\b/g, `sources[${arrayIndex}]`);

/**
 * 计算双限额估算值：state 与全部题目逐一 `estimateTokens(JSON.stringify(...))`，
 * 乘 1.15 余量。纯计算，不做决策。
 */
export const allBudgetEstimatesOf = (
  state: JevState,
  questions: Record<string, JevQuestion>
): AllBudgetEstimates => {
  const stateTokens = estimateTokens(JSON.stringify(state));
  const questionTokens = Object.values(questions).map((question) =>
    estimateTokens(JSON.stringify(question))
  );
  const longest = questionTokens.length > 0 ? Math.max(...questionTokens) : 0;
  const total = questionTokens.reduce((sum, value) => sum + value, 0);
  return {
    state_tokens: stateTokens,
    longest_question_tokens: longest,
    total_questions_tokens: total,
    single_limit_estimate: (stateTokens + longest) * ALL_TOKEN_MARGIN,
    total_limit_estimate: (stateTokens + total) * ALL_TOKEN_MARGIN,
  };
};

/**
 * 双限额最终校验（FULL_CONTEXT_ROLLOUT_PLAN §5.1）：两条限制都检查、边界含等号
 * （估算值 ≤ 限额可发，> 限额为超）。规划层与客户端防御共用同一份判定。
 * @example checkAllBudget(state, questions).ok === true → 可以派发
 */
export function checkAllBudget(
  state: JevState,
  questions: Record<string, JevQuestion>
): AllBudgetCheck {
  const estimates = allBudgetEstimatesOf(state, questions);
  if (estimates.single_limit_estimate > ALL_LIMIT_32K) {
    return { ok: false, violation: 'single', estimates };
  }
  if (estimates.total_limit_estimate > ALL_LIMIT_64K) {
    return { ok: false, violation: 'total', estimates };
  }
  return { ok: true, estimates };
}

/**
 * 全量请求规划（计划 §4.1/§5.1）：把本地步 1–4 后的全部候选放进一个共享 state
 * （Brave 原序、来源 ID 不重编号），每候选拨同一套局部题目做命名空间转换，建立
 * 显式映射，最后做双限额预检——超限就不构造可发请求（调用方整批回退 single）。
 *
 * 纯函数：不修改入参候选；state.sources 是候选数组的新引用（元素原样），题目全部
 * 新建。入参是带配对身份的候选（片段身份键进映射条目，文本进 state）。调用方保证
 * `candidates.length >= 2`——零候选不构造空题目请求，单候选直接走 single
 * （single_candidate 回退，计划 §3 表格）。
 */
export function planAllRequest(
  candidates: readonly JevCandidateDetailed[],
  query: string,
  intent: string
): AllPlanResult {
  const state: JevAllState = {
    query,
    intent,
    sources: candidates.map((candidate) => ({
      id: candidate.id,
      url: candidate.url,
      title: candidate.title,
      snippets: candidate.snippets.map((snippet) => snippet.text),
    })),
  };

  const questions: Record<string, JevQuestion> = {};
  const entries: JevRequestMappingEntry[] = [];
  const localQuestions: Record<string, Record<string, JevQuestion>> = {};
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    const local = buildQuestions(candidate.snippets.map((snippet) => snippet.text));
    localQuestions[candidate.id] = local;
    const questionKeys: Record<string, string> = {};
    for (const [localKey, question] of Object.entries(local)) {
      const globalKey = allQuestionKey(candidate.id, localKey);
      questions[globalKey] = {
        ...question,
        instructions: toNamespaceInstructions(question.instructions, index),
      };
      questionKeys[localKey] = globalKey;
    }
    entries.push({
      source_id: candidate.id,
      array_index: index,
      snippet_keys: candidate.snippets.map((snippet) => snippet.key),
      question_keys: questionKeys,
    });
  }

  const check = checkAllBudget(state, questions);
  if (!check.ok) {
    return {
      ok: false,
      reason: 'over_budget',
      violation: check.violation,
      estimates: check.estimates,
    };
  }
  return {
    ok: true,
    plan: { state, questions, entries, localQuestions, estimates: check.estimates },
  };
}

/** 逐来源答案投影的输出（与 runJevStage 单来源内联收集同形状，裁决层直接消费）。 */
export type ProjectedSourceAnswers = {
  /** 来源级答案：六题与时间题的 noul 概率（缺答 / 错型不进表，按现有保守防御） */
  answers: Record<string, number>;
  /** 逐题评分有效性（按实发片段范围对齐；与 JevDispatchRecord.snippet_score_validity 同义） */
  scoreValidity: boolean[];
  /** 按题位保留的实际有限评分（含越界值；缺答 / 错型 / 非有限为 null） */
  scoresReceived: Array<number | null>;
  /** snip0..snip{n-1} 是否全部为 score 答案（整组防御语义，缺一位就 false） */
  scoresComplete: boolean;
  /** 整组分数（仅 scoresComplete 为 true 时有值；顺序即实发片段位置） */
  snippetScores?: number[];
};

/**
 * 逐来源答案投影（计划 §4.2）：从一次逻辑请求的答案按显式映射取出该来源的六题、
 * 时间题与片段分数。单来源与全量共用同一份实现——single 的查询函数按局部键恒等
 * 查找，all 按映射换算全局键；缺答、错型、越界一律走现有保守语义，绝不把坏答案
 * 当 0 或删除信号，也不把缺答位之后的答案左移（scoreValidity / scoresReceived 按
 * 题位保留，snippetScores 只在整组齐全时产出）。
 *
 * @param params.nSnippets 候选片段数（题位上界之一）
 * @param params.sentStateSnippetCount 实发 state 中该来源的片段数（single 阶梯
 *   cut_tail 后变小；全量无阶梯等于候选全长）
 * @param params.sentSnippets 实际带 score 题发送的片段数（single `sent_snippets`；
 *   全量等于候选全长）
 * @param params.localQuestionAt 本地构造题集查询（时间题"是否提问"依据之一）
 * @param params.sentQuestionAt 实发题集查询（时间题只消费实际提交的题）
 * @param params.answerAt 答案查询（按局部键）
 */
export function projectSourceAnswers(params: {
  nSnippets: number;
  sentStateSnippetCount: number;
  sentSnippets: number;
  localQuestionAt: (localKey: string) => JevQuestion | undefined;
  sentQuestionAt: (localKey: string) => JevQuestion | undefined;
  answerAt: (localKey: string) => JevAnswer | undefined;
}): ProjectedSourceAnswers {
  const answers: Record<string, number> = {};
  // 来源级六题：与既有单来源收集一致——答案存在且为 noul 才收，缺答 / 错型不进表
  for (const key of Object.keys(SOURCE_QUESTIONS)) {
    const answer = params.answerAt(key);
    if (answer?.kind === 'noul') answers[key] = answer.probability;
  }
  // 时间题：本地构造了、且实发题集里也有，才消费 noul 答案——未提问、缺答或坏值
  // 不制造时间删除（计划 §4.2）；上界是实发 state 的片段数（降级砍尾不串位）
  for (let i = 0; i < params.sentStateSnippetCount; i += 1) {
    const key = `time_snip${i}`;
    if (params.localQuestionAt(key) === undefined || params.sentQuestionAt(key) === undefined) {
      continue;
    }
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
    scoresComplete,
  };
  if (scoresComplete) result.snippetScores = snippetScores;
  return result;
}

/**
 * 从实发联合 state 取指定来源的片段数（样本 v4 与投影共用）：single 按 `.source`，
 * all 按 `sources[arrayIndex]`。来源不存在 / 形状异常返回 undefined——调用方按
 * "未知"处理，绝不猜。
 */
export const snippetCountOfState = (state: JevState, arrayIndex: number): number | undefined => {
  if ('source' in state) {
    return arrayIndex === 0 ? state.source.snippets.length : undefined;
  }
  const source = state.sources[arrayIndex];
  return source === undefined ? undefined : source.snippets.length;
};
