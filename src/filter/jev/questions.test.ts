/**
 * 题库常量单测：十键齐全、总指令前缀、计数公式与 state 形状。
 * probe ↔ 生产的深比较门禁（两份 `.jev.json` 夹具顶层 questions / levels 与
 * 本表逐字对账）在 Task 2 追加；这里先锁常量表自身的结构与形状。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
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

describe('SOURCE_QUESTIONS', () => {
  it('has exactly the ten v3 source-level keys', () => {
    assert.deepEqual(Object.keys(SOURCE_QUESTIONS), [
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
  it('carries the eleven authoritative initial values', () => {
    assert.deepEqual(
      { ...DEFAULT_THRESHOLDS },
      {
        offTopicDrop: 0.85,
        listingDrop: 0.8,
        selfDeprecated: 0.7,
        staleDrop: 0.85,
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
  it('returns ten source-level questions plus one score question per snippet', () => {
    const questions = buildQuestions(3);
    assert.equal(Object.keys(questions).length, 13);
    assert.deepEqual(
      Object.keys(questions).filter((key) => key.startsWith('snip')),
      ['snip0', 'snip1', 'snip2']
    );
  });

  it('returns zero snippet questions for a source without snippets', () => {
    assert.equal(Object.keys(buildQuestions(0)).length, 10);
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
