import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { connectTestClient, useTestClient } from '../../testUtils/mcpTestHarness.js';
import { JEV_CONFIG_FILE_ENV } from '../../filter/config.js';
import { name, resetFilterStateForTest } from './index.js';
import { LlmContextInputSchema, RequestParamsSchema } from './schemas/input.js';

// 过滤层配置自 02-FIX 批 B 起只有一个载体：JEV_FILTER_CONFIG_FILE 指向的 JSON 文件。
// 适配行持进程级惰性单例（启动时读一次），所以每个用例前后都要清单例并隔离该变量。
const FILTER_ENV_VARS = [JEV_CONFIG_FILE_ENV] as const;

/** 临时配置目录：整个文件一个，测后统一清理。 */
const configDir = mkdtempSync(join(tmpdir(), 'jev-llm-context-test-'));

// execute() 现在每请求写一条 JSONL 日志（D-16），无显式 log_dir 时默认
// ~/.brave-jev/logs 会把测试日志写进真实 home——测试一律指进临时目录，用后即删
// （T-03-03）。这份默认隔离配置只改 log_dir，其余全默认（mode off）。
const defaultLogDir = mkdtempSync(join(tmpdir(), 'jev-llm-context-logs-'));
const defaultConfigPath = join(configDir, 'default-config.json');
writeFileSync(defaultConfigPath, JSON.stringify({ log_dir: defaultLogDir }), 'utf8');

after(() => {
  rmSync(configDir, { recursive: true, force: true });
  rmSync(defaultLogDir, { recursive: true, force: true });
});

/**
 * 写入配置 JSON 并让适配行重新读一次：设 `JEV_FILTER_CONFIG_FILE` 指向新文件、
 * 清掉惰性单例。返回文件路径，供"改内容后再搜索"的用例复用同一路径。
 * 配置对象默认注入临时 `log_dir`（用例显式给出时以用例为准）。
 */
const useFilterConfig = (
  value: unknown,
  filename = `config-${Date.now()}-${Math.random()}.json`
) => {
  const filePath = join(configDir, filename);
  const withLogDir = { log_dir: defaultLogDir, ...(value as Record<string, unknown>) };
  writeFileSync(filePath, JSON.stringify(withLogDir), 'utf8');
  process.env[JEV_CONFIG_FILE_ENV] = filePath;
  resetFilterStateForTest();
  return filePath;
};

// 在 describe 体内注册一对 before/after，把配置文件变量指到默认隔离配置（不再
// 指向真实配置）、清单例；after 恢复原值
const useIsolatedFilterEnv = () => {
  const originalEnv = Object.fromEntries(FILTER_ENV_VARS.map((key) => [key, process.env[key]]));

  before(() => {
    for (const key of FILTER_ENV_VARS) delete process.env[key];
    process.env[JEV_CONFIG_FILE_ENV] = defaultConfigPath;
    resetFilterStateForTest();
  });

  after(() => {
    for (const key of FILTER_ENV_VARS) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
    resetFilterStateForTest();
  });
};

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

