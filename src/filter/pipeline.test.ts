import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseJevResponse } from './jev/client.js';
import { DEFAULT_JEV_MODEL, DEFAULT_THRESHOLDS } from './jev/questions.js';
import { collectJevCandidates, filterLlmContext, trimSourceMeta } from './pipeline.js';
import { createNoKeyJevStats } from './stats.js';
import type {
  BraveLlmContextResponse,
  ClassifyDeps,
  FilterConfig,
  FilterRequest,
} from './types.js';

const offConfig: FilterConfig = {
  mode: 'off',
  overfetchFactor: 1,
  blocklist: new Set(),
  thresholds: { ...DEFAULT_THRESHOLDS },
  jev: { model: DEFAULT_JEV_MODEL, backend: 'typesafe', timeoutMs: 15000, concurrency: 12 },
};

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

  it('skips the Jev stage entirely in off mode even when classify is injected (EMBED-02)', async () => {
    let calls = 0;
    const classify: ClassifyDeps['classify'] = async () => {
      calls += 1;
      return { status: 'failed', kind: 'network' };
    };

    const { stats } = await filterLlmContext(payload(), request, offConfig, { classify });

    assert.equal(calls, 0);
    assert.equal(stats.jev, null);
  });

  for (const mode of ['off', 'shadow', 'on'] as const) {
    it(`mode=${mode} performs no network call and records the mode`, async () => {
      const data = payload();

      const { result, stats } = await filterLlmContext(data, request, { ...offConfig, mode });

      assert.equal(stats.mode, mode);
      // off 模式 Jev 整段跳过（stats.jev 保持 null，A16）；on/shadow 未注入 classify
      // 时记 no_key 零值对象且零请求（SAFE-01 语义前置）
      if (mode === 'off') {
        assert.equal(stats.jev, null);
      } else {
        assert.deepEqual(stats.jev, createNoKeyJevStats());
        assert.equal(stats.jev?.n_requests, 0);
      }
      assert.equal(stats.shadow_diff, null);
      assert.deepEqual(
        result.grounding.generic.map((item) => item.snippets),
        data.grounding.generic.map((item) => item.snippets)
      );
    });
  }

  it('passes sources and snippets through unchanged in off mode', async () => {
    const data = payload();

    const { result } = await filterLlmContext(data, request, offConfig);

    assert.deepEqual(result.grounding.generic, data.grounding.generic);
    assert.deepEqual(
      result.grounding.generic.map((item) => item.url),
      ['https://search.brave.com/', 'https://example.com/post']
    );
  });

  it('passes map and poi through as-is', async () => {
    const data = payload();
    const map = [{ name: 'Place', url: '', title: 'Place', snippets: ['Open daily.'] }];
    const poi = { name: 'POI', url: 'https://poi.example/', title: 'POI', snippets: ['x'] };
    data.grounding.map = map;
    data.grounding.poi = poi;

    const { result } = await filterLlmContext(data, request, offConfig);

    assert.equal(result.grounding.map, map);
    assert.equal(result.grounding.poi, poi);
  });

  it('omits poi when the input has none', async () => {
    const { result } = await filterLlmContext(payload(), request, offConfig);

    assert.equal(Object.hasOwn(result.grounding, 'poi'), false);
  });

  it('trims sources to title / hostname / age in Brave order', async () => {
    const { result } = await filterLlmContext(payload(), request, offConfig);

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

  it('returns empty grounding and sources for an empty response', async () => {
    const data: BraveLlmContextResponse = { grounding: { generic: [], map: [] }, sources: {} };

    const { result, stats } = await filterLlmContext(data, request, offConfig);

    assert.deepEqual(result, { grounding: { generic: [], map: [] }, sources: {} });
    assert.equal(stats.brave.n_sources, 0);
    assert.equal(stats.brave.n_snippets, 0);
    assert.equal(stats.output.n_sources, 0);
    assert.deepEqual(stats.sources, []);
  });

  it('prefilters a short nav-only snippet in place during step 3', async () => {
    const data = payload();
    data.grounding.generic[1].snippets.push('On this page\nInstallation and upgrading');

    const { result, stats } = await filterLlmContext(data, request, offConfig);

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

  it('truncates a snippet at a paywall marker line and counts it', async () => {
    const data = payload();
    data.grounding.generic[0].snippets[0] =
      'Brave is a privacy-focused browser.\nSubscribe to continue reading\njunk after the marker';

    const { result, stats } = await filterLlmContext(data, request, offConfig);

    assert.deepEqual(
      result.grounding.generic[0].snippets[0],
      'Brave is a privacy-focused browser.'
    );
    assert.equal(stats.sources[0].snippets[0].truncated, true);
    assert.equal(stats.local.paywall_truncated, 1);
  });

  it('drops a feed-shaped source during step 4 and cleans its sources entry', async () => {
    const data = payload();
    data.grounding.generic.push({
      url: 'https://example.com/blog/feed/',
      title: 'Feed',
      snippets: ['Brave updates feed.'],
    });
    data.sources['https://example.com/blog/feed/'] = { title: 'Feed', hostname: 'example.com' };

    const { result, stats } = await filterLlmContext(data, request, offConfig);

    assert.deepEqual(
      result.grounding.generic.map((item) => item.url),
      ['https://search.brave.com/', 'https://example.com/post']
    );
    assert.equal(Object.hasOwn(result.sources, 'https://example.com/blog/feed/'), false);
    assert.equal(stats.local.feed_hits, 1);
    assert.deepEqual(stats.sources[2].reason, 'feed');
  });

  it('drops a blocklisted host during step 4', async () => {
    const data = payload();
    const config: FilterConfig = { ...offConfig, blocklist: new Set(['example.com']) };

    const { result, stats } = await filterLlmContext(data, request, config);

    assert.deepEqual(
      result.grounding.generic.map((item) => item.url),
      ['https://search.brave.com/']
    );
    assert.equal(stats.local.blocklist_hits, 1);
    assert.equal(stats.sources[1].reason, 'blocklist');
  });

  it('drops a source whose only snippet is JSON-LD metadata during step 8', async () => {
    const data = payload();
    data.grounding.generic.push({
      url: 'https://example.org/meta',
      title: 'Meta',
      snippets: ['{"author":"A","datePublished":"2026-01-01","publisher":"P"}'],
    });
    data.sources['https://example.org/meta'] = { title: 'Meta', hostname: 'example.org' };

    const { result, stats } = await filterLlmContext(data, request, offConfig);

    assert.equal(Object.hasOwn(result.sources, 'https://example.org/meta'), false);
    assert.equal(stats.local.empty_dropped, 1);
    assert.equal(stats.sources[2].reason, 'empty');
  });

  it('drops a one-liner source that only shares intent terms during step 8', async () => {
    const data = payload();
    data.grounding.generic.push({
      url: 'https://example.org/oneliner',
      title: 'Oneliner',
      snippets: ['The current version.'],
    });
    data.sources['https://example.org/oneliner'] = { title: 'Oneliner', hostname: 'example.org' };
    const req = {
      params: { query: 'brave browser' },
      intent: 'about the current version',
    };

    const { result, stats } = await filterLlmContext(data, req, offConfig);

    // 片段含 intent 实词（current/version）所以步 3 保留，但不含 query 实词 → 步 8 丢
    assert.equal(Object.hasOwn(result.sources, 'https://example.org/oneliner'), false);
    assert.equal(stats.local.empty_dropped, 1);
    assert.equal(stats.sources[2].reason, 'empty');
  });

  it('drops a source whose snippets are all gone and cleans its sources entry', async () => {
    const data = payload();
    data.grounding.generic.push({ url: 'https://empty.example/', title: 'Empty', snippets: [] });
    data.sources['https://empty.example/'] = { title: 'Empty', hostname: 'empty.example' };

    const { result, stats } = await filterLlmContext(data, request, offConfig);

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

  it('keeps a source whose metadata is missing entirely', async () => {
    const data = payload();
    delete data.sources['https://example.com/post'];

    const { result } = await filterLlmContext(data, request, offConfig);

    assert.equal(result.grounding.generic.length, 2);
    assert.deepEqual(result.sources['https://example.com/post'], {});
  });

  it('records Brave-order indices, per-snippet chars and request defaults in stats', async () => {
    const data = payload();

    const { stats } = await filterLlmContext(
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

  it('keeps stats independent across alternating configs in one process', async () => {
    const data = payload();
    const first = await filterLlmContext(
      data,
      { params: { query: 'first' }, intent: 'first intent' },
      {
        mode: 'shadow',
        overfetchFactor: 2,
        blocklist: new Set(),
        thresholds: { ...DEFAULT_THRESHOLDS },
        jev: { model: DEFAULT_JEV_MODEL, backend: 'typesafe', timeoutMs: 15000, concurrency: 12 },
      }
    );
    const second = await filterLlmContext(
      data,
      { params: { query: 'second' }, intent: 'second intent' },
      {
        mode: 'on',
        overfetchFactor: 1,
        blocklist: new Set(),
        thresholds: { ...DEFAULT_THRESHOLDS },
        jev: { model: DEFAULT_JEV_MODEL, backend: 'typesafe', timeoutMs: 15000, concurrency: 12 },
      }
    );
    const third = await filterLlmContext(
      data,
      { params: { query: 'first' }, intent: 'first intent' },
      {
        mode: 'shadow',
        overfetchFactor: 2,
        blocklist: new Set(),
        thresholds: { ...DEFAULT_THRESHOLDS },
        jev: { model: DEFAULT_JEV_MODEL, backend: 'typesafe', timeoutMs: 15000, concurrency: 12 },
      }
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

  it('reads process.env at call time when config is omitted', async () => {
    const original = process.env.JEV_FILTER_MODE;
    process.env.JEV_FILTER_MODE = 'shadow';

    try {
      assert.equal((await filterLlmContext(payload(), request)).stats.mode, 'shadow');
      process.env.JEV_FILTER_MODE = 'banana';
      assert.equal((await filterLlmContext(payload(), request)).stats.mode, 'off');
    } finally {
      if (original === undefined) {
        delete process.env.JEV_FILTER_MODE;
      } else {
        process.env.JEV_FILTER_MODE = original;
      }
    }
  });

  it('marks paywall_empty rows as truncated=true with kept=false', async () => {
    // 审查测试缺口 13：截断后为空的片段此前不写 truncated，夹具测试的
    // paywall_empty 分支一旦被走到就会挂在 undefined 断言上
    const data = payload();
    data.grounding.generic[1].snippets = ['Subscribe to continue reading'];

    const { stats } = await filterLlmContext(data, request, offConfig);
    const source = stats.sources.find((entry) => entry.url === 'https://example.com/post');

    assert.ok(source, 'source missing from stats');
    assert.deepEqual(
      source.snippets.map((row) => ({
        truncated: row.truncated,
        kept: row.kept,
        reason: row.reason,
      })),
      [{ truncated: true, kept: false, reason: 'paywall_empty' }]
    );
  });

  describe('step 9 budget', () => {
    const tightRequest: { params: FilterRequest; intent: string } = {
      params: { query: 'brave browser', maximum_number_of_urls: 5, maximum_number_of_tokens: 10 },
      intent: 'What Brave Search is',
    };

    it('skips the trim when the overfetch factor is 1 (Brave already honored the cap)', async () => {
      // 倍数为 1 时 Brave 已按请求上限执行输出、过滤层只删不加；估算公式为 Jev 32k
      // 保护标定、对普通文本偏高（审查问题 6），再按估算裁只会砍掉 Brave 给的完整内容
      const { result, stats } = await filterLlmContext(payload(), tightRequest, offConfig);

      assert.equal(stats.local.budget_trimmed_snippets, 0);
      assert.equal(stats.local.budget_dropped_sources, 0);
      assert.equal(result.grounding.generic[0].snippets.length, 2);
      assert.equal(result.grounding.generic[1].snippets.length, 1);
    });

    it('trims back to the original request when the overfetch factor exceeds 1', async () => {
      const config: FilterConfig = {
        mode: 'off',
        overfetchFactor: 2,
        blocklist: new Set(),
        thresholds: { ...DEFAULT_THRESHOLDS },
        jev: { model: DEFAULT_JEV_MODEL, backend: 'typesafe', timeoutMs: 15000, concurrency: 12 },
      };
      const { result, stats } = await filterLlmContext(payload(), tightRequest, config);

      assert.equal(stats.local.budget_trimmed_snippets > 0, true);
      assert.equal(stats.local.budget_dropped_sources > 0, true);
      // 放大后的请求发给了 Brave（Brave 侧预算翻倍），但输出仍按模型原始请求裁回
      assert.equal(result.grounding.generic.length, 0);
    });
  });
});

describe('collectJevCandidates', () => {
  // 四类情形内联载荷：s0 普通纯文本来源；s1 JSON-LD 转段来源（数组两个 articleBody，
  // 步 1 转出各段都是候选片段）；s2 feed URL 来源（步 4 整源丢）；s3 与 s0 同规范
  // URL 的待归并来源（步 2 drop+merged，其片段并入 s0）。片段都含 query 实词
  // （brave / browser），步 3 预筛不误伤。
  const jevPayload = (): BraveLlmContextResponse => ({
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
          url: 'https://example.com/article',
          title: 'Brave Release Notes',
          snippets: [
            '[{"@type":"NewsArticle","articleBody":"First body about Brave release details."},{"@type":"NewsArticle","articleBody":"Second body with more Brave analysis."}]',
          ],
        },
        {
          url: 'https://example.com/blog/feed/',
          title: 'Feed',
          snippets: ['Brave updates feed entry.'],
        },
        {
          url: 'https://www.search.brave.com/',
          title: 'Brave Search (www)',
          snippets: ['Third snippet about Brave performance.'],
        },
      ],
      map: [],
    },
    sources: {},
  });

  it('collects surviving sources with s{index} ids and excludes feed and merged ones', () => {
    const candidates = collectJevCandidates(jevPayload(), request, offConfig);

    // feed 来源（s2）与被归并来源（s3）不出现在候选集；被归并片段并入 s0 的片段序列
    assert.deepEqual(candidates, [
      {
        id: 's0',
        url: 'https://search.brave.com/',
        title: 'Brave Search',
        snippets: [
          'Brave is a privacy-focused browser and search engine.',
          'Second snippet about Brave.',
          'Third snippet about Brave performance.',
        ],
      },
      {
        id: 's1',
        url: 'https://example.com/article',
        title: 'Brave Release Notes',
        snippets: [
          'First body about Brave release details.',
          'Second body with more Brave analysis.',
        ],
      },
    ]);
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

// ---------------------------------------------------------------------------
// on 模式裁决端到端（02-03）：回放夹具驱动 + 合成 classify，步 6/7 前半接线、
// 步 8 score 删光归 'empty'、幸存者 Brave 原序不变式
// ---------------------------------------------------------------------------

describe('on-mode verdicts end to end (replay fixture)', () => {
  const fixtureRoot = fileURLToPath(new URL('../../fixtures/', import.meta.url));
  const expectedRoot = join(fixtureRoot, 'expected');

  const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

  /** 三形状 Brave 夹具加载器（与 pipeline.fixtures.test.ts 同逻辑，不建 testUtils）。 */
  const loadBraveData = (rel: string): BraveLlmContextResponse => {
    const parsed: unknown = JSON.parse(readFileSync(join(fixtureRoot, rel), 'utf8'));
    assert.ok(isRecord(parsed), `${rel} is not an object`);
    if ('response' in parsed) return parsed.response as BraveLlmContextResponse;
    return parsed as BraveLlmContextResponse;
  };

  /** 期望文件头三件套：query / intent / request 与录制口径一致（02-01 守卫镜像）。 */
  const loadExpectedHeader = (
    rel: string
  ): { query: string; intent: string; request: Omit<FilterRequest, 'query'> } => {
    const parsed: unknown = JSON.parse(readFileSync(join(expectedRoot, rel), 'utf8'));
    assert.ok(isRecord(parsed), `${rel} is not an object`);
    assert.equal(typeof parsed.query, 'string', `${rel} has no query`);
    assert.equal(typeof parsed.intent, 'string', `${rel} has no intent`);
    assert.ok(isRecord(parsed.request), `${rel} has no request`);
    return {
      query: parsed.query as string,
      intent: parsed.intent as string,
      request: parsed.request as Omit<FilterRequest, 'query'>,
    };
  };

  /** 回放传输：按 state.source.id 取录制条目，200 走生产同一条 parseJevResponse。 */
  const replay: ClassifyDeps['classify'] = async ({ state }) => {
    const parsed: unknown = JSON.parse(
      readFileSync(join(fixtureRoot, 'jev_release_default.jev.json'), 'utf8')
    );
    assert.ok(isRecord(parsed) && isRecord(parsed.results), 'recording has no results');
    const results = parsed.results as Record<
      string,
      {
        http: number;
        response: { model: string; answers: unknown; usage: { input_tokens: number } };
      }
    >;
    const entry = results[state.source.id];
    if (!entry || entry.http !== 200) return { status: 'failed', kind: 'network' };
    const parsedResponse = parseJevResponse(entry.http, JSON.stringify(entry.response));
    return parsedResponse.ok
      ? {
          status: 'answered',
          model: parsedResponse.model,
          answers: parsedResponse.answers,
          input_tokens: parsedResponse.input_tokens,
        }
      : { status: 'failed', kind: 'validation' };
  };

  const braveOrderIsSubsequence = (data: BraveLlmContextResponse, outputUrls: string[]) => {
    const inputUrls = data.grounding.generic.map((item) => item.url);
    let cursor = 0;
    for (const url of outputUrls) {
      const found = inputUrls.indexOf(url, cursor);
      assert.ok(found >= cursor, `output url ${url} breaks Brave order`);
      cursor = found + 1;
    }
  };

  it('keeps every source under the default thresholds and removes exactly the low-score snippets', async () => {
    const data = loadBraveData('jev_release_default.json');
    const expected = loadExpectedHeader('jev_release_default.off.json');
    const fixtureRequest = {
      params: { ...expected.request, query: expected.query },
      intent: expected.intent,
    };

    const { result, stats } = await filterLlmContext(
      data,
      fixtureRequest,
      { ...offConfig, mode: 'on' },
      { classify: replay }
    );

    // 真实录好的答案全部低于五道门槛：12 源来源级 keep
    const perSource = stats.jev?.per_source ?? [];
    assert.equal(perSource.length, 12);
    for (const row of perSource) {
      assert.equal(row.status, 'answered', `${row.src} status`);
      assert.equal(row.verdict, 'keep', `${row.src} verdict`);
    }
    // 幸存者保持 Brave 原序子序列
    braveOrderIsSubsequence(
      data,
      result.grounding.generic.map((item) => item.url)
    );
    // score 删除计数与夹具 snippet_scores 推导一致（s8 4 + s9 4 + s10 2 = 10）
    const derived = perSource.reduce(
      (sum, row) =>
        sum +
        (row.snippet_scores ?? []).filter((score) => score < DEFAULT_THRESHOLDS.snippetMin).length,
      0
    );
    const removed = stats.sources.reduce(
      (sum, source) =>
        sum +
        source.snippets.filter((snippet) => !snippet.kept && snippet.reason === 'score').length,
      0
    );
    assert.equal(removed, 10);
    assert.equal(removed, derived);
    // 没有来源被 score 删光：步 8 不产生 empty
    assert.equal(stats.local.empty_dropped, 0);
  });

  it('drops every candidate as off_topic when the threshold is lowered and returns empty without refill', async () => {
    const data = loadBraveData('jev_release_default.json');
    const expected = loadExpectedHeader('jev_release_default.off.json');
    const fixtureRequest = {
      params: { ...expected.request, query: expected.query },
      intent: expected.intent,
    };
    const config: FilterConfig = {
      ...offConfig,
      mode: 'on',
      // default 夹具全部来源 CJK 占比 0、is_off_topic >= 0.02：门槛降到 0.01 后全部命中
      thresholds: { ...DEFAULT_THRESHOLDS, offTopicDrop: 0.01 },
    };

    const { result, stats } = await filterLlmContext(data, fixtureRequest, config, {
      classify: replay,
    });

    // 被来源级丢弃的来源不在输出；过滤后为空返回空不补回（VERDICT-06）
    assert.deepEqual(result.grounding.generic, []);
    assert.deepEqual(result.sources, {});
    // stats.sources 保持 Brave 原序（只翻标记不重排）且 reason 正确
    assert.deepEqual(
      stats.sources.map((source) => [source.index, source.reason]),
      Array.from({ length: 12 }, (_, index) => [index, 'off_topic'])
    );
    for (const row of stats.jev?.per_source ?? []) {
      assert.equal(row.verdict, 'drop', `${row.src} verdict`);
      assert.equal(row.reason, 'off_topic', `${row.src} reason`);
    }
    // 来源级已丢的来源不再跑 score 删除
    const scoreRemoved = stats.sources.reduce(
      (sum, source) =>
        sum +
        source.snippets.filter((snippet) => !snippet.kept && snippet.reason === 'score').length,
      0
    );
    assert.equal(scoreRemoved, 0);
  });

  it('marks a source whose snippets are all score-removed as empty in step 8', async () => {
    // 步 8 归因口径（notes/dedup-and-rewrite-policy.md）：仅 score/本地原因删光 →
    // 'empty'；novelty/跨源 dup 删光记 'rewrite' 的分支属 02-04
    const data: BraveLlmContextResponse = {
      grounding: {
        generic: [
          {
            url: 'https://a.example/',
            title: 'A',
            snippets: ['Brave fact one.', 'Brave fact two.'],
          },
        ],
        map: [],
      },
      sources: {},
    };
    const answers: Record<string, number> = {};
    for (const key of [
      'worth_keeping',
      'is_primary',
      'has_original_reasoning',
      'is_attributed_rewrite',
      'is_template_filler',
      'is_off_topic',
      'is_listing',
      'self_deprecated',
      'stale',
      'paywalled',
    ]) {
      answers[key] = 0;
    }
    const classify: ClassifyDeps['classify'] = async () => ({
      status: 'answered',
      model: DEFAULT_JEV_MODEL,
      answers: {
        ...Object.fromEntries(
          Object.entries(answers).map(([key, probability]) => [key, { kind: 'noul', probability }])
        ),
        snip0: { kind: 'score', score: 0.1 },
        snip1: { kind: 'score', score: 0.2 },
      },
      input_tokens: 10,
    });

    const { result, stats } = await filterLlmContext(
      data,
      request,
      { ...offConfig, mode: 'on' },
      { classify }
    );

    assert.deepEqual(result.grounding.generic, []);
    assert.equal(stats.sources[0].verdict, 'drop');
    assert.equal(stats.sources[0].reason, 'empty');
    assert.equal(stats.local.empty_dropped, 1);
  });
});

// ---------------------------------------------------------------------------
// 三模式语义矩阵（02-03 Task 2）：同一内联夹具 × off/shadow/on，on/shadow 注入
// 同一合成 classify——off 直通、shadow 记账不动正本、on 全链生效（VERDICT-05）
// ---------------------------------------------------------------------------

describe('three-mode semantic matrix (off / shadow / on)', () => {
  // 四来源覆盖矩阵四角：s0 来源级 keep 且 score 全过（三模式输出同）；s1 来源级
  // off_topic 丢弃；s2 部分片段 score 删除；s3 score 删光 → 步 8 empty 间接清空。
  // 片段都含 query 实词（brave）且短于 shingle 门槛，本地规则不误删。
  const matrixPayload = (): BraveLlmContextResponse => ({
    grounding: {
      generic: [
        {
          url: 'https://s0.example/',
          title: 'Keep Source',
          snippets: [
            'Brave keeps snippet alpha with facts.',
            'Brave keeps snippet beta with facts.',
          ],
        },
        {
          url: 'https://s1.example/',
          title: 'Off Topic Source',
          snippets: ['Brave off topic snippet gamma.'],
        },
        {
          url: 'https://s2.example/',
          title: 'Partial Score Source',
          snippets: [
            'Brave strong snippet one.',
            'Brave weak snippet two.',
            'Brave weak snippet three.',
          ],
        },
        {
          url: 'https://s3.example/',
          title: 'All Low Score Source',
          snippets: ['Brave low snippet one.', 'Brave low snippet two.'],
        },
      ],
      map: [],
    },
    sources: {},
  });

  /** 每源的片段 score（夹具答案推导的根基；来源级 noul 全 0，除外 s1 off_topic 0.9）。 */
  const SNIP_SCORES: Record<string, number[]> = {
    s0: [1.5, 1.0], // 1.0 恰等 SNIPPET_MIN → 保留
    s1: [1.2],
    s2: [1.5, 0.3, 0.2],
    s3: [0.1, 0.2],
  };

  const makeClassify =
    (counter: { calls: number }): ClassifyDeps['classify'] =>
    async ({ state }) => {
      counter.calls += 1;
      const answers: Record<
        string,
        { kind: 'noul'; probability: number } | { kind: 'score'; score: number }
      > = {};
      for (const key of [
        'worth_keeping',
        'is_primary',
        'has_original_reasoning',
        'is_attributed_rewrite',
        'is_template_filler',
        'is_off_topic',
        'is_listing',
        'self_deprecated',
        'stale',
        'paywalled',
      ]) {
        answers[key] = {
          kind: 'noul',
          probability: state.source.id === 's1' && key === 'is_off_topic' ? 0.9 : 0,
        };
      }
      for (const [i, score] of (SNIP_SCORES[state.source.id] ?? []).entries()) {
        answers[`snip${i}`] = { kind: 'score', score };
      }
      return { status: 'answered', model: DEFAULT_JEV_MODEL, answers, input_tokens: 10 };
    };

  it('off: no classify call, stats.jev null, shadow_diff null, full local output', async () => {
    const data = matrixPayload();
    const counter = { calls: 0 };

    const { result, stats } = await filterLlmContext(data, request, offConfig, {
      classify: makeClassify(counter),
    });

    assert.equal(counter.calls, 0);
    assert.equal(stats.jev, null);
    assert.equal(stats.shadow_diff, null);
    // 本地规则结果：4 源 8 片段全留
    assert.deepEqual(
      result.grounding.generic.map((item) => [item.url, item.snippets.length]),
      [
        ['https://s0.example/', 2],
        ['https://s1.example/', 1],
        ['https://s2.example/', 3],
        ['https://s3.example/', 2],
      ]
    );
  });

  it('shadow: classify called, output deep-equals the off output, would bookkeeping derived from answers', async () => {
    const counter = { calls: 0 };
    const offRun = await filterLlmContext(matrixPayload(), request, offConfig);

    const shadowRun = await filterLlmContext(
      matrixPayload(),
      request,
      { ...offConfig, mode: 'shadow' },
      { classify: makeClassify(counter) }
    );

    // Jev 照常调用（4 候选源各一次）并记账
    assert.equal(counter.calls, 4);
    assert.equal(shadowRun.stats.jev?.n_requests, 4);
    // 正本不动：输出与 off 模式 deepEqual
    assert.deepEqual(shadowRun.result, offRun.result);
    // would_drop 与夹具答案推导一致：s1（off_topic）+ s3（score 删光间接清空）
    assert.deepEqual(shadowRun.stats.shadow_diff?.would_drop, ['s1', 's3']);
    // would_remove_snippets 与 score 推导一致：s2 删 2 + s3 删 2 = 4
    assert.equal(shadowRun.stats.shadow_diff?.would_remove_snippets, 4);
    // would 层裁决记账进 per_source，但正本输出不受影响
    const s1Row = shadowRun.stats.jev?.per_source.find((row) => row.src === 's1');
    assert.equal(s1Row?.verdict, 'drop');
    assert.equal(s1Row?.reason, 'off_topic');
    const s0Row = shadowRun.stats.jev?.per_source.find((row) => row.src === 's0');
    assert.equal(s0Row?.verdict, 'keep');
    // 本地 empty 计数不被 would 链的拷贝步 8 污染（正本 4 源无一为空）
    assert.equal(shadowRun.stats.local.empty_dropped, 0);
  });

  it('on: output equals the would view applied, dropped sources absent, Brave order kept, shadow_diff null', async () => {
    const counter = { calls: 0 };
    const shadowRun = await filterLlmContext(
      matrixPayload(),
      request,
      { ...offConfig, mode: 'shadow' },
      { classify: makeClassify(counter) }
    );
    counter.calls = 0;
    const onRun = await filterLlmContext(
      matrixPayload(),
      request,
      { ...offConfig, mode: 'on' },
      { classify: makeClassify(counter) }
    );

    assert.ok(counter.calls > 0);
    assert.equal(onRun.stats.shadow_diff, null);
    // on 输出 = shadow 的 would 视图应用后的结果：would_drop 来源整源移除、
    // 低 score 片段（score < SNIPPET_MIN）按夹具 snippet_scores 推导移除
    const dropped = new Set(shadowRun.stats.shadow_diff?.would_drop ?? []);
    const urlOf: Record<string, string> = {
      s0: 'https://s0.example/',
      s1: 'https://s1.example/',
      s2: 'https://s2.example/',
      s3: 'https://s3.example/',
    };
    const expectedGeneric = shadowRun.result.grounding.generic
      .filter((item) => ![...dropped].some((id) => urlOf[id] === item.url))
      .map((item) => {
        const id = Object.keys(urlOf).find((key) => urlOf[key] === item.url);
        const scores = SNIP_SCORES[id ?? ''] ?? [];
        return {
          ...item,
          snippets: item.snippets.filter(
            (_, i) => (scores[i] ?? 0) >= DEFAULT_THRESHOLDS.snippetMin
          ),
        };
      });
    assert.deepEqual(onRun.result.grounding.generic, expectedGeneric);
    // 具体形状：s0 两段全留、s1 整源丢、s2 剩第一条、s3 整源丢
    assert.deepEqual(
      onRun.result.grounding.generic.map((item) => [item.url, item.snippets.length]),
      [
        ['https://s0.example/', 2],
        ['https://s2.example/', 1],
      ]
    );
    // Brave 原序子序列保持
    const data = matrixPayload();
    const inputUrls = data.grounding.generic.map((item) => item.url);
    let cursor = 0;
    for (const url of onRun.result.grounding.generic.map((item) => item.url)) {
      const found = inputUrls.indexOf(url, cursor);
      assert.ok(found >= cursor, `output url ${url} breaks Brave order`);
      cursor = found + 1;
    }
  });
});
