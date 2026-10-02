/**
 * 四题全量上下文请求组织纯逻辑单测（FULL_CONTEXT_ROLLOUT_PLAN §8.1 T03/T04/T05/T06）：
 * 全量 state 与命名空间题目构造（数组位置与来源 ID 解耦、引用转换与第十六轮口径
 * 逐字一致）、双限额预算（32k/64k 分别校验、边界含等号）、显式映射与逐来源答案
 * 投影（缺答不左移、坏值不当 0）。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  allQuestionKey,
  allBudgetEstimatesOf,
  checkAllBudget,
  planAllRequest,
  projectSourceAnswers,
  snippetCountOfState,
} from './context.js';
import { buildQuestions, GLOBAL_INSTRUCTION, SNIPPET_LEVELS } from './questions.js';
import { estimateTokens } from '../tokens.js';
import type { JevCandidateDetailed, JevQuestion, JevState } from '../types.js';

/** 带身份候选构造（key 即管道 snippetKeyOf 格式）。 */
const candidateOf = (id: string, snippets: string[], keys?: string[]): JevCandidateDetailed => ({
  id,
  url: `https://${id}.example/post`,
  title: `${id} title`,
  snippets: snippets.map((text, index) => ({ key: keys?.[index] ?? `${index}`, text })),
});

describe('planAllRequest: state / questions / mapping', () => {
  it('builds one shared state in Brave order; array position is decoupled from source id (T03)', () => {
    // 预筛后候选 ID 非连续（s0、s7）：数组位置 0/1，来源 ID 不重编号
    const candidates = [candidateOf('s0', ['a']), candidateOf('s7', ['b', 'c'], ['2', '5'])];
    const result = planAllRequest(candidates, 'q', 'i');
    assert.ok(result.ok);
    const { plan } = result;
    assert.deepEqual(plan.state, {
      query: 'q',
      intent: 'i',
      sources: [
        { id: 's0', url: 'https://s0.example/post', title: 's0 title', snippets: ['a'] },
        { id: 's7', url: 'https://s7.example/post', title: 's7 title', snippets: ['b', 'c'] },
      ],
    });
    // 映射：数组位置与来源 ID、片段配对身份一一对应
    assert.deepEqual(plan.entries, [
      {
        source_id: 's0',
        array_index: 0,
        snippet_keys: ['0'],
        question_keys: Object.fromEntries(
          Object.keys(plan.localQuestions['s0'] ?? {}).map((key) => [
            key,
            allQuestionKey('s0', key),
          ])
        ),
      },
      {
        source_id: 's7',
        array_index: 1,
        snippet_keys: ['2', '5'],
        question_keys: Object.fromEntries(
          Object.keys(plan.localQuestions['s7'] ?? {}).map((key) => [
            key,
            allQuestionKey('s7', key),
          ])
        ),
      },
    ]);
    assert.equal(plan.state.sources[1]?.id, 's7');
  });

  it('namespaces question keys and rewrites `source` references exactly like round-16 (§4.1)', () => {
    const candidates = [
      candidateOf('s0', ['plain text']),
      candidateOf('s7', ['has 2026 year', 'another']),
    ];
    const result = planAllRequest(candidates, 'q', 'i');
    assert.ok(result.ok);
    const { plan } = result;

    // 题键：`${source.id}__${localQuestionKey}`（例 s7__snip2）
    const keys = Object.keys(plan.questions);
    for (const key of keys) {
      assert.ok(key.startsWith('s0__') || key.startsWith('s7__'), key);
    }
    assert.ok(keys.includes('s7__snip0'));

    // 题干引用转换：`\bsource\b` → `sources[i]`（i 为数组位置），与
    // dev/filter-round16-quality.ts 的 instructions.replace 同一正则同一结果——
    // 总指令、来源题、score 题三处引用全部命中
    assert.equal(
      plan.questions['s7__is_off_topic']?.instructions,
      GLOBAL_INSTRUCTION.replace(/\bsource\b/g, 'sources[1]') +
        ' `sources[1]` is not about the subject of `query`.'
    );
    assert.equal(
      plan.questions['s7__snip1']?.instructions,
      `${GLOBAL_INSTRUCTION.replace(/\bsource\b/g, 'sources[1]')} How useful is \`sources[1].snippets[1]\` for \`intent\`?`
    );
    assert.equal(plan.questions['s7__snip1']?.criteria, SNIPPET_LEVELS, 'criteria 原样保留');
    // s0（数组位置 0）引用 sources[0]，不串到 s7 的位置
    assert.match(
      plan.questions['s0__is_off_topic']?.instructions ?? /$/,
      /`sources\[0\]` is not about/
    );

    // 不加范围限制提示词、不加新总指令：题干只含总指令 + 原题意
    assert.equal(plan.questions['s7__is_off_topic']?.type, 'noul');
    assert.equal(plan.questions['s7__snip1']?.type, 'score');
  });

  it('keeps the per-source local question set byte-equal to buildQuestions (single construction unchanged)', () => {
    const snippets = ['has 2026 year', 'another text'];
    const candidates = [candidateOf('s0', snippets)];
    const result = planAllRequest(candidates, 'q', 'i');
    assert.ok(result.ok);
    assert.deepEqual(result.plan.localQuestions['s0'], buildQuestions(snippets));
  });

  it('does not mutate the input candidates (write-copy)', () => {
    const candidates = [candidateOf('s0', ['a', 'b'], ['0', '1'])];
    const frozen = structuredClone(candidates);
    planAllRequest(candidates, 'q', 'i');
    assert.deepEqual(candidates, frozen);
  });
});