describe(`${name} (status line and JSONL log)`, () => {
  useIsolatedFilterEnv();

  const logDirs: string[] = [];

  after(() => {
    for (const dir of logDirs) rmSync(dir, { recursive: true, force: true });
  });

  // 写入在进程内 promise 链里异步完成：让出一轮事件循环等它落盘再断言
  const flushWrites = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

  /** 建一个独立的临时 log_dir 并登记，测后统一清理。 */
  const newLogDir = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'jev-statusline-log-'));
    logDirs.push(dir);
    return dir;
  };

  /** 最小合法上游载荷（照抄文件顶部的 braveResponse 形状）。 */
  const cleanResponse = {
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
        age: [],
      },
    },
  };

  // 有丢弃的载荷：第二个来源只有空白片段（步 3 删光 → 步 8 空来源丢弃）；
  // 幸存来源的片段长过 200 字符，避免步 8 的一句话来源规则把它也丢掉
  // （drop case 的 query 实词不在片段里，短片段会被 isOneLiner 判丢）
  const dropResponse = {
    grounding: {
      generic: [
        {
          url: 'https://good.example/post',
          title: 'Good Post',
          snippets: [
            'A real snippet with enough content to survive every local rule in the pipeline. '.repeat(
              3
            ),
          ],
        },
        {
          url: 'https://empty.example/',
          title: 'Empty Page',
          snippets: ['   '],
        },
      ],
      map: [],
    },
    sources: {
      'https://good.example/post': { title: 'Good Post', hostname: 'good.example', age: [] },
      'https://empty.example/': { title: 'Empty Page', hostname: 'empty.example', age: [] },
    },
  };

  const getClient = useTestClient((url) => {
    if (url.pathname === '/res/v1/llm/context') {
      return url.searchParams.get('q') === 'drop case' ? dropResponse : cleanResponse;
    }
  });

  it('appends no second block without drops and still writes one JSONL record', async () => {
    const logDir = newLogDir();
    useFilterConfig({ mode: 'off', log_dir: logDir });

    const result = await getClient().callTool({
      name,
      arguments: {
        query: 'brave browser',
        intent: 'What Brave Search is and how it differs from other engines',
      },
    });

    assert.equal(result.isError ?? false, false, JSON.stringify(result.content));
    const content = result.content as { text: string }[];
    // 无丢弃：content 恰一块（D-08 追加条件与 buildStatusLine 返回值同源）
    assert.equal(content.length, 1);

    // 临时 log_dir 恰一个按天文件、恰一行、可解析、含 mode 与 ts
    await flushWrites();
    const files = readdirSync(logDir).filter((file) => file.endsWith('.jsonl'));
    assert.equal(files.length, 1);
    const lines = readFileSync(join(logDir, files[0]), 'utf8').split('\n').filter(Boolean);
    assert.equal(lines.length, 1);
    const record = JSON.parse(lines[0]) as Record<string, unknown>;
    assert.equal(record.mode, 'off');
    assert.match(String(record.ts), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/);
  });

  it('appends a single-line status block identical to stats.output.status_line with drops', async () => {
    const logDir = newLogDir();
    useFilterConfig({ mode: 'off', log_dir: logDir });

    const result = await getClient().callTool({
      name,
      arguments: {
        query: 'drop case',
        intent: 'What Brave Search is and how it differs from other engines',
      },
    });

    assert.equal(result.isError ?? false, false, JSON.stringify(result.content));
    const content = result.content as { text: string }[];
    // 有丢弃：第二块存在、以 [filter] 开头、单行英文
    assert.equal(content.length, 2);
    const statusLine = content[1].text;
    assert.ok(statusLine.startsWith('[filter] '), statusLine);
    assert.ok(!statusLine.includes('\n'), 'status line must be a single line');

    // D-08 同源红线：状态行文本与 JSON 块内 stats.output.status_line 逐字相同
    const payload = JSON.parse(content[0].text) as { output: { status_line?: string } };
    assert.equal(payload.output.status_line, statusLine);
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
    // delete 覆盖本机 shell 里设的 key
    const savedKeys: Array<[string, string | undefined]> = ['TYPESAFE_API_KEY'].map((key) => [
      key,
      process.env[key],
    ]);
    for (const [key] of savedKeys) delete process.env[key];
    // mode 来自配置文件（旧 JEV_FILTER_MODE 变量已不再被读）
    useFilterConfig({ mode: 'on' });

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
      for (const [key, value] of savedKeys) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

describe(`${name} (config file lifecycle)`, () => {
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

  const call = () =>
    getClient().callTool({
      name,
      arguments: {
        query: 'brave browser',
        intent: 'What Brave Search is',
        maximum_number_of_urls: 5,
      },
    });

  it('reads the config file once: rewriting it does not change the running behaviour', async () => {
    // 第一次搜索：factor 2 → 发给 Brave 的 maximum_number_of_urls 被放大成 10
    const filePath = useFilterConfig({ overfetch_factor: 2 });
    assert.equal((await call()).isError ?? false, false);
    assert.equal(forwarded[0].searchParams.get('maximum_number_of_urls'), '10');

    // 改写同一个文件（factor 1 / mode on），不重启：进程级单例仍在，行为不变
    writeFileSync(filePath, JSON.stringify({ mode: 'on', overfetch_factor: 1 }), 'utf8');
    assert.equal((await call()).isError ?? false, false);
    assert.equal(calls, 2);
    assert.equal(forwarded[1].searchParams.get('maximum_number_of_urls'), '10');
  });

  it('ignores the removed JEV_FILTER_MODE variable entirely', async () => {
    // 新写一份不含 mode 的配置（上一条用例已把旧文件改成 mode on），删掉 key，
    // 旧变量设成 on：若它仍被读，on 缺 key 会打 "No Jev API key" 那一行；
    // 走 off 则一行都不打（审查 R2）
    const savedKey = process.env.TYPESAFE_API_KEY;
    const savedMode = process.env.JEV_FILTER_MODE;
    delete process.env.TYPESAFE_API_KEY;
    useFilterConfig({ overfetch_factor: 1 });
    process.env.JEV_FILTER_MODE = 'on';

    const errors: unknown[][] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args);
    };
    try {
      const result = await call();
      assert.equal(result.isError ?? false, false, JSON.stringify(result.content));
      assert.ok(
        !errors.some((args) => args.some((arg) => String(arg).includes('No Jev API key'))),
        `JEV_FILTER_MODE must not switch the mode on: ${JSON.stringify(errors)}`
      );
    } finally {
      console.error = originalError;
      if (savedMode === undefined) delete process.env.JEV_FILTER_MODE;
      else process.env.JEV_FILTER_MODE = savedMode;
      if (savedKey === undefined) delete process.env.TYPESAFE_API_KEY;
      else process.env.TYPESAFE_API_KEY = savedKey;
      resetFilterStateForTest();
    }
  });
});

