/** 共享请求与答案投影测试：来源 ID 和数组位置分离，组显式映射，坏组不左移。 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CHOICE_SUM_TOLERANCE,
  allQuestionKey,
  buildContextRequest,
  projectSourceAnswers,
  snippetCountOfState,
} from './context.js';
import {
  choiceCriteria,
  groupInstructions,
  pageFillerInstructions,
  singleInstructions,
} from './questions.js';
import type { JevAnswer, JevCandidateDetailed, JevSnippetGroup } from '../types.js';

/** 带身份候选构造（key 即管道 snippetKeyOf 格式；默认给一个确定页级日期）。 */
const candidateOf = (
  id: string,
  snippets: string[],
  keys?: string[],
  bravePageDate: string | null = '2026-10-01'
): JevCandidateDetailed => ({
  id,
  url: `https://${id}.example/post`,
  title: `${id} title`,
  snippets: snippets.map((text, index) => ({ key: keys?.[index] ?? `${index}`, text })),
  bravePageDate,
});

describe('buildContextRequest: state / questions / mapping', () => {
  it('builds one shared state in Brave order; array position is decoupled from source id (T03)', () => {
    // 预筛后候选 ID 非连续（s0、s7）：数组位置 0/1，来源 ID 不重编号
    const candidates = [candidateOf('s0', ['a']), candidateOf('s7', ['b', 'c'], ['2', '5'])];
    const request = buildContextRequest(candidates, 'q', 'i');
    assert.deepEqual(request.state, {
      query: 'q',
      intent: 'i',
      sources: [
        {
          id: 's0',
          url: 'https://s0.example/post',
          title: 's0 title',
          snippets: ['a'],
          brave_page_date: '2026-10-01',
        },
        {
          id: 's7',
          url: 'https://s7.example/post',
          title: 's7 title',
          snippets: ['b', 'c'],
          brave_page_date: '2026-10-01',
        },
      ],
    });
    // 映射：数组位置与来源 ID、片段配对身份、组合组定义一一对应
    assert.deepEqual(request.entries, [
      {
        source_id: 's0',
        array_index: 0,
        snippet_keys: ['0'],
        question_keys: { filler: 's0__filler', group0: 's0__group0' },
        snippet_groups: [{ key: 'group0', start: 0, size: 1, letters: ['A'] }],
      },
      {
        source_id: 's7',
        array_index: 1,
        snippet_keys: ['2', '5'],
        question_keys: { filler: 's7__filler', group0: 's7__group0' },
        snippet_groups: [{ key: 'group0', start: 0, size: 2, letters: ['A', 'B'] }],
      },
    ]);
    assert.equal(request.state.sources[1]?.id, 's7');
  });

  it('namespaces question keys and builds the page filler plus group questions by array position', () => {
    const candidates = [
      candidateOf('s0', ['plain text']),
      candidateOf('s7', ['a', 'b', 'c', 'd'], ['2', '5', '6', '9']),
    ];
    const request = buildContextRequest(candidates, 'q', 'i');

    // 题键：`${source.id}__${localQuestionKey}`（例 s7__group3）
    const keys = Object.keys(request.questions);
    for (const key of keys) {
      assert.ok(key.startsWith('s0__') || key.startsWith('s7__'), key);
    }

    // 页面题：只发 filler，题干按数组位置展开（数组位置 1 的 s7 引用 sources[1]）
    assert.equal(request.questions['s7__filler']?.type, 'noul');
    assert.equal(
      request.questions['s7__filler']?.type === 'noul'
        ? request.questions['s7__filler'].instructions
        : '',
      pageFillerInstructions(1)
    );
    assert.match(
      request.questions['s0__filler']?.instructions ?? /$/,
      /^Judge the text of `sources\[0\]`\./
    );

    // 四片段来源：3 + 1 两组；group0 用完整组合题，group3 用单片短题
    assert.equal(request.questions['s7__group0']?.type, 'choice');
    assert.equal(
      request.questions['s7__group0']?.type === 'choice'
        ? request.questions['s7__group0'].instructions
        : '',
      groupInstructions(1, 0, 3)
    );
    assert.equal(request.questions['s7__group3']?.type, 'choice');
    assert.equal(
      request.questions['s7__group3']?.type === 'choice'
        ? request.questions['s7__group3'].instructions
        : '',
      singleInstructions(1, 3)
    );
  });

  it('keeps the question key structure: one filler plus one group per tile of three', () => {
    const candidates = [candidateOf('s0', ['a']), candidateOf('s7', ['b', 'c'], ['2', '5'])];
    const request = buildContextRequest(candidates, 'q', 'i');
    assert.deepEqual(
      Object.keys(request.questions).filter((key) => key.startsWith('s7__')),
      ['s7__filler', 's7__group0']
    );
    assert.deepEqual(
      Object.keys(request.questions).filter((key) => key.startsWith('s0__')),
      ['s0__filler', 's0__group0']
    );
    // 总题数公式：候选数 × 1（页面题） + 组数
    assert.equal(Object.keys(request.questions).length, 2 + 2);
  });

  it('emits bitmask-ordered criteria per group size (§3.2)', () => {
    const candidates = [
      candidateOf('s0', ['a']),
      candidateOf('s7', ['b', 'c'], ['0', '1']),
      candidateOf('s9', ['d', 'e', 'f'], ['0', '1', '2']),
    ];
    const request = buildContextRequest(candidates, 'q', 'i');
    for (const [key, size] of [
      ['s0__group0', 1],
      ['s7__group0', 2],
      ['s9__group0', 3],
    ] as const) {
      const question = request.questions[key];
      assert.equal(question?.type, 'choice', key);
      if (question?.type === 'choice') {
        assert.deepEqual(question.criteria, choiceCriteria(size));
      }
    }
  });

  it('does not mutate the input candidates (write-copy)', () => {
    const candidates = [candidateOf('s0', ['a', 'b'], ['0', '1'])];
    const frozen = structuredClone(candidates);
    buildContextRequest(candidates, 'q', 'i');
    assert.deepEqual(candidates, frozen);
  });
});

