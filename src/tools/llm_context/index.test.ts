import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { useTestClient } from '../../testUtils/mcpTestHarness.js';
import { name } from './index.js';
import { RequestParamsSchema } from './schemas/input.js';

// 过滤层读取的环境变量：经过 execute() 的用例都要先删掉，避免开发机 .env 泄漏进测试
const FILTER_ENV_VARS = [
  'JEV_FILTER_MODE',
  'JEV_FILTER_OVERFETCH_FACTOR',
  'JEV_FILTER_TOOL_DESCRIPTION_FILE',
] as const;

// 声明白名单：补丁脚本 KEEP_PARAMS 逐字；再加必填 intent
const WHITELIST = [
  'query',
  'country',
  'search_lang',
  'count',
  'maximum_number_of_urls',
  'maximum_number_of_tokens',
  'maximum_number_of_tokens_per_url',
  'freshness',
  'goggles',
];

// 在 describe 体内注册一对 before/after，删掉并恢复过滤层环境变量
const useIsolatedFilterEnv = () => {
  const originalEnv = Object.fromEntries(FILTER_ENV_VARS.map((key) => [key, process.env[key]]));

  before(() => {
    for (const key of FILTER_ENV_VARS) {
      delete process.env[key];
    }
  });

  after(() => {
    for (const key of FILTER_ENV_VARS) {
      if (originalEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originalEnv[key];
      }
    }
  });
};

// 最小合法上游载荷：两个来源；第一个带完整元数据（age 四元数组），第二个 age 为空数组
const braveResponse = {
  grounding: {
    generic: [
      {
        url: 'https://search.brave.com/',
        title: 'Brave Search',
        snippets: ['Brave is a privacy-focused browser and search engine.'],
      },
      {
        url: 'https://example.com/post',
        title: 'Example Post',
        snippets: ['Example snippet one.', 'Example snippet two.'],
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
    'https://example.com/post': {
      title: 'Example Post',
      hostname: 'example.com',
      age: [],
    },
  },
};

describe(name, () => {
  useIsolatedFilterEnv();

  let calls = 0;
  let intentForwarded = false;

  const getClient = useTestClient((url) => {
    if (url.pathname === '/res/v1/llm/context') {
      calls++;
      intentForwarded = intentForwarded || url.searchParams.has('intent');
      return braveResponse;
    }
  });

  it('declares only the whitelist plus required intent, no outputSchema', async () => {
    const { tools } = await getClient().listTools();
    const tool = tools.find((t) => t.name === name);

    assert.ok(tool, `${name} is not listed`);
    assert.deepEqual(
      Object.keys(tool.inputSchema.properties ?? {}).sort(),
      [...WHITELIST, 'intent'].sort()
    );
    assert.deepEqual(tool.inputSchema.required, ['query', 'intent']);
    assert.equal(tool.outputSchema, undefined);
    assert.match(tool.description ?? '', /name the current version and its defining mechanism/);
    // 方言补丁仍然生效
    assert.equal(tool.inputSchema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  });

  it('returns text-only content with trimmed sources and a single Brave request', async () => {
    const result = await getClient().callTool({
      name,
      arguments: {
        query: 'brave browser',
        intent: 'What Brave Search is and how it differs from other engines',
      },
    });

    assert.equal(result.isError ?? false, false, JSON.stringify(result.content));
    assert.equal(result.structuredContent, undefined);

    const content = result.content as { text: string }[];
    const payload = JSON.parse(content[0].text);

    // off 模式是结构直通：幸存来源与片段逐条等于输入
    assert.deepEqual(payload.grounding.generic, braveResponse.grounding.generic);
    assert.deepEqual(payload.grounding.map, []);

    // sources 只留 title / hostname / age；age 只留首个 ISO 日期，空数组时省略键
    assert.deepEqual(Object.keys(payload.sources), [
      'https://search.brave.com/',
      'https://example.com/post',
    ]);
    assert.deepEqual(payload.sources['https://search.brave.com/'], {
      title: 'Brave Search',
      hostname: 'search.brave.com',
      age: ['2026-09-16'],
    });
    assert.deepEqual(Object.keys(payload.sources['https://search.brave.com/']).sort(), [
      'age',
      'hostname',
      'title',
    ]);
    assert.deepEqual(payload.sources['https://example.com/post'], {
      title: 'Example Post',
      hostname: 'example.com',
    });

    // 整个调用只打一次 Brave，且 intent 没有转发给 Brave
    assert.equal(calls, 1);
    assert.equal(intentForwarded, false);
  });
});

describe(`${name} (missing intent)`, () => {
  useIsolatedFilterEnv();

  let calls = 0;

  const getClient = useTestClient((url) => {
    if (url.pathname === '/res/v1/llm/context') {
      calls++;
      return braveResponse;
    }
  });

  it('rejects a call without intent before reaching Brave', async () => {
    const result = await getClient().callTool({ name, arguments: { query: 'brave browser' } });

    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.content), /intent/);
    assert.equal(calls, 0);
  });

  it('rejects a blank intent before reaching Brave', async () => {
    const result = await getClient().callTool({
      name,
      arguments: { query: 'brave browser', intent: '   ' },
    });

    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.content), /intent/);
    assert.equal(calls, 0);
  });
});