describe(`${name} (tool_description_file from config)`, () => {
  useIsolatedFilterEnv();

  it('overrides the tool description with the file named in the config', async () => {
    // register 必须从配置取描述文件路径（审查 R6）：适配行改成 undefined 这条就红
    const descPath = join(configDir, `desc-${Date.now()}.md`);
    writeFileSync(descPath, 'Custom description from file.', 'utf8');
    useFilterConfig({ tool_description_file: descPath });

    const client = await connectTestClient();
    try {
      const { tools } = await client.listTools();
      const tool = tools.find((t) => t.name === name);
      assert.ok(tool);
      assert.equal(tool.description, 'Custom description from file.');
    } finally {
      await client.close();
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

describe(`${name} (brave 500 error logging)`, () => {
  useIsolatedFilterEnv();

  let restoreFetch: () => void = () => {};
  const logDir = mkdtempSync(join(tmpdir(), 'jev-error-log-'));

  before(() => {
    // useTestClient 的桩固定回 200：这条用例要真 500，自管 fetch 桩
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response('{"error":"boom"}', {
        status: 500,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;
    restoreFetch = () => {
      globalThis.fetch = originalFetch;
    };
  });

  after(() => {
    restoreFetch();
    rmSync(logDir, { recursive: true, force: true });
  });

  it('writes one error record and still returns an error result when Brave fails', async () => {
    useFilterConfig({ mode: 'off', log_dir: logDir });
    const client = await connectTestClient();
    try {
      const result = await client.callTool({
        name,
        arguments: { query: 'brave browser', intent: 'What Brave Search is' },
      });
      assert.equal(result.isError, true);

      // 错误请求也落账（Brave 报错记 stage 'brave'）：临时 log_dir 恰一条含
      // error 字段的记录
      await new Promise((resolve) => setImmediate(resolve));
      const files = readdirSync(logDir).filter((file) => file.endsWith('.jsonl'));
      assert.equal(files.length, 1);
      const lines = readFileSync(join(logDir, files[0]), 'utf8').split('\n').filter(Boolean);
      assert.equal(lines.length, 1);
      const record = JSON.parse(lines[0]) as Record<string, unknown>;
      const error = record.error as { stage: string; message: string } | undefined;
      assert.ok(error, `error field missing: ${lines[0]}`);
      assert.equal(error.stage, 'brave');
      assert.match(error.message, /500/);
    } finally {
      await client.close();
    }
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