// 页面日期始终构造；检索时间仅在显式传入合法值时携带。

describe('buildContextRequest: time context', () => {
  it('always carries brave_page_date per source and adds retrieval_time after sources when supplied', () => {
    const candidates = [
      candidateOf('s0', ['a'], undefined, '2026-10-01T13:00:00Z'),
      candidateOf('s7', ['b', 'c'], ['2', '5'], null),
    ];
    const request = buildContextRequest(candidates, 'q', 'i', '2026-10-02T04:26:27.787+08:00');
    // 键序：brave_page_date 在片段之后；retrieval_time 在 sources 之后（冻结请求同序）
    assert.deepEqual(Object.keys(request.state), ['query', 'intent', 'sources', 'retrieval_time']);
    assert.equal(request.state.retrieval_time, '2026-10-02T04:26:27.787+08:00');
    assert.deepEqual(Object.keys(request.state.sources[0] ?? {}), [
      'id',
      'url',
      'title',
      'snippets',
      'brave_page_date',
    ]);
    assert.equal(request.state.sources[0]?.brave_page_date, '2026-10-01T13:00:00Z');
    assert.equal(request.state.sources[1]?.brave_page_date, null, '键恒在，无日期为 null');
  });

  it('omits retrieval_time when no normalized value is supplied but keeps page dates', () => {
    // 缺失 / 非法的检索时间由调用方归一为 undefined；纯库不读当前时间补"今天"
    const candidates = [candidateOf('s0', ['a'])];
    const request = buildContextRequest(candidates, 'q', 'i');
    assert.equal('retrieval_time' in request.state, false);
    assert.equal(request.state.sources[0]?.brave_page_date, '2026-10-01');
    // 组合题题干读取 `sources` 与 `intent`，不依赖 retrieval_time 是否在场
    assert.ok(request.questions['s0__group0']?.instructions.includes('`intent`'));
  });
});

describe('buildContextRequest: single candidate', () => {
  it('uses the shared sources[0] shape and the same grouping for one candidate too (§3.1)', () => {
    // 一个或多个候选都走同一构造：单元素也是 sources[0] + 组题，没有特殊模板
    const request = buildContextRequest(
      [candidateOf('s0', ['only surviving snippet'])],
      'q',
      'i',
      '2026-10-03T12:00:00Z'
    );
    assert.equal(request.state.sources.length, 1);
    assert.deepEqual(request.state.sources[0]?.snippets, ['only surviving snippet']);
    assert.equal(Object.keys(request.questions).length, 1 + 1);
    const group0 = request.questions['s0__group0'];
    assert.equal(group0?.type, 'choice');
    assert.equal(group0?.type === 'choice' ? group0.instructions : '', singleInstructions(0, 0));
    assert.deepEqual(request.entries, [
      {
        source_id: 's0',
        array_index: 0,
        snippet_keys: ['0'],
        question_keys: { filler: 's0__filler', group0: 's0__group0' },
        snippet_groups: [{ key: 'group0', start: 0, size: 1, letters: ['A'] }],
      },
    ]);
  });
});

