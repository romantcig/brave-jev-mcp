/** 来源与片段裁决测试。工作表使用最小结构类型，judged 与统计行共享引用以检查回写。 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createFilterStats } from '../stats.js';
import type { FilterStats, JevPerSourceStats, SnippetJudgments } from '../types.js';
import { DEFAULT_THRESHOLDS } from './questions.js';
import {
  applySnippetJudgments,
  applySourceVerdicts,
  snippetKeepThreshold,
} from './verdict.js';
import type { VerdictSourceRow } from './verdict.js';

// ---------------------------------------------------------------------------
// 构造辅助：最小行类型工作表 + 合成 judged 答案 + 带 per_source 行的 stats
// ---------------------------------------------------------------------------

/** 页面题 filler 概率的合成基底：0（远离丢弃门槛）。 */
const FILLER_KEEP = 0;

/** 在基底上覆写页面概率。 */
const answersWith = (fillerProbability: number): Record<string, number> => ({
  filler: fillerProbability ?? FILLER_KEEP,
});

/** 最小行工作表：一来源一片段（或手给文本数组），全 kept。 */
const buildTable = (spec: Array<{ title?: string; texts: string[] }>): VerdictSourceRow[] =>
  spec.map((entry, index) => ({
    index,
    url: `https://src${index}.example/`,
    title: entry.title ?? `Source ${index}`,
    snippets: entry.texts.map((text, snippetIndex) => ({
      index: snippetIndex,
      text,
      kept: true,
    })),
    verdict: 'keep' as const,
  }));

/** 保留概率判断数组：value 直接按序填入。 */
const judgmentsOf = (...values: Array<number | null>): SnippetJudgments =>
  values.map((value) => (value === null ? null : { kind: 'keep_probability', value }));

/** 组定义速记：key/start/size 三元组。 */
const group = (key: string, start: number, size: number) => ({
  key,
  start,
  size,
  letters: 'ABC'.slice(0, size).split(''),
});

/** 合成 answered 行：与 runJevStage 的 per_source 行同形状。 */
const answeredRow = (
  src: string,
  answers: Record<string, number>,
  judgments: SnippetJudgments = []
): JevPerSourceStats => ({
  src,
  url: `https://rec.example/${src}`,
  status: 'answered',
  answers,
  snippet_judgments: judgments,
});

/** stats：jev.per_source 预填（与 judged Map 共享同一行引用，回写可断言）。 */
const buildStats = (rows: JevPerSourceStats[]): FilterStats => {
  const stats = createFilterStats(
    'on',
    { query: 'q', intent: 'i', max_urls: 5, max_tokens: 4000 },
    { grounding: { generic: [], map: [] }, sources: {} }
  );
  stats.jev = {
    n_requests: rows.length,
    input_tokens: 0,
    latency_ms_total: 0,
    status: 'ok',
    per_source: rows,
    n_http_attempts: 0,
    requests: [],
  };
  return stats;
};

const buildJudged = (rows: JevPerSourceStats[]): ReadonlyMap<string, JevPerSourceStats> =>
  new Map(rows.map((row) => [row.src, row]));

/** 单来源场景：表、judged、stats 三件套，行引用互通。 */
const singleSource = (
  fillerProbability: number,
  opts: {
    title?: string;
    texts?: string[];
    judgments?: SnippetJudgments;
    groups?: Array<ReturnType<typeof group>>;
  } = {}
): { table: VerdictSourceRow[]; row: JevPerSourceStats; stats: FilterStats } => {
  const table = buildTable([
    { title: opts.title, texts: opts.texts ?? ['A body snippet about brave.'] },
  ]);
  const row = answeredRow('s0', answersWith(fillerProbability), opts.judgments ?? []);
  const stats = buildStats([row]);
  return { table, row, stats };
};

// ---------------------------------------------------------------------------
// snippetKeepThreshold：组大小选择门槛——二/三片组 groupKeepMin，单片 singleKeepMin
// ---------------------------------------------------------------------------

describe('snippetKeepThreshold', () => {
  it('selects the gate by group size: singles use singleKeepMin, pairs/triples use groupKeepMin', () => {
    assert.equal(snippetKeepThreshold(1, DEFAULT_THRESHOLDS), 0.5);
    assert.equal(snippetKeepThreshold(2, DEFAULT_THRESHOLDS), 0.25);
    assert.equal(snippetKeepThreshold(3, DEFAULT_THRESHOLDS), 0.25);
  });
});

// 页面裁决：只判 filler；无效概率保守保留并记 validation。

