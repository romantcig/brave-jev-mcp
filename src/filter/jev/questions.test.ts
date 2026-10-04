/** 当前题库生成与哈希测试；历史录制单独验证结构完整性，不改写成当前题库回答。 */

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
  QUESTION_SET_ID,
  SNIPPET_CRITERIA,
  SOURCE_QUESTIONS,
  buildSnippetScoreQuestion,
  buildSourceQuestions,
  snippetScoreInstructions,
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

// ---------------------------------------------------------------------------
// 来源级四题生成器（唯一生成接口之一）：按请求 sources[] 数组位置生成，题意、
// 顺序与总指令前缀不变；`\bsource\b` 命名空间转换与第十六 / 十九轮口径逐字一致。
// ---------------------------------------------------------------------------

describe('buildSourceQuestions', () => {
  it('returns exactly the four source-level questions with their keys in bank order', () => {
    const questions = buildSourceQuestions(0);
    assert.deepEqual(Object.keys(questions), [
      'has_original_reasoning',
      'is_template_filler',
      'is_off_topic',
      'is_listing',
    ]);
  });

  it('types every question as noul without criteria and prefixes the (namespaced) global instruction', () => {
    // 前缀在拼接后整体做命名空间转换：总指令里的 `source` 一并换成 sources[i]
    // （与原 planAllRequest 口径一致，基线快照逐字对账）
    for (const question of Object.values(buildSourceQuestions(0))) {
      assert.equal(question.type, 'noul');
      assert.equal('criteria' in question, false);
      assert.ok(
        question.instructions.startsWith(
          `${GLOBAL_INSTRUCTION.replace(/\bsource\b/g, 'sources[0]')} `
        ),
        `missing global instruction prefix: ${question.instructions.slice(0, 60)}`
      );
    }
  });

  it('rewrites `source` references to `sources[i]` by array position, not source id (round-16)', () => {
    // 数组位置 0：总指令与题干里的 `source` 全部替换
    const atZero = buildSourceQuestions(0);
    assert.equal(
      atZero.is_off_topic?.instructions,
      `${GLOBAL_INSTRUCTION.replace(/\bsource\b/g, 'sources[0]')} \`sources[0]\` is not about the subject of \`query\`.`
    );

    // 数组位置与来源 ID 解耦：s7 这类 ID 也可能落在数组位置 1
    const atOne = buildSourceQuestions(1);
    assert.equal(
      atOne.has_original_reasoning?.instructions,
      GLOBAL_INSTRUCTION.replace(/\bsource\b/g, 'sources[1]') +
        " `sources[1]` contains the author's own evaluation, criticism, comparison, or argument with stated reasons, not just reported claims."
    );
    assert.equal(atOne.is_off_topic?.instructions.includes('`sources[1]` is not about'), true);
  });

  it('does not touch words other than the standalone `source` (plural and possessive stay)', () => {
    // \b 边界：is_listing 题干里的 "a single article" 与总指令以外的词不受影响；
    // 转换只命中独立的 source 单词
    const questions = buildSourceQuestions(2);
    assert.ok(questions.is_listing?.instructions.includes('not the body of a single article.'));
    assert.equal(questions.is_listing?.instructions.includes('`sources[2]` is a list'), true);
  });
});

// 逐字锁定评分题干与 criteria（Candidate 1+ / C1+ 规范），改题后必须重新取得回答。

/** 冻结评分题干（Candidate 1+，位置 (3,1) 实例化）。 */
const FROZEN_INSTRUCTIONS_3_1 =
  'How useful is `sources[3].snippets[1]` for answering `intent`? ' +
  'Assess time-bound claims using `sources`: an earlier prediction replaced by ' +
  'a confirmed event is obsolete, but still-applicable technical explanations, ' +
  'architectural comparisons, or practical examples remain useful.';

describe('SNIPPET_CRITERIA', () => {
  it('carries the three frozen criteria verbatim in order', () => {
    assert.deepEqual(
      [...SNIPPET_CRITERIA],
      [
        'Navigation, boilerplate, off-direction, or an obsolete prediction replaced by confirmed facts',
        'Mentions the subject of `intent` but provides no specific information usable in answering it',
        'States specific facts, technical explanations, architectural comparisons, or practical examples that answer `intent`',
      ]
    );
    assert.equal(Object.isFrozen(SNIPPET_CRITERIA), true);
  });
});

describe('buildSnippetScoreQuestion', () => {
  it('reproduces the frozen text verbatim at a non-zero position', () => {
    const question = buildSnippetScoreQuestion(3, 1);
    assert.equal(question.type, 'score');
    assert.equal(question.instructions, FROZEN_INSTRUCTIONS_3_1);
    assert.deepEqual(question.criteria, SNIPPET_CRITERIA);
  });

  it('substitutes only the two index numbers and never the global-instruction prefix', () => {
    const question = buildSnippetScoreQuestion(7, 2);
    assert.ok(
      question.instructions.startsWith(
        'How useful is `sources[7].snippets[2]` for answering `intent`?'
      )
    );
    // 总指令限定"只看 source 的可观察文本"，与新题读取其他来源冲突——不加前缀
    assert.equal(question.instructions.includes(GLOBAL_INSTRUCTION), false);
    assert.ok(question.instructions.includes('architectural comparisons'));
    assert.ok(question.instructions.includes('using `sources`'));
  });

  it('is the projection of snippetScoreInstructions at the same position', () => {
    assert.equal(buildSnippetScoreQuestion(2, 5).instructions, snippetScoreInstructions(2, 5));
  });
});

describe('QUESTION_SET_ID (all-only recipe)', () => {
  it('pins the hash that covers only the active bank: source questions, global instruction, the frozen score template and criteria', () => {
    // 锁定现行题库完整哈希，防止题干、criteria、键序或总指令无意漂移。
    assert.equal(QUESTION_SET_ID, 'a03ab5c2506c');
  });
});

// 两份历史录制是旧十题题库的真实记录，验证原始结构，不改写内容。
// 其回答用于当前规则回放时属于固定回答验证，不代表模型对当前题目的回答。

/** 历史录制对应的十个来源题键。 */
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

/** 历史录制的三档评分说明，仅用于核对原始格式。 */
const V3_HISTORICAL_LEVELS: readonly string[] = [
  'Navigation, metadata, boilerplate, or unrelated to `query`',
  'Mentions the subject of `query` but adds no specific information',
  'States specific information or analysis that directly serves `intent`',
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

      it('keeps the three snippet levels aligned with the retired v3 legend verbatim', () => {
        assert.deepEqual(recording.levels, [...V3_HISTORICAL_LEVELS]);
      });
    });
  }
});
