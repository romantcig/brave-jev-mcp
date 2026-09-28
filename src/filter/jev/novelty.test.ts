import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_THRESHOLDS } from './questions.js';
import {
  applyNovelty,
  extractFingerprints,
  seedingOrder,
  type JevSideDeletionFlags,
  type NoveltyJudgedRow,
  type NoveltySnippetRow,
  type NoveltySourceRow,
} from './novelty.js';
import { createFilterStats } from '../stats.js';
import type { FilterStats, JevThresholds } from '../types.js';

// ---------------------------------------------------------------------------
// 纯函数直测（无需网络与夹具）：五类指纹元素正反例、判据与保护边界、播种序、
// 跨源 5-gram 先于指纹。依据 notes/dedup-and-rewrite-policy.md（逐字权威）。
// ---------------------------------------------------------------------------

const thresholds: JevThresholds = { ...DEFAULT_THRESHOLDS };

const makeStats = (): FilterStats =>
  createFilterStats(
    'off',
    { query: 'q', intent: 'i', max_urls: 5, max_tokens: 4000, overfetch_factor: 1 },
    { grounding: { generic: [], map: [] }, sources: {} }
  );

const snippet = (index: number, text: string): NoveltySnippetRow => ({ index, text, kept: true });

const source = (
  index: number,
  snippets: NoveltySnippetRow[],
  overrides?: Partial<Pick<NoveltySourceRow, 'verdict' | 'reason'>>
): NoveltySourceRow => ({
  index,
  url: `https://s${index}.example/`,
  snippets,
  verdict: 'keep',
  ...overrides,
});

const answered = (answers: Record<string, number>): NoveltyJudgedRow => ({
  status: 'answered',
  answers,
});

const judgedMap = (
  entries: Record<string, NoveltyJudgedRow>
): ReadonlyMap<string, NoveltyJudgedRow> => new Map(Object.entries(entries));

/** 断言某一类前缀的指纹集合（排序后比较，免受 Set 插入序影响）。 */
const classOf = (fp: ReadonlySet<string>, prefix: string): string[] =>
  [...fp].filter((entry) => entry.startsWith(prefix)).sort();

// 与实现共享语义的测试语料：全部小写正文（无专名干扰），指纹可手工穷举。
// 注意 tokenize 会把 "$4.2m" 切成 "4"+"2m"，shingle 数比直觉多——涉及 shingle
// 门槛的用例都按切分后口径数过。

/** 4 个数字指纹（≥ MIN_FACTS），12+ token，供边界用例做播种源。 */
const FACTS_A = 'version 1.13 costs $4.2m and runs 193x faster with 40% less latency';
/** 同四事实的改写（词序不同 → 无共享 5-gram，不触发跨源 dup）。 */
const FACTS_A_REWORD = 'it costs $4.2m, runs 193x faster, and has 40% less latency at version 1.13';
/** 三个新事实之一换成新值：novel = 1。 */
const FACTS_A_NOVEL1 = 'it costs $4.2m, runs 193x faster, and has 40% less latency at version 1.14';
/** 两个事实换新值：novel = 2 → 保留。 */
const FACTS_A_NOVEL2 = 'it costs $4.3m, runs 195x faster, and has 40% less latency at version 1.13';
/** 仅 3 个指纹（< MIN_FACTS）。 */
const FACTS_SHORT = 'version 1.13 costs $4.2m and runs 193x faster';
const FACTS_SHORT_REWORD = 'it costs $4.2m and runs 193x faster at version 1.13';

/** 逐字长句（15 token ≥ 8 shingle），指纹只有 1 个——供跨源 dup 用例。 */
const DUP_LONG = 'the model ships with a streaming api and costs $4.2m per month for scale';

/** dup 先于指纹的语料：B 是 A 加新尾巴（共享 5-gram ≥ 0.8 且新指纹 novel = 1）。 */
const DUPFP_A =
  'the model ships with a streaming api costing $4.2m per month and runs 193x faster with 40% less latency overall';
const DUPFP_B = `${DUPFP_A} at 55% uptime`;