describe('applySourceVerdicts', () => {
  it('drops at exactly the filler threshold (p >= threshold) and keeps just below', () => {
    const dropped = singleSource(0.8);
    applySourceVerdicts(
      dropped.table,
      buildJudged([dropped.row]),
      DEFAULT_THRESHOLDS,
      dropped.stats
    );
    assert.equal(dropped.table[0].verdict, 'drop');
    assert.equal(dropped.table[0].reason, 'filler');
    assert.equal(dropped.row.verdict, 'drop');
    assert.equal(dropped.row.reason, 'filler');

    const kept = singleSource(0.79);
    applySourceVerdicts(kept.table, buildJudged([kept.row]), DEFAULT_THRESHOLDS, kept.stats);
    assert.equal(kept.table[0].verdict, 'keep');
    assert.equal(kept.row.verdict, 'keep');
    assert.equal(kept.row.reason, undefined);
  });

  it('skips the page verdict and records validation for missing or out-of-range probabilities', () => {
    // 缺答与超出 [0,1] 的概率按保守处理（不丢）并在 per_source 记 validation 备查
    const missing = singleSource(0.9);
    missing.row.answers = {}; // 无 filler 键 = 页面题缺答
    applySourceVerdicts(
      missing.table,
      buildJudged([missing.row]),
      DEFAULT_THRESHOLDS,
      missing.stats
    );
    assert.equal(missing.table[0].verdict, 'keep');
    assert.equal(missing.row.verdict, 'keep');
    assert.equal(missing.row.fail_kind, 'validation');

    for (const bad of [1.5, -0.2, Number.NaN]) {
      const { table, row, stats } = singleSource(bad);
      applySourceVerdicts(table, buildJudged([row]), DEFAULT_THRESHOLDS, stats);
      assert.equal(table[0].verdict, 'keep', `p=${bad} must not drop`);
      assert.equal(row.verdict, 'keep');
      assert.equal(row.fail_kind, 'validation');
    }
  });

  it('leaves failed and skipped sources untouched (SAFE-01: judge failure keeps)', () => {
    const table = buildTable([{ texts: ['A body snippet about brave.'] }]);
    const failed: JevPerSourceStats = {
      src: 's0',
      url: 'https://rec.example/s0',
      status: 'failed',
      fail_kind: 'network',
    };
    const stats = buildStats([failed]);
    applySourceVerdicts(table, buildJudged([failed]), DEFAULT_THRESHOLDS, stats);
    assert.equal(table[0].verdict, 'keep');
    assert.equal(failed.verdict, undefined);
  });

  it('does not touch sources already dropped by the local rules', () => {
    const { table, row, stats } = singleSource(0.99);
    table[0].verdict = 'drop';
    table[0].reason = 'empty';
    applySourceVerdicts(table, buildJudged([row]), DEFAULT_THRESHOLDS, stats);
    // 本地规则的裁决不被覆盖（只处理 verdict === 'keep' 的来源）
    assert.equal(table[0].reason, 'empty');
    assert.equal(row.verdict, undefined);
  });
});

// ---------------------------------------------------------------------------
// applySnippetJudgments：保留概率 < 所在组门槛才删（边界保留）、
// 判断数组与幸存片段等长才应用（等长契约）、null 判断与无组映射保守保留
// ---------------------------------------------------------------------------

