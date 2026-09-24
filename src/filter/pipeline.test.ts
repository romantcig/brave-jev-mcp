import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { filterLlmContext, trimSourceMeta } from './pipeline.js';
import type { BraveLlmContextResponse, FilterConfig, FilterRequest } from './types.js';

const offConfig: FilterConfig = { mode: 'off', overfetchFactor: 1 };

const request: { params: FilterRequest; intent: string } = {
  params: { query: 'brave browser', maximum_number_of_urls: 5, maximum_number_of_tokens: 4000 },
  intent: 'What Brave Search is',
};

// 最小内联载荷：两个来源，第一个两段片段带完整元数据，第二个一段片段且 age 为空数组。
// 片段文本都含 query 实词（brave），步 3 预筛不命中——步 3 自身的行为在下面的专用用例里断言。
const payload = (): BraveLlmContextResponse => ({
  grounding: {
    generic: [
      {
        url: 'https://search.brave.com/',
        title: 'Brave Search',
        snippets: [
          'Brave is a privacy-focused browser and search engine.',
          'Second snippet about Brave.',
        ],
      },
      {
        url: 'https://example.com/post',
        title: 'Example Post',
        snippets: ['Example snippet about Brave.'],
      },
    ],
    map: [],
  },
  sources: {
    'https://search.brave.com/': {
      title: 'Brave Search',
      hostname: 'search.brave.com',
      age: ['Wednesday, September 16, 2026', '2026-09-16', '1 week ago', '2026-09-16T00:00:00'],
      site_name: 'Brave',
      favicon: 'https://search.brave.com/favicon.ico',
    },
    'https://example.com/post': { title: 'Example Post', hostname: 'example.com', age: [] },
  },
});