describe('planAllRequest: dual budget limits (T06)', () => {
  /** 单调递增的大片段 state：二分找检查翻转点。 */
  const budgetAt = (L: number) => {
    const candidates = [candidateOf('s0', ['ab']), candidateOf('s7', ['a'.repeat(L)])];
    const result = planAllRequest(candidates, 'q', 'i');
    if (result.ok) return { ok: true as const, estimates: result.plan.estimates };
    return { ok: false as const, violation: result.violation, estimates: result.estimates };
  };

  // (state + 最长单题) × 1.15 的浮点等号：estimateTokens 的 0.9/0.5 权重使
  // (st+longest)*1.15 无法精确等于 32000——用浮点可表示的最接近值从两侧夹，
  // 验证"≤ 可发、> 拒绝"（含等号语义在此浮点精度下成立）
  const findSingleBoundary = (): { lastOk: number; firstOver: number } => {
    let low = 1;
    let high = 400000;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      const check = budgetAt(mid);
      if (check.ok) low = mid + 1;
      else high = mid;
    }
    return { lastOk: low - 1, firstOver: low };
  };

  it('allows the request just below the 32k limit and rejects just above (single violation)', () => {
    const { lastOk, firstOver } = findSingleBoundary();
    const okCheck = budgetAt(lastOk);
    assert.ok(okCheck.ok, '最后一个可发组合必须通过（≤ 含等号）');
    assert.ok(okCheck.estimates.single_limit_estimate <= 32000);
    assert.ok(okCheck.estimates.single_limit_estimate > 31900, '贴近边界（不是远低于）');
    assert.ok(okCheck.estimates.total_limit_estimate <= 64000, 'total 同时成立');
    const overCheck = budgetAt(firstOver);
    assert.deepEqual(
      { ok: overCheck.ok, violation: overCheck.ok ? null : overCheck.violation },
      { ok: false, violation: 'single' }
    );
    assert.ok(overCheck.estimates.single_limit_estimate > 32000);
  });

  it('allows the request just below the 64k limit and rejects just above (total violation)', () => {
    // 大量片段（每片段一道 score 题）使 state + 全部题目之和超 64k，而
    // state + 最长单题仍远低于 32k——两条限额独立检查
    const totalAt = (nSnippets: number) => {
      const candidates = [
        candidateOf(
          's0',
          Array.from({ length: nSnippets }, (_, i) => `snippet ${i} text`)
        ),
        candidateOf('s7', ['b']),
      ];
      const result = planAllRequest(candidates, 'q', 'i');
      if (result.ok) return { ok: true as const, estimates: result.plan.estimates };
      return { ok: false as const, violation: result.violation, estimates: result.estimates };
    };
    let low = 1;
    let high = 10000;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      const check = totalAt(mid);
      if (check.ok) low = mid + 1;
      else high = mid;
    }
    const okCheck = totalAt(low - 1);
    assert.ok(okCheck.ok);
    assert.ok(okCheck.estimates.total_limit_estimate <= 64000);
    // 贴近边界：距上限不足一步（一步 = 一个片段 + 一道 score 题）。窗口按单步
    // 增量推导而非固定常数——题库规模变化会平移落点，固定窗口会随动失准
    const prev = totalAt(low - 2);
    assert.ok(prev.ok);
    const step = okCheck.estimates.total_limit_estimate - prev.estimates.total_limit_estimate;
    assert.ok(step > 0);
    assert.ok(okCheck.estimates.total_limit_estimate > 64000 - step, '贴近边界');
    const overCheck = totalAt(low);
    assert.deepEqual(
      { ok: overCheck.ok, violation: overCheck.ok ? null : overCheck.violation },
      { ok: false, violation: 'total' }
    );
  });
});