describe('extractFingerprints', () => {
  it('numbers with currency and multiplier suffixes enter the n: class', () => {
    const fp = extractFingerprints('raised $4.2M at 193x speed');

    assert.deepEqual(classOf(fp, 'n:'), ['n:$4.2m', 'n:193x']);
  });

  it('a plain word without digits or symbols enters no fingerprint class', () => {
    assert.equal(extractFingerprints('the launch was smooth').size, 0);
  });

  it('ISO dates and English month dates enter the d: class', () => {
    const fp = extractFingerprints('since 2026-09-25 and September 25, 2026');

    assert.deepEqual(classOf(fp, 'd:'), ['d:2026-09-25', 'd:september 25, 2026']);
  });

  it('prose without dates adds no d: fingerprint', () => {
    assert.deepEqual(classOf(extractFingerprints('nothing temporal in this prose'), 'd:'), []);
  });

  it('backtick content and dotted identifiers enter the c: class', () => {
    const fp = extractFingerprints(
      'run `npm run build` inside sanity.config.ts then call foo.bar()'
    );

    assert.deepEqual(classOf(fp, 'c:'), ['c:`npm run build`', 'c:foo.bar()', 'c:sanity.config.ts']);
  });

  it('prose without code shapes adds no c: fingerprint', () => {
    assert.deepEqual(classOf(extractFingerprints('no code shapes in this sentence'), 'c:'), []);
  });

  it('quotes of six or more words enter the q: class', () => {
    const fp = extractFingerprints('He said "the model ships with a streaming api today" and left');

    assert.deepEqual(classOf(fp, 'q:'), ['q:the model ships with a streaming api today']);
  });

  it('a five-word quote does not enter the q: class', () => {
    assert.deepEqual(classOf(extractFingerprints('"one two three four five"'), 'q:'), []);
  });

  it('capitalized word groups enter the p: class', () => {
    const fp = extractFingerprints('TypeSafe AI released the Jev model');

    assert.deepEqual(classOf(fp, 'p:'), ['p:jev', 'p:typesafe ai']);
  });

  it('a capitalized group made only of common function words is filtered out', () => {
    assert.deepEqual(classOf(extractFingerprints('Best Guide Using This'), 'p:'), []);
  });

  it('lowercases every fingerprint', () => {
    const fp = extractFingerprints('TypeSafe AI Raised $4.2M in 2026');

    assert.ok(fp.size > 0);
    for (const entry of fp) {
      assert.equal(entry, entry.toLowerCase(), `fingerprint ${entry} must be lowercase`);
    }
  });
});

describe('seedingOrder', () => {
  it('seeds answered sources by is_primary descending', () => {
    const table = [source(0, []), source(1, [])];
    const judged = judgedMap({
      s0: answered({ is_primary: 0.5 }),
      s1: answered({ is_primary: 0.9 }),
    });

    assert.deepEqual(seedingOrder(table, judged, 'on'), [1, 0]);
  });

  it('breaks is_primary ties by Brave order', () => {
    const table = [source(0, []), source(1, [])];
    const judged = judgedMap({
      s0: answered({ is_primary: 0.8 }),
      s1: answered({ is_primary: 0.8 }),
    });

    assert.deepEqual(seedingOrder(table, judged, 'on'), [0, 1]);
  });

  it('places unjudged sources after judged ones in Brave order', () => {
    const table = [source(0, []), source(1, []), source(2, []), source(3, [])];
    const judged = judgedMap({
      s0: answered({ is_primary: 0.9 }),
      s1: { status: 'failed' },
      s2: answered({ is_primary: 0.5 }),
      s3: answered({}), // answered 但无 is_primary 答案 → 未判定组
    });

    assert.deepEqual(seedingOrder(table, judged, 'on'), [0, 2, 1, 3]);
  });

  it('uses pure Brave order in off mode even when judged rows exist', () => {
    const table = [source(0, []), source(1, [])];
    const judged = judgedMap({
      s0: answered({ is_primary: 0.5 }),
      s1: answered({ is_primary: 0.9 }),
    });

    assert.deepEqual(seedingOrder(table, judged, 'off'), [0, 1]);
    assert.deepEqual(seedingOrder(table, undefined, 'on'), [0, 1]);
  });

  it('excludes dropped sources from the seeding order', () => {
    const table = [
      source(0, [], { verdict: 'drop', reason: 'off_topic' }),
      source(1, []),
      source(2, []),
    ];

    assert.deepEqual(seedingOrder(table, undefined, 'on'), [1, 2]);
  });
});