describe('filterLlmContext', () => {
  let savedFetch: typeof fetch;

  before(() => {
    // 无 fetch 保护：库必须同步完成、不碰网络，任何出站请求都会在这里抛
    savedFetch = globalThis.fetch;
    globalThis.fetch = (() => {
      throw new Error('unexpected fetch');
    }) as typeof fetch;
  });

  after(() => {
    globalThis.fetch = savedFetch;
  });

  for (const mode of ['off', 'shadow', 'on'] as const) {
    it(`mode=${mode} performs no network call and records the mode`, () => {
      const data = payload();

      const { result, stats } = filterLlmContext(data, request, { ...offConfig, mode });

      assert.equal(stats.mode, mode);
      assert.equal(stats.jev, null);
      assert.equal(stats.shadow_diff, null);
      assert.deepEqual(
        result.grounding.generic.map((item) => item.snippets),
        data.grounding.generic.map((item) => item.snippets)
      );
    });
  }

  it('passes sources and snippets through unchanged in off mode', () => {
    const data = payload();

    const { result } = filterLlmContext(data, request, offConfig);

    assert.deepEqual(result.grounding.generic, data.grounding.generic);
    assert.deepEqual(
      result.grounding.generic.map((item) => item.url),
      ['https://search.brave.com/', 'https://example.com/post']
    );
  });

  it('passes map and poi through as-is', () => {
    const data = payload();
    const map = [{ name: 'Place', url: '', title: 'Place', snippets: ['Open daily.'] }];
    const poi = { name: 'POI', url: 'https://poi.example/', title: 'POI', snippets: ['x'] };
    data.grounding.map = map;
    data.grounding.poi = poi;

    const { result } = filterLlmContext(data, request, offConfig);

    assert.equal(result.grounding.map, map);
    assert.equal(result.grounding.poi, poi);
  });

  it('omits poi when the input has none', () => {
    const { result } = filterLlmContext(payload(), request, offConfig);

    assert.equal(Object.hasOwn(result.grounding, 'poi'), false);
  });

  it('trims sources to title / hostname / age in Brave order', () => {
    const { result } = filterLlmContext(payload(), request, offConfig);

    assert.deepEqual(Object.keys(result.sources), [
      'https://search.brave.com/',
      'https://example.com/post',
    ]);
    assert.deepEqual(result.sources, {
      'https://search.brave.com/': {
        title: 'Brave Search',
        hostname: 'search.brave.com',
        age: ['2026-09-16'],
      },
      'https://example.com/post': { title: 'Example Post', hostname: 'example.com' },
    });
  });

  it('returns empty grounding and sources for an empty response', () => {
    const data: BraveLlmContextResponse = { grounding: { generic: [], map: [] }, sources: {} };

    const { result, stats } = filterLlmContext(data, request, offConfig);

    assert.deepEqual(result, { grounding: { generic: [], map: [] }, sources: {} });
    assert.equal(stats.brave.n_sources, 0);
    assert.equal(stats.brave.n_snippets, 0);
    assert.equal(stats.output.n_sources, 0);
    assert.deepEqual(stats.sources, []);
  });

  it('prefilters a short nav-only snippet in place during step 3', () => {
    const data = payload();
    data.grounding.generic[1].snippets.push('On this page\nInstallation and upgrading');

    const { result, stats } = filterLlmContext(data, request, offConfig);

    // 被删片段留在原位只翻 kept，幸存片段保持 Brave 原序
    assert.deepEqual(
      stats.sources[1].snippets.map((snippet) => [snippet.index, snippet.kept, snippet.reason]),
      [
        [0, true, undefined],
        [1, false, 'nav'],
      ]
    );
    assert.deepEqual(result.grounding.generic[1].snippets, ['Example snippet about Brave.']);
    assert.equal(stats.local.snippets_prefiltered, 1);
  });

  it('truncates a snippet at a paywall marker line and counts it', () => {
    const data = payload();
    data.grounding.generic[0].snippets[0] =
      'Brave is a privacy-focused browser.\nSubscribe to continue reading\njunk after the marker';

    const { result, stats } = filterLlmContext(data, request, offConfig);

    assert.deepEqual(
      result.grounding.generic[0].snippets[0],
      'Brave is a privacy-focused browser.'
    );
    assert.equal(stats.sources[0].snippets[0].truncated, true);
    assert.equal(stats.local.paywall_truncated, 1);
  });

  it('drops a source whose snippets are all gone and cleans its sources entry', () => {
    const data = payload();
    data.grounding.generic.push({ url: 'https://empty.example/', title: 'Empty', snippets: [] });
    data.sources['https://empty.example/'] = { title: 'Empty', hostname: 'empty.example' };

    const { result, stats } = filterLlmContext(data, request, offConfig);

    assert.deepEqual(
      result.grounding.generic.map((item) => item.url),
      ['https://search.brave.com/', 'https://example.com/post']
    );
    assert.equal(Object.hasOwn(result.sources, 'https://empty.example/'), false);
    assert.equal(stats.local.empty_dropped, 1);
    assert.deepEqual(
      stats.sources.map((source) => [source.verdict, source.reason]),
      [
        ['keep', undefined],
        ['keep', undefined],
        ['drop', 'empty'],
      ]
    );
  });

  it('keeps a source whose metadata is missing entirely', () => {
    const data = payload();
    delete data.sources['https://example.com/post'];

    const { result } = filterLlmContext(data, request, offConfig);

    assert.equal(result.grounding.generic.length, 2);
    assert.deepEqual(result.sources['https://example.com/post'], {});
  });

  it('records Brave-order indices, per-snippet chars and request defaults in stats', () => {
    const data = payload();

    const { stats } = filterLlmContext(
      data,
      { params: { query: 'brave browser' }, intent: 'What Brave Search is' },
      offConfig
    );

    assert.deepEqual(stats.request, {
      query: 'brave browser',
      intent: 'What Brave Search is',
      max_urls: 20,
      max_tokens: 8192,
      overfetch_factor: 1,
    });
    assert.deepEqual(stats.brave, {
      n_sources: 2,
      n_snippets: 3,
      chars: data.grounding.generic.flatMap((item) => item.snippets).join('').length,
    });
    assert.deepEqual(
      stats.sources.map((source) => [
        source.index,
        source.url,
        source.canonical_url,
        source.hostname,
      ]),
      [
        [0, 'https://search.brave.com/', 'search.brave.com/', 'search.brave.com'],
        [1, 'https://example.com/post', 'example.com/post', 'example.com'],
      ]
    );
    assert.deepEqual(
      stats.sources[0].snippets.map((snippet) => [snippet.index, snippet.kept, snippet.chars]),
      [
        [0, true, 'Brave is a privacy-focused browser and search engine.'.length],
        [1, true, 'Second snippet about Brave.'.length],
      ]
    );
    assert.equal(stats.output.n_sources, 2);
    assert.equal(stats.output.n_snippets, 3);
    assert.equal(stats.output.chars, stats.brave.chars);
    assert.ok(stats.output.est_tokens > 0);
    // 统计表不含片段正文
    assert.doesNotMatch(JSON.stringify(stats), /privacy-focused/);
  });

  it('keeps stats independent across alternating configs in one process', () => {
    const data = payload();
    const first = filterLlmContext(
      data,
      { params: { query: 'first' }, intent: 'first intent' },
      { mode: 'shadow', overfetchFactor: 2 }
    );
    const second = filterLlmContext(
      data,
      { params: { query: 'second' }, intent: 'second intent' },
      { mode: 'on', overfetchFactor: 1 }
    );
    const third = filterLlmContext(
      data,
      { params: { query: 'first' }, intent: 'first intent' },
      { mode: 'shadow', overfetchFactor: 2 }
    );

    assert.equal(first.stats.mode, 'shadow');
    assert.equal(second.stats.mode, 'on');
    assert.equal(first.stats.request.overfetch_factor, 2);
    assert.equal(second.stats.request.overfetch_factor, 1);
    assert.equal(first.stats.request.query, 'first');
    assert.equal(second.stats.request.query, 'second');
    assert.notEqual(first.stats, second.stats);
    assert.deepEqual(first.stats, third.stats);
  });

  it('reads process.env at call time when config is omitted', () => {
    const original = process.env.JEV_FILTER_MODE;
    process.env.JEV_FILTER_MODE = 'shadow';

    try {
      assert.equal(filterLlmContext(payload(), request).stats.mode, 'shadow');
      process.env.JEV_FILTER_MODE = 'banana';
      assert.equal(filterLlmContext(payload(), request).stats.mode, 'off');
    } finally {
      if (original === undefined) {
        delete process.env.JEV_FILTER_MODE;
      } else {
        process.env.JEV_FILTER_MODE = original;
      }
    }
  });
});