describe('checkAllBudget / allBudgetEstimatesOf', () => {
  it('computes the estimates exactly as the ladder margin formula', () => {
    const state: JevState = {
      query: 'q',
      intent: 'i',
      sources: [{ id: 's0', url: 'u', title: 't', snippets: ['hello world text'] }],
    };
    const questions = {
      [allQuestionKey('s0', 'is_off_topic')]: {
        type: 'noul' as const,
        instructions: 'short instruction',
      },
      [allQuestionKey('s0', 'snip0')]: {
        type: 'score' as const,
        instructions: 'a much longer score instruction that dominates the maximum',
        criteria: SNIPPET_LEVELS,
      },
    };
    const estimates = allBudgetEstimatesOf(state, questions);
    assert.equal(estimates.state_tokens, estimateTokens(JSON.stringify(state)));
    assert.equal(
      estimates.longest_question_tokens,
      Math.max(...Object.values(questions).map((q) => estimateTokens(JSON.stringify(q))))
    );
    assert.equal(
      estimates.total_questions_tokens,
      Object.values(questions).reduce((sum, q) => sum + estimateTokens(JSON.stringify(q)), 0)
    );
    assert.equal(
      estimates.single_limit_estimate,
      (estimates.state_tokens + estimates.longest_question_tokens) * 1.15
    );
    assert.equal(
      estimates.total_limit_estimate,
      (estimates.state_tokens + estimates.total_questions_tokens) * 1.15
    );
    assert.equal(checkAllBudget(state, questions).ok, true);
  });
});

describe('snippetCountOfState', () => {
  it('reads the per-source snippet count for both state shapes and rejects bad indices', () => {
    const single: JevState = {
      query: 'q',
      intent: 'i',
      source: { id: 's0', url: 'u', title: 't', snippets: ['a', 'b', 'c'] },
    };
    const all: JevState = {
      query: 'q',
      intent: 'i',
      sources: [
        { id: 's0', url: 'u', title: 't', snippets: ['a'] },
        { id: 's7', url: 'v', title: 'u', snippets: ['x', 'y'] },
      ],
    };
    assert.equal(snippetCountOfState(single, 0), 3);
    assert.equal(snippetCountOfState(single, 1), undefined, 'single state has no array slot 1');
    assert.equal(snippetCountOfState(all, 0), 1);
    assert.equal(snippetCountOfState(all, 1), 2);
    assert.equal(snippetCountOfState(all, 2), undefined);
  });
});