describe('applyNovelty', () => {
  it('keeps a snippet with fewer than MIN_FACTS fingerprints even when nothing is novel', () => {
    // s0 播种 3 个事实；s1 同三事实改写 → fp.size 3 < MIN_FACTS，不判重复（保守留）
    const table = [
      source(0, [snippet(0, FACTS_SHORT)]),
      source(1, [snippet(0, FACTS_SHORT_REWORD)]),
    ];
    const stats = makeStats();

    applyNovelty(table, undefined, 'off', thresholds, stats);

    assert.equal(table[1].snippets[0].kept, true);
    assert.equal(table[1].snippets[0].reason, undefined);
    assert.equal(stats.local.novelty_removed, 0);
  });

  it('deletes a same-facts rewrite with MIN_FACTS fingerprints and no novel facts', () => {
    const table = [source(0, [snippet(0, FACTS_A)]), source(1, [snippet(0, FACTS_A_REWORD)])];
    const stats = makeStats();

    applyNovelty(table, undefined, 'off', thresholds, stats);

    assert.equal(table[1].snippets[0].kept, false);
    assert.equal(table[1].snippets[0].reason, 'novelty');
    assert.equal(stats.local.novelty_removed, 1);
  });

  it('deletes a rewrite with exactly one novel fingerprint', () => {
    const table = [source(0, [snippet(0, FACTS_A)]), source(1, [snippet(0, FACTS_A_NOVEL1)])];
    const stats = makeStats();

    applyNovelty(table, undefined, 'off', thresholds, stats);

    assert.equal(table[1].snippets[0].kept, false);
    assert.equal(table[1].snippets[0].reason, 'novelty');
    assert.equal(stats.local.novelty_removed, 1);
  });

  it('keeps a rewrite with two novel fingerprints (NOVELTY_MIN includes 2)', () => {
    const table = [source(0, [snippet(0, FACTS_A)]), source(1, [snippet(0, FACTS_A_NOVEL2)])];
    const stats = makeStats();

    applyNovelty(table, undefined, 'off', thresholds, stats);

    assert.equal(table[1].snippets[0].kept, true);
    assert.equal(stats.local.novelty_removed, 0);
  });

  it('exempts a source at exactly the reasoning protect threshold from novelty deletion', () => {
    // has_original_reasoning = 0.70 恰等 REASONING_PROTECT → 免于新颖度删除
    const table = [source(0, [snippet(0, FACTS_A)]), source(1, [snippet(0, FACTS_A_NOVEL1)])];
    const judged = judgedMap({ s1: answered({ has_original_reasoning: 0.7 }) });
    const stats = makeStats();

    applyNovelty(table, judged, 'on', thresholds, stats);

    assert.equal(table[1].snippets[0].kept, true);
    assert.equal(table[1].snippets[0].reason, undefined);
    assert.equal(stats.local.novelty_removed, 0);
  });

  it('aggregates per-source fp_total as the deleted-union size and novel as its diff vs the surviving union (C-04.1)', () => {
    // 手算（C-02 复核口径）：s0 播种占 4 指纹；s1 片段 0 三个指纹被占、n:1.14 新
    // （novel=1）删；片段 1 独有四事实 novel=4 保留（n:2.0 随幸存片段进指纹并集）；
    // 片段 2 的 $4.2m/193x/40% 被 s0 占、2.0 被片段 1 吸收 → novel=0 删。
    // 删除条目并集 = 两被删片段 4+4 指纹重叠 3 → fp_total=5；novel = 并集 − 幸存
    // 指纹并集 = {n:1.14}——若没有中途幸存片段吸收 n:2.0，novel 会是 2 个。两被删
    // 片段的逐片段 novel（1 与 0）都不能从聚合数复原（C-02）。
    const table = [
      source(0, [snippet(0, FACTS_A)]),
      source(1, [
        snippet(0, FACTS_A_NOVEL1),
        snippet(1, 'version 2.0 costs 5.5m and runs 66x faster with 70% less latency'),
        snippet(2, 'it costs $4.2m at version 2.0, runs 193x faster, and has 40% less latency'),
      ]),
    ];
    const stats = makeStats();

    applyNovelty(table, undefined, 'off', thresholds, stats);

    assert.equal(table[1].snippets[0].kept, false);
    assert.equal(table[1].snippets[1].kept, true);
    assert.equal(table[1].snippets[2].kept, false);
    assert.equal(stats.local.novelty_removed, 2);
    assert.equal(stats.local.cross_source_dup_removed, 0);
    assert.deepEqual(stats.local.novelty, [{ src: 's1', fp_total: 5, novel: ['n:1.14'] }]);
  });

  it('does not exempt a source below the reasoning protect threshold', () => {
    const table = [source(0, [snippet(0, FACTS_A)]), source(1, [snippet(0, FACTS_A_NOVEL1)])];
    const judged = judgedMap({ s1: answered({ has_original_reasoning: 0.69 }) });
    const stats = makeStats();

    applyNovelty(table, judged, 'on', thresholds, stats);

    assert.equal(table[1].snippets[0].kept, false);
    assert.equal(table[1].snippets[0].reason, 'novelty');
    assert.equal(stats.local.novelty_removed, 1);
  });

  it('still deletes a protected source verbatim duplicate as cross-source dup', () => {
    // 论证段保护只豁免指纹新颖度；逐字转载不是原创论证 → 跨源 dup 照删
    const table = [source(0, [snippet(0, DUP_LONG)]), source(1, [snippet(0, DUP_LONG)])];
    const judged = judgedMap({ s1: answered({ has_original_reasoning: 0.7 }) });
    const stats = makeStats();

    applyNovelty(table, judged, 'on', thresholds, stats);

    assert.equal(table[1].snippets[0].kept, false);
    assert.equal(table[1].snippets[0].reason, 'dup');
    assert.equal(stats.local.cross_source_dup_removed, 1);
    assert.equal(stats.local.novelty_removed, 0);
  });

  it('deletes a later-seeded near-duplicate as dup before the fingerprint check', () => {
    // B 共享 A 的 5-gram ≥ 0.8 且指纹新颖（novel = 1）——dup 先判，reason 是 'dup'
    const table = [source(0, [snippet(0, DUPFP_A)]), source(1, [snippet(0, DUPFP_B)])];
    const stats = makeStats();

    applyNovelty(table, undefined, 'off', thresholds, stats);

    assert.equal(table[1].snippets[0].kept, false);
    assert.equal(table[1].snippets[0].reason, 'dup');
    assert.equal(stats.local.cross_source_dup_removed, 1);
    assert.equal(stats.local.novelty_removed, 0);
  });

  it('seeds by is_primary order so the higher-primary source keeps its facts', () => {
    // s1 primary 0.9 先播种并幸存；s0（Brave 序在前但 primary 0.5）同事实改写被删
    const table = [source(0, [snippet(0, FACTS_A)]), source(1, [snippet(0, FACTS_A_REWORD)])];
    const judged = judgedMap({
      s0: answered({ is_primary: 0.5 }),
      s1: answered({ is_primary: 0.9 }),
    });
    const stats = makeStats();

    applyNovelty(table, judged, 'on', thresholds, stats);

    assert.equal(table[1].snippets[0].kept, true);
    assert.equal(table[0].snippets[0].kept, false);
    assert.equal(table[0].snippets[0].reason, 'novelty');
    assert.equal(stats.local.novelty_removed, 1);
  });

  it('seeds in Brave order in off mode even when judged rows exist', () => {
    const table = [source(0, [snippet(0, FACTS_A)]), source(1, [snippet(0, FACTS_A_REWORD)])];
    const judged = judgedMap({
      s0: answered({ is_primary: 0.5 }),
      s1: answered({ is_primary: 0.9 }),
    });
    const stats = makeStats();

    applyNovelty(table, judged, 'off', thresholds, stats);

    assert.equal(table[0].snippets[0].kept, true);
    assert.equal(table[1].snippets[0].kept, false);
  });

  it('ignores dropped sources when seeding and deleting', () => {
    // 已被来源级裁决丢掉的来源不播种、其片段不参与判定
    const table = [
      source(0, [snippet(0, FACTS_A)], { verdict: 'drop', reason: 'off_topic' }),
      source(1, [snippet(0, FACTS_A_REWORD)]),
    ];
    const stats = makeStats();

    const markers = applyNovelty(table, undefined, 'off', thresholds, stats);

    assert.equal(table[1].snippets[0].kept, true);
    assert.equal(stats.local.novelty_removed, 0);
    assert.equal(markers.size, 0);
  });

  it('records per-source Jev-side deletion markers for step 8 attribution', () => {
    // s1 被新颖度删光、s3 被跨源 dup 删光、s0/s2 幸存无标记
    const table = [
      source(0, [snippet(0, FACTS_A)]),
      source(1, [snippet(0, FACTS_A_REWORD)]),
      source(2, [snippet(0, DUP_LONG)]),
      source(3, [snippet(0, DUP_LONG)]),
    ];
    const stats = makeStats();

    const markers: ReadonlyMap<number, JevSideDeletionFlags> = applyNovelty(
      table,
      undefined,
      'off',
      thresholds,
      stats
    );

    assert.deepEqual(markers.get(1), { novelty: true, crossSourceDup: false });
    assert.deepEqual(markers.get(3), { novelty: false, crossSourceDup: true });
    assert.equal(markers.has(0), false);
    assert.equal(markers.has(2), false);
  });

  it('keeps the table order and flips flags in place', () => {
    // 管道不重排幸存者：删除只翻 kept/reason，行仍在原位（RULES-08）
    const table = [
      source(0, [snippet(0, FACTS_A), snippet(1, 'a brave unique snippet about 42% uptime')]),
      source(1, [snippet(0, FACTS_A_REWORD)]),
    ];
    const stats = makeStats();

    applyNovelty(table, undefined, 'off', thresholds, stats);

    assert.deepEqual(
      table.map((entry) => entry.index),
      [0, 1]
    );
    assert.equal(table[0].snippets.length, 2);
    assert.equal(table[1].snippets.length, 1);
    assert.equal(table[0].snippets[0].kept, true);
    assert.equal(table[0].snippets[1].kept, true);
    assert.equal(table[1].snippets[0].kept, false);
  });
});
