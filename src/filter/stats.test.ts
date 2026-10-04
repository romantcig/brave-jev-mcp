import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { summarizeOutput, type SummarizeSourceRow } from './stats.js';

const makeSource = (
  texts: string[],
  kept: boolean[] = texts.map(() => true),
  verdict: 'keep' | 'drop' = 'keep'
): SummarizeSourceRow => ({
  verdict,
  snippets: texts.map((text, i) => ({ text, kept: kept[i] ?? true })),
});

describe('summarizeOutput', () => {
  it('ceils the unrounded estimate sum (2.1 + 2.1 → 5, not a rounding to 4)', () => {
    const table = [makeSource(['abcd', 'efgh'], [true, false]), makeSource(['ijkl'], [true])];

    const out = summarizeOutput(table, () => 2.1);

    assert.equal(out.est_tokens, 5); // Math.ceil(4.2)；Math.round(4.2) 会给 4
    assert.equal(out.n_sources, 2);
    assert.equal(out.n_snippets, 2);
  });

  it('sums chars over surviving snippets only, as String.length', () => {
    const table = [
      makeSource(['abcd', 'ef'], [true, false]), // 2 字符的被删片段不计入
      makeSource(['ghijkl'], [true]),
    ];

    const out = summarizeOutput(table, (text) => text.length * 0.5);

    assert.deepEqual(out, { n_sources: 2, n_snippets: 2, chars: 10, est_tokens: 5 });
  });

  it('skips dropped sources entirely', () => {
    const table = [makeSource(['abcd'], [true], 'keep'), makeSource(['efgh'], [true], 'drop')];

    const out = summarizeOutput(table, (text) => text.length);

    assert.deepEqual(out, { n_sources: 1, n_snippets: 1, chars: 4, est_tokens: 4 });
  });
});
