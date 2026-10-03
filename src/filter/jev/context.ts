/**
 * 四题全量上下文的请求组织纯逻辑（FULL_CONTEXT_ROLLOUT_PLAN §4/§5）：全量 state
 * 与命名空间题目的构造、双限额预算规划、显式身份映射与逐来源答案投影。
 *
 * 职责边界（计划 §2.1）：本模块只做请求构造与证据映射——不改阈值、不新增过滤
 * 步骤、不碰 MCP 层；裁决链（verdict.ts）与十步管道（pipeline.ts）不在这里复制。
 * 题意仍以 questions.ts 为唯一来源：本模块对每个候选拨 `buildQuestions` 生成同一
 * 套局部题目，再做命名空间转换——题干引用 `\bsource\b` → `sources[i]`（i 是该
 * 来源在全量 state.sources 里的数组位置，不是来源 ID 数字），与第十六 / 十九轮
 * A 阶段的转换口径逐字一致（dev/filter-round16-quality.ts、filter-round19-retest.ts）。
 * 时间上下文开关开启时（`temporal` 参数），片段 score 题改由冻结新题构造器按实际
 * 数组位置直接生成（TEMPORAL_CONTEXT_SCORING_ROLLOUT_PLAN §5），来源题转换不变。
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
import { buildQuestions, buildTemporalScoreQuestion, SOURCE_QUESTIONS } from './questions.js';
import type {
  AllBudgetEstimates,
  JevAllState,
  JevAnswer,
  JevCandidate,
  JevCandidateDetailed,
  JevQuestion,
  JevRequestMappingEntry,
  JevSingleState,
  JevState,
} from '../types.js';

export type { AllBudgetEstimates } from '../types.js';

/**
 * 时间上下文参数（TEMPORAL_CONTEXT_SCORING_ROLLOUT_PLAN §4/§5）：提供本参数（非
 * undefined）即开关开启——state 携带 `retrieval_time` 与每来源 `brave_page_date`，
 * 片段 score 题改用冻结新题。`retrievalTime` 由调用方归一（合法值才有，缺失时
 * state 省略该字段但页面日期照常携带）；页面日期已在候选上按归并冲突消解。
 */
export type AllTemporalContext = { retrievalTime?: string };

/** 32k 限额：state + 最长单题（token；官方模型页 jev-1.13.0）。 */
export const ALL_LIMIT_32K = 32000;

/** 64k 限额：state + 全部题目（token；官方模型页 jev-1.13.0）。 */
export const ALL_LIMIT_64K = 64000;

/** 预算估算余量：与单来源阶梯同一保守系数。 */
export const ALL_TOKEN_MARGIN = 1.15;

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
  /** 每来源的局部题集；时间评分题与实发题共用同一个构造结果。 */
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
 * 时间上下文（TEMPORAL_CONTEXT_SCORING_ROLLOUT_PLAN §4/§5）：`temporal` 提供时
 * （开关开启）state 携带时间字段——每来源 `brave_page_date` 键恒在（无日期 / 归并
 * 冲突为 null，与冻结请求一致，取自候选上的统一页级日期），`retrieval_time` 仅在
 * 传入合法值时出现、键序在 `sources` 之后；片段 score 题改用冻结新题——由
 * `buildTemporalScoreQuestion` 直接接收**实际数组位置**与片段位置生成题干，不走
 * `\bsource\b` 全局替换（新题干里 "A source's ..." 是普通英语）；四道来源题沿用
 * 原有转换。完整日期与新题全部加入 state / questions **之后**才做双限额预算检查
 * ——不能先按旧短题估算、临发时替换成长题。
 *
 * `localQuestions` 与实发题目同源；时间评分题直接使用实际数组位置构造，局部表
 * 与命名空间表保存同一题对象，防止映射记录仍带旧题。
 *
 * 纯函数：不修改入参候选；state.sources 是候选数组的新引用（元素原样），题目全部
 * 新建。入参是带配对身份的候选（片段身份键进映射条目，文本进 state）。调用方保证
 * `candidates.length >= 2`——零候选不构造空题目请求，单候选直接走 single
 * （single_candidate 回退，计划 §3 表格）。
 */
export function planAllRequest(
  candidates: readonly JevCandidateDetailed[],
  query: string,
  intent: string,
  temporal?: AllTemporalContext
): AllPlanResult {
  const state: JevAllState = {
    query,
    intent,
    sources: candidates.map((candidate) => ({
      id: candidate.id,
      url: candidate.url,
      title: candidate.title,
      snippets: candidate.snippets.map((snippet) => snippet.text),
      // 开关开启时键恒在（string | null，与冻结请求逐字一致）；关闭时不出现
      ...(temporal !== undefined ? { brave_page_date: candidate.bravePageDate ?? null } : {}),
    })),
    // 开关开启且调用方传入合法检索时间时出现；键序在 sources 之后（冻结请求同序）
    ...(temporal !== undefined && temporal.retrievalTime !== undefined
      ? { retrieval_time: temporal.retrievalTime }
      : {}),
  };

  const questions: Record<string, JevQuestion> = {};
  const entries: JevRequestMappingEntry[] = [];
  const localQuestions: Record<string, Record<string, JevQuestion>> = {};
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    const local = buildQuestions(candidate.snippets.map((snippet) => snippet.text));
    if (temporal !== undefined) {
      for (let snippetIndex = 0; snippetIndex < candidate.snippets.length; snippetIndex += 1) {
        local[`snip${snippetIndex}`] = buildTemporalScoreQuestion(index, snippetIndex);
      }
    }
    localQuestions[candidate.id] = local;
    const questionKeys: Record<string, string> = {};
    for (const [localKey, question] of Object.entries(local)) {
      const globalKey = allQuestionKey(candidate.id, localKey);
      questions[globalKey] =
        temporal !== undefined && localKey.startsWith('snip')
          ? question
          : {
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
 * 从实发联合 state 取指定来源的片段数（样本 v4 与投影共用）：single 按 `.source`，
 * all 按 `sources[arrayIndex]`。来源不存在 / 形状异常返回 undefined——调用方按
 * "未知"处理，绝不猜。src 侧主要消费方是 sample.ts（buildJevSection 算 in_state）。
 */
export const snippetCountOfState = (state: JevState, arrayIndex: number): number | undefined => {
  if ('source' in state) {
    return arrayIndex === 0 ? state.source.snippets.length : undefined;
  }
  const source = state.sources[arrayIndex];
  return source === undefined ? undefined : source.snippets.length;
};
