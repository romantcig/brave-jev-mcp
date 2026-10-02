/**
 * 题库常量单测：四键齐全（2026-10-03 精简后）、总指令前缀、计数公式、state 形状，
 * 以及历史录制兼容——两份重录 `.jev.json` 夹具是 v3 十题题库的历史证据（不得改写
 * 冒充新题库），这里只验证其结构完整可读；当前题库契约由 SOURCE_QUESTIONS /
 * buildQuestions 断言锁定，不再要求旧录制等于当前生成器。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_JEV_CONCURRENCY,
  DEFAULT_JEV_MODEL,
  DEFAULT_JEV_TIMEOUT_MS,
  DEFAULT_THRESHOLDS,
  GLOBAL_INSTRUCTION,
  SNIPPET_LEVELS,
  SOURCE_QUESTIONS,
  buildQuestions,
  buildState,
} from './questions.js';

const fixtureRoot = fileURLToPath(new URL('../../../fixtures/', import.meta.url));

describe('SOURCE_QUESTIONS', () => {
  it('has exactly the four source-level keys after the 2026-10-03 slimming', () => {
    assert.deepEqual(Object.keys(SOURCE_QUESTIONS), [
      'has_original_reasoning',
      'is_template_filler',
      'is_off_topic',
      'is_listing',
    ]);
  });

  it('is frozen so callers cannot mutate the question bank', () => {
    assert.equal(Object.isFrozen(SOURCE_QUESTIONS), true);
  });
});

describe('SNIPPET_LEVELS', () => {
  it('carries the three legend entries in probe order', () => {
    assert.deepEqual(
      [...SNIPPET_LEVELS],
      [
        'Navigation, metadata, boilerplate, or unrelated to `query`',
        'Mentions the subject of `query` but adds no specific information',
        'States specific information or analysis that directly serves `intent`',
      ]
    );
  });
});

describe('DEFAULT_THRESHOLDS', () => {
  it('carries the nine authoritative initial values', () => {
    assert.deepEqual(
      { ...DEFAULT_THRESHOLDS },
      {
        offTopicDrop: 0.85,
        listingDrop: 0.8,
        fillerDrop: 0.8,
        reasoningProtect: 0.7,
        snippetMin: 1.0,
        minFacts: 4,
        noveltyMin: 2,
        cjkBonus: 0.1,
        cjkShare: 0.5,
      }
    );
  });
});

describe('pinned model and fallback constants', () => {
  it('pins the model id and never uses the drifting latest alias', () => {
    assert.equal(DEFAULT_JEV_MODEL, 'jev-1.13.0');
    assert.doesNotMatch(DEFAULT_JEV_MODEL, /latest/);
  });

  it('carries the timeout and concurrency fallback constants', () => {
    assert.equal(DEFAULT_JEV_TIMEOUT_MS, 15000);
    assert.equal(DEFAULT_JEV_CONCURRENCY, 12);
  });
});

describe('buildQuestions', () => {
  it('returns four source-level questions plus one score question per snippet', () => {
    const questions = buildQuestions(3);
    assert.equal(Object.keys(questions).length, 7);
    assert.deepEqual(
      Object.keys(questions).filter((key) => key.startsWith('snip')),
      ['snip0', 'snip1', 'snip2']
    );
  });

  it('returns zero snippet questions for a source without snippets', () => {
    assert.equal(Object.keys(buildQuestions(0)).length, 4);
  });

  it('produces equal tables for text and count forms now that temporal questions are retired', () => {
    // 片段级时间题退役（2026-10-03，filter-rules-12）后，正文形式与数量形式的
    // 产出完全一致（4 来源题 + N 道 snip 题）；此守卫锁住该性质——含带年份片段
    // 也不再追加题目。签名合并属单独的兼容性清理（MAINTENANCE_SIMPLIFICATION_PLAN §2），
    // 届时以本守卫为锚。
    const snippets = [
      'Measured in January 2024: the response took 80ms.',
      'The instance list is available as JSON.',
      'Measurements from 2026 remain below the limit.',
    ];
    assert.deepEqual(buildQuestions(snippets), buildQuestions(snippets.length));
  });

  it('prefixes the global instruction followed by a space into every question', () => {
    for (const question of Object.values(buildQuestions(2))) {
      assert.ok(
        question.instructions.startsWith(`${GLOBAL_INSTRUCTION} `),
        `missing global instruction prefix: ${question.instructions.slice(0, 60)}`
      );
    }
  });

  it('types source-level questions as noul without criteria', () => {
    const questions = buildQuestions(1);
    for (const key of Object.keys(SOURCE_QUESTIONS)) {
      const question = questions[key];
      assert.ok(question, `${key} missing from the built table`);
      assert.equal(question.type, 'noul');
      assert.equal('criteria' in question, false, `${key} must not carry criteria`);
    }
  });

  it('types snippet questions as score with the three-level criteria', () => {
    const snip = buildQuestions(1)['snip0'];
    assert.ok(snip, 'snip0 missing');
    assert.equal(snip.type, 'score');
    assert.deepEqual(snip.criteria, SNIPPET_LEVELS);
    assert.match(snip.instructions, /How useful is `source\.snippets\[0\]` for `intent`\?$/);
  });
});

describe('buildState', () => {
  it('shapes the single-source state with query and intent at the top', () => {
    assert.deepEqual(buildState('s0', 'https://a.example/', 'Title', ['one', 'two'], 'q', 'i'), {
      query: 'q',
      intent: 'i',
      source: { id: 's0', url: 'https://a.example/', title: 'Title', snippets: ['one', 'two'] },
    });
  });

  it('passes the snippets array by reference without copying or reordering', () => {
    const snippets = ['a', 'b'];
    const state = buildState('s1', 'https://b.example/', 'T', snippets, 'q', 'i');
    assert.equal(state.source.snippets, snippets);
  });
});

// ---------------------------------------------------------------------------
// 历史录制兼容：两份 .jev.json 是 2026-09-25 v3 十题题库的真实探测记录（历史证据，
// 不得修改 questions / answers / model / usage 冒充新题库录制）。2026-10-01 六题
// 精简后它们不再是当前生成器的投影——这里只验证历史结构完整可读（v3 十键齐全、
// 总指令前缀、三档 levels），供回放与历史对账；旧回答在新规则下回放属于"固定回
// 答的规则验证"，不能冒充新题的真实回答。
// ---------------------------------------------------------------------------

/** v3 历史十题键（2026-10-01 精简前的完整集合；git 历史 `git log -- src/filter/jev/questions.ts` 可取证）。 */
const V3_HISTORICAL_KEYS: readonly string[] = [
  'worth_keeping',
  'is_primary',
  'has_original_reasoning',
  'is_attributed_rewrite',
  'is_template_filler',
  'is_off_topic',
  'is_listing',
  'self_deprecated',
  'stale',
  'paywalled',
];

describe('historical recording compatibility', () => {
  for (const name of ['jev_release_default', 'jev_release_strict']) {
    describe(name, () => {
      const parsed: unknown = JSON.parse(
        readFileSync(join(fixtureRoot, `${name}.jev.json`), 'utf8')
      );
      assert.ok(
        typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed),
        `${name}.jev.json is not an object`
      );
      const recording = parsed as { questions: Record<string, string>; levels: string[] };

      it('keeps the ten v3 questions readable and untouched as historical evidence', () => {
        assert.deepEqual(Object.keys(recording.questions), [...V3_HISTORICAL_KEYS]);
        for (const [key, text] of Object.entries(recording.questions)) {
          assert.equal(typeof text, 'string', `${key} must remain a string`);
          assert.ok(
            text.startsWith(`${GLOBAL_INSTRUCTION} `),
            `${key} must carry the global instruction prefix`
          );
        }
      });

      it('keeps the three snippet levels aligned with the unchanged SNIPPET_LEVELS', () => {
        assert.deepEqual(recording.levels, [...SNIPPET_LEVELS]);
      });
    });
  }
});
