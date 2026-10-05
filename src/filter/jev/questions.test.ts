/** 当前题库生成与哈希测试。 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_JEV_CONCURRENCY,
  DEFAULT_JEV_MODEL,
  DEFAULT_JEV_TIMEOUT_MS,
  GROUP_MAX_SIZE,
  PAGE_QUESTION_KEY,
  QUESTION_SET_ID,
  buildPageFillerQuestion,
  buildSnippetGroupQuestion,
  choiceCriteria,
  groupInstructions,
  pageFillerInstructions,
  singleInstructions,
  snippetGroupsOf,
} from './questions.js';

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
// 页面题：每来源一道模板垃圾题，局部键 filler，noul 无 criteria。
// ---------------------------------------------------------------------------

describe('pageFillerInstructions / buildPageFillerQuestion', () => {
  it('expands only the array position and keeps the exact frozen wording', () => {
    assert.equal(
      pageFillerInstructions(0),
      'Judge the text of `sources[0]`. This source mostly repeats the topic name and ' +
        'generic phrasing without specific facts, or is a template article assembled from ' +
        "headlines, AND it lacks the author's own evaluation, criticism, comparison, or " +
        'argument with stated reasons.'
    );
    assert.ok(pageFillerInstructions(4).startsWith('Judge the text of `sources[4]`.'));
  });

  it('types the page question as noul with the filler key and no criteria', () => {
    const question = buildPageFillerQuestion(2);
    assert.equal(question.type, 'noul');
    assert.equal('criteria' in question, false);
    assert.equal(question.instructions, pageFillerInstructions(2));
    assert.equal(PAGE_QUESTION_KEY, 'filler');
  });
});

// ---------------------------------------------------------------------------
// choice 组合题：criteria 按位掩码从 0 递增（none, A, B, AB, C, AC, BC, ABC），
// 不改为字母排序；组内字母每组从 A 重新开始。
// ---------------------------------------------------------------------------

describe('choiceCriteria', () => {
  it('generates bitmask order labels for one, two and three snippet groups', () => {
    assert.deepEqual(Object.keys(choiceCriteria(1)), ['none', 'A']);
    assert.deepEqual(Object.keys(choiceCriteria(2)), ['none', 'A', 'B', 'AB']);
    assert.deepEqual(Object.keys(choiceCriteria(3)), [
      'none',
      'A',
      'B',
      'AB',
      'C',
      'AC',
      'BC',
      'ABC',
    ]);
  });

  it('maps every label to null', () => {
    for (const value of Object.values(choiceCriteria(3))) assert.equal(value, null);
  });
});

describe('groupInstructions / singleInstructions', () => {
  it('lists explicit letter references for multi-snippet groups and restarts letters per group', () => {
    assert.ok(
      groupInstructions(0, 3, 2).startsWith(
        'A=`sources[0].snippets[3]`; B=`sources[0].snippets[4]`. '
      )
    );
    assert.ok(
      groupInstructions(2, 6, 3).startsWith(
        'A=`sources[2].snippets[6]`; B=`sources[2].snippets[7]`; C=`sources[2].snippets[8]`. '
      )
    );
  });

  it('carries the retain/discard standard, the time context and the exact-select closing line', () => {
    const instructions = groupInstructions(0, 0, 3);
    assert.ok(
      instructions.includes(
        'Retain snippets containing specific facts, technical explanations, architectural comparisons, or practical examples usable in answering `intent`.'
      )
    );
    assert.ok(
      instructions.includes(
        'Assess time-bound claims using `sources`: an earlier prediction replaced by a confirmed event is obsolete'
      )
    );
    assert.ok(
      instructions.endsWith(
        'Evaluate each snippet independently. Select exactly the letters of all snippets to retain, or none.'
      )
    );
  });

  it('uses the short single-snippet wording bound to one letter reference', () => {
    assert.equal(
      singleInstructions(3, 0),
      'A=`sources[3].snippets[0]`. Keep A if it provides specific information usable in ' +
        'answering `intent`. Discard navigation, boilerplate, off-direction content, mere ' +
        'topic mentions, and obsolete predictions replaced by confirmed events in `sources`. ' +
        'Retain still-applicable explanations, comparisons, and examples.'
    );
  });
});

describe('buildSnippetGroupQuestion', () => {
  it('builds single questions with the short wording and two-option criteria', () => {
    const question = buildSnippetGroupQuestion(1, 3, 1);
    assert.equal(question.type, 'choice');
    assert.equal(question.instructions, singleInstructions(1, 3));
    if (question.type === 'choice') assert.deepEqual(Object.keys(question.criteria), ['none', 'A']);
  });

  it('builds two and three snippet questions with the full wording and matching criteria', () => {
    for (const size of [2, 3] as const) {
      const question = buildSnippetGroupQuestion(0, 0, size);
      assert.equal(question.type, 'choice');
      assert.equal(question.instructions, groupInstructions(0, 0, size));
      if (question.type === 'choice') {
        assert.deepEqual(question.criteria, choiceCriteria(size));
      }
    }
  });
});

describe('snippetGroupsOf', () => {
  it('tiles snippet counts 1..7 into groups of at most three without crossing sources', () => {
    const shape = (count: number) =>
      snippetGroupsOf(count).map((group) => [group.key, group.start, group.size]);
    assert.deepEqual(shape(1), [['group0', 0, 1]]);
    assert.deepEqual(shape(2), [['group0', 0, 2]]);
    assert.deepEqual(shape(3), [['group0', 0, 3]]);
    assert.deepEqual(shape(4), [
      ['group0', 0, 3],
      ['group3', 3, 1],
    ]);
    assert.deepEqual(shape(5), [
      ['group0', 0, 3],
      ['group3', 3, 2],
    ]);
    assert.deepEqual(shape(6), [
      ['group0', 0, 3],
      ['group3', 3, 3],
    ]);
    assert.deepEqual(shape(7), [
      ['group0', 0, 3],
      ['group3', 3, 3],
      ['group6', 6, 1],
    ]);
  });

  it('assigns letters from A within each group and covers every position', () => {
    for (let count = 1; count <= 7; count += 1) {
      const groups = snippetGroupsOf(count);
      const covered: number[] = [];
      for (const group of groups) {
        assert.equal(group.letters.length, group.size);
        assert.equal(group.letters[0], 'A');
        for (let k = 0; k < group.size; k += 1) covered.push(group.start + k);
      }
      assert.deepEqual(
        covered,
        Array.from({ length: count }, (_, index) => index)
      );
    }
  });

  it('caps the group size at three', () => {
    assert.equal(GROUP_MAX_SIZE, 3);
  });
});

describe('QUESTION_SET_ID (three-in-one recipe)', () => {
  it('pins the hash that covers the page template, all group templates and the option orders', () => {
    // 锁定现行题库完整哈希，防止题干、criteria 或选项顺序无意漂移。
    assert.equal(QUESTION_SET_ID, 'da31568304ee');
  });
});