describe('snippetCountOfState', () => {
  it('reads the per-source snippet count by array index and rejects bad indices', () => {
    const state = buildContextRequest(
      [candidateOf('s0', ['a']), candidateOf('s7', ['x', 'y'])],
      'q',
      'i'
    ).state;
    assert.equal(snippetCountOfState(state, 0), 1);
    assert.equal(snippetCountOfState(state, 1), 2);
    assert.equal(snippetCountOfState(state, 2), undefined, '越界数组位按未知处理');
  });
});

// ---------------------------------------------------------------------------
// projectSourceAnswers：按显式映射投影；边缘概率 = 含该位字母的全部选项概率之和；
// 坏组只影响本组，覆盖位保守记 null，不压缩不左移。
// ---------------------------------------------------------------------------

describe('projectSourceAnswers', () => {
  const GROUPS_THREE: JevSnippetGroup[] = [
    { key: 'group0', start: 0, size: 3, letters: ['A', 'B', 'C'] },
  ];

  /** choice 答案速记。 */
  const choice = (probabilities: Record<string, number>): JevAnswer => ({
    kind: 'choice',
    probabilities,
  });

  it('decodes marginal probabilities: max single option is not the per-snippet verdict (§3.3)', () => {
    // 计划示例：P(none)=0.4, P(A)=0.2, P(B)=0.1, P(AB)=0.3
    // → p(A)=0.5, p(B)=0.4；即使最大单个选项是 none，A/B 的边缘概率照常解码
    const projected = projectSourceAnswers({
      snippetCount: 2,
      groups: [{ key: 'group0', start: 0, size: 2, letters: ['A', 'B'] }],
      answerAt: (key) =>
        key === 'group0'
          ? choice({ none: 0.4, A: 0.2, B: 0.1, AB: 0.3 })
          : key === 'filler'
            ? { kind: 'noul', probability: 0.1 }
            : undefined,
    });
    assert.deepEqual(projected.judgments, [
      { kind: 'keep_probability', value: 0.5 },
      { kind: 'keep_probability', value: 0.4 },
    ]);
    assert.deepEqual(projected.answers, { filler: 0.1 });
    assert.equal(projected.invalidGroups, undefined);
  });

  it('decodes non-adjacent selections and the none label across a three-snippet group', () => {
    // p(A) = P(A) + P(AB) + P(AC) + P(ABC) = 0.15 + 0 + 0.05 + 0.1 = 0.3
    // p(B) = P(B) + P(AB) + P(BC) + P(ABC) = 0.3；p(C) = P(C) + P(AC) + P(BC) + P(ABC) = 0.75
    const projected = projectSourceAnswers({
      snippetCount: 3,
      groups: GROUPS_THREE,
      answerAt: (key) =>
        key === 'group0'
          ? choice({ none: 0.1, A: 0.15, B: 0, AB: 0, C: 0.4, AC: 0.05, BC: 0.2, ABC: 0.1 })
          : undefined,
    });
    const values = projected.judgments.map((judgment) => judgment?.value ?? Number.NaN);
    assert.ok(Math.abs(values[0] - 0.3) < 1e-12, `p(A)=${values[0]}`);
    assert.ok(Math.abs(values[1] - 0.3) < 1e-12, `p(B)=${values[1]}`);
    assert.ok(Math.abs(values[2] - 0.75) < 1e-12, `p(C)=${values[2]}`);
  });

  it('uses P(A) directly for single-snippet groups', () => {
    const projected = projectSourceAnswers({
      snippetCount: 1,
      groups: [{ key: 'group0', start: 0, size: 1, letters: ['A'] }],
      answerAt: (key) => (key === 'group0' ? choice({ none: 0.7, A: 0.3 }) : undefined),
    });
    assert.deepEqual(projected.judgments, [{ kind: 'keep_probability', value: 0.3 }]);
  });

  it('keeps holes at their positions: a broken middle group does not shift other groups (T05)', () => {
    // 7 片 = 3 + 3 + 1：中间组缺答，尾组仍写回第 6 位。
    const projected = projectSourceAnswers({
      snippetCount: 7,
      groups: [
        ...GROUPS_THREE,
        { key: 'group3', start: 3, size: 3, letters: ['A', 'B', 'C'] },
        { key: 'group6', start: 6, size: 1, letters: ['A'] },
      ],
      answerAt: (key) =>
        key === 'group0'
          ? choice({ none: 0, A: 1, B: 0, AB: 0, C: 0, AC: 0, BC: 0, ABC: 0 })
          : key === 'group6'
            ? choice({ none: 0.2, A: 0.8 })
            : key === 'filler'
              ? { kind: 'noul', probability: 0.2 }
              : undefined,
    });
    assert.deepEqual(projected.judgments, [
      { kind: 'keep_probability', value: 1 },
      { kind: 'keep_probability', value: 0 },
      { kind: 'keep_probability', value: 0 },
      null,
      null,
      null,
      { kind: 'keep_probability', value: 0.8 },
    ]);
    assert.deepEqual(projected.invalidGroups, { group3: 'missing' });
  });

  it('rejects label mismatches without filling zeros and records the reason (§4.1)', () => {
    const base = {
      snippetCount: 2,
      groups: [{ key: 'group0', start: 0, size: 2, letters: ['A', 'B'] }] as JevSnippetGroup[],
    };
    // 缺标签：缺失概率不补 0
    const missingLabel = projectSourceAnswers({
      ...base,
      answerAt: (key) => (key === 'group0' ? choice({ none: 0.5, A: 0.5 }) : undefined),
    });
    assert.deepEqual(missingLabel.judgments, [null, null]);
    assert.deepEqual(missingLabel.invalidGroups, { group0: 'labels' });
    // 多余标签
    const extraLabel = projectSourceAnswers({
      ...base,
      answerAt: (key) =>
        key === 'group0' ? choice({ none: 0.4, A: 0.3, B: 0.2, AB: 0.1, X: 0 }) : undefined,
    });
    assert.deepEqual(extraLabel.invalidGroups, { group0: 'labels' });
    // 错误字母
    const wrongLetter = projectSourceAnswers({
      ...base,
      answerAt: (key) =>
        key === 'group0' ? choice({ none: 0.4, A: 0.3, B: 0.2, AX: 0.1 }) : undefined,
    });
    assert.deepEqual(wrongLetter.invalidGroups, { group0: 'labels' });
  });

  it('rejects probability sums outside the local tolerance', () => {
    const projected = projectSourceAnswers({
      snippetCount: 1,
      groups: [{ key: 'group0', start: 0, size: 1, letters: ['A'] }],
      answerAt: (key) => (key === 'group0' ? choice({ none: 0.4, A: 0.4 }) : undefined), // 和 0.8
    });
    assert.deepEqual(projected.invalidGroups, { group0: 'sum' });
    assert.deepEqual(projected.judgments, [null]);
    // 边界：|sum-1| 恰好达到容忍度判无效，严格小于才接受
    const atTolerance = CHOICE_SUM_TOLERANCE;
    const edge = projectSourceAnswers({
      snippetCount: 1,
      groups: [{ key: 'group0', start: 0, size: 1, letters: ['A'] }],
      answerAt: (key) => (key === 'group0' ? choice({ none: 1, A: atTolerance }) : undefined), // 和 1.06
    });
    assert.deepEqual(edge.invalidGroups, { group0: 'sum' });
  });

  it('接受范围内的概率和误差不会被归一化或舍入到保留门槛', () => {
    const probabilities = { none: 0.701, A: 0.249, B: 0, AB: 0 };
    const projected = projectSourceAnswers({
      snippetCount: 2,
      groups: [{ key: 'group0', start: 0, size: 2, letters: ['A', 'B'] }],
      answerAt: (key) => (key === 'group0' ? choice(probabilities) : undefined),
    });
    assert.equal(projected.invalidGroups, undefined);
    assert.equal(projected.judgments[0]?.value, 0.249);
    assert.ok(projected.judgments[0]!.value < 0.25);
    assert.deepEqual(probabilities, { none: 0.701, A: 0.249, B: 0, AB: 0 });
  });

  it('treats wrong-type page answers as absent and keeps page answers out of the table only when missing', () => {
    const projected = projectSourceAnswers({
      snippetCount: 1,
      groups: [{ key: 'group0', start: 0, size: 1, letters: ['A'] }],
      answerAt: (key) => (key === 'group0' ? choice({ none: 0.2, A: 0.8 }) : undefined),
    });
    // 页面题缺答：不进表（范围与 validation 校验在裁决层）
    assert.deepEqual(projected.answers, {});
    assert.equal(projected.invalidGroups, undefined);

    const wrongType = projectSourceAnswers({
      snippetCount: 1,
      groups: [{ key: 'group0', start: 0, size: 1, letters: ['A'] }],
      answerAt: (key) =>
        key === 'group0'
          ? choice({ none: 0.2, A: 0.8 })
          : key === 'filler'
            ? choice({ none: 0.2, A: 0.8 }) // 页面题收到 choice：错型不进表
            : undefined,
    });
    assert.deepEqual(wrongType.answers, {});
  });
});
