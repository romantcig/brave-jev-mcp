/**
 * 来源级裁决链与片段 score 删除（VERDICT-01/02/04 + T-02-03-1）。
 *
 * 工作表按 verdict.ts 的最小行类型构造（pipeline 的 WorkSource 结构上满足，
 * 照 budget.test.ts 先例）；judged 行即 `JevPerSourceStats`（runJevStage 的
 * per_source 行，status/answers/snippet_scores 参与判定），judged Map 与
 * per_source 行共享同一对象引用——回写记账可断言。
 *
 * 依据：PLAN §3.3 固定顺序、notes/test-mode-logging.md 阈值判据方向、
 * 02-03-PLAN.md behavior 块。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createFilterStats } from '../stats.js';
import type { FilterStats, JevPerSourceStats } from '../types.js';
import { DEFAULT_THRESHOLDS } from './questions.js';
import { applySnippetScores, applySourceVerdicts, cjkShareOf } from './verdict.js';
import type { VerdictSourceRow } from './verdict.js';

// ---------------------------------------------------------------------------
// 构造辅助：最小行类型工作表 + 合成 judged 答案 + 带 per_source 行的 stats
// ---------------------------------------------------------------------------

/** 六道来源级 noul 概率的合成基底：全 0（全部远离丢弃门槛）。 */
const ZERO_ANSWERS: Readonly<Record<string, number>> = Object.freeze({
  has_original_reasoning: 0,
  is_template_filler: 0,
  is_off_topic: 0,
  is_listing: 0,
  self_deprecated: 0,
  stale: 0,
});

