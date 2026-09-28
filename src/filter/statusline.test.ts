import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createFilterStats } from './stats.js';
import { buildStatusLine } from './statusline.js';
import type { BraveLlmContextResponse, FilterStats, SourceDropReason } from './types.js';

/** createFilterStats 需要的请求摘要（上限缺省已填 Brave 默认值的形状）。 */
const request: FilterStats['request'] = {
  query: 'test query',
  intent: 'test intent',
  max_urls: 10,
  max_tokens: 8192,
  overfetch_factor: 1,
};

/** 用片段文本建一份最小 Brave 响应。 */
const dataOf = (...sources: { url: string; snippets: string[] }[]): BraveLlmContextResponse => ({
  grounding: {
    generic: sources.map((source) => ({
      url: source.url,
      title: '',
      snippets: source.snippets,
    })),
    map: [],
  },
  sources: {},
});

const statsOf = (
  mode: FilterStats['mode'] = 'off',
  overrides: { intent?: string; sources?: { url: string; snippets: string[] }[] } = {}
): FilterStats => {
  const sources = overrides.sources ?? [
    { url: 'https://a.example/', snippets: ['one'] },
    { url: 'https://b.example/', snippets: ['two'] },
    { url: 'https://c.example/', snippets: ['three'] },
  ];
  return createFilterStats(
    mode,
    { ...request, ...(overrides.intent ? { intent: overrides.intent } : {}) },
    dataOf(...sources)
  );
};

/** 把统计表里的一个来源翻成丢弃（管道各步的最终落账形状）。 */
const dropSource = (stats: FilterStats, index: number, reason: SourceDropReason): void => {
  const row = stats.sources[index];
  row.verdict = 'drop';
  row.reason = reason;
};

/** 把统计表里幸存来源的一个片段翻成删除。 */
const dropSnippet = (stats: FilterStats, sourceIndex: number, snippetIndex: number): void => {
  stats.sources[sourceIndex].snippets[snippetIndex].kept = false;
};

/** 给 on/shadow 载体挂一份 Jev 记账（per_source 行按需给 status）。 */
const withJev = (
  stats: FilterStats,
  rows: Array<{ src: string; status: 'answered' | 'failed' | 'skipped' | 'breaker_open' }>
): FilterStats => {
  stats.jev = {
    n_requests: rows.filter((row) => row.status === 'answered').length,
    input_tokens: 0,
    latency_ms_total: 0,
    status: 'ok',
    per_source: rows.map((row) => ({
      src: row.src,
      url: `https://${row.src}.example/`,
      status: row.status,
    })),
  };
  return stats;
};

