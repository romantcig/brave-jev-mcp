import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseJevResponse } from './jev/client.js';
import {
  DEFAULT_JEV_MODEL,
  DEFAULT_THRESHOLDS,
  SOURCE_QUESTIONS,
  SNIPPET_LEVELS,
} from './jev/questions.js';
import { collectJevCandidates, filterLlmContext, trimSourceMeta } from './pipeline.js';
import { createNoKeyJevStats } from './stats.js';
import { estimateTokens } from './tokens.js';
import type {
  BraveLlmContextResponse,
  ClassifyDeps,
  ClassifyOutcome,
  FilterConfig,
  FilterRequest,
  JevAllState,
  JevAnswer,
  JevQuestion,
  JevState,
} from './types.js';
import { ALL_LIMIT_32K, ALL_LIMIT_64K } from './jev/context.js';

const offConfig: FilterConfig = {
  mode: 'off',
  overfetchFactor: 1,
  blocklist: new Set(),
  thresholds: { ...DEFAULT_THRESHOLDS },
  jev: {
    model: DEFAULT_JEV_MODEL,
    timeoutMs: 15000,
    concurrency: 12,
    contextMode: 'single',
    temporalContext: false,
  },
  logDir: join(homedir(), '.brave-jev', 'logs'),
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

  for (const mode of ['off', 'test', 'on'] as const) {
    it(`mode=${mode} performs no network call and records the mode`, async () => {
      const data = payload();

      const { result, stats } = await filterLlmContext(data, request, { ...offConfig, mode });

      assert.equal(stats.mode, mode);
      // off 模式 Jev 整段跳过（stats.jev 保持 null，A16）；on/test 未注入 classify
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

  it('keeps a short nav-only snippet after the short-no-terms retirement (filter-rules-13)', async () => {
    const data = payload();
    data.grounding.generic[1].snippets.push('On this page\nInstallation and upgrading');

    const { result, stats } = await filterLlmContext(data, request, offConfig);

    // 短且无实词预筛已退役（第二十四轮消融实证误伤真实内容）：首行样板剥离后
    // 余行保留在原位，质量判断交 Jev 评分（off 模式下随输出返回）；幸存片段保持
    // Brave 原序
    assert.deepEqual(
      stats.sources[1].snippets.map((snippet) => [snippet.index, snippet.kept, snippet.reason]),
      [
        [0, true, undefined],
        [1, true, undefined],
      ]
    );
    assert.deepEqual(result.grounding.generic[1].snippets, [
      'Example snippet about Brave.',
      'Installation and upgrading',
    ]);
    assert.equal(stats.local.snippets_prefiltered, 0);
  });

  for (const mode of ['off', 'test', 'on'] as const) {
    it(`${mode} 模式的本地预筛保留引用首段事实和混合摘要整块`, async () => {
      const snippets = [
        [
          '### Sources & References',
          '- Cloudflare must obtain browser approval before issuing classical certificates · Official · Accessed September 2026',
          '- Post quantum certificate issuance remains dependent on client support · Official · Accessed September 2026',
        ].join('\n'),
        [
          '### Sources & References',
          '- CA application Cloudflare·Official·Accessed September 2026',
          '- CA deployment guide Cloudflare·Official·Accessed September 2026',
          '- Cloudflare · Browser approval is still required before issuing certificates. · Accessed September 2026',
        ].join('\n'),
      ];
      for (const text of snippets) {
        const data = payload();
        data.grounding.generic = [
          { ...data.grounding.generic[0], title: 'Certificate evidence', snippets: [text] },
        ];
        const { result, stats } = await filterLlmContext(
          data,
          { params: { query: 'Cloudflare certificates' }, intent: 'Cloudflare certificates' },
          { ...offConfig, mode }
        );

        assert.deepEqual(result.grounding.generic[0]?.snippets, [text]);
        assert.equal(stats.local.snippets_prefiltered, 0);
      }
    });
  }

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
      // 过滤前 token 估算（D-10）：期望侧用同一 estimateTokens 逐段求和后 Math.ceil——
      // 绝不复制公式，也不 join 后整体估算（跨段边界会拼出假 token 段）
      est_tokens: Math.ceil(
        data.grounding.generic
          .flatMap((item) => item.snippets)
          .reduce((sum, text) => sum + estimateTokens(text), 0)
      ),
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

  it('records context_threshold_mode in stats.request only when the request carries it', async () => {
    const data = payload();

    // MCP 工具声明层不含 context_threshold_mode（SDK 会 strip 未知键），该参数
    // 只能经 filterLlmContext 直调注入——条件 spread 语义在管道层锁定（D-10）
    const withMode = await filterLlmContext(
      data,
      {
        params: { query: 'brave browser', context_threshold_mode: 'strict' },
        intent: 'What Brave Search is',
      },
      offConfig
    );
    assert.equal(withMode.stats.request.context_threshold_mode, 'strict');

    const without = await filterLlmContext(
      data,
      { params: { query: 'brave browser' }, intent: 'What Brave Search is' },
      offConfig
    );
    assert.equal(Object.hasOwn(without.stats.request, 'context_threshold_mode'), false);
    assert.equal(Object.hasOwn(without.stats.request, 'freshness'), false);
  });

  it('keeps stats independent across alternating configs in one process', async () => {
    const data = payload();
    const first = await filterLlmContext(
      data,
      { params: { query: 'first' }, intent: 'first intent' },
      {
        mode: 'test',
        overfetchFactor: 2,
        blocklist: new Set(),
        thresholds: { ...DEFAULT_THRESHOLDS },
        jev: {
          model: DEFAULT_JEV_MODEL,
          timeoutMs: 15000,
          concurrency: 12,
          contextMode: 'single',
          temporalContext: false,
        },
        logDir: join(homedir(), '.brave-jev', 'logs'),
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
        jev: {
          model: DEFAULT_JEV_MODEL,
          timeoutMs: 15000,
          concurrency: 12,
          contextMode: 'single',
          temporalContext: false,
        },
        logDir: join(homedir(), '.brave-jev', 'logs'),
      }
    );
    const third = await filterLlmContext(
      data,
      { params: { query: 'first' }, intent: 'first intent' },
      {
        mode: 'test',
        overfetchFactor: 2,
        blocklist: new Set(),
        thresholds: { ...DEFAULT_THRESHOLDS },
        jev: {
          model: DEFAULT_JEV_MODEL,
          timeoutMs: 15000,
          concurrency: 12,
          contextMode: 'single',
          temporalContext: false,
        },
        logDir: join(homedir(), '.brave-jev', 'logs'),
      }
    );

    assert.equal(first.stats.mode, 'test');
    assert.equal(second.stats.mode, 'on');
    assert.equal(first.stats.request.overfetch_factor, 2);
    assert.equal(second.stats.request.overfetch_factor, 1);
    assert.equal(first.stats.request.query, 'first');
    assert.equal(second.stats.request.query, 'second');
    assert.notEqual(first.stats, second.stats);
    assert.deepEqual(first.stats, third.stats);
  });

  it('uses the all-default config when config is omitted, ignoring filter env vars', async () => {
    // 02-FIX 批 B：环境变量只剩 Jev key 与 JEV_FILTER_CONFIG_FILE 两个，库不再读
    // 任何 JEV_FILTER_* 开关；省略 config 就是全默认（mode off）
    const savedMode = process.env.JEV_FILTER_MODE;
    const savedFile = process.env.JEV_FILTER_CONFIG_FILE;
    process.env.JEV_FILTER_MODE = 'on';
    process.env.JEV_FILTER_CONFIG_FILE = 'C:/no/such/file.json';

    try {
      assert.equal((await filterLlmContext(payload(), request)).stats.mode, 'off');
    } finally {
      if (savedMode === undefined) delete process.env.JEV_FILTER_MODE;
      else process.env.JEV_FILTER_MODE = savedMode;
      if (savedFile === undefined) delete process.env.JEV_FILTER_CONFIG_FILE;
      else process.env.JEV_FILTER_CONFIG_FILE = savedFile;
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
        jev: {
          model: DEFAULT_JEV_MODEL,
          timeoutMs: 15000,
          concurrency: 12,
          contextMode: 'single',
          temporalContext: false,
        },
        logDir: join(homedir(), '.brave-jev', 'logs'),
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

    // feed 来源（s2）与被归并来源（s3）不出现在候选集；被归并片段并入 s0 的片段序列。
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
    if (!('source' in state)) return { status: 'failed', kind: 'validation' };
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

    // 真实录好的答案全部低于三道门槛：12 源来源级 keep
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
      'has_original_reasoning',
      'is_template_filler',
      'is_off_topic',
      'is_listing',
      'self_deprecated',
      'stale',
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
// 三模式语义矩阵（02-03 Task 2，04-01 迁移到 test 语义）：同一内联夹具 ×
// off/test/on，test/on 注入同一合成 classify——off 直通、test 与 on 共用同一条链且
// 裁决真实生效（04-CONTEXT：不维护两套易漂移的实现）。注意：本例人造片段的
// 数字/日期等事实指纹少于 minFacts，步 7 的指纹新颖度不触发——新颖度按播种序的
// 模式差异由 novelty 组与 pipeline.fixtures.test.ts 的 test 相对 off 差集断言锁住。
// ---------------------------------------------------------------------------

describe('three-mode semantic matrix (off / test / on)', () => {
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
      if (!('source' in state)) return { status: 'failed', kind: 'validation' };
      counter.calls += 1;
      const answers: Record<
        string,
        { kind: 'noul'; probability: number } | { kind: 'score'; score: number }
      > = {};
      for (const key of [
        'has_original_reasoning',
        'is_template_filler',
        'is_off_topic',
        'is_listing',
        'self_deprecated',
        'stale',
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

  it('test: classify called and verdicts really apply — dropped sources vanish, low-score snippets removed', async () => {
    const counter = { calls: 0 };

    const testRun = await filterLlmContext(
      matrixPayload(),
      request,
      { ...offConfig, mode: 'test' },
      { classify: makeClassify(counter) }
    );

    // Jev 照常调用（4 候选源各一次）并记账
    assert.equal(counter.calls, 4);
    assert.equal(testRun.stats.jev?.n_requests, 4);
    // 裁决真实生效（04-01 单链语义，旧 shadow"只算不丢"行为退役）：s1 来源级
    // off_topic 丢弃、s3 片段被 score 删光后步 8 清空、s2 两条低分片段删除
    assert.deepEqual(
      testRun.result.grounding.generic.map((item) => [item.url, item.snippets.length]),
      [
        ['https://s0.example/', 2],
        ['https://s2.example/', 1],
      ]
    );
    // per_source 的 verdict/reason 记账：s1 drop + off_topic、s0 keep；s3 来源级
    // keep（删光它的是后续本地规则步 8，不是 Jev 裁决）
    const rowOf = (src: string) => testRun.stats.jev?.per_source.find((row) => row.src === src);
    assert.equal(rowOf('s1')?.verdict, 'drop');
    assert.equal(rowOf('s1')?.reason, 'off_topic');
    assert.equal(rowOf('s0')?.verdict, 'keep');
    assert.equal(rowOf('s3')?.verdict, 'keep');
    // 新记录不再产生 would 层字段（shadow_diff 恒 null、shadow_evidence 键省略，
    // 历史字段仅为读旧记录保留）
    assert.equal(testRun.stats.shadow_diff, null);
    assert.equal(testRun.stats.shadow_evidence, undefined);
    // score 删光清空的来源按 'empty' 记账（无新颖度/跨源 dup 标记，不记 rewrite）
    assert.equal(testRun.stats.local.empty_dropped, 1);
  });

  it('test: output equals the on run field by field under the same classify (single chain)', async () => {
    const counter = { calls: 0 };
    const testRun = await filterLlmContext(
      matrixPayload(),
      request,
      { ...offConfig, mode: 'test' },
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
    // 同输入、同回放桩：test 与 on 共用同一链，输出与统计投影逐字段一致（04-CONTEXT）
    assert.deepEqual(testRun.result, onRun.result);
    assert.deepEqual(testRun.stats.sources, onRun.stats.sources);
    assert.deepEqual(testRun.stats.local, onRun.stats.local);
    assert.equal(onRun.stats.shadow_diff, null);
    // 具体形状：s0 两段全留、s1 整源丢、s2 剩第一条、s3 整源丢
    assert.deepEqual(
      testRun.result.grounding.generic.map((item) => [item.url, item.snippets.length]),
      [
        ['https://s0.example/', 2],
        ['https://s2.example/', 1],
      ]
    );
    // Brave 原序子序列保持
    const data = matrixPayload();
    const inputUrls = data.grounding.generic.map((item) => item.url);
    let cursor = 0;
    for (const url of testRun.result.grounding.generic.map((item) => item.url)) {
      const found = inputUrls.indexOf(url, cursor);
      assert.ok(found >= cursor, `output url ${url} breaks Brave order`);
      cursor = found + 1;
    }
  });
});

describe('jev status aggregation and SAFE-02 trim-back (02-05 Task 3)', () => {
  // 按 state.source.id 注入预定 outcome 的合成 classify
  const scriptedClassify =
    (script: Record<string, ClassifyOutcome>): ClassifyDeps['classify'] =>
    async ({ state }) => {
      // 单来源桩：非 single state（本文件不会出现）防御式失败
      if (!('source' in state)) return { status: 'failed', kind: 'validation' };
      const outcome = script[state.source.id];
      assert.ok(outcome, `no scripted outcome for ${state.source.id}`);
      return outcome;
    };

  const breakerOpen: ClassifyOutcome = {
    status: 'failed',
    kind: 'breaker_open',
    detail: 'circuit open after consecutive transient failures',
  };

  // 低概率来源级答案：裁决链三道门槛全不命中，来源保留（answers 部分缺失走
  // T-02-03-1 防御式跳过，方向同为保守不丢——断言只关心 status 聚合）
  const answeredLow: ClassifyOutcome = {
    status: 'answered',
    model: DEFAULT_JEV_MODEL,
    answers: {
      is_off_topic: { kind: 'noul', probability: 0.1 },
      has_original_reasoning: { kind: 'noul', probability: 0.9 },
    },
    input_tokens: 100,
  };

  it('aggregates status ok when every candidate is answered', async () => {
    const { stats } = await filterLlmContext(
      payload(),
      request,
      { ...offConfig, mode: 'on' },
      {
        classify: scriptedClassify({ s0: answeredLow, s1: answeredLow }),
      }
    );

    assert.equal(stats.jev?.status, 'ok');
    assert.equal(stats.jev?.n_requests, 2);
  });

  it('aggregates status degraded when some candidates fail', async () => {
    const { stats } = await filterLlmContext(
      payload(),
      request,
      { ...offConfig, mode: 'on' },
      {
        classify: scriptedClassify({ s0: answeredLow, s1: { status: 'failed', kind: 'network' } }),
      }
    );

    assert.equal(stats.jev?.status, 'degraded');
    // FULL_CONTEXT_ROLLOUT_PLAN §6.1：n_requests = 实际至少派发一次的逻辑请求数——
    // 桩的 failed 无实发载荷（无已派发证据）不计；生产客户端已派发失败的 outcome
    // 带 dispatch，照常计入（sample.test 的 http-failed 用例同口径验证）
    assert.equal(stats.jev?.n_requests, 1);
    assert.equal(stats.jev?.requests.length, 2);
    assert.equal(stats.jev?.requests[1]?.fail_kind, 'network');
    assert.equal(stats.jev?.requests[1]?.usage_complete, false);
  });

  it('aggregates status breaker_open when any candidate is short-circuited (SAFE-02)', async () => {
    const { stats } = await filterLlmContext(
      payload(),
      request,
      { ...offConfig, mode: 'on' },
      {
        classify: scriptedClassify({ s0: answeredLow, s1: breakerOpen }),
      }
    );

    assert.equal(stats.jev?.status, 'breaker_open');
    // breaker_open 短路不计请求（02-02 记账口径）
    assert.equal(stats.jev?.n_requests, 1);
  });

  it('records ladder skipped on the per_source row for a too_large failure (JEV-05 ladder ④)', async () => {
    const { stats } = await filterLlmContext(
      payload(),
      request,
      { ...offConfig, mode: 'on' },
      {
        classify: scriptedClassify({
          s0: { status: 'failed', kind: 'too_large' },
          s1: { status: 'failed', kind: 'too_large' },
        }),
      }
    );

    assert.equal(stats.jev?.status, 'degraded');
    for (const row of stats.jev?.per_source ?? []) {
      assert.equal(row.status, 'failed');
      assert.equal(row.fail_kind, 'too_large');
      assert.equal(row.ladder, 'skipped');
    }
  });

  it('SAFE-02: with overfetch 2 and an all-breaker_open classify the output deep-equals the off run', async () => {
    const overfetch2 = { ...offConfig, overfetchFactor: 2 };
    const offRun = await filterLlmContext(payload(), request, { ...overfetch2, mode: 'off' });
    const onRun = await filterLlmContext(
      payload(),
      request,
      { ...overfetch2, mode: 'on' },
      { classify: scriptedClassify({ s0: breakerOpen, s1: breakerOpen }) }
    );

    // 超量抓取的内容不原样放行：熔断期只跑本地规则，输出与同参数 off 模式
    // deepEqual（步 9 trimToBudget 照常裁回）
    assert.deepEqual(onRun.result, offRun.result);
    // 失败来源全部按留（SAFE-01）
    assert.deepEqual(
      onRun.result.grounding.generic.map((item) => item.url),
      ['https://search.brave.com/', 'https://example.com/post']
    );
    assert.equal(onRun.stats.jev?.status, 'breaker_open');
    assert.equal(onRun.stats.jev?.n_requests, 0);
  });
});

// ---------------------------------------------------------------------------
// 步 7 后半新颖度与跨源 dup（02-04）：off 删重 + rewrite 归因、三模式播种序、
// 跨源逐字 dup 独立计数。
// ---------------------------------------------------------------------------

describe('novelty and cross-source dup (02-04)', () => {
  // s0 原文（四数字事实 + p:brave），s1 同四事实改写（词序不同 → 无共享 5-gram，
  // 不触发跨源 dup、走指纹新颖度），s2 独有事实（全模式幸存）
  const S0_TEXT = 'Brave version 1.13 costs $4.2m and runs 193x faster with 40% less latency';
  const S1_TEXT =
    'Brave it costs $4.2m, runs 193x faster, and has 40% less latency at version 1.13';
  const S2_TEXT = 'Brave unique snippet with 42% uptime details';

  const noveltyPayload = (): BraveLlmContextResponse => ({
    grounding: {
      generic: [
        { url: 'https://origin.example/', title: 'Origin', snippets: [S0_TEXT] },
        { url: 'https://rewrite.example/', title: 'Rewrite', snippets: [S1_TEXT] },
        { url: 'https://unique.example/', title: 'Unique', snippets: [S2_TEXT] },
      ],
      map: [],
    },
    sources: {},
  });

  it('off mode removes the rewritten duplicate as novelty and marks the emptied source rewrite', async () => {
    const { result, stats } = await filterLlmContext(noveltyPayload(), request, offConfig);

    assert.deepEqual(
      result.grounding.generic.map((item) => item.url),
      ['https://origin.example/', 'https://unique.example/']
    );
    assert.equal(stats.local.novelty_removed, 1);
    const rewrite = stats.sources.find((entry) => entry.url === 'https://rewrite.example/');
    assert.equal(rewrite?.verdict, 'drop');
    assert.equal(rewrite?.reason, 'rewrite');
    assert.equal(stats.local.empty_dropped, 0);
  });

  it('all three modes seed novelty in Brave order; test and on share one chain output', async () => {
    // filter-rules-5 起当事方播种序取消：test/on 与 off 的去重播种同为 Brave 原序，
    // 旧答案里的 is_primary 概率（历史录制回放形态）不影响谁先参与去重
    const judgedAnswers = (primary: number): Record<string, JevAnswer> => {
      const answers: Record<string, JevAnswer> = {};
      for (const key of [
        'has_original_reasoning',
        'is_template_filler',
        'is_off_topic',
        'is_listing',
        'self_deprecated',
        'stale',
        // 历史 v3 键：回放旧回答时可能仍在，新规则必须忽略
        'worth_keeping',
        'is_primary',
        'is_attributed_rewrite',
        'paywalled',
      ]) {
        answers[key] = { kind: 'noul', probability: key === 'is_primary' ? primary : 0 };
      }
      return answers;
    };
    const classify: ClassifyDeps['classify'] = async ({ state }) => {
      if (!('source' in state)) return { status: 'failed', kind: 'validation' };
      const primary = state.source.id === 's1' ? 0.9 : state.source.id === 's0' ? 0.5 : 0.1;
      return {
        status: 'answered',
        model: DEFAULT_JEV_MODEL,
        answers: judgedAnswers(primary),
        input_tokens: 10,
      };
    };

    const offRun = await filterLlmContext(noveltyPayload(), request, offConfig);
    const testRun = await filterLlmContext(
      noveltyPayload(),
      request,
      { ...offConfig, mode: 'test' },
      { classify }
    );
    const onRun = await filterLlmContext(
      noveltyPayload(),
      request,
      { ...offConfig, mode: 'on' },
      { classify }
    );

    // 三模式统一 Brave 序播种：s1（改写）被新颖度删除、s0 幸存——test/on 不再因
    // 当事方概率让 s1 抢先，与 off 同一结果
    const expected = ['https://origin.example/', 'https://unique.example/'];
    for (const run of [offRun, testRun, onRun]) {
      assert.deepEqual(
        run.result.grounding.generic.map((item) => item.url),
        expected
      );
    }
    // test 与 on 共用同一链：输出逐字段一致
    assert.deepEqual(testRun.result, onRun.result);
    assert.equal(testRun.stats.shadow_diff, null);
    // 三模式输出都是 Brave 序子序列（幸存者不重排）
    const inputUrls = noveltyPayload().grounding.generic.map((item) => item.url);
    for (const outputUrls of [
      offRun.result.grounding.generic.map((item) => item.url),
      testRun.result.grounding.generic.map((item) => item.url),
      onRun.result.grounding.generic.map((item) => item.url),
    ]) {
      let cursor = 0;
      for (const url of outputUrls) {
        const found = inputUrls.indexOf(url, cursor);
        assert.ok(found >= cursor, `output url ${url} breaks Brave order`);
        cursor = found + 1;
      }
    }
  });

  it('cross-source verbatim duplicate is removed as dup with its own counter in off mode', async () => {
    // 通稿转载：s1 逐字复制 s0 的长片段 → 跨源 5-gram dup（先于指纹）、独立计数；
    // 片段被 Jev 侧删除清空的来源记 'rewrite'
    const dupLong =
      'the brave model ships with a streaming api and costs $4.2m per month for scale';
    const data: BraveLlmContextResponse = {
      grounding: {
        generic: [
          { url: 'https://wire.example/', title: 'Wire', snippets: [dupLong] },
          { url: 'https://syndicated.example/', title: 'Syndicated', snippets: [dupLong] },
        ],
        map: [],
      },
      sources: {},
    };

    const { result, stats } = await filterLlmContext(data, request, offConfig);

    assert.deepEqual(
      result.grounding.generic.map((item) => item.url),
      ['https://wire.example/']
    );
    assert.equal(stats.local.cross_source_dup_removed, 1);
    assert.equal(stats.local.novelty_removed, 0);
    const syndicated = stats.sources.find((entry) => entry.url === 'https://syndicated.example/');
    assert.equal(syndicated?.verdict, 'drop');
    assert.equal(syndicated?.reason, 'rewrite');
    assert.equal(stats.local.empty_dropped, 0);
  });
});

// ---------------------------------------------------------------------------
// 批 D（02-FIX）：32k 砍尾后没砍的片段分数照常生效；score 删掉部分片段后残余
// 一句话来源在 test 与 on 链下被步 8 丢弃。
// ---------------------------------------------------------------------------

describe('score alignment after the 32k cut_tail downgrade (02-FIX batch D)', () => {
  it('removes only the scored snippet and keeps the ones cut off before sending', async () => {
    // 一个来源 5 个片段，假 classify 报 ladder cut_tail / sent_snippets 3、
    // snip0..2 分数 [2, 0, 2] → 只有第 2 个片段被删，第 4、5 个（没发出去）保留
    const data: BraveLlmContextResponse = {
      grounding: {
        generic: [
          {
            url: 'https://cut.example/',
            title: 'Cut',
            snippets: [
              'Brave alpha fact.',
              'Brave beta fact.',
              'Brave gamma fact.',
              'Brave delta fact.',
              'Brave epsilon fact.',
            ],
          },
        ],
        map: [],
      },
      sources: {},
    };
    const classify: ClassifyDeps['classify'] = async () => ({
      status: 'answered',
      model: DEFAULT_JEV_MODEL,
      answers: {
        ...Object.fromEntries(
          Object.keys(SOURCE_QUESTIONS).map((key) => [
            key,
            { kind: 'noul' as const, probability: 0 },
          ])
        ),
        snip0: { kind: 'score', score: 2 },
        snip1: { kind: 'score', score: 0 },
        snip2: { kind: 'score', score: 2 },
      },
      input_tokens: 10,
      ladder: 'cut_tail',
      sent_snippets: 3,
    });

    const { result, stats } = await filterLlmContext(
      data,
      request,
      { ...offConfig, mode: 'on' },
      {
        classify,
      }
    );

    assert.deepEqual(stats.jev?.per_source[0].snippet_scores, [2, 0, 2]);
    assert.deepEqual(
      stats.sources[0].snippets.map((row) => [row.kept, row.reason ?? null]),
      [
        [true, null],
        [false, 'score'],
        [true, null],
        [true, null],
        [true, null],
      ]
    );
    assert.equal(result.grounding.generic[0].snippets.length, 4);
  });

  it('keeps every snippet when a score in the sent range is missing', async () => {
    // sent_snippets 3 但只回了 snip0 与 snip2：中间缺一个会让位置整体错位，
    // 保守起见整源不写 snippet_scores、片段全保留
    const data: BraveLlmContextResponse = {
      grounding: {
        generic: [
          {
            url: 'https://gap.example/',
            title: 'Gap',
            snippets: ['Brave one.', 'Brave two.', 'Brave three.', 'Brave four.'],
          },
        ],
        map: [],
      },
      sources: {},
    };
    const classify: ClassifyDeps['classify'] = async () => ({
      status: 'answered',
      model: DEFAULT_JEV_MODEL,
      answers: {
        ...Object.fromEntries(
          Object.keys(SOURCE_QUESTIONS).map((key) => [
            key,
            { kind: 'noul' as const, probability: 0 },
          ])
        ),
        snip0: { kind: 'score', score: 2 },
        snip2: { kind: 'score', score: 0 },
      },
      input_tokens: 10,
      ladder: 'cut_tail',
      sent_snippets: 3,
    });

    const { stats } = await filterLlmContext(
      data,
      request,
      { ...offConfig, mode: 'on' },
      {
        classify,
      }
    );

    assert.equal(stats.jev?.per_source[0].snippet_scores, undefined);
    assert.deepEqual(
      stats.sources[0].snippets.map((row) => row.kept),
      [true, true, true, true]
    );
  });

  it('keeps every snippet when the source_only_questions level sends no scores', async () => {
    const data: BraveLlmContextResponse = {
      grounding: {
        generic: [
          { url: 'https://wide.example/', title: 'Wide', snippets: ['Brave one.', 'Brave two.'] },
        ],
        map: [],
      },
      sources: {},
    };
    const classify: ClassifyDeps['classify'] = async () => ({
      status: 'answered',
      model: DEFAULT_JEV_MODEL,
      answers: Object.fromEntries(
        Object.keys(SOURCE_QUESTIONS).map((key) => [key, { kind: 'noul' as const, probability: 0 }])
      ),
      input_tokens: 10,
      ladder: 'source_only_questions',
      // 客户端在该级别不发任何 snip 题，落实发片段数为 0
      sent_snippets: 0,
    });

    const { stats } = await filterLlmContext(
      data,
      request,
      { ...offConfig, mode: 'on' },
      {
        classify,
      }
    );

    assert.deepEqual(stats.jev?.per_source[0].snippet_scores, []);
    assert.deepEqual(
      stats.sources[0].snippets.map((row) => row.kept),
      [true, true]
    );
  });
});

describe('one-liner sources emptied by score are dropped in test mode (02-FIX batch D2)', () => {
  it('reports a source that keeps only one query-term-free snippet after scoring', async () => {
    // s1 两个片段：score 删掉含 query 实词的那条，只剩一条不含实词的短片段。
    // off 链下它照常保留（off 不看 score）；test 与 on 的链下步 8 判一句话来源丢掉。
    const data: BraveLlmContextResponse = {
      grounding: {
        generic: [
          {
            url: 'https://keep.example/',
            title: 'Keep',
            snippets: ['Brave alpha source with details.'],
          },
          {
            url: 'https://oneliner.example/',
            title: 'Oneliner',
            snippets: ['Brave beta fragment with query terms.', 'The current release timing.'],
          },
        ],
        map: [],
      },
      sources: {},
    };
    const classify: ClassifyDeps['classify'] = async ({ state }) => {
      if (!('source' in state)) return { status: 'failed', kind: 'validation' };
      const answers: Record<
        string,
        { kind: 'noul'; probability: number } | { kind: 'score'; score: number }
      > = {};
      for (const key of Object.keys(SOURCE_QUESTIONS)) {
        answers[key] = { kind: 'noul', probability: 0 };
      }
      // s1 的第一条（含实词）打 0 分被删，第二条（不含实词的短句）保留 → 一句话来源
      answers.snip0 = {
        kind: 'score',
        score: state.source.id === 's1' ? 0 : 2,
      };
      if (state.source.id === 's1') answers.snip1 = { kind: 'score', score: 2 };
      return { status: 'answered', model: DEFAULT_JEV_MODEL, answers, input_tokens: 10 };
    };

    const offRun = await filterLlmContext(data, request, offConfig);
    const testRun = await filterLlmContext(
      data,
      request,
      { ...offConfig, mode: 'test' },
      { classify }
    );
    const onRun = await filterLlmContext(data, request, { ...offConfig, mode: 'on' }, { classify });

    // off 保留 s1；test 与 on 把 s1 丢掉（score 删掉含实词片段后只剩一句话）
    assert.equal(
      offRun.result.grounding.generic.some((item) => item.url === 'https://oneliner.example/'),
      true
    );
    assert.equal(
      testRun.result.grounding.generic.some((item) => item.url === 'https://oneliner.example/'),
      false
    );
    // test 与 on 共用同一链：输出逐字段一致；新记录不再产生 would 层字段
    assert.deepEqual(testRun.result, onRun.result);
    assert.equal(testRun.stats.shadow_diff, null);
  });
});

// ---------------------------------------------------------------------------
// 四题全量上下文请求组织（FULL_CONTEXT_ROLLOUT_PLAN §8.1 T02–T09/T11）：注入式
// classify 驱动 all 分支的编排、映射、回退与记账。桩是辨识事实驱动——按收到的
// state.sources 数组位置从脚本取答案、按 `${id}__${local}` 命名空间写回，映射
// 任何一处错位（数组下标 / 来源 ID / 片段身份）都会让断言红。
// ---------------------------------------------------------------------------

describe('four-question all-context request organization (FULL_CONTEXT_ROLLOUT_PLAN T02-T09/T11)', () => {
  const allConfig: FilterConfig = {
    ...offConfig,
    mode: 'on',
    jev: { ...offConfig.jev, contextMode: 'all' },
  };

  /** 保守 keep 答案（四题 + 退役两题旧键，全部离删除阈值很远）。 */
  const SIX_KEEP: Record<string, JevAnswer> = {
    has_original_reasoning: { kind: 'noul', probability: 0.9 },
    is_template_filler: { kind: 'noul', probability: 0.1 },
    is_off_topic: { kind: 'noul', probability: 0.1 },
    is_listing: { kind: 'noul', probability: 0.1 },
    self_deprecated: { kind: 'noul', probability: 0.1 },
    stale: { kind: 'noul', probability: 0.1 },
  };

  type AllSeen = { state: JevAllState; questions: Record<string, JevQuestion> };

  /**
   * 全量桩：脚本按来源 ID 给局部答案，桩按 `${id}__${localKey}` 写回，且只回答
   * 实发题集里存在的键（不发明题目）；`extra` 无视该约束（验证未提问的额外答案
   * 不生效）。answered outcome 带实发载荷与 http_attempts（生产客户端形状）。
   */
  const allClassify =
    (
      script: Record<string, Record<string, JevAnswer>>,
      options: {
        seen?: AllSeen[];
        extra?: Record<string, JevAnswer>;
        inputTokens?: number;
        httpAttempts?: number;
      } = {}
    ): ClassifyDeps['classify'] =>
    async ({ state, questions }) => {
      if (!('sources' in state)) return { status: 'failed', kind: 'validation' };
      options.seen?.push({ state, questions });
      const answers: Record<string, JevAnswer> = { ...options.extra };
      for (const source of state.sources) {
        const local = script[source.id];
        assert.ok(local, `no scripted answers for ${source.id}`);
        for (const [localKey, answer] of Object.entries(local)) {
          const globalKey = `${source.id}__${localKey}`;
          if (questions[globalKey] !== undefined) answers[globalKey] = answer;
        }
      }
      return {
        status: 'answered',
        model: DEFAULT_JEV_MODEL,
        answers,
        input_tokens: options.inputTokens ?? 42,
        http_attempts: options.httpAttempts ?? 1,
        dispatch: { state, questions },
      };
    };

  it('zero candidates issue no request and no fallback (T02)', async () => {
    let calls = 0;
    const classify: ClassifyDeps['classify'] = async () => {
      calls += 1;
      return { status: 'failed', kind: 'validation' };
    };
    const data: BraveLlmContextResponse = {
      grounding: {
        generic: [{ url: 'https://empty.example/', title: 'Empty', snippets: [] }],
        map: [],
      },
      sources: {},
    };

    const { result, stats } = await filterLlmContext(data, request, allConfig, { classify });

    assert.equal(calls, 0);
    assert.equal(stats.jev?.status, 'ok');
    assert.equal(stats.jev?.n_requests, 0);
    assert.deepEqual(stats.jev?.requests, []);
    assert.deepEqual(result.grounding.generic, []);
  });

  it('a single candidate falls back to one single request with fallback_reason (T02)', async () => {
    const data: BraveLlmContextResponse = {
      grounding: {
        generic: [
          {
            url: 'https://solo.example/',
            title: 'Solo',
            snippets: ['Brave solo facts with detail.'],
          },
        ],
        map: [],
      },
      sources: {},
    };
    const classify: ClassifyDeps['classify'] = async ({ state, questions }) => {
      assert.ok('source' in state);
      return {
        status: 'answered',
        model: DEFAULT_JEV_MODEL,
        answers: { ...SIX_KEEP, snip0: { kind: 'score', score: 2 } },
        input_tokens: 10,
        dispatch: { state, questions },
      };
    };

    // 映射在完整请求记录里（stats.jev.requests 是瘦身摘要，无 mapping / state）
    const { stats, jev_requests } = await filterLlmContext(data, request, allConfig, { classify });

    const requests = jev_requests;
    assert.equal(requests.length, 1);
    const record = requests[0];
    assert.equal(record?.mode, 'single');
    assert.equal(record?.requested, 'all');
    assert.equal(record?.effective, 'single');
    assert.equal(record?.fallback_reason, 'single_candidate');
    assert.deepEqual(record?.source_ids, ['s0']);
    assert.equal(stats.jev?.n_requests, 1);
    // single 的映射是恒等：局部键即请求级键
    assert.equal(record?.mapping[0]?.question_keys['is_off_topic'], 'is_off_topic');
    assert.equal((stats.jev?.per_source ?? [])[0]?.status, 'answered');
  });

  it('multiple candidates share exactly one all request in Brave order (T02/T03)', async () => {
    const seen: AllSeen[] = [];
    // 请求级完整记录（含 mapping）在 jev_requests；stats.jev.requests 是瘦身摘要
    const { result, stats, jev_requests } = await filterLlmContext(payload(), request, allConfig, {
      classify: allClassify(
        {
          s0: {
            ...SIX_KEEP,
            snip0: { kind: 'score', score: 2 },
            snip1: { kind: 'score', score: 2 },
          },
          s1: { ...SIX_KEEP, snip0: { kind: 'score', score: 2 } },
        },
        { seen }
      ),
    });

    // 恰好一次逻辑请求：全量 state 是 Brave 原序候选、来源 ID 不重编号
    assert.equal(seen.length, 1);
    const state = seen[0]?.state;
    assert.deepEqual(
      state?.sources.map((source) => [source.id, source.url]),
      [
        ['s0', 'https://search.brave.com/'],
        ['s1', 'https://example.com/post'],
      ]
    );
    assert.equal(state?.query, 'brave browser');
    assert.equal(state?.intent, 'What Brave Search is');
    assert.deepEqual(state?.sources[0]?.snippets, [
      'Brave is a privacy-focused browser and search engine.',
      'Second snippet about Brave.',
    ]);
    // 题键命名空间：`${id}__${local}`，s0 六道、s1 五道（四题 + 各自片段的 score 题）
    const questions = seen[0]?.questions ?? {};
    assert.equal(Object.keys(questions).length, 11);
    assert.ok(questions['s0__snip0'] !== undefined && questions['s0__snip1'] !== undefined);
    assert.ok(questions['s1__snip0'] !== undefined);
    // 题干数组下标按数组位置命名空间化（s1 引用 sources[1]，不是 sources[0]）
    assert.match(questions['s0__snip0']?.instructions ?? '', /`sources\[0\]\.snippets\[0\]`/);
    assert.match(questions['s1__snip0']?.instructions ?? '', /`sources\[1\]\.snippets\[0\]`/);

    const jev = stats.jev;
    assert.equal(jev?.n_requests, 1);
    assert.equal(jev?.n_http_attempts, 1);
    assert.equal(jev?.status, 'ok');
    const record = jev_requests[0];
    assert.equal(record?.mode, 'all');
    assert.equal(record?.requested, 'all');
    assert.equal(record?.effective, 'all');
    assert.equal(record?.fallback_reason, undefined);
    assert.deepEqual(record?.source_ids, ['s0', 's1']);
    assert.equal(record?.dispatched, true);
    assert.equal(record?.usage_complete, true);
    assert.ok((record?.planned_estimates?.single_limit_estimate ?? Infinity) <= ALL_LIMIT_32K);
    assert.ok((record?.planned_estimates?.total_limit_estimate ?? Infinity) <= ALL_LIMIT_64K);
    // 显式映射：数组位置、来源 ID、片段身份三者对齐
    const mapping = record?.mapping ?? [];
    assert.equal(mapping.length, 2);
    assert.equal(mapping[0]?.source_id, 's0');
    assert.equal(mapping[0]?.array_index, 0);
    assert.deepEqual(mapping[0]?.snippet_keys, ['0', '1']);
    assert.equal(mapping[0]?.question_keys['snip1'], 's0__snip1');
    assert.equal(Object.keys(mapping[0]?.question_keys ?? {}).length, 6);
    assert.equal(mapping[1]?.source_id, 's1');
    assert.equal(mapping[1]?.array_index, 1);
    assert.deepEqual(mapping[1]?.snippet_keys, ['0']);
    assert.equal(mapping[1]?.question_keys['snip0'], 's1__snip0');
    assert.equal(Object.keys(mapping[1]?.question_keys ?? {}).length, 5);
    // 两来源行都 answered、指向同一请求；投影答案按映射回流
    assert.deepEqual(
      (jev?.per_source ?? []).map((row) => [row.src, row.status, row.request_id]),
      [
        ['s0', 'answered', 'j1'],
        ['s1', 'answered', 'j1'],
      ]
    );
    assert.deepEqual((jev?.per_source ?? [])[0]?.snippet_scores, [2, 2]);
    assert.deepEqual((jev?.per_source ?? [])[1]?.snippet_scores, [2]);
    // 输出保持 Brave 原序、内容无删
    assert.deepEqual(
      result.grounding.generic.map((item) => item.url),
      ['https://search.brave.com/', 'https://example.com/post']
    );
  });

  it('keeps gapped IDs and Brave order when an earlier source is locally dropped (T03)', async () => {
    const seen: AllSeen[] = [];
    // s0 的片段是纯空白 → 步 3 空片段删除清空来源、来源出局（短无实词预筛已随
    // filter-rules-13 退役，空片段删除保留），候选从 s1 开始——数组位置 0 ≠ ID 数字 1
    const data: BraveLlmContextResponse = {
      grounding: {
        generic: [
          {
            url: 'https://noise.example/',
            title: 'Noise',
            snippets: ['   '],
          },
          {
            url: 'https://alpha.example/',
            title: 'Alpha',
            snippets: ['Brave alpha facts with detail.'],
          },
          {
            url: 'https://beta.example/',
            title: 'Beta',
            snippets: ['Brave beta facts with detail.'],
          },
        ],
        map: [],
      },
      sources: {},
    };

    const { result, stats, jev_requests } = await filterLlmContext(data, request, allConfig, {
      classify: allClassify(
        {
          s1: { ...SIX_KEEP, snip0: { kind: 'score', score: 2 } },
          s2: { ...SIX_KEEP, snip0: { kind: 'score', score: 0 } },
        },
        { seen }
      ),
    });

    const state = seen[0]?.state;
    assert.deepEqual(
      state?.sources.map((source) => source.id),
      ['s1', 's2']
    );
    assert.equal(state?.sources[0]?.url, 'https://alpha.example/');
    const record = jev_requests[0];
    assert.deepEqual(record?.source_ids, ['s1', 's2']);
    assert.deepEqual(
      (record?.mapping ?? []).map((entry) => [entry.source_id, entry.array_index]),
      [
        ['s1', 0],
        ['s2', 1],
      ]
    );
    assert.ok((seen[0]?.questions ?? {})['s1__snip0'] !== undefined);
    assert.ok((seen[0]?.questions ?? {})['s2__snip0'] !== undefined);
    // s2 的 0 分片段删光来源，s1 幸存；输出仍是 Brave 原序子序列
    assert.deepEqual(
      result.grounding.generic.map((item) => item.url),
      ['https://alpha.example/']
    );
  });

  it('ignores extra answers for questions that were never asked (T04)', async () => {
    // 桩塞回未提问的答案：退役来源题旧键（stale / self_deprecated，filter-rules-11
    // 退役）与退役片段时间题键（time_snip，filter-rules-12 退役），全部给高概率——
    // 若被消费，来源级会触发删除、时间键会进 answers。映射里没有这些题，投影必须
    // 一概不消费：一条用例守住两轮退役机制的负空间。
    const { result, stats } = await filterLlmContext(payload(), request, allConfig, {
      classify: allClassify(
        {
          s0: {
            ...SIX_KEEP,
            snip0: { kind: 'score', score: 2 },
            snip1: { kind: 'score', score: 2 },
          },
          s1: { ...SIX_KEEP, snip0: { kind: 'score', score: 2 } },
        },
        {
          extra: {
            s0__stale: { kind: 'noul', probability: 0.99 },
            s0__self_deprecated: { kind: 'noul', probability: 0.99 },
            s1__stale: { kind: 'noul', probability: 0.99 },
            s0__time_snip0: { kind: 'noul', probability: 0.9 },
            s1__time_snip0: { kind: 'noul', probability: 0.9 },
          },
        }
      ),
    });

    assert.deepEqual(
      result.grounding.generic.map((item) => item.url),
      ['https://search.brave.com/', 'https://example.com/post']
    );
    for (const row of stats.jev?.per_source ?? []) {
      assert.equal(row.answers?.['stale'], undefined);
      assert.equal(row.answers?.['self_deprecated'], undefined);
      assert.equal(row.answers?.['time_snip0'], undefined);
    }
  });

  it('missing answers never poison a source or shift its neighbors (T05)', async () => {
    // s0：缺 is_off_topic（来源题缺答）且 snip1 缺答（中间缺位）；s1：完整且 snip0 打 0
    const { result, stats } = await filterLlmContext(payload(), request, allConfig, {
      classify: allClassify({
        s0: {
          has_original_reasoning: { kind: 'noul', probability: 0.9 },
          is_template_filler: { kind: 'noul', probability: 0.1 },
          is_listing: { kind: 'noul', probability: 0.1 },
          self_deprecated: { kind: 'noul', probability: 0.1 },
          stale: { kind: 'noul', probability: 0.1 },
          snip0: { kind: 'score', score: 2 },
        },
        s1: { ...SIX_KEEP, snip0: { kind: 'score', score: 0 } },
      }),
    });

    const rows = stats.jev?.per_source ?? [];
    const s0 = rows.find((row) => row.src === 's0');
    const s1 = rows.find((row) => row.src === 's1');
    // 缺中间 score 位：整组分数不产出（无左移错位），片段全保留
    assert.equal(s0?.snippet_scores, undefined);
    assert.deepEqual(
      stats.sources
        .find((entry) => entry.url === 'https://search.brave.com/')
        ?.snippets.map((snippet) => snippet.kept),
      [true, true]
    );
    // 缺答来源题不进答案表（保守防御，不冒充 0）
    assert.equal(s0?.answers?.['is_off_topic'], undefined);
    assert.equal(s1?.answers?.['is_off_topic'], 0.1);
    // s1 完整：0 分片段删光来源
    assert.deepEqual(s1?.snippet_scores, [0]);
    assert.deepEqual(
      result.grounding.generic.map((item) => item.url),
      ['https://search.brave.com/']
    );
  });

  it('an over-budget plan skips the all request entirely and falls back to single (T06)', async () => {
    // 每片段 2 万个 6 字符词 ≈ 4 万 token，两来源合计远超 64k/1.15——规划层
    // 预检不通过，绝不构造可发全量请求，整批回退 single
    const filler = (marker: string): string =>
      `Brave ${marker} ${Array.from({ length: 20000 }, (_, i) => `${marker}${String(i).padStart(5, '0')}`).join(' ')}`;
    const data: BraveLlmContextResponse = {
      grounding: {
        generic: [
          { url: 'https://huge-a.example/', title: 'A', snippets: [filler('a')] },
          { url: 'https://huge-b.example/', title: 'B', snippets: [filler('b')] },
        ],
        map: [],
      },
      sources: {},
    };
    let allCalls = 0;
    const singleIds: string[] = [];
    const classify: ClassifyDeps['classify'] = async ({ state, questions }) => {
      if ('sources' in state) {
        allCalls += 1;
        return { status: 'failed', kind: 'validation' };
      }
      singleIds.push(state.source.id);
      return {
        status: 'answered',
        model: DEFAULT_JEV_MODEL,
        answers: { ...SIX_KEEP, snip0: { kind: 'score', score: 2 } },
        input_tokens: 10,
        dispatch: { state, questions },
      };
    };

    const { stats } = await filterLlmContext(data, request, allConfig, { classify });

    // 零全量 HTTP；single 回退按 Brave 原序处理同一批冻结候选
    assert.equal(allCalls, 0);
    assert.deepEqual(singleIds, ['s0', 's1']);
    const requests = stats.jev?.requests ?? [];
    assert.equal(requests.length, 2);
    for (const record of requests) {
      assert.equal(record.mode, 'single');
      assert.equal(record.requested, 'all');
      assert.equal(record.effective, 'single');
      assert.equal(record.fallback_reason, 'over_budget');
    }
    assert.equal(stats.jev?.n_requests, 2);
  });

  it('a client-side too_large rejection falls back to single once for the same batch (T06)', async () => {
    let calls = 0;
    const singleIds: string[] = [];
    const classify: ClassifyDeps['classify'] = async ({ state, questions }) => {
      calls += 1;
      if (calls === 1) {
        // 规划层已预检通过，客户端防御仍在派发前拒绝（双保险路径）
        assert.ok('sources' in state);
        return { status: 'failed', kind: 'too_large', http_attempts: 0 };
      }
      assert.ok('source' in state);
      singleIds.push(state.source.id);
      return {
        status: 'answered',
        model: DEFAULT_JEV_MODEL,
        answers: { ...SIX_KEEP, snip0: { kind: 'score', score: 2 } },
        input_tokens: 10,
        dispatch: { state, questions },
      };
    };

    const { stats } = await filterLlmContext(payload(), request, allConfig, { classify });

    assert.equal(calls, 3);
    assert.deepEqual(singleIds, ['s0', 's1']); // 同一批冻结候选，Brave 原序
    const requests = stats.jev?.requests ?? [];
    assert.equal(requests.length, 3);
    const allRecord = requests[0];
    assert.equal(allRecord?.mode, 'all');
    assert.equal(allRecord?.dispatched, false);
    assert.equal(allRecord?.fail_kind, 'too_large');
    assert.equal(allRecord?.usage_complete, false);
    // 未派发的拒绝不计逻辑请求
    assert.equal(stats.jev?.n_requests, 2);
    for (const record of requests.slice(1)) {
      assert.equal(record?.mode, 'single');
      assert.equal(record?.requested, 'all');
      assert.equal(record?.effective, 'single');
      assert.equal(record?.fallback_reason, 'client_too_large');
    }
    assert.ok((stats.jev?.per_source ?? []).every((row) => row.status === 'answered'));
  });

  it('a dispatched all-request failure is never fanned out into singles (T07)', async () => {
    let calls = 0;
    const classify: ClassifyDeps['classify'] = async ({ state, questions }) => {
      calls += 1;
      assert.ok('sources' in state);
      return {
        status: 'failed',
        kind: 'network',
        detail: 'connection reset',
        dispatch: { state, questions },
        http_attempts: 3,
      };
    };

    const { result, stats } = await filterLlmContext(payload(), request, allConfig, { classify });

    // 绝不放大成 N 个 single；一次已派发失败记一次逻辑请求，HTTP 尝试如实累加
    assert.equal(calls, 1);
    assert.equal(stats.jev?.status, 'degraded');
    assert.equal(stats.jev?.n_requests, 1);
    assert.equal(stats.jev?.n_http_attempts, 3);
    const record = (stats.jev?.requests ?? [])[0];
    assert.equal(record?.dispatched, true);
    assert.equal(record?.fail_kind, 'network');
    assert.equal(record?.http_attempts, 3);
    assert.equal(record?.usage_complete, false);
    assert.equal(record?.input_tokens, null);
    assert.deepEqual(
      (stats.jev?.per_source ?? []).map((row) => [row.src, row.status, row.fail_kind]),
      [
        ['s0', 'failed', 'network'],
        ['s1', 'failed', 'network'],
      ]
    );
    // 失败来源全部按留（SAFE-01）
    assert.deepEqual(
      result.grounding.generic.map((item) => item.url),
      ['https://search.brave.com/', 'https://example.com/post']
    );
  });

  it('a breaker short-circuit issues zero HTTP and never falls back (T07)', async () => {
    let calls = 0;
    const classify: ClassifyDeps['classify'] = async ({ state }) => {
      calls += 1;
      assert.ok('sources' in state);
      return { status: 'failed', kind: 'breaker_open', detail: 'circuit open', http_attempts: 0 };
    };

    const { stats } = await filterLlmContext(payload(), request, allConfig, { classify });

    assert.equal(calls, 1);
    assert.equal(stats.jev?.status, 'breaker_open');
    assert.equal(stats.jev?.n_requests, 0);
    assert.equal(stats.jev?.n_http_attempts, 0);
    const record = (stats.jev?.requests ?? [])[0];
    assert.equal(record?.dispatched, false);
    assert.equal(record?.fail_kind, 'breaker_open');
    assert.equal(record?.http_attempts, 0);
    assert.deepEqual(
      (stats.jev?.per_source ?? []).map((row) => row.status),
      ['breaker_open', 'breaker_open']
    );
  });

  it('counts usage once per logical request and keeps HTTP attempts separate (T09)', async () => {
    const { stats } = await filterLlmContext(payload(), request, allConfig, {
      classify: allClassify(
        {
          s0: {
            ...SIX_KEEP,
            snip0: { kind: 'score', score: 2 },
            snip1: { kind: 'score', score: 2 },
          },
          s1: { ...SIX_KEEP, snip0: { kind: 'score', score: 2 } },
        },
        { inputTokens: 100, httpAttempts: 2 }
      ),
    });

    // 一次逻辑请求（重试后成功）：usage 只计一次；HTTP 尝试单列不混入请求数
    assert.equal(stats.jev?.n_requests, 1);
    assert.equal(stats.jev?.n_http_attempts, 2);
    assert.equal(stats.jev?.input_tokens, 100);
    const record = (stats.jev?.requests ?? [])[0];
    assert.equal(record?.input_tokens, 100);
    assert.equal(record?.http_attempts, 2);
    assert.equal(record?.usage_complete, true);
    // 全量来源行不复制请求级 token/耗时——经 request_id 关联（计划 §6.1）
    for (const row of stats.jev?.per_source ?? []) {
      assert.equal(row.input_tokens, undefined);
      assert.equal(row.latency_ms, undefined);
      assert.equal(row.model, DEFAULT_JEV_MODEL);
      assert.equal(row.request_id, 'j1');
    }
  });

  it('test and on share one chain and one all request under fixed answers (T11)', async () => {
    const script: Record<string, Record<string, JevAnswer>> = {
      s0: { ...SIX_KEEP, snip0: { kind: 'score', score: 2 }, snip1: { kind: 'score', score: 0 } },
      s1: { ...SIX_KEEP, snip0: { kind: 'score', score: 2 } },
    };

    const testRun = await filterLlmContext(
      payload(),
      request,
      { ...allConfig, mode: 'test' },
      {
        classify: allClassify(script),
      }
    );
    const onRun = await filterLlmContext(payload(), request, allConfig, {
      classify: allClassify(script),
    });

    // 同一过滤实现：最终正文与裁决逐字段一致，仅样本保存等模式职责不同
    assert.deepEqual(testRun.result, onRun.result);
    assert.deepEqual(testRun.stats.sources, onRun.stats.sources);
    assert.deepEqual(testRun.stats.local, onRun.stats.local);
    assert.equal(testRun.stats.shadow_diff, null);
    assert.equal(onRun.stats.shadow_diff, null);
    assert.deepEqual(
      onRun.result.grounding.generic.map((item) => [item.url, item.snippets.length]),
      [
        ['https://search.brave.com/', 1],
        ['https://example.com/post', 1],
      ]
    );
  });
});

// ---------------------------------------------------------------------------
// 步 3 GitHub 平台界面清洗（filter-rules-9）：test/on 在 Jev 派发前清洗且最终返回
// 同步干净（Jev 输入与最终输出同一份清洗后文本）；off 不应用本次清洗；动作明细
// 进统计表（github_cleanup_actions 计数 + 逐片段 github_cleanup）。
// ---------------------------------------------------------------------------

describe('step-3 GitHub UI cleanup (filter-rules-9)', () => {
  const ghPayload = (): BraveLlmContextResponse => ({
    grounding: {
      generic: [
        {
          url: 'https://github.com/lotillc/redlib-loti',
          title: 'redlib-loti',
          snippets: [
            '## Repository files navigation\n# Saved searches\n# Search code, repositories, users, issues, pull requests...\n\n# Provide feedback\n\nPrivate front-end for Reddit, a brave browser project.',
          ],
        },
        {
          url: 'https://github.com/HexRaysSA/ida-mcp/pull/8',
          title: 'ida-mcp PR 8',
          snippets: [
            'migrate-mcp HexRaysSA/ida-mcp:migrate-mcp Copy head branch name to clipboard\nBrave browser patch discussion.',
          ],
        },
        {
          url: 'https://example.com/post',
          title: 'Example Post',
          snippets: ['Example snippet about brave.'],
        },
      ],
      map: [],
    },
    sources: {},
  });

  /** 捕获实收 state 的全保留 classify（来源级全 0、片段分满分——只裁 keep）。 */
  const capturingClassify =
    (captured: JevState[]): ClassifyDeps['classify'] =>
    async ({ state }) => {
      captured.push(JSON.parse(JSON.stringify(state)) as JevState);
      return {
        status: 'answered',
        model: DEFAULT_JEV_MODEL,
        answers: {
          has_original_reasoning: { kind: 'noul', probability: 0 },
          is_template_filler: { kind: 'noul', probability: 0 },
          is_off_topic: { kind: 'noul', probability: 0 },
          is_listing: { kind: 'noul', probability: 0 },
          self_deprecated: { kind: 'noul', probability: 0 },
          stale: { kind: 'noul', probability: 0 },
          snip0: { kind: 'score', score: 2 },
        },
        input_tokens: 10,
      };
    };

  const stateOf = (captured: JevState[], id: string): JevState => {
    const found = captured.find((state) => 'source' in state && state.source.id === id);
    assert.ok(found, `state ${id} captured`);
    return found;
  };

  it('test/on: UI lines are stripped before classify, body kept; final output shares the cleaned text', async () => {
    // test 与 on 共用同一清洗实现与接入位置，两种模式都用假 Jev 客户端真实跑通
    for (const mode of ['test', 'on'] as const) {
      const captured: JevState[] = [];
      const { result, stats } = await filterLlmContext(
        ghPayload(),
        request,
        { ...offConfig, mode },
        {
          classify: capturingClassify(captured),
        }
      );

      // Jev 输入（实收 state）：界面行已清掉、正文还在、按钮后缀已剥
      const repoState = stateOf(captured, 's0');
      assert.ok('source' in repoState);
      assert.deepEqual(repoState.source.snippets, [
        'Private front-end for Reddit, a brave browser project.',
      ]);
      const prState = stateOf(captured, 's1');
      assert.ok('source' in prState);
      assert.deepEqual(prState.source.snippets, [
        'migrate-mcp HexRaysSA/ida-mcp:migrate-mcp\nBrave browser patch discussion.',
      ]);

      // 最终实际返回与 Jev 输入同一份清洗后文本（同步干净）
      assert.deepEqual(
        result.grounding.generic.map((item) => [item.url, item.snippets]),
        [
          [
            'https://github.com/lotillc/redlib-loti',
            ['Private front-end for Reddit, a brave browser project.'],
          ],
          [
            'https://github.com/HexRaysSA/ida-mcp/pull/8',
            ['migrate-mcp HexRaysSA/ida-mcp:migrate-mcp\nBrave browser patch discussion.'],
          ],
          ['https://example.com/post', ['Example snippet about brave.']],
        ]
      );

      // 计数与逐片段动作（4 = repo_nav + search_block×3；1 = copy_branch_button）
      assert.equal(stats.local.github_cleanup_actions, 5);
      const repoRow = stats.sources[0].snippets[0];
      assert.deepEqual(repoRow.github_cleanup, [
        { rule: 'repo_nav', line: 1 },
        { rule: 'search_block', line: 2 },
        { rule: 'search_block', line: 3 },
        { rule: 'search_block', line: 5 },
      ]);
      assert.equal(repoRow.chars, 'Private front-end for Reddit, a brave browser project.'.length);
      assert.deepEqual(stats.sources[1].snippets[0].github_cleanup, [
        { rule: 'copy_branch_button', line: 1, partial: true },
      ]);
      // 非 GitHub 来源无动作键
      assert.equal(stats.sources[2].snippets[0].github_cleanup, undefined);
    }
  });

  it('off: cleanup is not applied — GitHub UI lines stay verbatim, no action accounting', async () => {
    const captured: JevState[] = [];
    const { result, stats } = await filterLlmContext(ghPayload(), request, offConfig, {
      classify: capturingClassify(captured),
    });

    assert.equal(stats.local.github_cleanup_actions, 0);
    assert.equal(stats.sources[0].snippets[0].github_cleanup, undefined);
    // 界面行逐字保留（off 连 Jev 也不跑，但本地样板剥离照旧——通用前缀表无这些行）
    assert.ok(
      result.grounding.generic[0].snippets[0]?.startsWith('## Repository files navigation')
    );
    assert.ok(result.grounding.generic[0].snippets[0]?.includes('# Saved searches'));
    const prSnippet = result.grounding.generic[1].snippets[0] ?? '';
    assert.ok(prSnippet.includes('Copy head branch name to clipboard'));
    assert.deepEqual(captured, []); // off 不派发
  });

  it('no_key (test/on without classify) still cleans: same config semantics as test/on', async () => {
    // 两种模式的无 key 路径都走同一本地规则链，清洗照常应用
    for (const mode of ['test', 'on'] as const) {
      const { result, stats } = await filterLlmContext(ghPayload(), request, {
        ...offConfig,
        mode,
      });

      assert.equal(stats.jev?.status, 'no_key');
      assert.equal(stats.local.github_cleanup_actions, 5);
      assert.deepEqual(result.grounding.generic[0].snippets, [
        'Private front-end for Reddit, a brave browser project.',
      ]);
    }
  });
});

// ---------------------------------------------------------------------------
// 时间上下文端到端（TEMPORAL_CONTEXT_SCORING_ROLLOUT_PLAN §7.1–7.6）：开关关闭精
// 确恢复旧请求形态（完整功能回退）；开关开启时 all / single / 回退三条路径的
// state 时间字段与题目分支、归并冲突置 null、非法检索时间省略。
// ---------------------------------------------------------------------------

describe('temporal context rollout (TEMPORAL_CONTEXT_SCORING_ROLLOUT_PLAN)', () => {
  const RETRIEVAL = '2026-10-02T04:26:27.787+08:00';
  const temporalAllConfig: FilterConfig = {
    ...offConfig,
    mode: 'on',
    jev: { ...offConfig.jev, contextMode: 'all', temporalContext: true },
  };
  const temporalSingleConfig: FilterConfig = {
    ...offConfig,
    mode: 'on',
    jev: { ...offConfig.jev, contextMode: 'single', temporalContext: true },
  };

  const seen: Array<{ state: JevState; questions: Record<string, JevQuestion> }> = [];
  const keepClassify: ClassifyDeps['classify'] = async ({ state, questions }) => {
    seen.push({ state, questions });
    const answers: Record<string, JevAnswer> = {};
    for (const key of Object.keys(questions)) {
      answers[key] = key.includes('snip')
        ? { kind: 'score', score: 2 }
        : { kind: 'noul', probability: 0.1 };
    }
    return {
      status: 'answered',
      model: DEFAULT_JEV_MODEL,
      answers,
      input_tokens: 42,
      dispatch: { state, questions },
    };
  };

  it('off 即使开启时间上下文也不请求 Jev；关闭开关的 all 不携带日期且恢复旧题', async () => {
    seen.length = 0;
    await filterLlmContext(
      payload(),
      { ...request, retrievalTime: RETRIEVAL },
      { ...temporalAllConfig, mode: 'off' },
      { classify: keepClassify }
    );
    assert.equal(seen.length, 0);
    await filterLlmContext(
      payload(),
      { ...request, retrievalTime: RETRIEVAL },
      {
        ...temporalAllConfig,
        jev: { ...temporalAllConfig.jev, temporalContext: false },
      },
      { classify: keepClassify }
    );
    assert.equal(seen.length, 1);
    assert.ok('sources' in seen[0].state);
    assert.equal('retrieval_time' in seen[0].state, false);
    assert.ok(seen[0].state.sources.every((source) => !('brave_page_date' in source)));
    assert.match(seen[0].questions.s0__snip0.instructions, /^Judge only/);
    assert.deepEqual(seen[0].questions.s0__snip0.criteria, SNIPPET_LEVELS);
  });

  it('完整新题触发 64k 预算回退，所有 single 沿用同一时间和旧题', async () => {
    // 旧题能放下，新题的三百个完整长题超出总限额；正文很短，不触发 32k。
    const data = payload();
    data.grounding.generic[0].snippets = Array.from(
      { length: 150 },
      (_, i) => `Brave parameter A${i} is ${i}.`
    );
    data.grounding.generic[1].snippets = Array.from(
      { length: 150 },
      (_, i) => `Browser constraint B${i} requires ${i}.`
    );
    seen.length = 0;
    await filterLlmContext(
      data,
      request,
      {
        ...temporalAllConfig,
        jev: { ...temporalAllConfig.jev, temporalContext: false },
      },
      { classify: keepClassify }
    );
    assert.equal(seen.length, 1);
    assert.ok('sources' in seen[0].state);
    seen.length = 0;
    const filtered = await filterLlmContext(
      data,
      { ...request, retrievalTime: RETRIEVAL },
      temporalAllConfig,
      { classify: keepClassify }
    );
    assert.equal(seen.length, 2);
    for (const { state, questions } of seen) {
      assert.ok('source' in state);
      assert.equal(state.retrieval_time, RETRIEVAL);
      assert.ok('brave_page_date' in state.source);
      assert.match(questions.snip0.instructions, /^Judge only/);
      assert.ok(Object.values(questions).every((q) => !q.instructions.includes('`sources')));
    }
    assert.ok(
      filtered.jev_requests.every(
        (r) => r.effective === 'single' && r.fallback_reason === 'over_budget'
      )
    );
  });

  it('过滤后非连续 ID、JSON-LD 拆分及归并片段保留原身份和日期归属', async () => {
    const article =
      'Brave browser uses independent indexing and provides detailed technical measurements.';
    const answer =
      'Rendering performance depends on cache capacity, CPU scheduling and transport latency.';
    const merged =
      'A separate experiment measures memory allocation under concurrent browser requests.';
    const other =
      'Privacy guarantees require disabling optional telemetry and reviewing the network settings.';
    const data: BraveLlmContextResponse = {
      grounding: {
        generic: [
          { url: 'https://empty.example/', title: 'Empty', snippets: [''] },
          {
            url: 'https://a.example/post',
            title: 'A',
            snippets: [
              JSON.stringify({
                articleBody: article,
                mainEntity: [{ acceptedAnswer: { text: answer } }],
              }),
            ],
          },
          { url: 'https://b.example/post', title: 'B', snippets: [other] },
          { url: 'https://www.a.example/post', title: 'A mirror', snippets: [merged] },
        ],
      },
      sources: {
        'https://empty.example/': { age: ['1999-01-01'] },
        'https://a.example/post': { age: ['2026-10-01'] },
        'https://b.example/post': { age: ['2024-02-29'] },
        'https://www.a.example/post': { age: ['2026-09-01'] },
      },
    };
    const before = structuredClone(data);
    seen.length = 0;
    const filtered = await filterLlmContext(
      data,
      { ...request, retrievalTime: RETRIEVAL },
      temporalAllConfig,
      { classify: keepClassify }
    );
    assert.equal(seen.length, 1);
    assert.ok('sources' in seen[0].state);
    assert.deepEqual(
      seen[0].state.sources.map((s) => [s.id, s.brave_page_date]),
      [
        ['s1', null],
        ['s2', '2024-02-29'],
      ]
    );
    assert.deepEqual(seen[0].state.sources[0].snippets, [article, `A: ${answer}`, merged]);
    assert.deepEqual(filtered.jev_requests[0].mapping[0].snippet_keys, ['0.0', '0.1', '3:0']);
    assert.match(
      seen[0].questions.s1__snip2.instructions,
      /^How useful is `sources\[0\].snippets\[2\]`/
    );
    assert.match(
      seen[0].questions.s2__snip0.instructions,
      /^How useful is `sources\[1\].snippets\[0\]`/
    );
    assert.deepEqual(data, before, '日期接入不改原正文或元数据');
    const onSources = filtered.stats.sources;
    const test = await filterLlmContext(
      data,
      { ...request, retrievalTime: RETRIEVAL },
      { ...temporalAllConfig, mode: 'test' },
      { classify: keepClassify }
    );
    assert.deepEqual(test.result, filtered.result);
    assert.deepEqual(test.stats.sources, onSources);
  });

  it('switch off: the classify payload keeps the exact legacy shape (no time fields, old questions)', async () => {
    seen.length = 0;
    await filterLlmContext(
      payload(),
      { ...request, retrievalTime: RETRIEVAL },
      { ...offConfig, mode: 'on' },
      {
        classify: keepClassify,
      }
    );
    assert.equal(seen.length, 2, 'single 模式两来源各一次请求');
    for (const { state, questions } of seen) {
      assert.ok('source' in state);
      assert.equal('retrieval_time' in state, false);
      assert.equal('brave_page_date' in state.source, false);
      // 旧 score 题干（总指令前缀 + source.snippets[i]）
      const snip = questions['snip0'];
      assert.ok(snip);
      assert.match(
        snip.instructions,
        /Judge only the observable text of `source`.* How useful is `source\.snippets\[0\]` for `intent`\?$/
      );
      assert.deepEqual(snip.criteria, SNIPPET_LEVELS);
    }
  });

  it('switch on + all: state carries retrieval_time and per-source brave_page_date; snip questions are the frozen temporal ones', async () => {
    seen.length = 0;
    const { result } = await filterLlmContext(
      payload(),
      { ...request, retrievalTime: RETRIEVAL },
      temporalAllConfig,
      { classify: keepClassify }
    );
    assert.equal(seen.length, 1, 'all 模式一次共享请求');
    const { state, questions } = seen[0] as {
      state: JevAllState;
      questions: Record<string, JevQuestion>;
    };
    assert.equal(state.retrieval_time, RETRIEVAL);
    assert.equal(
      state.sources[0]?.brave_page_date,
      '2026-09-16T00:00:00',
      '合法绝对时间优先于纯日期'
    );
    assert.equal(state.sources[1]?.brave_page_date, null, 'age 为空数组 → null，键恒在');

    // snip 题走冻结新题（s0 在数组位置 0），来源题保持总指令前缀的旧转换
    const snip = questions['s0__snip0'];
    assert.ok(snip);
    assert.equal(snip.type, 'score');
    assert.ok(
      snip.instructions.startsWith('How useful is `sources[0].snippets[0]` for answering `intent`?')
    );
    assert.ok(snip.instructions.includes("A source's `brave_page_date`"));
    const sourceQuestion = questions['s0__is_off_topic'];
    assert.ok(sourceQuestion);
    assert.ok(
      sourceQuestion.instructions.startsWith('Judge only the observable text of `sources[0]`.')
    );

    // 幸存内容与裁决照旧：全 keep 输出 Brave 原序两来源
    assert.equal(result.grounding.generic.length, 2);
  });

  it('switch on + single: state carries time fields but the score questions stay the legacy template', async () => {
    seen.length = 0;
    await filterLlmContext(
      payload(),
      { ...request, retrievalTime: RETRIEVAL },
      temporalSingleConfig,
      { classify: keepClassify }
    );
    assert.equal(seen.length, 2);
    for (const { state, questions } of seen) {
      assert.ok('source' in state);
      assert.equal('retrieval_time' in state, true);
      assert.equal(state.retrieval_time, RETRIEVAL);
      assert.equal('brave_page_date' in state.source, true);
      // single 沿用旧评分题：题干引用 source.snippets[i]，绝不指向不存在的 sources
      const snip = questions['snip0'];
      assert.ok(snip);
      assert.match(snip.instructions, /How useful is `source\.snippets\[0\]` for `intent`\?$/);
      assert.equal(questions['s0__snip0'], undefined);
      assert.deepEqual(snip.criteria, SNIPPET_LEVELS);
    }
  });

  it('invalid retrieval time is omitted from the state while page dates remain', async () => {
    seen.length = 0;
    await filterLlmContext(
      payload(),
      { ...request, retrievalTime: 'not a date' },
      temporalAllConfig,
      {
        classify: keepClassify,
      }
    );
    assert.equal(seen.length, 1);
    const { state } = seen[0] as { state: JevAllState };
    assert.equal('retrieval_time' in state, false, '非法值省略，绝不取系统时间冒充');
    assert.equal(state.sources[0]?.brave_page_date, '2026-09-16T00:00:00');
  });

  it('all-fallback to single (single candidate) keeps the time anchors with legacy questions', async () => {
    seen.length = 0;
    const singleSource: BraveLlmContextResponse = {
      grounding: {
        generic: [
          {
            url: 'https://search.brave.com/',
            title: 'Brave Search',
            snippets: ['Brave is a privacy-focused browser and search engine.'],
          },
        ],
        map: [],
      },
      sources: {
        'https://search.brave.com/': {
          title: 'Brave Search',
          hostname: 'search.brave.com',
          age: ['2026-09-16'],
        },
      },
    };
    const { stats } = await filterLlmContext(
      singleSource,
      { ...request, retrievalTime: RETRIEVAL },
      temporalAllConfig,
      { classify: keepClassify }
    );
    assert.equal(seen.length, 1);
    assert.ok('source' in seen[0].state, 'single_candidate 回退走 single 形状');
    assert.equal(seen[0].state.retrieval_time, RETRIEVAL);
    assert.equal(seen[0].state.source.brave_page_date, '2026-09-16');
    assert.match(
      seen[0].questions['snip0']?.instructions ?? '',
      /How useful is `source\.snippets\[0\]` for `intent`\?$/
    );
    assert.equal(stats.jev?.requests[0]?.fallback_reason, 'single_candidate');
  });

  it('merged candidates collapse conflicting page dates to null and keep identical ones', async () => {
    // 同一 canonical URL 的两个来源（example.com/article 与 www 变体）：日期不同 → null；
    // 相同 → 保留。片段身份映射不受影响（mergedFrom 并入宿主片段序列）
    const mergedPayload = (): BraveLlmContextResponse => ({
      grounding: {
        generic: [
          {
            url: 'https://example.com/article',
            title: 'Article',
            snippets: ['A body snippet about brave with enough words to survive. '.repeat(3)],
          },
          {
            url: 'https://www.example.com/article',
            title: 'Article (www)',
            snippets: ['A merged snippet about brave with enough words to survive. '.repeat(3)],
          },
        ],
        map: [],
      },
      sources: {
        'https://example.com/article': { title: 'Article', age: ['2026-09-16'] },
        'https://www.example.com/article': { title: 'Article (www)', age: ['2023-04-18'] },
      },
    });
    seen.length = 0;
    await filterLlmContext(
      mergedPayload(),
      { ...request, retrievalTime: RETRIEVAL },
      temporalAllConfig,
      {
        classify: keepClassify,
      }
    );
    assert.equal(seen.length, 1);
    const { state } = seen[0];
    assert.ok('source' in state, '步 2 归并后单候选回退 single');
    assert.equal(state.source.brave_page_date, null, 'A、B 日期不同 → null，不把 A 的日期贴到 B');

    // 相同日期保留
    const samePayload = mergedPayload();
    samePayload.sources['https://www.example.com/article'] = {
      title: 'Article (www)',
      age: ['2026-09-16'],
    };
    seen.length = 0;
    await filterLlmContext(
      samePayload,
      { ...request, retrievalTime: RETRIEVAL },
      temporalAllConfig,
      {
        classify: keepClassify,
      }
    );
    assert.ok('source' in seen[0].state);
    assert.equal(seen[0].state.source.brave_page_date, '2026-09-16');

    delete samePayload.sources['https://www.example.com/article'].age;
    seen.length = 0;
    await filterLlmContext(
      samePayload,
      { ...request, retrievalTime: RETRIEVAL },
      temporalAllConfig,
      {
        classify: keepClassify,
      }
    );
    assert.ok('source' in seen[0].state);
    assert.equal(seen[0].state.source.brave_page_date, null, '部分未知不能冒用宿主日期');
  });
});