/** 在全 0 基底上覆写指定题的概率。 */
const answersWith = (overrides: Record<string, number>): Record<string, number> => ({
  ...ZERO_ANSWERS,
  ...overrides,
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

/** 合成 answered 行：与 runJevStage 的 per_source 行同形状。 */
const answeredRow = (
  src: string,
  answers: Record<string, number>,
  snippetScores: number[] = []
): JevPerSourceStats => ({
  src,
  url: `https://rec.example/${src}`,
  status: 'answered',
  answers,
  snippet_scores: snippetScores,
});

/** stats：jev.per_source 预填（与 judged Map 共享同一行引用，回写可断言）。 */
const buildStats = (rows: JevPerSourceStats[]): FilterStats => {
  const stats = createFilterStats(
    'on',
    { query: 'q', intent: 'i', max_urls: 5, max_tokens: 4000, overfetch_factor: 1 },
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
  overrides: Record<string, number>,
  opts: { title?: string; texts?: string[]; snippetScores?: number[] } = {}
): { table: VerdictSourceRow[]; row: JevPerSourceStats; stats: FilterStats } => {
  const table = buildTable([
    { title: opts.title, texts: opts.texts ?? ['A body snippet about brave.'] },
  ]);
  const row = answeredRow('s0', answersWith(overrides), opts.snippetScores ?? []);
  const stats = buildStats([row]);
  return { table, row, stats };
};

// ---------------------------------------------------------------------------
// cjkShareOf：CJK 字符数 / 标题加全部文本总字符数
// ---------------------------------------------------------------------------

describe('cjkShareOf', () => {
  it('counts CJK characters over title plus all text characters', () => {
    // '世界ab' = 2 CJK + 2 latin；title 'Hello' 5 chars 全 latin
    // CJK 2 / total (5 + 4) = 2/9
    const share = cjkShareOf('Hello', ['世界ab']);

    assert.ok(Math.abs(share - 2 / 9) < 1e-12, `expected 2/9, got ${share}`);
  });

  it('returns 0 when there are no CJK characters or no text at all', () => {
    assert.equal(cjkShareOf('Hello', ['plain text']), 0);
    assert.equal(cjkShareOf('', []), 0);
    assert.equal(cjkShareOf('', ['']), 0);
  });
});

// ---------------------------------------------------------------------------
// applySourceVerdicts：固定顺序五道丢弃门槛（含等号）、命中即停、
// 三题只记不丢、CJK 加成、异常概率防御
// ---------------------------------------------------------------------------

describe('applySourceVerdicts', () => {
  it('drops at exactly the off_topic threshold (p >= threshold) and keeps just below', () => {
    const dropped = singleSource({ is_off_topic: 0.85 });
    applySourceVerdicts(
      dropped.table,
      buildJudged([dropped.row]),
      DEFAULT_THRESHOLDS,
      dropped.stats
    );
    assert.equal(dropped.table[0].verdict, 'drop');
    assert.equal(dropped.table[0].reason, 'off_topic');
    assert.equal(dropped.row.verdict, 'drop');
    assert.equal(dropped.row.reason, 'off_topic');

    const kept = singleSource({ is_off_topic: 0.84 });
    applySourceVerdicts(kept.table, buildJudged([kept.row]), DEFAULT_THRESHOLDS, kept.stats);
    assert.equal(kept.table[0].verdict, 'keep');
    assert.equal(kept.row.verdict, 'keep');
  });

  it('drops a listing at 0.80 and stops the chain at off_topic first when both exceed', () => {
    const listing = singleSource({ is_listing: 0.8 });
    applySourceVerdicts(
      listing.table,
      buildJudged([listing.row]),
      DEFAULT_THRESHOLDS,
      listing.stats
    );
    assert.equal(listing.table[0].verdict, 'drop');
    assert.equal(listing.table[0].reason, 'listing');

    // off_topic 与 listing 同时超门槛：先判先停，reason 是 off_topic
    const both = singleSource({ is_off_topic: 0.9, is_listing: 0.9 });
    applySourceVerdicts(both.table, buildJudged([both.row]), DEFAULT_THRESHOLDS, both.stats);
    assert.equal(both.table[0].verdict, 'drop');
    assert.equal(both.table[0].reason, 'off_topic');
  });

  it('drops a self-deprecated source at exactly 0.70', () => {
    const { table, row, stats } = singleSource({ self_deprecated: 0.7 });
    applySourceVerdicts(table, buildJudged([row]), DEFAULT_THRESHOLDS, stats);
    assert.equal(table[0].verdict, 'drop');
    assert.equal(table[0].reason, 'self_deprecated');
  });

  it('drops a stale source at exactly 0.85 without branching on intent', () => {
    const { table, row, stats } = singleSource({ stale: 0.85 });
    applySourceVerdicts(table, buildJudged([row]), DEFAULT_THRESHOLDS, stats);
    assert.equal(table[0].verdict, 'drop');
    assert.equal(table[0].reason, 'stale');
  });

  it('drops a filler when reasoning is strictly below the protect line', () => {
    const { table, row, stats } = singleSource({
      is_template_filler: 0.8,
      has_original_reasoning: 0.69,
    });
    applySourceVerdicts(table, buildJudged([row]), DEFAULT_THRESHOLDS, stats);
    assert.equal(table[0].verdict, 'drop');
    assert.equal(table[0].reason, 'filler');
  });

  it('keeps a filler when reasoning exactly equals the protect line (>= protects)', () => {
    const { table, row, stats } = singleSource({
      is_template_filler: 0.8,
      has_original_reasoning: 0.7,
    });
    applySourceVerdicts(table, buildJudged([row]), DEFAULT_THRESHOLDS, stats);
    assert.equal(table[0].verdict, 'keep');
    assert.equal(row.verdict, 'keep');
  });

  it('ignores legacy v3 answers no matter how high they answer (historical replay defense)', () => {
    // 2026-10-01 六题精简后 worth_keeping / is_attributed_rewrite / paywalled 不再
    // 提问；旧十题录制回放时 judged.answers 可能仍带旧键高概率——裁决链只读六键，
    // 绝不因额外旧键丢弃来源（旧键原样保留在传入的 answers 对象里）
    const { table, row, stats } = singleSource({
      is_attributed_rewrite: 0.99,
      paywalled: 0.99,
      worth_keeping: 0.99,
    });
    applySourceVerdicts(table, buildJudged([row]), DEFAULT_THRESHOLDS, stats);
    assert.equal(table[0].verdict, 'keep');
    assert.equal(row.verdict, 'keep');
    assert.equal(row.answers?.is_attributed_rewrite, 0.99);
    assert.equal(row.answers?.paywalled, 0.99);
    assert.equal(row.answers?.worth_keeping, 0.99);
  });

  it('rescues a 0.90 off_topic with the CJK bonus when the share is above the threshold', () => {
    // title 2 CJK + text 2 CJK + 2 latin → CJK 4 / 6 ≈ 0.667 > 0.5 → bonus 0.10
    const rescued = singleSource({ is_off_topic: 0.9 }, { title: '你好', texts: ['世界ab'] });
    applySourceVerdicts(
      rescued.table,
      buildJudged([rescued.row]),
      DEFAULT_THRESHOLDS,
      rescued.stats
    );
    // 0.90 < 0.85 + 0.10 = 0.95 → keep（方向保守：中文来源更难被丢）
    assert.equal(rescued.table[0].verdict, 'keep');
    assert.equal(rescued.row.verdict, 'keep');
  });

  it('does not apply the bonus when the CJK share is exactly the threshold', () => {
    // title '你好a' = 2 CJK + 1 latin；text '世bc' = 1 CJK + 2 latin → CJK 3 / 6 = 0.5
    const { table, row, stats } = singleSource(
      { is_off_topic: 0.9 },
      { title: '你好a', texts: ['世bc'] }
    );
    applySourceVerdicts(table, buildJudged([row]), DEFAULT_THRESHOLDS, stats);
    // 占比恰 0.5 不加成（严格大于），0.90 >= 0.85 → drop
    assert.equal(table[0].verdict, 'drop');
    assert.equal(table[0].reason, 'off_topic');
  });

  it('keeps a source whose five gate probabilities are all below the thresholds', () => {
    const { table, row, stats } = singleSource({
      is_off_topic: 0.84,
      is_listing: 0.79,
      self_deprecated: 0.69,
      stale: 0.84,
      is_template_filler: 0.79,
      has_original_reasoning: 0.1,
    });
    applySourceVerdicts(table, buildJudged([row]), DEFAULT_THRESHOLDS, stats);
    assert.equal(table[0].verdict, 'keep');
    assert.equal(row.verdict, 'keep');
    assert.equal(row.reason, undefined);
  });

  it('skips the verdict defensively and records fail for out-of-range probabilities (T-02-03-1)', () => {
    // 超出 [0,1] 的概率按保守处理（不丢）并在 per_source 记 fail 备查
    for (const bad of [1.5, -0.2]) {
      const { table, row, stats } = singleSource({ is_off_topic: bad });
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
    const { table, row, stats } = singleSource({ is_off_topic: 0.99 });
    table[0].verdict = 'drop';
    table[0].reason = 'feed';
    applySourceVerdicts(table, buildJudged([row]), DEFAULT_THRESHOLDS, stats);
    // 步 4 的裁决不被覆盖（只处理 verdict === 'keep' 的来源）
    assert.equal(table[0].reason, 'feed');
    assert.equal(row.verdict, undefined);
  });
});

// ---------------------------------------------------------------------------
// applySnippetScores：score < snippetMin 严格小于才删（连续值）、
// 分数比幸存片段少时按前缀对齐（cut_tail 降级）、多时整来源跳过、
// CJK 加成不抬 score 门槛
// ---------------------------------------------------------------------------

describe('applySnippetScores', () => {
  it('keeps a snippet scoring exactly SNIPPET_MIN and removes just below with reason score', () => {
    const table = buildTable([{ texts: ['first', 'second', 'third'] }]);
    const row = answeredRow('s0', answersWith({}), [1.0, 0.99, 1.2]);
    const stats = buildStats([row]);

    applySnippetScores(table, buildJudged([row]), DEFAULT_THRESHOLDS, stats);

    assert.deepEqual(
      table[0].snippets.map((snippet) => [snippet.kept, snippet.reason ?? null]),
      [
        [true, null],
        [false, 'score'],
        [true, null],
      ]
    );
  });

  it('aligns scores with the surviving snippet order, not the raw index', () => {
    const table = buildTable([{ texts: ['first', 'second', 'third'] }]);
    // 中间片段已被本地规则删掉：state 只发幸存片段 first / third，score 与之对齐
    table[0].snippets[1].kept = false;
    table[0].snippets[1].reason = 'boilerplate';
    const row = answeredRow('s0', answersWith({}), [0.5, 1.5]);
    const stats = buildStats([row]);

    applySnippetScores(table, buildJudged([row]), DEFAULT_THRESHOLDS, stats);

    assert.equal(table[0].snippets[0].kept, false);
    assert.equal(table[0].snippets[0].reason, 'score');
    assert.equal(table[0].snippets[1].reason, 'boilerplate'); // 本地裁决不被覆盖
    assert.equal(table[0].snippets[2].kept, true);
  });

  it('aligns a shorter score list to the prefix and keeps the unsent tail (cut_tail)', () => {
    // 32k 砍尾降级后回来的分数比幸存片段少：前 scores.length 个按位置对齐，
    // 其后未发给 Jev 的片段保留（JEV-05 / 02-FIX 批 D1）
    const table = buildTable([{ texts: ['first', 'second', 'third', 'fourth'] }]);
    const row = answeredRow('s0', answersWith({}), [2, 0.2]); // 前两段发了，后两段被砍
    const stats = buildStats([row]);

    applySnippetScores(table, buildJudged([row]), DEFAULT_THRESHOLDS, stats);

    assert.deepEqual(
      table[0].snippets.map((snippet) => [snippet.kept, snippet.reason ?? null]),
      [
        [true, null],
        [false, 'score'],
        [true, null],
        [true, null],
      ]
    );
  });

  it('skips the whole source when the score list is longer than the surviving snippets', () => {
    const table = buildTable([{ texts: ['first', 'second', 'third'] }]);
    const row = answeredRow('s0', answersWith({}), [0.2, 0.2, 0.2, 0.2]); // 分数比片段还多：对齐依据不成立
    const stats = buildStats([row]);

    applySnippetScores(table, buildJudged([row]), DEFAULT_THRESHOLDS, stats);

    // 保守：整来源跳过 score 删除，全部保留
    assert.deepEqual(
      table[0].snippets.map((snippet) => snippet.kept),
      [true, true, true]
    );
  });

  it('behaves exactly as before when the score list has the same length', () => {
    const table = buildTable([{ texts: ['first', 'second', 'third'] }]);
    const row = answeredRow('s0', answersWith({}), [1.5, 0.4, 2]);
    const stats = buildStats([row]);

    applySnippetScores(table, buildJudged([row]), DEFAULT_THRESHOLDS, stats);

    assert.deepEqual(
      table[0].snippets.map((snippet) => [snippet.kept, snippet.reason ?? null]),
      [
        [true, null],
        [false, 'score'],
        [true, null],
      ]
    );
  });

  it('does not raise the score threshold with the CJK bonus', () => {
    // CJK 占比高（4/6 > 0.5）→ 来源级门槛加成，但 SNIPPET_MIN 不被抬高
    const table = buildTable([{ title: '你好', texts: ['世界ab'] }]);
    const row = answeredRow('s0', answersWith({}), [0.99]);
    const stats = buildStats([row]);

    applySnippetScores(table, buildJudged([row]), DEFAULT_THRESHOLDS, stats);

    assert.equal(table[0].snippets[0].kept, false);
    assert.equal(table[0].snippets[0].reason, 'score');
  });

  it('ignores failed rows and missing score arrays (judge failure keeps snippets)', () => {
    const table = buildTable([{ texts: ['first', 'second'] }]);
    const failed: JevPerSourceStats = {
      src: 's0',
      url: 'https://rec.example/s0',
      status: 'failed',
      fail_kind: 'timeout',
    };
    const stats = buildStats([failed]);

    applySnippetScores(table, buildJudged([failed]), DEFAULT_THRESHOLDS, stats);
    assert.deepEqual(
      table[0].snippets.map((snippet) => snippet.kept),
      [true, true]
    );
  });
});