describe('buildStatusLine', () => {
  it('returns undefined when nothing was dropped or removed', () => {
    const stats = statsOf('off', {
      sources: [
        { url: 'https://a.example/', snippets: ['one', 'two'] },
        { url: 'https://b.example/', snippets: ['three'] },
      ],
    });
    assert.equal(buildStatusLine(stats), undefined);
  });

  it('counts dropped sources by reason with SourceDropReason keys verbatim, in first-seen order', () => {
    const stats = statsOf();
    dropSource(stats, 0, 'rewrite');
    dropSource(stats, 1, 'rewrite');
    dropSource(stats, 2, 'blocklist');
    assert.equal(buildStatusLine(stats), '[filter] dropped 3 of 3 sources: 2 rewrite, 1 blocklist');
  });

  it('keeps reason words undeformed and counts budget like any other reason', () => {
    const stats = statsOf('off', {
      sources: [
        { url: 'https://a.example/', snippets: ['one'] },
        { url: 'https://b.example/', snippets: ['two'] },
      ],
    });
    dropSource(stats, 0, 'budget');
    assert.equal(buildStatusLine(stats), '[filter] dropped 1 of 2 sources: 1 budget');
  });

  it('does not count merged as a drop', () => {
    const stats = statsOf();
    dropSource(stats, 1, 'merged');
    // 唯一的"丢弃"是 merged → 不算丢弃、无附加内容 → 不附状态行
    assert.equal(buildStatusLine(stats), undefined);
  });

  it('counts removed snippets inside surviving sources only, with English plurals', () => {
    const stats = statsOf('off', {
      sources: [
        { url: 'https://a.example/', snippets: ['one', 'two', 'three'] },
        { url: 'https://b.example/', snippets: ['four', 'five'] },
      ],
    });
    dropSnippet(stats, 0, 1);
    dropSource(stats, 1, 'empty'); // 被丢来源的片段不重复计
    dropSnippet(stats, 1, 0);
    assert.equal(
      buildStatusLine(stats),
      '[filter] dropped 1 of 2 sources: 1 empty; 1 snippet removed'
    );
  });

  it('uses the plural snippet form for two or more removals', () => {
    const stats = statsOf('off', {
      sources: [{ url: 'https://a.example/', snippets: ['one', 'two', 'three'] }],
    });
    dropSnippet(stats, 0, 0);
    dropSnippet(stats, 0, 1);
    assert.equal(buildStatusLine(stats), '[filter] 2 snippets removed');
  });

  it('uses the singular source form when only one source was fetched', () => {
    const stats = statsOf('off', {
      sources: [{ url: 'https://a.example/', snippets: ['one', 'two'] }],
    });
    dropSnippet(stats, 0, 0);
    stats.brave.n_sources = 1;
    assert.equal(buildStatusLine(stats), '[filter] 1 snippet removed');
  });

  it('lists paywall-truncated snippets as its own item after the removal count', () => {
    const stats = statsOf('off', {
      sources: [{ url: 'https://a.example/', snippets: ['one', 'two'] }],
    });
    dropSnippet(stats, 0, 0);
    stats.local.paywall_truncated = 2;
    assert.equal(
      buildStatusLine(stats),
      '[filter] 1 snippet removed; 2 snippets paywall-truncated'
    );
  });

  it('echoes the intent verbatim for a stale drop', () => {
    const stats = statsOf('off', {
      intent: 'current Sanity Studio (v6, sanity.config.ts based)',
      sources: [{ url: 'https://a.example/', snippets: ['one'] }],
    });
    dropSource(stats, 0, 'stale');
    assert.equal(
      buildStatusLine(stats),
      '[filter] dropped 1 of 1 source: 1 stale (vs intent: "current Sanity Studio (v6, sanity.config.ts based)")'
    );
  });

  it('truncates a long intent at 100 characters with an ellipsis', () => {
    const longIntent = 'x'.repeat(150);
    const stats = statsOf('off', {
      intent: longIntent,
      sources: [{ url: 'https://a.example/', snippets: ['one'] }],
    });
    dropSource(stats, 0, 'stale');
    assert.equal(
      buildStatusLine(stats),
      `[filter] dropped 1 of 1 source: 1 stale (vs intent: "${'x'.repeat(100)}…")`
    );
  });

  it('echoes each stale drop on its own when several are dropped', () => {
    const stats = statsOf('off', {
      sources: [
        { url: 'https://a.example/', snippets: ['one'] },
        { url: 'https://b.example/', snippets: ['two'] },
      ],
    });
    dropSource(stats, 0, 'stale');
    dropSource(stats, 1, 'stale');
    assert.equal(
      buildStatusLine(stats),
      '[filter] dropped 2 of 2 sources: 1 stale (vs intent: "test intent"), 1 stale (vs intent: "test intent")'
    );
  });

  it('counts unchecked sources on mode on even with zero drops', () => {
    const stats = statsOf('on', {
      sources: [
        { url: 'https://a.example/', snippets: ['one'] },
        { url: 'https://b.example/', snippets: ['two'] },
      ],
    });
    // per_source 缺 s1 的行（no_key 形态是整表为空；缺行是同一判定的最小构造）
    withJev(stats, [{ src: 's0', status: 'answered' }]);
    assert.equal(buildStatusLine(stats), '[filter] 1 source not checked by Jev (kept)');
  });

  it('does not count a failed per-source row as checked, using the plural form', () => {
    const stats = statsOf('on');
    withJev(stats, [
      { src: 's0', status: 'answered' },
      { src: 's1', status: 'answered' },
      { src: 's2', status: 'failed' },
    ]);
    assert.equal(buildStatusLine(stats), '[filter] 1 source not checked by Jev (kept)');

    const twoFailed = statsOf('on');
    withJev(twoFailed, [
      { src: 's0', status: 'failed' },
      { src: 's1', status: 'failed' },
    ]);
    dropSource(twoFailed, 0, 'stale');
    // s0 已被丢弃不参与未判定计数；keep 的 s1（failed）与 s2（缺行）都算未判定
    assert.equal(
      buildStatusLine(twoFailed),
      '[filter] dropped 1 of 3 sources: 1 stale (vs intent: "test intent"); 2 sources not checked by Jev (kept)'
    );
  });

  it('never adds the unchecked segment off or shadow, and skips it when everything is answered', () => {
    // off：即使 per_source 缺行也不数未判定
    const offStats = statsOf('off');
    withJev(offStats, []);
    dropSource(offStats, 0, 'empty');
    assert.equal(buildStatusLine(offStats), '[filter] dropped 1 of 3 sources: 1 empty');

    // shadow：与 off 同样不数（would 差异只进日志）
    const shadowStats = statsOf('shadow');
    withJev(shadowStats, []);
    dropSource(shadowStats, 0, 'empty');
    assert.equal(buildStatusLine(shadowStats), '[filter] dropped 1 of 3 sources: 1 empty');

    // on 且全部 answered、零丢弃零删除 → 不附
    const allAnswered = statsOf('on');
    withJev(allAnswered, [
      { src: 's0', status: 'answered' },
      { src: 's1', status: 'answered' },
      { src: 's2', status: 'answered' },
    ]);
    assert.equal(buildStatusLine(allAnswered), undefined);
  });

  it('produces a byte-identical status line for shadow and off carriers of the same verdicts', () => {
    const build = (mode: FilterStats['mode']): string => {
      const stats = statsOf(mode, {
        intent: 'current Sanity Studio (v6, sanity.config.ts based)',
        sources: [
          { url: 'https://a.example/', snippets: ['one', 'two'] },
          { url: 'https://b.example/', snippets: ['three'] },
          { url: 'https://c.example/', snippets: ['four'] },
        ],
      });
      dropSource(stats, 0, 'stale');
      dropSource(stats, 1, 'merged');
      dropSource(stats, 2, 'rewrite');
      dropSnippet(stats, 0, 1);
      return buildStatusLine(stats) ?? '';
    };
    // D-07：shadow 的状态行与 off 逐字相同——生成只读实际生效链，绝不读 shadow_diff
    assert.equal(build('shadow'), build('off'));
  });
});
