import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseJevResponse } from './jev/client.js';
import { DEFAULT_JEV_MODEL, DEFAULT_THRESHOLDS } from './jev/questions.js';
import { collectJevCandidatesDetailed, filterLlmContext, trimSourceMeta } from './pipeline.js';
import { createNoKeyJevStats } from './stats.js';
import type {
  BraveLlmContextResponse,
  BraveLlmContextGenericItem,
  ClassifyDeps,
  ClassifyOutcome,
  FilterCallContext,
  FilterConfig,
  FilterRequest,
  JevAnswer,
  JevQuestion,
  JevState,
} from './types.js';

const offConfig: FilterConfig = {
  mode: 'off',
  thresholds: { ...DEFAULT_THRESHOLDS },
  jev: {
    model: DEFAULT_JEV_MODEL,
    timeoutMs: 15000,
    concurrency: 12,
  },
  logDir: join(homedir(), '.brave-jev', 'logs'),
};

const request: { params: FilterRequest; intent: string } = {
  params: { query: 'brave browser', maximum_number_of_urls: 5, maximum_number_of_tokens: 4000 },
  intent: 'What Brave Search is',
};

/** 全保留的 choice 分布：概率 1 全给最长字母标签（none 为 0）。 */
const allKeepProbabilities = (criteria: Record<string, null>): Record<string, number> => {
  const full = Object.keys(criteria)
    .filter((label) => label !== 'none')
    .reduce((best, label) => (label.length > best.length ? label : best), '');
  return Object.fromEntries(Object.keys(criteria).map((label) => [label, label === full ? 1 : 0]));
};

/** 全删除的 choice 分布：概率 1 全给 none。 */
const allDropProbabilities = (criteria: Record<string, null>): Record<string, number> =>
  Object.fromEntries(Object.keys(criteria).map((label) => [label, label === 'none' ? 1 : 0]));

/** 按题型生成全保留答案：noul 概率 0，choice 全保留分布。 */
const keepAllAnswers = (questions: Record<string, JevQuestion>): Record<string, JevAnswer> =>
  Object.fromEntries(
    Object.entries(questions).map(([key, question]) => [
      key,
      question.type === 'choice'
        ? { kind: 'choice', probabilities: allKeepProbabilities(question.criteria) }
        : { kind: 'noul', probability: 0 },
    ])
  );