describe('projectSourceAnswers', () => {
  const QUESTION_KEYS = [
    'is_off_topic',
    'is_listing',
    'is_template_filler',
    'has_original_reasoning',
  ];
  /** 局部题集（与 buildQuestions 同形的最小投影；instructions 不参与投影逻辑）。 */
  const localQuestions = (nSnippets: number): Record<string, JevQuestion> => {
    const questions: Record<string, JevQuestion> = {};
    for (const key of QUESTION_KEYS) questions[key] = { type: 'noul', instructions: 'x' };
    for (let i = 0; i < nSnippets; i += 1)
      questions[`snip${i}`] = { type: 'score', instructions: 'x' };
    return questions;
  };
  const answer = (kind: 'noul' | 'score', value: number) =>
    kind === 'noul'
      ? { kind: 'noul' as const, probability: value }
      : { kind: 'score' as const, score: value };

  it('projects via the mapping for all mode: answers land on the right source, no cross-source bleed (T04)', () => {
    // s7 在数组位置 1；映射把局部键换到 s7__ 前缀
    const questions = localQuestions(2);
    const questionKeys: Record<string, string> = {};
    for (const [key, value] of Object.entries(questions)) {
      questionKeys[key] = allQuestionKey('s7', key);
    }
    const projected = projectSourceAnswers({
      sentSnippets: 2,
      answerAt: (key) => {
        const global = questionKeys[key];
        const answers: Record<
          string,
          { kind: 'noul' | 'score'; probability?: number; score?: number }
        > = {
          [allQuestionKey('s7', 'is_off_topic')]: answer('noul', 0.2),
          [allQuestionKey('s7', 'is_listing')]: answer('noul', 0.1),
          [allQuestionKey('s7', 'is_template_filler')]: answer('noul', 0.1),
          [allQuestionKey('s7', 'has_original_reasoning')]: answer('noul', 0.1),
          [allQuestionKey('s7', 'snip0')]: answer('score', 1.5),
          [allQuestionKey('s7', 'snip1')]: answer('score', 0.3),
          // 其他来源答案不串位
          [allQuestionKey('s0', 'is_off_topic')]: answer('noul', 0.99),
        };
        return global !== undefined && Object.hasOwn(answers, global)
          ? (answers[global] as ReturnType<typeof answer>)
          : undefined;
      },
    });
    assert.deepEqual(projected.answers, {
      is_off_topic: 0.2,
      is_listing: 0.1,
      is_template_filler: 0.1,
      has_original_reasoning: 0.1,
    });
    assert.deepEqual(projected.scoreValidity, [true, true]);
    assert.deepEqual(projected.scoresReceived, [1.5, 0.3]);
    assert.deepEqual(projected.snippetScores, [1.5, 0.3]);
  });

  it('single mode identity lookup behaves like the previous inline collection (T12 basis)', () => {
    const projected = projectSourceAnswers({
      sentSnippets: 2,
      answerAt: (key) =>
        key === 'is_off_topic'
          ? answer('noul', 0.9)
          : key === 'snip0'
            ? answer('score', 2)
            : key === 'snip1'
              ? answer('score', 1)
              : answer('noul', 0),
    });
    assert.equal(projected.answers['is_off_topic'], 0.9);
    assert.deepEqual(projected.snippetScores, [2, 1]);
  });

  it('keeps holes at their positions: missing middle score does not shift later answers (T05)', () => {
    const scores = [answer('score', 2), undefined, answer('score', 0.3)];
    const projected = projectSourceAnswers({
      sentSnippets: 3,
      answerAt: (key) => {
        const match = /^snip(\d+)$/.exec(key);
        if (match !== null) return scores[Number(match[1])];
        return answer('noul', 0.1);
      },
    });
    // 逐题有效性按题位：缺答位 false，后续不左移
    assert.deepEqual(projected.scoreValidity, [true, false, true]);
    assert.deepEqual(projected.scoresReceived, [2, null, 0.3]);
    // 整组防御：缺一位就不产出 snippet_scores
    assert.equal(projected.snippetScores, undefined);
  });

  it('treats bad types, non-finite, negative and out-of-range scores as unusable but keeps the received value (T05)', () => {
    const answerFor = (key: string) => {
      if (key === 'snip0') return { kind: 'noul' as const, probability: 0.5 }; // 错误类型
      if (key === 'snip1') return { kind: 'score' as const, score: Number.NaN }; // 非有限
      if (key === 'snip2') return { kind: 'score' as const, score: -0.5 }; // 负分
      if (key === 'snip3') return { kind: 'score' as const, score: 3 }; // 越界（上限 2）
      return answer('noul', 0);
    };
    const projected = projectSourceAnswers({
      sentSnippets: 4,
      answerAt: answerFor,
    });
    assert.deepEqual(projected.scoreValidity, [false, false, false, false]);
    // 实收值保留（含越界）供复查；非有限为 null
    assert.deepEqual(projected.scoresReceived, [null, null, -0.5, 3]);
    // snip0 错型（noul）缺位：4 个题位只收 3 个 score → 整组不完整
    assert.equal(projected.snippetScores, undefined);
  });
});
