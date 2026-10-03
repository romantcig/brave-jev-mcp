/** 共享请求与答案投影测试：来源 ID 和数组位置分离，缺答不左移，坏值不当作零分。 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  allQuestionKey,
  buildContextRequest,
  projectSourceAnswers,
  snippetCountOfState,
} from './context.js';
import { GLOBAL_INSTRUCTION, SNIPPET_CRITERIA } from './questions.js';
import type { JevCandidateDetailed } from '../types.js';

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
    // 映射：数组位置与来源 ID、片段配对身份一一对应
    assert.deepEqual(request.entries, [
      {
        source_id: 's0',
        array_index: 0,
        snippet_keys: ['0'],
        question_keys: {
          has_original_reasoning: 's0__has_original_reasoning',
          is_template_filler: 's0__is_template_filler',
          is_off_topic: 's0__is_off_topic',
          is_listing: 's0__is_listing',
          snip0: 's0__snip0',
        },
      },
      {
        source_id: 's7',
        array_index: 1,
        snippet_keys: ['2', '5'],
        question_keys: {
          has_original_reasoning: 's7__has_original_reasoning',
          is_template_filler: 's7__is_template_filler',
          is_off_topic: 's7__is_off_topic',
          is_listing: 's7__is_listing',
          snip0: 's7__snip0',
          snip1: 's7__snip1',
        },
      },
    ]);
    assert.equal(request.state.sources[1]?.id, 's7');
  });

  it('namespaces question keys and rewrites `source` references exactly like round-16 (§4.1)', () => {
    const candidates = [
      candidateOf('s0', ['plain text']),
      candidateOf('s7', ['has 2026 year', 'another']),
    ];
    const request = buildContextRequest(candidates, 'q', 'i');

    // 题键：`${source.id}__${localQuestionKey}`（例 s7__snip2）
    const keys = Object.keys(request.questions);
    for (const key of keys) {
      assert.ok(key.startsWith('s0__') || key.startsWith('s7__'), key);
    }
    assert.ok(keys.includes('s7__snip0'));

    // 来源题引用转换：`\bsource\b` → `sources[i]`（i 为数组位置），与
    // dev/filter-round16-quality.ts 的 instructions.replace 同一正则同一结果——
    // 总指令与来源题的引用全部命中
    assert.equal(
      request.questions['s7__is_off_topic']?.instructions,
      GLOBAL_INSTRUCTION.replace(/\bsource\b/g, 'sources[1]') +
        ' `sources[1]` is not about the subject of `query`.'
    );
    // 片段题是冻结新题：按数组位置生成、新三档 criteria、不带总指令前缀
    const s7snip1 = request.questions['s7__snip1'];
    assert.equal(s7snip1?.type, 'score');
    assert.ok(
      s7snip1?.instructions.startsWith(
        'How useful is `sources[1].snippets[1]` for answering `intent`?'
      )
    );
    assert.equal(s7snip1?.instructions.includes(GLOBAL_INSTRUCTION), false);
    assert.ok(s7snip1?.instructions.includes("A source's `brave_page_date`"));
    assert.deepEqual(s7snip1?.criteria, SNIPPET_CRITERIA);
    // s0（数组位置 0）引用 sources[0]，不串到 s7 的位置
    assert.match(
      request.questions['s0__is_off_topic']?.instructions ?? /$/,
      /`sources\[0\]` is not about/
    );
  });

  it('keeps the question key structure: four source questions plus one score per snippet', () => {
    const candidates = [candidateOf('s0', ['a']), candidateOf('s7', ['b', 'c'], ['2', '5'])];
    const request = buildContextRequest(candidates, 'q', 'i');
    assert.deepEqual(
      Object.keys(request.questions).filter((key) => key.startsWith('s7__')),
      [
        's7__has_original_reasoning',
        's7__is_template_filler',
        's7__is_off_topic',
        's7__is_listing',
        's7__snip0',
        's7__snip1',
      ]
    );
    // 总题数公式：候选数 × 4 + 候选片段数
    assert.equal(Object.keys(request.questions).length, 2 * 4 + 3);
  });

  it('does not mutate the input candidates (write-copy)', () => {
    const candidates = [candidateOf('s0', ['a', 'b'], ['0', '1'])];
    const frozen = structuredClone(candidates);
    buildContextRequest(candidates, 'q', 'i');
    assert.deepEqual(candidates, frozen);
  });
});

// 页面日期与评分题始终构造；检索时间仅在显式传入合法值时携带。

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
    // 片段题仍是冻结新题（题干读取 retrieval_time 的措辞照发，缺输入由 Jev 侧处理）
    assert.ok(
      request.questions['s0__snip0']?.instructions.startsWith(
        'How useful is `sources[0].snippets[0]` for answering `intent`?'
      )
    );
  });
});

describe('buildContextRequest: single candidate', () => {
  it('uses the shared sources[0] shape and the frozen score question for one candidate too (§3.1)', () => {
    // 一个或多个候选都走同一构造：单元素也是 sources[0] + 新题，没有特殊模板
    const request = buildContextRequest(
      [candidateOf('s0', ['only surviving snippet'])],
      'q',
      'i',
      '2026-10-03T12:00:00Z'
    );
    assert.equal(request.state.sources.length, 1);
    assert.deepEqual(request.state.sources[0]?.snippets, ['only surviving snippet']);
    assert.equal(Object.keys(request.questions).length, 4 + 1);
    const snip0 = request.questions['s0__snip0'];
    assert.equal(snip0?.type, 'score');
    assert.ok(
      snip0?.instructions.startsWith(
        'How useful is `sources[0].snippets[0]` for answering `intent`?'
      )
    );
    assert.deepEqual(request.entries, [
      {
        source_id: 's0',
        array_index: 0,
        snippet_keys: ['0'],
        question_keys: {
          has_original_reasoning: 's0__has_original_reasoning',
          is_template_filler: 's0__is_template_filler',
          is_off_topic: 's0__is_off_topic',
          is_listing: 's0__is_listing',
          snip0: 's0__snip0',
        },
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

describe('projectSourceAnswers', () => {
  const QUESTION_KEYS = [
    'is_off_topic',
    'is_listing',
    'is_template_filler',
    'has_original_reasoning',
  ];
  /** 局部键全集（与构造的题键同形；instructions 不参与投影逻辑）。 */
  const localKeys = (nSnippets: number): string[] => [
    ...QUESTION_KEYS,
    ...Array.from({ length: nSnippets }, (_, i) => `snip${i}`),
  ];
  const answer = (kind: 'noul' | 'score', value: number) =>
    kind === 'noul'
      ? { kind: 'noul' as const, probability: value }
      : { kind: 'score' as const, score: value };

  it('projects via the mapping for all mode: answers land on the right source, no cross-source bleed (T04)', () => {
    // s7 在数组位置 1；映射把局部键换到 s7__ 前缀
    const questionKeys: Record<string, string> = {};
    for (const key of localKeys(2)) {
      questionKeys[key] = allQuestionKey('s7', key);
    }
    const projected = projectSourceAnswers({
      snippetCount: 2,
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

  it('projects one source by explicit keys like the previous inline collection (T12 basis)', () => {
    const projected = projectSourceAnswers({
      snippetCount: 2,
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
      snippetCount: 3,
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
      snippetCount: 4,
      answerAt: answerFor,
    });
    assert.deepEqual(projected.scoreValidity, [false, false, false, false]);
    // 实收值保留（含越界）供复查；非有限为 null
    assert.deepEqual(projected.scoresReceived, [null, null, -0.5, 3]);
    // snip0 错型（noul）缺位：4 个题位只收 3 个 score → 整组不完整
    assert.equal(projected.snippetScores, undefined);
  });
});