/** 把逐来源局部答案脚本按 `${id}__${localKey}` 命名空间铺成全量共享请求的答案表。 */
const namespaced = (
  state: JevState,
  questions: Record<string, JevQuestion>,
  script: Record<string, Record<string, JevAnswer>>
): Record<string, JevAnswer> => {
  const answers: Record<string, JevAnswer> = {};
  for (const source of state.sources) {
    const local = script[source.id];
    assert.ok(local, `no scripted answers for ${source.id}`);
    for (const [localKey, answer] of Object.entries(local)) {
      const globalKey = `${source.id}__${localKey}`;
      if (questions[globalKey] !== undefined) answers[globalKey] = answer;
    }
  }
  return answers;
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

  it('off mode is a strict pass-through: skips classify, keeps stats.jev null, and returns the payload unchanged', async () => {
    let calls = 0;
    const classify: ClassifyDeps['classify'] = async () => {
      calls += 1;
      return { status: 'failed', kind: 'network' };
    };
    const data = payload();

    const { result, stats } = await filterLlmContext(data, request, offConfig, { classify });

    assert.equal(calls, 0);
    assert.equal(stats.jev, null);
    assert.equal(stats.mode, 'off');
    // generic 输出与输入全等：内容与 URL 顺序均原样透传。
    assert.deepEqual(result.grounding.generic, data.grounding.generic);
    assert.deepEqual(
      result.grounding.generic.map((item) => item.url),
      ['https://search.brave.com/', 'https://example.com/post']
    );
  });

  // test/on 未注入 classify 时走 no_key 本地链：记账 no_key、零请求、内容透传。
  for (const mode of ['test', 'on'] as const) {
    it(`mode=${mode} without a classifier records no_key and performs no network call`, async () => {
      const data = payload();

      const { result, stats } = await filterLlmContext(data, request, { ...offConfig, mode });

      assert.equal(stats.mode, mode);
      assert.deepEqual(stats.jev, createNoKeyJevStats());
      assert.equal(stats.jev?.n_requests, 0);
      assert.deepEqual(
        result.grounding.generic.map((item) => item.snippets),
        data.grounding.generic.map((item) => item.snippets)
      );
    });
  }

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

    // 样板首行删除后，短片段仍按原序保留，质量交给 Jev 判断。
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
    });
    assert.deepEqual(stats.brave, {
      n_sources: 2,
      n_snippets: 3,
      chars: data.grounding.generic.flatMap((item) => item.snippets).join('').length,
    });
    assert.deepEqual(
      stats.sources.map((source) => [source.index, source.url, source.hostname]),
      [
        [0, 'https://search.brave.com/', 'search.brave.com'],
        [1, 'https://example.com/post', 'example.com'],
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
    // 统计表不含片段正文
    assert.doesNotMatch(JSON.stringify(stats), /privacy-focused/);
  });

  it('records context_threshold_mode in stats.request only when the request carries it', async () => {
    const data = payload();

    // context_threshold_mode 不在 MCP 工具声明中，只通过纯库直调用例验证记录行为。
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
        thresholds: { ...DEFAULT_THRESHOLDS },
        jev: {
          model: DEFAULT_JEV_MODEL,
          timeoutMs: 15000,
          concurrency: 12,
        },
        logDir: join(homedir(), '.brave-jev', 'logs'),
      }
    );
    const second = await filterLlmContext(
      data,
      { params: { query: 'second' }, intent: 'second intent' },
      {
        mode: 'on',
        thresholds: { ...DEFAULT_THRESHOLDS },
        jev: {
          model: DEFAULT_JEV_MODEL,
          timeoutMs: 15000,
          concurrency: 12,
        },
        logDir: join(homedir(), '.brave-jev', 'logs'),
      }
    );
    const third = await filterLlmContext(
      data,
      { params: { query: 'first' }, intent: 'first intent' },
      {
        mode: 'test',
        thresholds: { ...DEFAULT_THRESHOLDS },
        jev: {
          model: DEFAULT_JEV_MODEL,
          timeoutMs: 15000,
          concurrency: 12,
        },
        logDir: join(homedir(), '.brave-jev', 'logs'),
      }
    );

    assert.equal(first.stats.mode, 'test');
    assert.equal(second.stats.mode, 'on');
    assert.equal(first.stats.request.query, 'first');
    assert.equal(second.stats.request.query, 'second');
    assert.notEqual(first.stats, second.stats);
    assert.deepEqual(first.stats, third.stats);
  });

  it('uses the all-default config when config is omitted, ignoring filter env vars', async () => {
    // 省略 config 时纯库使用默认配置，不读取环境中的过滤开关。
    const savedMode = process.env.JEV_FILTER_MODE;
    const savedFile = process.env.JEV_FILTER_CONFIG_FILE;
    process.env.JEV_FILTER_MODE = 'off';
    process.env.JEV_FILTER_CONFIG_FILE = 'C:/no/such/file.json';

    try {
      assert.equal((await filterLlmContext(payload(), request)).stats.mode, 'on');
    } finally {
      if (savedMode === undefined) delete process.env.JEV_FILTER_MODE;
      else process.env.JEV_FILTER_MODE = savedMode;
      if (savedFile === undefined) delete process.env.JEV_FILTER_CONFIG_FILE;
      else process.env.JEV_FILTER_CONFIG_FILE = savedFile;
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
  });

  it('returns an empty object for missing metadata', () => {
    assert.deepEqual(trimSourceMeta(undefined), {});
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

describe('empty-source verdicts and drops', () => {
  it('marks a source whose snippets are all keep-probability-removed as empty in step 8', async () => {
    // 片段被保留概率裁决或本地清理删空时，来源归为 empty。
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
    const classify: ClassifyDeps['classify'] = async ({ questions }) => ({
      status: 'answered',
      model: DEFAULT_JEV_MODEL,
      answers: Object.fromEntries(
        Object.entries(questions).map(([key, question]) => [
          key,
          question.type === 'choice'
            ? { kind: 'choice', probabilities: allDropProbabilities(question.criteria) }
            : { kind: 'noul', probability: 0 },
        ])
      ),
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

// 同一合成夹具验证三模式：test/on 真实应用裁决，off 仅用本地规则。

describe('three-mode semantic matrix (off / test / on)', () => {
  // 四来源覆盖矩阵四角：s0 来源级 keep 且组合题全保留（三模式输出同）；s1 来源级
  // filler 丢弃；s2 组合题只保留首片；s3 组合题全删 → 步 8 empty 间接清空。
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
          title: 'Partly Useful Source',
          snippets: [
            'Brave strong snippet one.',
            'Brave weak snippet two.',
            'Brave weak snippet three.',
          ],
        },
        {
          url: 'https://s3.example/',
          title: 'Low Utility Source',
          snippets: ['Brave low snippet one.', 'Brave low snippet two.'],
        },
      ],
      map: [],
    },
    sources: {},
  });

  /** 组合题答案速记：片数 → 分布。 */
  const groupAnswer = (probabilities: Record<string, number>): JevAnswer => ({
    kind: 'choice',
    probabilities,
  });

  const makeClassify =
    (counter: { calls: number }): ClassifyDeps['classify'] =>
    async ({ state, questions }) => {
      counter.calls += 1;
      // 全量共享桩：按 `${id}__${localKey}` 命名空间逐来源注入答案
      const script: Record<string, Record<string, JevAnswer>> = {};
      for (const source of state.sources) {
        const local: Record<string, JevAnswer> = {
          filler: { kind: 'noul', probability: source.id === 's1' ? 0.9 : 0 },
        };
        if (source.id === 's2') {
          // 三片组只保留 A：p(B)=p(C)=0 低于组合门槛 0.25
          local.group0 = groupAnswer({
            none: 0,
            A: 1,
            B: 0,
            AB: 0,
            C: 0,
            AC: 0,
            BC: 0,
            ABC: 0,
          });
        } else if (source.id === 's3') {
          // 两片组全删
          local.group0 = groupAnswer({ none: 1, A: 0, B: 0, AB: 0 });
        } else {
          // s0 两片、s1 单片：全保留
          local.group0 = groupAnswer(
            source.snippets.length === 1 ? { none: 0, A: 1 } : { none: 0, A: 0, B: 0, AB: 1 }
          );
        }
        script[source.id] = local;
      }
      return {
        status: 'answered',
        model: DEFAULT_JEV_MODEL,
        answers: namespaced(state, questions, script),
        input_tokens: 10,
        dispatch: { state, questions },
      };
    };

  it('off: no classify call, stats.jev null, full local output', async () => {
    const data = matrixPayload();
    const counter = { calls: 0 };

    const { result, stats } = await filterLlmContext(data, request, offConfig, {
      classify: makeClassify(counter),
    });

    assert.equal(counter.calls, 0);
    assert.equal(stats.jev, null);
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

  it('test: classify called and verdicts really apply — dropped sources vanish, low-probability snippets removed', async () => {
    const counter = { calls: 0 };

    const testRun = await filterLlmContext(
      matrixPayload(),
      request,
      { ...offConfig, mode: 'test' },
      { classify: makeClassify(counter) }
    );

    // Jev 照常调用（一次全量共享请求）并记账
    assert.equal(counter.calls, 1);
    assert.equal(testRun.stats.jev?.n_requests, 1);
    // 核对来源级 filler 丢弃、低概率片段删除与组合题删空后的来源删除。
    assert.deepEqual(
      testRun.result.grounding.generic.map((item) => [item.url, item.snippets.length]),
      [
        ['https://s0.example/', 2],
        ['https://s2.example/', 1],
      ]
    );
    // per_source 的 verdict/reason 记账：s1 drop + filler、s0 keep；s3 来源级
    // keep（删光它的是后续本地规则步 8，不是 Jev 裁决）
    const rowOf = (src: string) => testRun.stats.jev?.per_source.find((row) => row.src === src);
    assert.equal(rowOf('s1')?.verdict, 'drop');
    assert.equal(rowOf('s1')?.reason, 'filler');
    assert.equal(rowOf('s0')?.verdict, 'keep');
    assert.equal(rowOf('s3')?.verdict, 'keep');
    // 组合题删光清空的来源按 'empty' 记账。
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
    // 同输入与回答下，test/on 输出及统计应逐字段一致。
    assert.deepEqual(testRun.result, onRun.result);
    assert.deepEqual(testRun.stats.sources, onRun.stats.sources);
    assert.deepEqual(testRun.stats.local, onRun.stats.local);
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

// 阈值附近的临界裁决：端到端覆盖页面先删与片段删空两条路径。

describe('near-threshold verdict end to end', () => {
  const nearPayload = (): BraveLlmContextResponse => ({
    grounding: {
      generic: [
        {
          url: 'https://near-page.example/',
          title: 'Near Page Source',
          snippets: ['Brave near page snippet with facts.'],
        },
        {
          url: 'https://near-snippet.example/',
          title: 'Near Snippet Source',
          snippets: ['Brave near snippet body with facts.'],
        },
      ],
      map: [],
    },
    sources: {},
  });

  const makeNearClassify =
    (fillerProbabilities: Record<string, number>, snippetProbabilities: Record<string, number>) =>
    async ({ state, questions }: { state: JevState; questions: Record<string, JevQuestion> }) => {
      const script: Record<string, Record<string, JevAnswer>> = {};
      for (const source of state.sources) {
        script[source.id] = {
          filler: { kind: 'noul', probability: fillerProbabilities[source.id]! },
          group0: {
            kind: 'choice',
            probabilities: {
              none: 1 - snippetProbabilities[source.id]!,
              A: snippetProbabilities[source.id]!,
            },
          },
        };
      }
      return {
        status: 'answered' as const,
        model: DEFAULT_JEV_MODEL,
        answers: namespaced(state, questions, script),
        input_tokens: 10,
        dispatch: { state, questions },
      };
    };

  it('page verdict within the gap drops the source and records near_threshold_gap without rewriting p', async () => {
    // s0 页面 0.79：未达 0.8 原线，临界删除；s1 页面 0、片段 A=1 全保留
    const { result, stats } = await filterLlmContext(
      nearPayload(),
      request,
      { ...offConfig, mode: 'test' },
      { classify: makeNearClassify({ s0: 0.79, s1: 0 }, { s0: 1, s1: 1 }) }
    );

    const rowOf = (src: string) => stats.jev?.per_source.find((row) => row.src === src);
    assert.equal(rowOf('s0')?.verdict, 'drop');
    assert.equal(rowOf('s0')?.reason, 'filler');
    // 实际浮点距离如实记录（0.8 - 0.79），原概率不被改写
    assert.equal(rowOf('s0')?.near_threshold_gap, 0.8 - 0.79);
    assert.equal(rowOf('s0')?.answers?.filler, 0.79);
    assert.equal(rowOf('s1')?.verdict, 'keep');
    assert.equal(rowOf('s1')?.near_threshold_gap, undefined);

    const stats0 = stats.sources.find((source) => source.url === 'https://near-page.example/');
    assert.equal(stats0?.verdict, 'drop');
    assert.equal(stats0?.reason, 'filler');
    // 页面直接删除不伪造片段应用记录：片段行保持本地保留状态，无临界标记
    assert.deepEqual(
      stats0?.snippets.map((snippet) => [snippet.kept, snippet.near_threshold_gap ?? null]),
      [[true, null]]
    );
    assert.deepEqual(
      result.grounding.generic.map((item) => item.url),
      ['https://near-snippet.example/']
    );
  });

  it('snippet verdict within the gap drops the snippet, empty source follows, gap 0 kept verbatim', async () => {
    // s1 页面 0 保留，单片片段 A=0.5 恰达保留线：临界删除 gap 0，来源随后按 empty 删除
    const { result, stats } = await filterLlmContext(
      nearPayload(),
      request,
      { ...offConfig, mode: 'test' },
      { classify: makeNearClassify({ s0: 0, s1: 0 }, { s0: 1, s1: 0.5 }) }
    );

    const stats1 = stats.sources.find((source) => source.url === 'https://near-snippet.example/');
    assert.equal(stats1?.verdict, 'drop');
    assert.equal(stats1?.reason, 'empty');
    assert.deepEqual(
      stats1?.snippets.map((snippet) => [
        snippet.kept,
        snippet.reason,
        snippet.near_threshold_gap ?? null,
      ]),
      [[false, 'keep_probability', 0]]
    );
    // 页面行不带临界标记（原判定保留）；s1 删空消失，s0 照常保留
    assert.equal(
      stats.jev?.per_source.find((row) => row.src === 's1')?.near_threshold_gap,
      undefined
    );
    assert.deepEqual(
      result.grounding.generic.map((item) => item.url),
      ['https://near-page.example/']
    );
  });

  it('verdicts strictly outside the gap stay untouched (no near markers, content kept)', async () => {
    // 页面 0.7799（差 0.0201）、片段 A=0.5201（差 0.0201）：全部保留且无标记
    const { result, stats } = await filterLlmContext(
      nearPayload(),
      request,
      { ...offConfig, mode: 'test' },
      { classify: makeNearClassify({ s0: 0.7799, s1: 0 }, { s0: 1, s1: 0.5201 }) }
    );

    assert.equal(
      stats.jev?.per_source.every((row) => row.near_threshold_gap === undefined),
      true
    );
    assert.equal(
      stats.sources.every((source) => source.verdict === 'keep'),
      true
    );
    assert.deepEqual(
      result.grounding.generic.map((item) => [item.url, item.snippets.length]),
      [
        ['https://near-page.example/', 1],
        ['https://near-snippet.example/', 1],
      ]
    );
  });
});

describe('jev status aggregation and breaker open trim-back', () => {
  // 全量共享请求下状态聚合只有三种路径：answered（ok）、已派发失败（degraded）、
  // 熔断短路（breaker_open）——来源行来自同一 outcome 的投影。
  const breakerOpen: ClassifyOutcome = {
    status: 'failed',
    kind: 'breaker_open',
    detail: 'circuit open after consecutive transient failures',
    http_attempts: 0,
  };

  /** 全保留 answered 桩：filler 0.1、组合题全保留 + 实发载荷（生产客户端形状）。 */
  const answeredAll: ClassifyDeps['classify'] = async ({ state, questions }) => ({
    status: 'answered',
    model: DEFAULT_JEV_MODEL,
    answers: Object.fromEntries(
      Object.keys(questions).map((key) => {
        const question = questions[key];
        return [
          key,
          question.type === 'choice'
            ? { kind: 'choice', probabilities: allKeepProbabilities(question.criteria) }
            : { kind: 'noul', probability: 0.1 },
        ];
      })
    ),
    input_tokens: 100,
    dispatch: { state, questions },
  });

  it('aggregates status ok when the shared request is answered', async () => {
    const { stats } = await filterLlmContext(
      payload(),
      request,
      { ...offConfig, mode: 'on' },
      {
        classify: answeredAll,
      }
    );

    assert.equal(stats.jev?.status, 'ok');
    assert.equal(stats.jev?.n_requests, 1);
    assert.deepEqual(
      (stats.jev?.per_source ?? []).map((row) => [row.src, row.status]),
      [
        ['s0', 'answered'],
        ['s1', 'answered'],
      ]
    );
  });

  it('aggregates status degraded when the dispatched shared request fails', async () => {
    let calls = 0;
    const { result, stats } = await filterLlmContext(
      payload(),
      request,
      { ...offConfig, mode: 'on' },
      {
        classify: async ({ state, questions }) => {
          calls += 1;
          assert.ok('sources' in state);
          return {
            status: 'failed',
            kind: 'network',
            detail: 'connection reset',
            dispatch: { state, questions },
            http_attempts: 3,
          };
        },
      }
    );

    // 派发后失败仍计一次逻辑请求，HTTP 尝试含重试，不拆成逐来源请求
    assert.equal(calls, 1);
    assert.equal(stats.jev?.status, 'degraded');
    assert.equal(stats.jev?.n_requests, 1);
    assert.equal(stats.jev?.n_http_attempts, 3);
    assert.equal(stats.jev?.requests.length, 1);
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
    // 失败来源应保守保留。
    assert.deepEqual(
      result.grounding.generic.map((item) => item.url),
      ['https://search.brave.com/', 'https://example.com/post']
    );
  });

  it('aggregates status breaker_open when the shared request is short-circuited', async () => {
    let calls = 0;
    const classify: ClassifyDeps['classify'] = async ({ state }) => {
      calls += 1;
      assert.ok('sources' in state);
      return breakerOpen;
    };

    const offRun = await filterLlmContext(payload(), request, { ...offConfig, mode: 'off' });
    const onRun = await filterLlmContext(
      payload(),
      request,
      { ...offConfig, mode: 'on' },
      { classify }
    );

    // 熔断短路不计逻辑请求与 HTTP 尝试
    assert.equal(calls, 1);
    assert.equal(onRun.stats.jev?.status, 'breaker_open');
    assert.equal(onRun.stats.jev?.n_requests, 0);
    assert.equal(onRun.stats.jev?.n_http_attempts, 0);
    const record = (onRun.stats.jev?.requests ?? [])[0];
    assert.equal(record?.dispatched, false);
    assert.equal(record?.fail_kind, 'breaker_open');
    assert.equal(record?.http_attempts, 0);
    assert.deepEqual(
      (onRun.stats.jev?.per_source ?? []).map((row) => row.status),
      ['breaker_open', 'breaker_open']
    );

    // 熔断期只跑本地规则，输出与同参数 off 模式 deepEqual
    assert.deepEqual(onRun.result, offRun.result);
    // 失败来源应保守保留。
    assert.deepEqual(
      onRun.result.grounding.generic.map((item) => item.url),
      ['https://search.brave.com/', 'https://example.com/post']
    );
  });
});

// 跨来源文本保留与来源顺序。

describe('跨来源内容独立保留', () => {
  // s0 原文，s1 改写（词序不同，非严格相等），s2 独有事实
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

  it('off 模式下非严格相等的改写内容完整保留，不因本地去重删除', async () => {
    const { result, stats } = await filterLlmContext(noveltyPayload(), request, offConfig);

    assert.deepEqual(
      result.grounding.generic.map((item) => item.url),
      ['https://origin.example/', 'https://rewrite.example/', 'https://unique.example/']
    );
    assert.equal(result.grounding.generic[1].snippets[0], S1_TEXT);
    assert.equal(stats.local.empty_dropped, 0);
  });

  it('启用 Jev 后组合题全保留新事实，不因并集覆盖删除', async () => {
    const classify: ClassifyDeps['classify'] = async ({ questions }) => ({
      status: 'answered',
      model: DEFAULT_JEV_MODEL,
      input_tokens: 10,
      answers: keepAllAnswers(questions),
    });
    const { result } = await filterLlmContext(
      noveltyPayload(),
      request,
      { ...offConfig, mode: 'on' },
      { classify }
    );
    assert.deepEqual(
      result.grounding.generic.map((item) => item.url),
      ['https://origin.example/', 'https://rewrite.example/', 'https://unique.example/']
    );
    assert.equal(result.grounding.generic[1].snippets[0], S1_TEXT);
  });

  it('跨来源完全相同的内容与证据出处均保留', async () => {
    // 同样的正文来自不同来源，保持两个出处及原序。
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

    for (const mode of ['off', 'test', 'on'] as const) {
      const { result, stats } = await filterLlmContext(
        data,
        request,
        { ...offConfig, mode },
        {
          classify: async ({ questions }) => ({
            status: 'answered',
            model: DEFAULT_JEV_MODEL,
            input_tokens: 10,
            answers: keepAllAnswers(questions),
          }),
        }
      );
      assert.deepEqual(
        result.grounding.generic.map((item) => item.url),
        ['https://wire.example/', 'https://syndicated.example/']
      );
      assert.deepEqual(
        result.grounding.generic.map((item) => item.snippets),
        [[dupLong], [dupLong]]
      );
      const syndicated = stats.sources.find((entry) => entry.url === 'https://syndicated.example/');
      assert.equal(syndicated?.verdict, 'keep');
      assert.equal(syndicated?.reason, undefined);
      assert.equal(stats.local.empty_dropped, 0);
    }
  });
});

describe('snippet verdicts leave a single short snippet and the source survives', () => {
  it('keeps a source that retains one query-term-free snippet after snippet verdicts', async () => {
    // s1 两个片段：组合题删掉含 query 实词的那条，只剩一条不含实词的短片段。
    // off 与 test 链下该来源均保留（不再判一句话来源）。
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
    const classify: ClassifyDeps['classify'] = async ({ state, questions }) => {
      const script: Record<string, Record<string, JevAnswer>> = {};
      for (const source of state.sources) {
        const local: Record<string, JevAnswer> = {
          filler: { kind: 'noul', probability: 0 },
        };
        if (source.id === 's1') {
          // s1 的第一条（含实词）保留概率 0 被删，第二条（不含实词的短句）保留
          local.group0 = { kind: 'choice', probabilities: { none: 0, A: 0, B: 1, AB: 0 } };
        } else {
          local.group0 = { kind: 'choice', probabilities: { none: 0, A: 1 } };
        }
        script[source.id] = local;
      }
      return {
        status: 'answered',
        model: DEFAULT_JEV_MODEL,
        answers: namespaced(state, questions, script),
        input_tokens: 10,
      };
    };

    const offRun = await filterLlmContext(data, request, offConfig);
    const testRun = await filterLlmContext(
      data,
      request,
      { ...offConfig, mode: 'test' },
      { classify }
    );

    // 组合题删掉含实词的片段；off 不跑 Jev（两条都在），test 只剩单条短片段。
    const offSurviving = offRun.result.grounding.generic.find(
      (item) => item.url === 'https://oneliner.example/'
    );
    assert.ok(offSurviving);
    assert.deepEqual(offSurviving.snippets, [
      'Brave beta fragment with query terms.',
      'The current release timing.',
    ]);
    const testSurviving = testRun.result.grounding.generic.find(
      (item) => item.url === 'https://oneliner.example/'
    );
    assert.ok(testSurviving);
    assert.deepEqual(testSurviving.snippets, ['The current release timing.']);
  });
});

// 共享请求的编排、映射与记账；按数组位置构造答案并写回来源命名空间。
// 数组下标、来源 ID 或片段身份错位时应被断言发现。

describe('all-context request organization (T02-T09/T11)', () => {
  const allConfig: FilterConfig = { ...offConfig, mode: 'on' };

  /** 保守保留的页面题答案。 */
  const FILLER_KEEP: Record<string, JevAnswer> = {
    filler: { kind: 'noul', probability: 0.1 },
  };

  /** 组合题答案速记。 */
  const groupAnswer = (probabilities: Record<string, number>): JevAnswer => ({
    kind: 'choice',
    probabilities,
  });
  /** 全保留：单片 {none:0,A:1}、两片 {…AB:1}、三片 {…ABC:1}。 */
  const GROUP_KEEP: Record<number, Record<string, number>> = {
    1: { none: 0, A: 1 },
    2: { none: 0, A: 0, B: 0, AB: 1 },
    3: { none: 0, A: 0, B: 0, AB: 0, C: 0, AC: 0, BC: 0, ABC: 1 },
  };
  const GROUP_DROP: Record<number, Record<string, number>> = {
    1: { none: 1, A: 0 },
    2: { none: 1, A: 0, B: 0, AB: 0 },
    3: { none: 1, A: 0, B: 0, AB: 0, C: 0, AC: 0, BC: 0, ABC: 0 },
  };

  type AllSeen = { state: JevState; questions: Record<string, JevQuestion> };

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
        usage_complete: true,
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

  it('a single candidate still shares one all request with sources[0] and the new questions (T02/§3.1)', async () => {
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
      // 元数据带合法 ISO 日期：单候选同样完成原始日期选择与绑定
      sources: { 'https://solo.example/': { title: 'Solo', age: ['2026-09-16'] } },
    };
    const seen: AllSeen[] = [];
    const { stats, jev_requests, result } = await filterLlmContext(data, request, allConfig, {
      classify: allClassify(
        { s0: { ...FILLER_KEEP, group0: groupAnswer(GROUP_KEEP[1]) } },
        { seen }
      ),
    });

    // 单候选也走全量形状：sources[0] + 命名空间题键 + 单片组合题，不走特殊模板
    assert.equal(seen.length, 1);
    const state = seen[0]?.state;
    assert.equal(state?.sources.length, 1);
    assert.equal(state?.sources[0]?.id, 's0');
    assert.equal(state?.sources[0]?.brave_page_date, '2026-09-16');
    const questions = seen[0]?.questions ?? {};
    assert.ok(questions['s0__group0'] !== undefined);
    assert.match(questions['s0__group0']?.instructions ?? '', /^A=`sources\[0\]\.snippets\[0\]`/);
    assert.ok(questions['s0__filler'] !== undefined);

    // 映射在完整请求记录里（stats.jev.requests 是瘦身摘要，无 mapping / state）
    const requests = jev_requests;
    assert.equal(requests.length, 1);
    const record = requests[0];
    assert.deepEqual(record?.source_ids, ['s0']);
    assert.equal(record?.mapping[0]?.array_index, 0);
    assert.equal(record?.mapping[0]?.question_keys['filler'], 's0__filler');
    assert.equal(record?.mapping[0]?.question_keys['group0'], 's0__group0');
    assert.deepEqual(record?.mapping[0]?.snippet_groups, [
      { key: 'group0', start: 0, size: 1, letters: ['A'] },
    ]);
    assert.equal(stats.jev?.n_requests, 1);
    const row = (stats.jev?.per_source ?? [])[0];
    assert.equal(row?.status, 'answered');
    // 保留概率应用正确：单片 p(A)=1 高于 0.5 门槛保留
    assert.deepEqual(row?.snippet_judgments, [{ kind: 'keep_probability', value: 1 }]);
    assert.deepEqual(
      result.grounding.generic.map((item) => item.url),
      ['https://solo.example/']
    );
  });

  it('multiple candidates share exactly one all request in Brave order (T02/T03)', async () => {
    const seen: AllSeen[] = [];
    // 请求级完整记录（含 mapping）在 jev_requests；stats.jev.requests 是瘦身摘要
    const { result, stats, jev_requests } = await filterLlmContext(payload(), request, allConfig, {
      classify: allClassify(
        {
          s0: { ...FILLER_KEEP, group0: groupAnswer(GROUP_KEEP[2]) },
          s1: { ...FILLER_KEEP, group0: groupAnswer(GROUP_KEEP[1]) },
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
    // 题键命名空间：`${id}__${local}`，每来源 filler + 组合题（s0 两片一组、s1 单片一组）
    const questions = seen[0]?.questions ?? {};
    assert.equal(Object.keys(questions).length, 4);
    assert.ok(questions['s0__filler'] !== undefined && questions['s0__group0'] !== undefined);
    assert.ok(questions['s1__filler'] !== undefined && questions['s1__group0'] !== undefined);
    // 组合题题干数组下标按数组位置展开（s1 引用 sources[1]，不是 sources[0]）
    assert.match(
      questions['s0__group0']?.instructions ?? '',
      /A=`sources\[0\]\.snippets\[0\]`; B=`sources\[0\]\.snippets\[1\]`/
    );
    assert.match(questions['s1__group0']?.instructions ?? '', /^A=`sources\[1\]\.snippets\[0\]`/);

    const jev = stats.jev;
    assert.equal(jev?.n_requests, 1);
    assert.equal(jev?.n_http_attempts, 1);
    assert.equal(jev?.status, 'ok');
    const record = jev_requests[0];
    assert.deepEqual(record?.source_ids, ['s0', 's1']);
    assert.equal(record?.dispatched, true);
    assert.equal(record?.usage_complete, true);
    // 显式映射：数组位置、来源 ID、片段身份三者对齐
    const mapping = record?.mapping ?? [];
    assert.equal(mapping.length, 2);
    assert.equal(mapping[0]?.source_id, 's0');
    assert.equal(mapping[0]?.array_index, 0);
    assert.deepEqual(mapping[0]?.snippet_keys, ['0', '1']);
    assert.equal(mapping[0]?.question_keys['group0'], 's0__group0');
    assert.equal(Object.keys(mapping[0]?.question_keys ?? {}).length, 2);
    assert.deepEqual(mapping[0]?.snippet_groups, [
      { key: 'group0', start: 0, size: 2, letters: ['A', 'B'] },
    ]);
    assert.equal(mapping[1]?.source_id, 's1');
    assert.equal(mapping[1]?.array_index, 1);
    assert.deepEqual(mapping[1]?.snippet_keys, ['0']);
    assert.equal(mapping[1]?.question_keys['group0'], 's1__group0');
    assert.equal(Object.keys(mapping[1]?.question_keys ?? {}).length, 2);
    assert.deepEqual(mapping[1]?.snippet_groups, [
      { key: 'group0', start: 0, size: 1, letters: ['A'] },
    ]);
    // 两来源行都 answered、指向同一请求；投影答案按映射回流
    assert.deepEqual(
      (jev?.per_source ?? []).map((row) => [row.src, row.status, row.request_id]),
      [
        ['s0', 'answered', 'j1'],
        ['s1', 'answered', 'j1'],
      ]
    );
    assert.deepEqual((jev?.per_source ?? [])[0]?.snippet_judgments, [
      { kind: 'keep_probability', value: 1 },
      { kind: 'keep_probability', value: 1 },
    ]);
    assert.deepEqual((jev?.per_source ?? [])[1]?.snippet_judgments, [
      { kind: 'keep_probability', value: 1 },
    ]);
    // 输出保持 Brave 原序、内容无删
    assert.deepEqual(
      result.grounding.generic.map((item) => item.url),
      ['https://search.brave.com/', 'https://example.com/post']
    );
  });

  it('keeps gapped IDs and Brave order when an earlier source is locally dropped (T03)', async () => {
    const seen: AllSeen[] = [];
    // s0 的空白片段被删除，首个候选为 s1：数组位置 0 与来源 ID 数字 1 不同。
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
          s1: { ...FILLER_KEEP, group0: groupAnswer(GROUP_KEEP[1]) },
          s2: { ...FILLER_KEEP, group0: groupAnswer(GROUP_DROP[1]) },
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
    assert.ok((seen[0]?.questions ?? {})['s1__group0'] !== undefined);
    assert.ok((seen[0]?.questions ?? {})['s2__group0'] !== undefined);
    // s2 的 0 保留概率片段删光来源，s1 幸存；输出仍是 Brave 原序子序列
    assert.deepEqual(
      result.grounding.generic.map((item) => item.url),
      ['https://alpha.example/']
    );
  });

  it('ignores extra answers for questions that were never asked (T04)', async () => {
    // 向桩加入高概率的未提问答案；显式映射必须忽略它们，不能触发删除或进入当前答案。
    const { result, stats } = await filterLlmContext(payload(), request, allConfig, {
      classify: allClassify(
        {
          s0: { ...FILLER_KEEP, group0: groupAnswer(GROUP_KEEP[2]) },
          s1: { ...FILLER_KEEP, group0: groupAnswer(GROUP_KEEP[1]) },
        },
        {
          extra: {
            s0__unasked_page: { kind: 'noul', probability: 0.99 },
            s0__another_unasked_page: { kind: 'noul', probability: 0.99 },
            s1__unasked_page: { kind: 'noul', probability: 0.99 },
            s0__unasked_snippet: { kind: 'noul', probability: 0.9 },
            s1__unasked_snippet: { kind: 'noul', probability: 0.9 },
          },
        }
      ),
    });

    assert.deepEqual(
      result.grounding.generic.map((item) => item.url),
      ['https://search.brave.com/', 'https://example.com/post']
    );
    for (const row of stats.jev?.per_source ?? []) {
      assert.equal(row.answers?.['unasked_page'], undefined);
      assert.equal(row.answers?.['another_unasked_page'], undefined);
      assert.equal(row.answers?.['unasked_snippet'], undefined);
    }
  });

  it('组合题无效时报告检查未完成，页面裁决有效性与已删来源分别处理', async () => {
    for (const mode of ['test', 'on'] as const) {
      const { stats, jev_dispatch } = await filterLlmContext(
        payload(),
        request,
        { ...allConfig, mode },
        {
          classify: allClassify({
            // 两片组缺少 B/AB 概率；页面有效，但片段检查未完成。
            s0: { ...FILLER_KEEP, group0: groupAnswer({ none: 0, A: 1 }) },
            // 页面已删，即使组合题缺答也不计入幸存来源的未检查数。
            s1: { filler: { kind: 'noul', probability: 0.9 } },
          }),
        }
      );
      assert.deepEqual(stats.jev?.per_source[0].snippet_validation, { group0: 'labels' });
      assert.deepEqual(
        stats.sources[0].snippets.map((snippet) => snippet.kept),
        [true, true]
      );
      assert.equal(jev_dispatch[0].source_verdict_valid, true);
      assert.equal(stats.sources[1].verdict, 'drop');
      assert.match(stats.output.status_line ?? '', /\[error\] \[1 source unchecked:/);
      assert.match(stats.output.status_line ?? '', /filter payload rejected/);
    }
  });

  it('missing answers never poison a source or shift its neighbors (T05)', async () => {
    // s0：页面题与组合题全部缺答（无可用答案）；s1：完整且组合题全删
    const { result, stats } = await filterLlmContext(payload(), request, allConfig, {
      classify: allClassify({
        s0: {},
        s1: { ...FILLER_KEEP, group0: groupAnswer(GROUP_DROP[1]) },
      }),
    });

    const rows = stats.jev?.per_source ?? [];
    const s0 = rows.find((row) => row.src === 's0');
    const s1 = rows.find((row) => row.src === 's1');
    // 缺组合题答案：逐位记 null（不压缩不左移），片段保守保留
    assert.deepEqual(s0?.snippet_judgments, [null, null]);
    assert.deepEqual(
      stats.sources
        .find((entry) => entry.url === 'https://search.brave.com/')
        ?.snippets.map((snippet) => snippet.kept),
      [true, true]
    );
    // 缺答页面题不进答案表（保守防御，不冒充 0），页面层记 validation
    assert.equal(s0?.answers?.['filler'], undefined);
    assert.equal(s0?.fail_kind, 'validation');
    assert.equal(s1?.answers?.['filler'], 0.1);
    // s1 完整：0 保留概率片段删光来源
    assert.deepEqual(s1?.snippet_judgments, [{ kind: 'keep_probability', value: 0 }]);
    assert.deepEqual(
      result.grounding.generic.map((item) => item.url),
      ['https://search.brave.com/']
    );
  });

  it('counts usage once per logical request and keeps HTTP attempts separate (T09)', async () => {
    const { stats } = await filterLlmContext(payload(), request, allConfig, {
      classify: allClassify(
        {
          s0: { ...FILLER_KEEP, group0: groupAnswer(GROUP_KEEP[2]) },
          s1: { ...FILLER_KEEP, group0: groupAnswer(GROUP_KEEP[1]) },
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
    // 请求用量与耗时通过 request_id 关联，不能逐来源重复累计。
    for (const row of stats.jev?.per_source ?? []) {
      assert.equal(row.input_tokens, undefined);
      assert.equal(row.latency_ms, undefined);
      assert.equal(row.model, DEFAULT_JEV_MODEL);
      assert.equal(row.request_id, 'j1');
    }
  });
});

// ---------------------------------------------------------------------------
// 步 3 GitHub 平台界面清洗（filter-rules-9）：test/on 在 Jev 派发前清洗且最终返回
// 同步干净（Jev 输入与最终输出同一份清洗后文本）；off 不应用本次清洗；动作明细
// 进统计表（github_cleanup_actions 计数 + 逐片段 github_cleanup）。
// ---------------------------------------------------------------------------

describe('GitHub 清洗接入', () => {
  it('比较菜单与 PR 占位在 test/on 清洗并计数，off 保留原文', async () => {
    const sha = 'abcd'.repeat(10);
    const body =
      'Brave browser repository documents its rendering pipeline and benchmark methodology.';
    const menu = `Configuration menu Copy the full SHA ${sha} View commit details Browse the repository at this point in the history`;
    const error = 'There was an error while loading. Please reload this page.\nAll reactions';
    for (const [url, text, expected, count] of [
      [
        'https://github.com/team/project/compare/main...fix',
        `${body} ${menu}`,
        `${body} ${sha}`,
        1,
      ],
      ['https://github.com/team/project/pull/42', `${error}\n${body}`, body, 2],
    ] as const) {
      const input: BraveLlmContextResponse = {
        grounding: { generic: [{ url, title: 'Change details', snippets: [text] }] },
        sources: {},
      };
      for (const mode of ['off', 'test', 'on'] as const) {
        const filtered = await filterLlmContext(input, request, { ...offConfig, mode });
        assert.deepEqual(filtered.result.grounding.generic[0].snippets, [
          mode === 'off' ? text : expected,
        ]);
        assert.equal(filtered.stats.local.github_cleanup_actions, mode === 'off' ? 0 : count);
        assert.equal(
          filtered.stats.sources[0].snippets[0].github_cleanup?.length ?? 0,
          mode === 'off' ? 0 : count
        );
      }
    }
  });

  const url = 'https://github.com/example/brave';
  const body =
    'Brave browser repository documents its rendering pipeline and benchmark methodology.';
  const input: BraveLlmContextResponse = {
    grounding: {
      generic: [{ url, title: 'Brave', snippets: ['## Repository files navigation', body] }],
    },
    sources: {},
  };

  it('分类收到清洗后的正文，返回和原始片段身份对应', async () => {
    let sent: JevState | undefined;
    const { result, stats } = await filterLlmContext(
      input,
      request,
      { ...offConfig, mode: 'on' },
      {
        classify: async ({ state, questions }) => {
          sent = state;
          return {
            status: 'answered',
            model: DEFAULT_JEV_MODEL,
            input_tokens: 10,
            answers: keepAllAnswers(questions),
          };
        },
      }
    );
    assert.deepEqual(sent?.sources[0].snippets, [body]);
    assert.deepEqual(result.grounding.generic[0].snippets, [body]);
    assert.deepEqual(
      stats.sources[0].snippets.filter((row) => row.kept).map((row) => row.index),
      [1]
    );
  });

  it('off 保留界面行；启用过滤但无密钥时仍执行本地清洗', async () => {
    const off = await filterLlmContext(input, request, offConfig);
    assert.deepEqual(off.result.grounding.generic[0].snippets, input.grounding.generic[0].snippets);
    const noKey = await filterLlmContext(input, request, { ...offConfig, mode: 'test' });
    assert.equal(noKey.stats.jev?.status, 'no_key');
    assert.deepEqual(noKey.result.grounding.generic[0].snippets, [body]);
  });
});

describe('X (Twitter) 清洗接入', () => {
  const url = 'https://x.com/CarterWChurch/status/2105167567706816690';
  const headingSnip = '## Related Trending Stories on X\nBreaking news headline';
  const showMoreSnip = 'From one prompt and one image, Astra deciphered the cipher. Show more';
  const authSidebar = [
    '## Log in or sign up for X',
    '',
    '## Relevant people',
    'Avatar',
    'Carter Church@CarterWChurch Follow',
    'staff ai engineer',
  ].join('\n');

  const input: BraveLlmContextResponse = {
    grounding: {
      generic: [
        {
          url,
          title: 'Carter Church on X',
          snippets: [headingSnip, showMoreSnip, authSidebar],
        },
      ],
    },
    sources: {},
  };

  it('保留行内 Show more、剥离界面标题并保留人物资料，明细进统计表', async () => {
    let sent: JevState | undefined;
    const { result, stats } = await filterLlmContext(
      input,
      request,
      { ...offConfig, mode: 'on' },
      {
        classify: async ({ state, questions }) => {
          sent = state;
          return {
            status: 'answered',
            model: DEFAULT_JEV_MODEL,
            input_tokens: 10,
            answers: keepAllAnswers(questions),
          };
        },
      }
    );

    const expectedSnippets = [
      'Breaking news headline',
      showMoreSnip,
      'Avatar\nCarter Church@CarterWChurch Follow\nstaff ai engineer',
    ];
    assert.deepEqual(sent?.sources[0].snippets, expectedSnippets);
    assert.deepEqual(result.grounding.generic[0].snippets, expectedSnippets);

    // 统计表记录平台清洗动作，人物资料仍保留供后续判断。
    assert.ok(stats.local.x_cleanup_actions > 0);
    const snipStats = stats.sources[0].snippets;
    assert.equal(snipStats[0].kept, true);
    assert.equal(snipStats[1].kept, true);
    assert.equal(snipStats[2].kept, true);
    assert.equal(stats.local.x_cleanup_actions, 3);
    assert.ok(snipStats[2].x_cleanup !== undefined);
  });

  it('off 模式不应用 X 清洗', async () => {
    const off = await filterLlmContext(input, request, offConfig);
    assert.deepEqual(off.result.grounding.generic[0].snippets, input.grounding.generic[0].snippets);
  });
});

// ---------------------------------------------------------------------------
// 时间上下文端到端（all-only）：检索时间归一进 state、逐来源 brave_page_date、
// 归并冲突置 null、非法检索时间省略；单候选同样走全量形状（无特殊模板）。
// ---------------------------------------------------------------------------

describe('temporal context (all-only)', () => {
  const RETRIEVAL = '2026-10-02T04:26:27.787+08:00';
  const temporalConfig: FilterConfig = { ...offConfig, mode: 'on' };

  const seen: Array<{ state: JevState; questions: Record<string, JevQuestion> }> = [];
  const keepClassify: ClassifyDeps['classify'] = async ({ state, questions }) => {
    seen.push({ state, questions });
    const answers: Record<string, JevAnswer> = {};
    for (const [key, question] of Object.entries(questions)) {
      answers[key] =
        question.type === 'choice'
          ? { kind: 'choice', probabilities: allKeepProbabilities(question.criteria) }
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
      temporalConfig,
      { classify: keepClassify }
    );
    assert.equal(seen.length, 1);
    const state = seen[0].state;
    assert.deepEqual(
      state.sources.map((s) => [s.id, s.brave_page_date]),
      [
        ['s1', '2026-10-01'],
        ['s2', '2024-02-29'],
        ['s3', '2026-09-01'],
      ]
    );
    assert.deepEqual(state.sources[0].snippets, [article, `A: ${answer}`]);
    assert.deepEqual(filtered.jev_requests[0].mapping[0].snippet_keys, ['0.0', '0.1']);
    // 组合题按数组位置展开显式字母引用：s1 两片一组，s2/s3 各单片短题
    assert.match(
      seen[0].questions.s1__group0.instructions,
      /A=`sources\[0\]\.snippets\[0\]`; B=`sources\[0\]\.snippets\[1\]`/
    );
    assert.match(
      seen[0].questions.s2__group0.instructions,
      /^A=`sources\[1\]\.snippets\[0\]`\. Keep A if/
    );
    assert.match(
      seen[0].questions.s3__group0.instructions,
      /^A=`sources\[2\]\.snippets\[0\]`\. Keep A if/
    );
    assert.deepEqual(data, before, '日期接入不改原正文或元数据');
    const onSources = filtered.stats.sources;
    const test = await filterLlmContext(
      data,
      { ...request, retrievalTime: RETRIEVAL },
      { ...temporalConfig, mode: 'test' },
      { classify: keepClassify }
    );
    assert.deepEqual(test.result, filtered.result);
    assert.deepEqual(test.stats.sources, onSources);
  });

  it('state carries retrieval_time and per-source brave_page_date; group questions carry the time anchors', async () => {
    seen.length = 0;
    const { result } = await filterLlmContext(
      payload(),
      { ...request, retrievalTime: RETRIEVAL },
      temporalConfig,
      { classify: keepClassify }
    );
    assert.equal(seen.length, 1, '一次共享请求');
    const { state, questions } = seen[0];
    assert.equal(state.retrieval_time, RETRIEVAL);
    assert.equal(
      state.sources[0]?.brave_page_date,
      '2026-09-16T00:00:00',
      '合法绝对时间优先于纯日期'
    );
    assert.equal(state.sources[1]?.brave_page_date, null, 'age 为空数组 → null，键恒在');

    // 组合题走三合一题干（s0 在数组位置 0，两片一组），页面题只判 filler
    const group = questions['s0__group0'];
    assert.ok(group);
    assert.equal(group.type, 'choice');
    assert.ok(
      group.instructions.startsWith('A=`sources[0].snippets[0]`; B=`sources[0].snippets[1]`.')
    );
    assert.ok(group.instructions.includes('architectural comparisons'));
    assert.ok(
      group.instructions.includes('an earlier prediction replaced by a confirmed event is obsolete')
    );
    const pageQuestion = questions['s0__filler'];
    assert.ok(pageQuestion);
    assert.ok(pageQuestion.instructions.startsWith('Judge the text of `sources[0]`.'));

    // 幸存内容与裁决照旧：全 keep 输出 Brave 原序两来源
    assert.equal(result.grounding.generic.length, 2);
  });

  it('invalid retrieval time is omitted from the state while page dates remain', async () => {
    seen.length = 0;
    await filterLlmContext(payload(), { ...request, retrievalTime: 'not a date' }, temporalConfig, {
      classify: keepClassify,
    });
    assert.equal(seen.length, 1);
    const { state } = seen[0];
    assert.equal('retrieval_time' in state, false, '非法值省略，绝不取系统时间冒充');
    assert.equal(state.sources[0]?.brave_page_date, '2026-09-16T00:00:00');
  });

  it('a single candidate keeps the time anchors with the shared all shape (no special template)', async () => {
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
      temporalConfig,
      { classify: keepClassify }
    );
    assert.equal(seen.length, 1);
    const state = seen[0].state;
    assert.equal(state.sources.length, 1, '单候选同样是 sources[] 全量形状');
    assert.equal(state.retrieval_time, RETRIEVAL);
    assert.equal(state.sources[0]?.brave_page_date, '2026-09-16');
    // 单片组合题（sources[0] 命名空间），不走特殊模板
    assert.match(
      seen[0].questions['s0__group0']?.instructions ?? '',
      /^A=`sources\[0\]\.snippets\[0\]`\. Keep A if/
    );
    assert.equal(stats.jev?.requests[0]?.request_id, 'j1');
  });
});

// ---------------------------------------------------------------------------
// LOCAL_DEDUP_CLEANUP_PLAN 最小行为回归集（§6.1）
// ---------------------------------------------------------------------------

describe('LOCAL_DEDUP_CLEANUP_PLAN minimal regression suite (§6.1)', () => {
  const regressionRequest: FilterCallContext = {
    params: { query: 'Brave release notes' },
    intent: 'Learn about the latest Brave browser updates and security notices',
  };

  it('日期与新事实：中文同日不同事件均保留，共享数字但新版本的片段保留', async () => {
    const data: BraveLlmContextResponse = {
      grounding: {
        generic: [
          {
            url: 'https://news.example/reg',
            title: 'Registration Notice',
            snippets: [
              'Brave 项目于2026-09-30开放注册。欢迎广大用户提前配置环境并参与首批公测体验，系统将在稍后发放邀请凭证。',
            ],
          },
          {
            url: 'https://sec.example/advisory',
            title: 'Security Advisory',
            snippets: [
              'Brave 安全公告确认，2026-09-30发现权限绕过漏洞，建议立即撤销公开链接并更新至最新安全补丁。',
            ],
          },
          {
            url: 'https://release.example/v14',
            title: 'Version 1.14 Update',
            snippets: [
              'Brave version 1.14 costs $4.2m and runs 193x faster with 40% less latency under heavy load benchmark testing.',
            ],
          },
        ],
        map: [],
      },
      sources: {},
    };

    const { result, stats } = await filterLlmContext(data, regressionRequest, offConfig);

    assert.equal(result.grounding.generic.length, 3);
    assert.ok(result.grounding.generic[0].snippets[0].includes('开放注册'));
    assert.ok(result.grounding.generic[1].snippets[0].includes('权限绕过漏洞'));
    assert.ok(result.grounding.generic[2].snippets[0].includes('1.14'));
  });

  it('结论与关联：共享相同指标与数字但反驳原结论的内容完整保留', async () => {
    const data: BraveLlmContextResponse = {
      grounding: {
        generic: [
          {
            url: 'https://benchmark.example/claim',
            title: 'Initial Claims',
            snippets: [
              'Brave version 1.13 costs $4.2m and runs 193x faster with 40% less latency in laboratory tests.',
            ],
          },
          {
            url: 'https://audit.example/rebuttal',
            title: 'Independent Audit Rebuttal',
            snippets: [
              'Independent tests show Brave version 1.13 does not cost $4.2m nor run 193x faster with 40% less latency in practice.',
            ],
          },
        ],
        map: [],
      },
      sources: {},
    };

    const { result, stats } = await filterLlmContext(data, regressionRequest, offConfig);

    assert.equal(result.grounding.generic.length, 2);
    assert.ok(result.grounding.generic[1].snippets[0].includes('does not cost $4.2m'));
  });

  it('近似不等于重复：高度重复正文加关键短句在页内与不同来源之间均保留', async () => {
    const base =
      'Brave browser ships with native ad blocking, fingerprinting protection, and multi-threaded script execution.';
    const pageWithBonus = `${base} 启动前必须关闭硬件加速才能启用实验模式。`;
    const crossWithBonus = `${base} 生产环境严禁直接开放未授权公网访问。`;

    const data: BraveLlmContextResponse = {
      grounding: {
        generic: [
          {
            url: 'https://docs.example/page1',
            title: 'Page 1 Documentation',
            snippets: [base, pageWithBonus],
          },
          {
            url: 'https://docs.example/page2',
            title: 'Page 2 Documentation',
            snippets: [crossWithBonus],
          },
        ],
        map: [],
      },
      sources: {},
    };

    const { result, stats } = await filterLlmContext(data, regressionRequest, offConfig);

    assert.equal(result.grounding.generic.length, 2);
    // 页内：两段均保留
    assert.equal(result.grounding.generic[0].snippets.length, 2);
    assert.ok(result.grounding.generic[0].snippets[1].includes('关闭硬件加速'));
    // 跨来源：保留
    assert.equal(result.grounding.generic[1].snippets.length, 1);
    assert.ok(result.grounding.generic[1].snippets[0].includes('严禁直接开放未授权公网访问'));
    assert.equal(stats.local.dup_removed, 0);
  });

  it('文本区别：代码大小写、缩进不同与负号不同不因去重合并', async () => {
    const codeRequest: FilterCallContext = {
      params: { query: 'configure maxRetries' },
      intent: 'Find maxRetries settings in source code',
    };
    const data: BraveLlmContextResponse = {
      grounding: {
        generic: [
          {
            url: 'https://code.example/s0',
            title: 'Code S0',
            snippets: ['function configure() {\n  return maxRetries;\n}'],
          },
          {
            url: 'https://code.example/s1',
            title: 'Code S1',
            snippets: ['function configure() {\n    return maxRetries;\n}'],
          },
          {
            url: 'https://code.example/s2',
            title: 'Code S2',
            snippets: ['function configure() {\n  return -maxRetries;\n}'],
          },
          {
            url: 'https://code.example/s3',
            title: 'Code S3',
            snippets: ['function configure() {\n  return MAX_RETRIES;\n}'],
          },
        ],
        map: [],
      },
      sources: {},
    };

    const { result, stats } = await filterLlmContext(data, codeRequest, offConfig);

    assert.equal(result.grounding.generic.length, 4);
  });

  it('完整重复不进行本地删除，独立保留出处', async () => {
    const textA = 'Brave browser official release announcement.';
    const shortText = 'Release v1.14';

    const data: BraveLlmContextResponse = {
      grounding: {
        generic: [
          {
            url: 'https://origin.example/s0',
            title: 'Origin S0',
            snippets: [textA, textA, shortText],
          },
          {
            url: 'https://mirror.example/s1',
            title: 'Mirror S1',
            snippets: [shortText],
          },
        ],
        map: [],
      },
      sources: {},
    };

    const { result, stats } = await filterLlmContext(data, regressionRequest, offConfig);

    // 完整重复不进行本地删除，原样保留（dup_removed = 0）
    assert.equal(result.grounding.generic[0].snippets.length, 3);
    assert.equal(stats.local.dup_removed, 0);

    // s1 保留独立来源的相同短片段。
    assert.equal(result.grounding.generic.length, 2);
    const mirror = stats.sources.find((s) => s.url === 'https://mirror.example/s1');
    assert.equal(mirror?.verdict, 'keep');
    assert.equal(mirror?.reason, undefined);
  });

  it('参照与顺序：被来源裁决删除的内容不影响后续来源参照，Brave 顺序保持', async () => {
    const commonText = 'Brave native privacy features documentation and architecture overview.';

    const data: BraveLlmContextResponse = {
      grounding: {
        generic: [
          {
            url: 'https://offtopic.example/s0',
            title: 'Offtopic S0',
            snippets: [commonText],
          },
          {
            url: 'https://legit.example/s1',
            title: 'Legit S1',
            snippets: [commonText],
          },
        ],
        map: [],
      },
      sources: {},
    };

    const classify: ClassifyDeps['classify'] = async ({ questions }) => ({
      status: 'answered',
      model: DEFAULT_JEV_MODEL,
      input_tokens: 10,
      answers: Object.fromEntries(
        Object.entries(questions).map(([key, q]) => [
          key,
          key.includes('s0__filler')
            ? { kind: 'noul', probability: 0.99 }
            : q.type === 'choice'
              ? { kind: 'choice', probabilities: allKeepProbabilities(q.criteria) }
              : { kind: 'noul', probability: 0 },
        ])
      ),
    });

    const { result, stats } = await filterLlmContext(
      data,
      regressionRequest,
      { ...offConfig, mode: 'on' },
      { classify }
    );

    // s0 被来源裁决（filler）删除，其片段不能压掉 s1
    assert.equal(result.grounding.generic.length, 1);
    assert.equal(result.grounding.generic[0].url, 'https://legit.example/s1');
    assert.equal(result.grounding.generic[0].snippets[0], commonText);
  });

  it('Jev 集成：组合题全保留的新事实完整保留', async () => {
    const data: BraveLlmContextResponse = {
      grounding: {
        generic: [
          {
            url: 'https://origin.example/s0',
            title: 'Origin S0',
            snippets: [
              'Brave version 1.13 costs $4.2m and runs 193x faster with 40% less latency under test.',
            ],
          },
          {
            url: 'https://update.example/s1',
            title: 'Update S1',
            snippets: [
              'Brave version 1.14 costs $4.2m and runs 193x faster with 40% less latency under test.',
            ],
          },
        ],
        map: [],
      },
      sources: {},
    };

    const classify: ClassifyDeps['classify'] = async ({ questions }) => ({
      status: 'answered',
      model: DEFAULT_JEV_MODEL,
      input_tokens: 10,
      answers: keepAllAnswers(questions),
    });

    const { result } = await filterLlmContext(
      data,
      regressionRequest,
      { ...offConfig, mode: 'on' },
      { classify }
    );

    assert.equal(result.grounding.generic.length, 2);
    assert.ok(result.grounding.generic[1].snippets[0].includes('1.14'));
  });
});

/** 使用实际来源验证站点清理、通用分流和 Jev 派发的接入顺序。 */
describe('dev.to 清理接入', () => {
  const sources: BraveLlmContextGenericItem[] = JSON.parse(
    readFileSync(new URL('../../fixtures/log-derived/devto-outlines.json', import.meta.url), 'utf8')
  );
  const input: BraveLlmContextResponse = { grounding: { generic: sources }, sources: {} };
  // 通用预筛会剥掉 FAQ 栏目标题，问答内容仍逐字保留。
  const expectedBodies = sources.map((source) =>
    source.snippets.slice(0, -1).map((text) => text.replace('## Frequently Asked Questions\n', ''))
  );
  const req = {
    params: { query: 'code review multi agent caveman' },
    intent: 'Compare code review tools and multi-agent workflows.',
  };

  for (const mode of ['off', 'test', 'on'] as const) {
    it(`${mode} 按模式清理提纲，保留正文顺序并准确记录动作`, async () => {
      const filtered = await filterLlmContext(input, req, { ...offConfig, mode });
      assert.equal(filtered.stats.local.devto_cleanup_actions, mode === 'off' ? 0 : 3);
      assert.equal(filtered.stats.local.jsonld_dropped, 0);
      assert.equal(filtered.stats.local.dup_removed, 0);
      assert.equal(filtered.stats.local.jsonld_converted, mode === 'off' ? 2 : 0);
      assert.deepEqual(
        filtered.result.grounding.generic.map((item) => item.url),
        sources.map((item) => item.url)
      );
      for (const [index, source] of sources.entries()) {
        const stats = filtered.stats.sources[index].snippets.at(-1)!;
        const snippets = filtered.result.grounding.generic[index].snippets;
        if (mode === 'off') {
          assert.equal(stats.devto_cleanup, undefined);
          assert.equal(stats.kept, true);
        } else {
          assert.equal(stats.index, source.snippets.length - 1);
          assert.equal(stats.part, undefined);
          assert.equal(stats.reason, 'boilerplate');
          assert.equal(stats.kept, false);
          assert.deepEqual(stats.devto_cleanup, [{ rule: 'article_outline' }]);
          assert.deepEqual(snippets, expectedBodies[index]);
        }
      }
    });
  }

  it('Jev 和候选导出都接收清理后的正文，输入样本保持不变', async () => {
    const original = structuredClone(input);
    let sent: JevState | undefined;
    const config = { ...offConfig, mode: 'on' as const };
    const filtered = await filterLlmContext(input, req, config, {
      classify: async ({ state, questions }) => {
        sent = state;
        return {
          status: 'answered',
          model: DEFAULT_JEV_MODEL,
          input_tokens: 10,
          answers: keepAllAnswers(questions),
        };
      },
    });
    assert.ok(sent);
    const candidates = collectJevCandidatesDetailed(input, req, config);
    for (const [index, source] of sources.entries()) {
      const expected = expectedBodies[index];
      assert.deepEqual(
        candidates[index].snippets.map((snippet) => snippet.text),
        expected
      );
      assert.deepEqual(sent.sources[index].snippets, expected);
      assert.deepEqual(filtered.result.grounding.generic[index].snippets, expected);
    }
    assert.deepEqual(input, original);
  });

  it('非 dev.to 的独有 text 正文保留，dev.to 只有提纲而缺少正文时也保留', async () => {
    const text = JSON.stringify({
      mainEntity: { text: 'Schema migration requires rebuilding the search index.' },
    });
    const data: BraveLlmContextResponse = {
      grounding: {
        generic: [
          { url: 'https://example.com/migration', title: 'Schema migration', snippets: [text] },
          { ...sources[0], snippets: [sources[0].snippets.at(-1)!] },
        ],
      },
      sources: {},
    };
    const filtered = await filterLlmContext(
      data,
      { params: { query: 'schema review migration' }, intent: 'Find migration evidence.' },
      { ...offConfig, mode: 'test' }
    );
    assert.deepEqual(filtered.result.grounding.generic, data.grounding.generic);
    assert.equal(filtered.stats.local.devto_cleanup_actions, 0);
    assert.equal(filtered.stats.local.jsonld_dropped, 0);
  });
});
