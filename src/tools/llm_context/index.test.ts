import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { useTestClient } from '../../testUtils/mcpTestHarness.js';
import { name } from './index.js';
import { LlmContextInputSchema, RequestParamsSchema } from './schemas/input.js';

// 过滤层读取的环境变量：经过 execute() 的用例都要先删掉，避免开发机 .env 泄漏进测试
const FILTER_ENV_VARS = [
  'JEV_FILTER_MODE',
  'JEV_FILTER_OVERFETCH_FACTOR',
  'JEV_FILTER_TOOL_DESCRIPTION_FILE',
  'JEV_FILTER_JEV_MODEL',
  'JEV_FILTER_JEV_BACKEND',
  'JEV_FILTER_JEV_TIMEOUT_MS',
  'JEV_FILTER_JEV_CONCURRENCY',
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
        snippets: ['Example snippet one about Brave.', 'Example snippet two about Brave.'],
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

describe(`${name} (no jev key, mode on)`, () => {
  useIsolatedFilterEnv();

  let calls = 0;

  const getClient = useTestClient((url) => {
    if (url.pathname === '/res/v1/llm/context') {
      calls++;
      return braveResponse;
    }
  });

  it('treats a missing key as off: normal result, one stderr line, zero Jev traffic', async () => {
    // key 变量不在 FILTER_ENV_VARS 名单（全局约定名），本用例内单独装卸：
    // Windows 的 process.env 大小写不敏感，delete 覆盖本机 shell 的 JEV_API_KEY
    const savedKeys: Array<[string, string | undefined]> = ['jev_API_KEY', 'TYPESAFE_API_KEY'].map(
      (key) => [key, process.env[key]]
    );
    for (const [key] of savedKeys) delete process.env[key];
    process.env.JEV_FILTER_MODE = 'on';

    const errors: unknown[][] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args);
    };

    try {
      const result = await getClient().callTool({
        name,
        arguments: {
          query: 'brave browser',
          intent: 'What Brave Search is and how it differs from other engines',
        },
      });

      // 输出正常（no_key 等价 off：本地规则对夹具零删减，stats.jev 由管道记 no_key
      // 零值对象——pipeline.test.ts 的未注入 classify 用例已锁该记账）
      assert.equal(result.isError ?? false, false, JSON.stringify(result.content));
      const payload = JSON.parse((result.content as { text: string }[])[0].text);
      assert.deepEqual(payload.grounding.generic, braveResponse.grounding.generic);

      // 一行带 [jev-filter] 前缀的 stderr 说明
      assert.equal(errors.length, 1, `expected exactly one stderr line, got ${errors.length}`);
      assert.ok(
        errors[0].some((arg) => String(arg).includes('[jev-filter]')),
        JSON.stringify(errors[0])
      );

      // 只有 Brave 一次调用——桩对 Jev 端点未 mock，任何 Jev 出站请求都会抛错失败
      assert.equal(calls, 1);
    } finally {
      console.error = originalError;
      delete process.env.JEV_FILTER_MODE;
      for (const [key, value] of savedKeys) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
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

  it('advertises the maximum but no minimum at all; the description states the floor', async () => {
    const { tools } = await getClient().listTools();
    const tool = tools.find((t) => t.name === name);

    assert.ok(tool, `${name} is not listed`);
    const properties = (tool.inputSchema.properties ?? {}) as Record<
      string,
      { maximum?: number; minimum?: number; description?: string }
    >;
    // zod 4.3.6 会把 .int() 的安全整数域渲染成 minimum: -2^53+1 噪音；用
    // .meta({ minimum: undefined }) 压掉，业务下限只写在描述里。断言键不存在
    // （而非 !== 512），zod 版本一变渲染行为就会在这里报警。
    for (const key of [
      'count',
      'maximum_number_of_urls',
      'maximum_number_of_tokens',
      'maximum_number_of_tokens_per_url',
    ]) {
      assert.equal(
        Object.hasOwn(properties[key] ?? {}, 'minimum'),
        false,
        `${key} must not advertise a minimum`
      );
      assert.ok(properties[key], `${key} must be advertised`);
    }
    assert.equal(properties.count?.maximum, 50);
    assert.equal(properties.maximum_number_of_urls?.maximum, 50);
    assert.equal(properties.maximum_number_of_tokens?.maximum, 32768);
    assert.equal(properties.maximum_number_of_tokens_per_url?.maximum, 8192);
    assert.match(
      properties.maximum_number_of_tokens_per_url?.description ?? '',
      /below 512 are raised to 512/
    );

    // SDK 校验层对 500 放行——下限钳位发生在 execute() 里
    assert.equal(
      LlmContextInputSchema.safeParse({
        query: 'q',
        intent: 'i',
        maximum_number_of_tokens_per_url: 500,
      }).success,
      true
    );
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
