import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createFilterStats } from './stats.js';
import { buildStatusLine, JEV_KEY_SETUP_HINT } from './statusline.js';
import type {
  BraveLlmContextResponse,
  FilterStats,
  JevFailKind,
  SourceDropReason,
} from './types.js';

/** createFilterStats 需要的请求摘要（上限缺省已填 Brave 默认值的形状）。 */
const request: FilterStats['request'] = {
  query: 'test query',
  intent: 'test intent',
  max_urls: 10,
  max_tokens: 8192,
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
  overrides: { sources?: { url: string; snippets: string[] }[] } = {}
): FilterStats => {
  const sources = overrides.sources ?? [
    { url: 'https://a.example/', snippets: ['one'] },
    { url: 'https://b.example/', snippets: ['two'] },
    { url: 'https://c.example/', snippets: ['three'] },
  ];
  return createFilterStats(mode, { ...request }, dataOf(...sources));
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

/** 给 on/test 载体挂一份 Jev 记账（per_source 行按需给 status 与 fail_kind）。 */
const withJev = (
  stats: FilterStats,
  rows: Array<{
    src: string;
    status: 'answered' | 'failed' | 'skipped' | 'breaker_open';
    fail_kind?: JevFailKind;
  }>
): FilterStats => {
  stats.jev = {
    n_requests: rows.filter((row) => row.status === 'answered').length,
    input_tokens: 0,
    latency_ms_total: 0,
    status: 'ok',
    n_http_attempts: 0,
    requests: [],
    per_source: rows.map((row) => ({
      src: row.src,
      url: `https://${row.src}.example/`,
      status: row.status,
      ...(row.fail_kind !== undefined ? { fail_kind: row.fail_kind } : {}),
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
    dropSource(stats, 0, 'filler');
    dropSource(stats, 1, 'filler');
    dropSource(stats, 2, 'empty');
    assert.equal(buildStatusLine(stats), '[filter] dropped 3 of 3 sources: 2 filler, 1 empty');
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

  it('reports error when sources not checked on mode on even with zero drops', () => {
    const stats = statsOf('on', {
      sources: [
        { url: 'https://a.example/', snippets: ['one'] },
        { url: 'https://b.example/', snippets: ['two'] },
      ],
    });
    // per_source 缺 s1 的行（no_key 形态是整表为空；缺行是同一判定的最小构造）
    withJev(stats, [{ src: 's0', status: 'answered' }]);
    assert.equal(
      buildStatusLine(stats),
      '[filter] [error] [1 source unchecked: filter check incomplete, raw sources kept] [500]'
    );
  });

  it('does not count a failed per-source row as checked and reports error', () => {
    const stats = statsOf('on');
    withJev(stats, [
      { src: 's0', status: 'answered' },
      { src: 's1', status: 'answered' },
      { src: 's2', status: 'failed' },
    ]);
    assert.equal(
      buildStatusLine(stats),
      '[filter] [error] [1 source unchecked: filter check incomplete, raw sources kept] [500]'
    );

    const twoFailed = statsOf('on');
    withJev(twoFailed, [
      { src: 's0', status: 'failed' },
      { src: 's1', status: 'failed' },
    ]);
    dropSource(twoFailed, 0, 'filler');
    // s0 已被丢弃不参与未判定计数；keep 的 s1（failed）与 s2（缺行）都算未判定
    assert.equal(
      buildStatusLine(twoFailed),
      '[filter] dropped 1 of 3 sources: 1 filler; [error] [2 sources unchecked: filter check incomplete, raw sources kept] [500]'
    );
  });

  it('formats structured errors for validation and rate_limited failures', () => {
    // 回答已收到但关键答案缺失/越界（fail_kind='validation'）：来源防御式保留
    const stats = statsOf('on', {
      sources: [
        { url: 'https://a.example/', snippets: ['one'] },
        { url: 'https://b.example/', snippets: ['two'] },
      ],
    });
    withJev(stats, [
      { src: 's0', status: 'answered' },
      { src: 's1', status: 'answered', fail_kind: 'validation' },
    ]);
    assert.equal(
      buildStatusLine(stats),
      '[filter] [error] [1 source unchecked: filter payload rejected, raw sources kept] [422]'
    );

    // 当遇到限流或超时等故障时，如实向模型暴露具体原因和状态码
    const rateLimitedStats = statsOf('on', {
      sources: [{ url: 'https://a.example/', snippets: ['one'] }],
    });
    withJev(rateLimitedStats, [{ src: 's0', status: 'failed', fail_kind: 'rate_limited' }]);
    assert.equal(
      buildStatusLine(rateLimitedStats),
      '[filter] [error] [1 source unchecked: filter rate limited, raw sources kept] [429]'
    );

    // 超时与熔断器测试
    const timeoutStats = statsOf('on', {
      sources: [{ url: 'https://a.example/', snippets: ['one'] }],
    });
    withJev(timeoutStats, [{ src: 's0', status: 'failed', fail_kind: 'timeout' }]);
    assert.equal(
      buildStatusLine(timeoutStats),
      '[filter] [error] [1 source unchecked: filter timeout, raw sources kept] [408]'
    );

    const breakerStats = statsOf('on', {
      sources: [{ url: 'https://a.example/', snippets: ['one'] }],
    });
    withJev(breakerStats, [{ src: 's0', status: 'breaker_open' }]);
    assert.equal(
      buildStatusLine(breakerStats),
      '[filter] [error] [1 source unchecked: filter circuit breaker open, raw sources kept] [503]'
    );

    // 未配置 key (no_key) 暴露 401
    const noKeyStats = statsOf('on', {
      sources: [{ url: 'https://a.example/', snippets: ['one'] }],
    });
    withJev(noKeyStats, []);
    noKeyStats.jev!.status = 'no_key';
    assert.equal(
      buildStatusLine(noKeyStats),
      `[filter] [error] [1 source unchecked: filter missing API key, raw sources kept] [401] ${JEV_KEY_SETUP_HINT}`
    );

    // 鉴权失败 (auth) 暴露 401
    const authStats = statsOf('on', {
      sources: [{ url: 'https://a.example/', snippets: ['one'] }],
    });
    withJev(authStats, [{ src: 's0', status: 'failed', fail_kind: 'auth' }]);
    assert.equal(
      buildStatusLine(authStats),
      '[filter] [error] [1 source unchecked: filter unauthorized, raw sources kept] [401]'
    );

    // 真实 HTTP 响应状态码（例如远端返回 529 过载）优先透传真实数字
    const http529Stats = statsOf('on', {
      sources: [{ url: 'https://a.example/', snippets: ['one'] }],
    });
    withJev(http529Stats, [{ src: 's0', status: 'failed', fail_kind: 'rate_limited' }]);
    http529Stats.jev!.requests = [
      {
        request_id: 'j1',
        source_ids: ['s0'],
        dispatched: true,
        answered: false,
        input_tokens: null,
        usage_complete: false,
        latency_ms: 120,
        fail_kind: 'rate_limited',
        http_status: 529,
      },
    ];
    assert.equal(
      buildStatusLine(http529Stats),
      '[filter] [error] [1 source unchecked: filter rate limited, raw sources kept] [529]'
    );
  });

  it('never adds the error segment off, and skips it when everything is answered', () => {
    // off：即使 per_source 缺行也不数未判定
    const offStats = statsOf('off');
    withJev(offStats, []);
    dropSource(offStats, 0, 'empty');
    assert.equal(buildStatusLine(offStats), '[filter] dropped 1 of 3 sources: 1 empty');

    // test/on 都把缺少来源判断的情况提示为未完成 Jev 检查。
    const testStats = statsOf('test');
    withJev(testStats, [{ src: 's0', status: 'answered' }]);
    assert.equal(
      buildStatusLine(testStats),
      '[filter] [error] [2 sources unchecked: filter check incomplete, raw sources kept] [500]'
    );

    // on 且全部 answered、零丢弃零删除 → 不附
    const allAnswered = statsOf('on');
    withJev(allAnswered, [
      { src: 's0', status: 'answered' },
      { src: 's1', status: 'answered' },
      { src: 's2', status: 'answered' },
    ]);
    assert.equal(buildStatusLine(allAnswered), undefined);
  });

  it('produces a byte-identical status line for test and on carriers of the same verdicts', () => {
    const build = (mode: FilterStats['mode']): string => {
      const stats = statsOf(mode, {
        sources: [
          { url: 'https://a.example/', snippets: ['one', 'two'] },
          { url: 'https://b.example/', snippets: ['three'] },
          { url: 'https://c.example/', snippets: ['four'] },
          { url: 'https://d.example/', snippets: ['five'] },
        ],
      });
      dropSource(stats, 0, 'filler');
      dropSource(stats, 1, 'empty');
      dropSource(stats, 2, 'filler');
      dropSnippet(stats, 0, 1);
      // 幸存的 d 来源未入 per_source：未判定段在 test/on 出现（同一裁决载体）
      withJev(stats, []);
      return buildStatusLine(stats) ?? '';
    };
    // test/on 的删除计数与未完成 Jev 检查提示应一致。
    assert.equal(build('test'), build('on'));
    // off 绝不带未判定段——同载体下与 test/on 的差异恰在该段
    assert.notEqual(build('off'), build('test'));
  });
});