describe('applySnippetJudgments', () => {
  it('keeps at exactly the group threshold and removes just below with reason keep_probability', () => {
    const table = buildTable([{ texts: ['first', 'second', 'third'] }]);
    // 三片组：0.25 边界保留，略低删除
    const row = answeredRow('s0', answersWith(FILLER_KEEP), judgmentsOf(0.25, 0.24, 0.9));
    const stats = buildStats([row]);
    const groups = new Map([['s0', [group('group0', 0, 3)]]]);

    applySnippetJudgments(table, buildJudged([row]), groups, DEFAULT_THRESHOLDS, stats);

    assert.deepEqual(
      table[0].snippets.map((snippet) => [snippet.kept, snippet.reason ?? null]),
      [
        [true, null],
        [false, 'keep_probability'],
        [true, null],
      ]
    );
  });

  it('uses the single gate for one-snippet groups (0.5 boundary keeps)', () => {
    const table = buildTable([{ texts: ['first', 'second'] }]);
    const row = answeredRow('s0', answersWith(FILLER_KEEP), judgmentsOf(0.5, 0.49));
    const stats = buildStats([row]);
    const groups = new Map([['s0', [group('group0', 0, 1), group('group1', 1, 1)]]]);

    applySnippetJudgments(table, buildJudged([row]), groups, DEFAULT_THRESHOLDS, stats);

    assert.deepEqual(
      table[0].snippets.map((snippet) => [snippet.kept, snippet.reason ?? null]),
      [
        [true, null],
        [false, 'keep_probability'],
      ]
    );
  });

  it('aligns judgments with the surviving snippet order, not the raw index', () => {
    const table = buildTable([{ texts: ['first', 'second', 'third'] }]);
    // 中间片段已被本地规则删掉：state 只发幸存片段 first / third，判断与之对齐
    table[0].snippets[1].kept = false;
    table[0].snippets[1].reason = 'boilerplate';
    const row = answeredRow('s0', answersWith(FILLER_KEEP), judgmentsOf(0.1, 0.9));
    const stats = buildStats([row]);
    const groups = new Map([['s0', [group('group0', 0, 1), group('group1', 1, 1)]]]);

    applySnippetJudgments(table, buildJudged([row]), groups, DEFAULT_THRESHOLDS, stats);

    assert.equal(table[0].snippets[0].kept, false);
    assert.equal(table[0].snippets[0].reason, 'keep_probability');
    assert.equal(table[0].snippets[1].reason, 'boilerplate'); // 本地裁决不被覆盖
    assert.equal(table[0].snippets[2].kept, true);
  });

  it('skips the whole source when the judgment list length mismatches the survivors', () => {
    // 等长契约：判断数组与幸存片段不等长说明对齐依据不成立——
    // 绝不按"短数组是前缀"套用；整源跳过，全部保留
    const shortTable = buildTable([{ texts: ['first', 'second', 'third', 'fourth'] }]);
    const shortRow = answeredRow('s0', answersWith(FILLER_KEEP), judgmentsOf(0.9, 0.1));
    const shortStats = buildStats([shortRow]);
    const shortGroups = new Map([['s0', [group('group0', 0, 2)]]]);
    applySnippetJudgments(
      shortTable,
      buildJudged([shortRow]),
      shortGroups,
      DEFAULT_THRESHOLDS,
      shortStats
    );
    assert.deepEqual(
      shortTable[0].snippets.map((snippet) => snippet.kept),
      [true, true, true, true]
    );

    const longTable = buildTable([{ texts: ['first', 'second'] }]);
    const longRow = answeredRow('s0', answersWith(FILLER_KEEP), judgmentsOf(0.1, 0.1, 0.1));
    const longStats = buildStats([longRow]);
    const longGroups = new Map([['s0', [group('group0', 0, 3)]]]);
    applySnippetJudgments(
      longTable,
      buildJudged([longRow]),
      longGroups,
      DEFAULT_THRESHOLDS,
      longStats
    );
    assert.deepEqual(
      longTable[0].snippets.map((snippet) => snippet.kept),
      [true, true]
    );
  });

  it('keeps snippets with null judgments (missing or invalid group answers) without polluting other groups', () => {
    const table = buildTable([{ texts: ['first', 'second', 'third'] }]);
    // 第二位无可用答案（组答案无效）：保守保留；其余组照常裁决
    const row = answeredRow('s0', answersWith(FILLER_KEEP), judgmentsOf(0.1, null, 0.9));
    const stats = buildStats([row]);
    const groups = new Map([['s0', [group('group0', 0, 1), group('group1', 1, 2)]]]);

    applySnippetJudgments(table, buildJudged([row]), groups, DEFAULT_THRESHOLDS, stats);

    assert.deepEqual(
      table[0].snippets.map((snippet) => snippet.kept),
      [false, true, true]
    );
  });

  it('keeps everything when the source has no group mapping (defensive)', () => {
    const table = buildTable([{ texts: ['first', 'second'] }]);
    const row = answeredRow('s0', answersWith(FILLER_KEEP), judgmentsOf(0.1, 0.1));
    const stats = buildStats([row]);

    applySnippetJudgments(table, buildJudged([row]), new Map(), DEFAULT_THRESHOLDS, stats);

    assert.deepEqual(
      table[0].snippets.map((snippet) => snippet.kept),
      [true, true]
    );
  });

  it('ignores failed rows and missing judgment arrays (judge failure keeps snippets)', () => {
    const table = buildTable([{ texts: ['first', 'second'] }]);
    const failed: JevPerSourceStats = {
      src: 's0',
      url: 'https://rec.example/s0',
      status: 'failed',
      fail_kind: 'timeout',
    };
    const stats = buildStats([failed]);

    applySnippetJudgments(
      table,
      buildJudged([failed]),
      new Map([['s0', [group('group0', 0, 2)]]]),
      DEFAULT_THRESHOLDS,
      stats
    );
    assert.deepEqual(
      table[0].snippets.map((snippet) => snippet.kept),
      [true, true]
    );
  });
});