describe(`${name} (malformed upstream response)`, () => {
  useIsolatedFilterEnv();

  const getClient = useTestClient((url) => {
    if (url.pathname === '/res/v1/llm/context') {
      // `sources` is required by the output schema; omitting it simulates
      // an upstream response that fails validation.
      return {
        grounding: { generic: [], map: [] },
      };
    }
  });

  it('surfaces the validation failure as an error result', async () => {
    const result = await getClient().callTool({
      name,
      arguments: { query: 'brave browser', intent: 'What Brave Search is' },
    });

    assert.equal(result.isError, true);
    assert.ok(JSON.stringify(result.content).includes('sources'), JSON.stringify(result.content));
  });
});

describe(`${name} (below-minimum clamping)`, () => {
  useIsolatedFilterEnv();

  let calls = 0;
  const forwarded: URL[] = [];

  const getClient = useTestClient((url) => {
    if (url.pathname === '/res/v1/llm/context') {
      calls++;
      forwarded.push(url);
      return braveResponse;
    }
  });

  it('raises below-minimum values, forwards the clamped ones, and reports the adjustment', async () => {
    const result = await getClient().callTool({
      name,
      arguments: {
        query: 'brave browser',
        intent: 'What Brave Search is',
        count: 0,
        maximum_number_of_urls: -1,
        maximum_number_of_tokens: 100,
        maximum_number_of_tokens_per_url: 500,
      },
    });

    assert.equal(result.isError ?? false, false, JSON.stringify(result.content));

    const payload = JSON.parse((result.content as { text: string }[])[0].text);
    assert.deepEqual(payload.parameter_adjustments, {
      count: { requested: 0, applied: 1 },
      maximum_number_of_urls: { requested: -1, applied: 1 },
      maximum_number_of_tokens: { requested: 100, applied: 1024 },
      maximum_number_of_tokens_per_url: { requested: 500, applied: 512 },
    });

    // Brave 收到的是钳位后的值
    const params = forwarded[forwarded.length - 1].searchParams;
    assert.equal(params.get('count'), '1');
    assert.equal(params.get('maximum_number_of_urls'), '1');
    assert.equal(params.get('maximum_number_of_tokens'), '1024');
    assert.equal(params.get('maximum_number_of_tokens_per_url'), '512');
  });

  it('leaves values at or above the minimum untouched and adds no adjustment key', async () => {
    const result = await getClient().callTool({
      name,
      arguments: {
        query: 'brave browser',
        intent: 'What Brave Search is',
        count: 10,
        maximum_number_of_tokens_per_url: 512,
      },
    });

    assert.equal(result.isError ?? false, false, JSON.stringify(result.content));

    const payload = JSON.parse((result.content as { text: string }[])[0].text);
    assert.equal(payload.parameter_adjustments, undefined);

    const params = forwarded[forwarded.length - 1].searchParams;
    assert.equal(params.get('count'), '10');
    assert.equal(params.get('maximum_number_of_tokens_per_url'), '512');
  });

  it('still rejects above-maximum and non-integer values before reaching Brave', async () => {
    const before = calls;

    const overMax = await getClient().callTool({
      name,
      arguments: {
        query: 'brave browser',
        intent: 'What Brave Search is',
        maximum_number_of_tokens_per_url: 9000,
      },
    });
    assert.equal(overMax.isError, true);
    assert.match(JSON.stringify(overMax.content), /8192/);

    const fractional = await getClient().callTool({
      name,
      arguments: {
        query: 'brave browser',
        intent: 'What Brave Search is',
        count: 1.5,
      },
    });
    assert.equal(fractional.isError, true);
    assert.match(JSON.stringify(fractional.content), /expected int/);

    assert.equal(calls, before);
  });

  it('advertises the maximum but not the minimum; the description states the floor', async () => {
    const { tools } = await getClient().listTools();
    const tool = tools.find((t) => t.name === name);

    assert.ok(tool, `${name} is not listed`);
    const perUrl = tool.inputSchema.properties.maximum_number_of_tokens_per_url;
    assert.equal(perUrl.maximum, 8192);
    assert.equal(perUrl.minimum, undefined);
    assert.match(perUrl.description, /below 512 are raised to 512/);
  });

  it('keeps the upstream RequestParamsSchema still rejecting below-minimum values', () => {
    assert.equal(RequestParamsSchema.shape.count.safeParse(0).success, false);
    assert.equal(RequestParamsSchema.shape.maximum_number_of_urls.safeParse(0).success, false);
    assert.equal(RequestParamsSchema.shape.maximum_number_of_tokens.safeParse(1023).success, false);
    assert.equal(
      RequestParamsSchema.shape.maximum_number_of_tokens_per_url.safeParse(511).success,
      false
    );
  });
});