describe('trimSourceMeta', () => {
  it('keeps title and hostname and the first ISO date in age', () => {
    const meta = {
      title: 'Brave Search',
      hostname: 'search.brave.com',
      age: ['Wednesday, September 16, 2026', '2026-09-16', '1 week ago', '2026-09-16T00:00:00'],
      site_name: 'Brave',
    };

    assert.deepEqual(trimSourceMeta(meta), {
      title: 'Brave Search',
      hostname: 'search.brave.com',
      age: ['2026-09-16'],
    });
  });

  it('matches ISO dates by prefix, not by length', () => {
    assert.deepEqual(trimSourceMeta({ age: ['2026-09-16T10:00:00Z'] }), {
      age: ['2026-09-16T10:00:00Z'],
    });
    assert.deepEqual(trimSourceMeta({ age: ['16.09.2026', 'yesterday'] }), {});
  });

  it('omits age for an empty array and omits missing title or hostname', () => {
    assert.deepEqual(trimSourceMeta({ title: 'Only title', age: [] }), { title: 'Only title' });
    assert.deepEqual(trimSourceMeta({ hostname: 'h.example' }), { hostname: 'h.example' });
    assert.deepEqual(trimSourceMeta({ title: 42, hostname: null, age: 'not-an-array' }), {});
  });

  it('returns an empty object for non-object input', () => {
    assert.deepEqual(trimSourceMeta(undefined), {});
    assert.deepEqual(trimSourceMeta(null), {});
    assert.deepEqual(trimSourceMeta('text'), {});
    assert.deepEqual(trimSourceMeta(['a']), {});
  });

  it('returns a fresh deep-equal object each time without mutating the input', () => {
    const meta = { title: 'T', hostname: 'h', age: ['Wed', '2026-09-16'], favicon: 'f' };
    const snapshot = structuredClone(meta);

    const first = trimSourceMeta(meta);
    const second = trimSourceMeta(meta);

    assert.deepEqual(first, second);
    assert.notEqual(first, second);
    assert.notEqual(first.age, meta.age);
    assert.deepEqual(meta, snapshot);
  });
});
