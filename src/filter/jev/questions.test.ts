/**
 * 题库常量单测：十键齐全、总指令前缀、计数公式、state 形状，以及 probe ↔ 生产
 * 的深比较门禁——两份重录 `.jev.json` 夹具的顶层 questions / levels 与本表
 * 逐字对账，probe 录制题库与生产题库任何一侧改动都会在这里红（02-01 三处
 * 同源对齐的根基）。
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
  it('only asks temporal questions for snippets containing a standalone year', () => {
    const questions = buildQuestions([
      'Measured in January 2024: the response took 80ms.',
      'The instance list is available as JSON.',
      'Identifier 1202400 is not a year.',
      'Measurements from 2026 remain below the limit.',
    ]);
    assert.deepEqual(
      Object.keys(questions).filter((key) => key.startsWith('time_')),
      ['time_snip0', 'time_snip3']
    );
    assert.equal(questions.time_snip0.type, 'noul');
    assert.equal(Object.hasOwn(questions, 'time_source'), false);
  });

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

// ---------------------------------------------------------------------------
// probe ↔ 生产题库深比较门禁：夹具顶层 questions（含总指令前缀的完整题干）与
// levels 必须与本表逐键逐字一致——录制口径与生产口径从此锁死。
// ---------------------------------------------------------------------------

describe('recorded question bank deep compare', () => {
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

      it('locks the ten recorded questions to the constant table verbatim', () => {
        const expected: Record<string, string> = {};
        for (const [key, text] of Object.entries(SOURCE_QUESTIONS)) {
          expected[key] = `${GLOBAL_INSTRUCTION} ${text}`;
        }
        assert.deepEqual(recording.questions, expected);
      });

      it('locks the three snippet levels to SNIPPET_LEVELS', () => {
        assert.deepEqual(recording.levels, [...SNIPPET_LEVELS]);
      });
    });
  }
});
