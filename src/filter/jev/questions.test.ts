/** 当前题库生成与哈希测试。 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_JEV_CONCURRENCY,
  DEFAULT_JEV_MODEL,
  DEFAULT_JEV_TIMEOUT_MS,
  GLOBAL_INSTRUCTION,
  QUESTION_SET_ID,
  SNIPPET_CRITERIA,
  SOURCE_QUESTIONS,
  buildSnippetScoreQuestion,
  buildSourceQuestions,
  snippetScoreInstructions,
} from './questions.js';

describe('SOURCE_QUESTIONS', () => {
  it('has exactly the four source-level keys after the 2026-10-03 slimming', () => {
    assert.deepEqual(Object.keys(SOURCE_QUESTIONS), [
      'has_original_reasoning',
      'is_template_filler',
      'is_off_topic',
      'is_listing',
    ]);
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

// 评分题干与 criteria 的全文由 QUESTION_SET_ID 哈希锁定（见下方用例），
// 此处只验证结构与占位符展开，不镜像长文本。

describe('SNIPPET_CRITERIA', () => {
  it('carries exactly three criteria in drop / weak / strong order', () => {
    assert.equal(SNIPPET_CRITERIA.length, 3);
    // 以前缀识别各条语义身份：剔除 → 提及但无可用信息 → 有具体信息
    assert.ok(SNIPPET_CRITERIA[0].startsWith('Navigation, boilerplate, off-direction'));
    assert.ok(SNIPPET_CRITERIA[1].startsWith('Mentions the subject of `intent`'));
    assert.ok(SNIPPET_CRITERIA[2].startsWith('States specific facts'));
  });
});

describe('buildSnippetScoreQuestion', () => {
  it('expands the score template placeholders at a non-zero position', () => {
    const question = buildSnippetScoreQuestion(3, 1);
    assert.equal(question.type, 'score');
    // 模板占位符按 (来源, 片段) 下标展开
    assert.ok(
      question.instructions.startsWith(
        'How useful is `sources[3].snippets[1]` for answering `intent`?'
      )
    );
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
