import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { summarizeOutput, zeroLocal, type SummarizeSourceRow } from './stats.js';

const makeSource = (
  texts: string[],
  kept: boolean[] = texts.map(() => true),
  verdict: 'keep' | 'drop' = 'keep'
): SummarizeSourceRow => ({
  verdict,
  snippets: texts.map((text, i) => ({ text, kept: kept[i] ?? true })),
});

describe('zeroLocal', () => {
  it('zeroLocal 包含全部本地统计初始计数', () => {
    assert.deepEqual(zeroLocal, {
      jsonld_converted: 0,
      jsonld_dropped: 0,
      jsonld_kept_raw: 0,
      snippets_prefiltered: 0,
      dup_removed: 0,
      empty_dropped: 0,
      github_cleanup_actions: 0,
      x_cleanup_actions: 0,
      devto_cleanup_actions: 0,
    });
  });
});

describe('summarizeOutput', () => {
  it('counts surviving sources and snippets', () => {
    const table = [makeSource(['abcd', 'efgh'], [true, false]), makeSource(['ijkl'], [true])];

    const out = summarizeOutput(table);

    assert.equal(out.n_sources, 2);
    assert.equal(out.n_snippets, 2);
    assert.equal(out.chars, 8);
  });

  it('sums chars over surviving snippets only, as String.length', () => {
    const table = [
      makeSource(['abcd', 'ef'], [true, false]), // 2 字符的被删片段不计入
      makeSource(['ghijkl'], [true]),
    ];

    const out = summarizeOutput(table);

    assert.deepEqual(out, { n_sources: 2, n_snippets: 2, chars: 10 });
  });

  it('skips dropped sources entirely', () => {
    const table = [makeSource(['abcd'], [true], 'keep'), makeSource(['efgh'], [true], 'drop')];

    const out = summarizeOutput(table);

    assert.deepEqual(out, { n_sources: 1, n_snippets: 1, chars: 4 });
  });
});
