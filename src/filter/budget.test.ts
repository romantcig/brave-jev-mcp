import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  BRAVE_MAX_TOKENS,
  BRAVE_MAX_URLS,
  applyOverfetch,
  resolveBudget,
  summarizeOutput,
  trimToBudget,
} from './budget.js';
import { rebuildOutput } from './pipeline.js';

const unit: FilterConfig = { mode: 'off', overfetchFactor: 1, blocklist: new Set() };
const doubled: FilterConfig = { mode: 'off', overfetchFactor: 2, blocklist: new Set() };

describe('applyOverfetch', () => {
  it('returns the very same object when the factor is 1', () => {
    const params = { query: 'q', maximum_number_of_urls: 5, maximum_number_of_tokens: 4000 };

    assert.equal(applyOverfetch(params, unit), params);
  });

  it('scales urls and tokens by the factor, rounding down', () => {
    const params = { query: 'q', maximum_number_of_urls: 5, maximum_number_of_tokens: 4001 };

    const result = applyOverfetch(params, {
      mode: 'off',
      overfetchFactor: 1.5,
      blocklist: new Set(),
    });

    assert.equal(result.maximum_number_of_urls, 7);
    assert.equal(result.maximum_number_of_tokens, 6001);
    assert.equal(result.query, 'q');
  });

  it('clamps to the Brave maximums', () => {
    const result = applyOverfetch(
      { maximum_number_of_urls: 50, maximum_number_of_tokens: 32768 },
      doubled
    );

    assert.equal(result.maximum_number_of_urls, BRAVE_MAX_URLS);
    assert.equal(result.maximum_number_of_tokens, BRAVE_MAX_TOKENS);
    assert.equal(BRAVE_MAX_URLS, 50);
    assert.equal(BRAVE_MAX_TOKENS, 32768);
  });

  it('does not invent keys that were absent', () => {
    const params: { query: string; maximum_number_of_urls?: number } = { query: 'q' };

    const result = applyOverfetch(params, doubled);

    assert.deepEqual(result, { query: 'q' });
    assert.equal(Object.hasOwn(result, 'maximum_number_of_urls'), false);
    assert.equal(Object.hasOwn(result, 'maximum_number_of_tokens'), false);
  });

  it('leaves maximum_number_of_tokens_per_url untouched', () => {
    const result = applyOverfetch(
      {
        maximum_number_of_urls: 5,
        maximum_number_of_tokens: 4000,
        maximum_number_of_tokens_per_url: 800,
      },
      doubled
    );

    assert.deepEqual(result, {
      maximum_number_of_urls: 10,
      maximum_number_of_tokens: 8000,
      maximum_number_of_tokens_per_url: 800,
    });
  });

  it('never mutates the input', () => {
    const params = { query: 'q', maximum_number_of_urls: 5, maximum_number_of_tokens: 4000 };
    const snapshot = structuredClone(params);

    const result = applyOverfetch(params, doubled);

    assert.notEqual(result, params);
    assert.deepEqual(params, snapshot);
  });
});

/** 步 9 用例的最小工作面：与 budget.ts 的 BudgetSourceRow 同构（多出的字段模拟 pipeline 工作表）。 */
type Row = {
  index: number;
  url: string;
  canonical: string;
  title: string;
  meta: Record<string, unknown> | undefined;
  snippets: { index: number; text: string; kept: boolean; reason?: string }[];
  verdict: 'keep' | 'drop';
  reason?: string;
};

const makeSource = (index: number, texts: string[]): Row => ({
  index,
  url: `https://s${index}.example/`,
  canonical: `s${index}.example`,
  title: `Source ${index}`,
  meta: undefined,
  snippets: texts.map((text, i) => ({ index: i, text, kept: true })),
  verdict: 'keep',
});

const makeTable = (sources: number, snippetsPerSource: number, weight: number): Row[] =>
  Array.from({ length: sources }, (_, s) =>
    makeSource(s, Array.from({ length: snippetsPerSource }, () => String(weight)))
  );

/** 注入估算器：片段文本是数字字符串，估算值即该数字——推演确定。 */
const est = (text: string): number => Number(text);

const countTrimmed = (table: Row[]): number =>
  table.reduce(
    (sum, source) =>
      sum + source.snippets.filter((snippet) => !snippet.kept && snippet.reason === 'budget').length,
    0
  );

const countDropped = (table: Row[]): number =>
  table.filter((source) => source.verdict === 'drop' && source.reason === 'budget').length;

const EMPTY_DATA = {
  grounding: { generic: [], map: [] },
  sources: {},
} as Parameters<typeof rebuildOutput>[1];

const rebuild = (table: Row[]): ReturnType<typeof rebuildOutput> =>
  rebuildOutput(table as Parameters<typeof rebuildOutput>[0], EMPTY_DATA);

describe('resolveBudget', () => {
  it('falls back to the Brave defaults of 20 urls / 8192 tokens', () => {
    assert.deepEqual(resolveBudget({}), { maxUrls: 20, maxTokens: 8192 });
  });

  it('passes explicit caps through and keeps the Brave default for the missing one', () => {
    assert.deepEqual(resolveBudget({ maximum_number_of_urls: 5, maximum_number_of_tokens: 3000 }), {
      maxUrls: 5,
      maxTokens: 3000,
    });
    assert.deepEqual(resolveBudget({ maximum_number_of_urls: 5 }), {
      maxUrls: 5,
      maxTokens: 8192,
    });
  });
});

describe('trimToBudget', () => {
  it('keeps the first N surviving sources in Brave order and marks the rest budget-dropped', () => {
    // 6 源 × 4 片段 × 160 = 3840；urls 上限 5 → 第 6 源丢；幸存 3200 > 3000 → 再砍源 4 末尾 2 条
    const table = makeTable(6, 4, 160);
    trimToBudget(table, { maximum_number_of_urls: 5, maximum_number_of_tokens: 3000 }, est);

    assert.equal(table[5].verdict, 'drop');
    assert.equal(table[5].reason, 'budget');
    const expectedUrls = [0, 1, 2, 3, 4].map((s) => `https://s${s}.example/`);
    assert.deepEqual(
      table.filter((source) => source.verdict === 'keep').map((source) => source.url),
      expectedUrls
    );
    // 幸存 URL 序列是 Brave 序的子序列（经输出重建后断言）
    const { result } = rebuild(table);
    assert.deepEqual(
      result.grounding.generic.map((item) => item.url),
      expectedUrls
    );
  });

  it('trims snippets from the tail of the last surviving source until the estimate fits', () => {
    const table = makeTable(6, 4, 160);
    trimToBudget(table, { maximum_number_of_urls: 5, maximum_number_of_tokens: 3000 }, est);

    // 3200 → 砍源 4 片段 3（3040）→ 片段 2（2880 ≤ 3000）停止
    assert.equal(countTrimmed(table), 2);
    assert.equal(countDropped(table), 1);
    assert.deepEqual(
      table[4].snippets.map((snippet) => snippet.kept),
      [true, true, false, false]
    );
    assert.equal(table[3].snippets.every((snippet) => snippet.kept), true);
  });

  it('trims nothing when the estimate equals the budget exactly', () => {
    const table = makeTable(5, 2, 100); // 总 1000 恰等于上限
    trimToBudget(table, { maximum_number_of_urls: 5, maximum_number_of_tokens: 1000 }, est);

    assert.equal(countTrimmed(table), 0);
    assert.equal(countDropped(table), 0);
    assert.equal(table.every((source) => source.verdict === 'keep'), true);
  });

  it('keeps sources when their number equals the url cap', () => {
    const table = makeTable(5, 2, 100);
    trimToBudget(table, { maximum_number_of_urls: 5, maximum_number_of_tokens: 8192 }, est);

    assert.equal(table.every((source) => source.verdict === 'keep'), true);
  });

  it('drops every snippet and source when maxTokens is 1, leaving an empty output', () => {
    const table = makeTable(3, 2, 100);
    trimToBudget(table, { maximum_number_of_tokens: 1 }, est);

    assert.equal(countTrimmed(table), 6);
    assert.equal(countDropped(table), 3);
    const { result } = rebuild(table);
    assert.deepEqual(result.grounding.generic, []);
    assert.deepEqual(result.sources, {});
  });

  it('walks backwards to the previous source once one runs out of snippets', () => {
    // 源 0 两片、源 1 一片、源 2 三片，各 100，总 600；预算 250：
    // 砍 s2 三片（源光 → drop）→ 砍 s1 一片（源光 → drop）→ 200 ≤ 250 停
    const table = [makeSource(0, ['100', '100']), makeSource(1, ['100']), makeSource(2, ['100', '100', '100'])];
    trimToBudget(table, { maximum_number_of_tokens: 250 }, est);

    assert.equal(countTrimmed(table), 4);
    assert.equal(countDropped(table), 2);
    assert.equal(table[2].verdict, 'drop');
    assert.equal(table[2].reason, 'budget');
    assert.equal(table[1].verdict, 'drop');
    assert.equal(table[1].reason, 'budget');
    assert.equal(table[0].verdict, 'keep');
    assert.deepEqual(
      table[0].snippets.map((snippet) => snippet.kept),
      [true, true]
    );
    const { result } = rebuild(table);
    assert.deepEqual(
      result.grounding.generic.map((item) => item.url),
      ['https://s0.example/']
    );
  });
});

describe('summarizeOutput', () => {
  it('ceils the unrounded estimate sum (2.1 + 2.1 → 5, not a rounding to 4)', () => {
    const table = [makeSource(0, ['abcd', 'efgh']), makeSource(1, ['ijkl'])];
    table[0].snippets[1].kept = false;

    const out = summarizeOutput(table, () => 2.1);

    assert.equal(out.est_tokens, 5); // Math.ceil(4.2)；Math.round(4.2) 会给 4
    assert.equal(out.n_sources, 2);
    assert.equal(out.n_snippets, 2);
  });

  it('sums chars over surviving snippets only, as String.length', () => {
    const table = [makeSource(0, ['abcd', 'ef']), makeSource(1, ['ghijkl'])];
    table[0].snippets[1].kept = false; // 2 字符的被删片段不计入

    const out = summarizeOutput(table, (text) => text.length * 0.5);

    assert.deepEqual(out, { n_sources: 2, n_snippets: 2, chars: 10, est_tokens: 5 });
  });
});
