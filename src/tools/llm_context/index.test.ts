import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
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

  it('records freshness only when the request carries it and omits both optional request keys otherwise', async () => {
    const logDir = newLogDir();
    useFilterConfig({ mode: 'off', log_dir: logDir });

    // 带 freshness 的调用：记录 request 含该键（D-10）
    const withFreshness = await getClient().callTool({
      name,
      arguments: {
        query: 'brave browser',
        intent: 'What Brave Search is and how it differs from other engines',
        freshness: 'pw',
      },
    });
    assert.equal(withFreshness.isError ?? false, false, JSON.stringify(withFreshness.content));

    await flushWrites();
    const files = readdirSync(logDir).filter((file) => file.endsWith('.jsonl'));
    assert.equal(files.length, 1);
    const lines = readFileSync(join(logDir, files[0]), 'utf8').split('\n').filter(Boolean);
    assert.equal(lines.length, 1);
    const withRecord = JSON.parse(lines[0]) as { request: Record<string, unknown> };
    assert.equal(withRecord.request.freshness, 'pw');

    // 不带的调用：记录 request 无 freshness 也无 context_threshold_mode——
    // 条件 spread 省略 undefined 键（deepEqual 对显式 undefined 键判不等）
    const without = await getClient().callTool({
      name,
      arguments: {
        query: 'brave browser',
        intent: 'What Brave Search is and how it differs from other engines',
      },
    });
    assert.equal(without.isError ?? false, false, JSON.stringify(without.content));

    await flushWrites();
    const allLines = readFileSync(join(logDir, files[0]), 'utf8').split('\n').filter(Boolean);
    assert.equal(allLines.length, 2);
    const withoutRecord = JSON.parse(allLines[1]) as { request: Record<string, unknown> };
    assert.equal(Object.hasOwn(withoutRecord.request, 'freshness'), false);
    assert.equal(Object.hasOwn(withoutRecord.request, 'context_threshold_mode'), false);
  });

  it('books brave.latency_ms and the pre-filter est_tokens into the record', async () => {
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

    await flushWrites();
    const files = readdirSync(logDir).filter((file) => file.endsWith('.jsonl'));
    assert.equal(files.length, 1);
    const lines = readFileSync(join(logDir, files[0]), 'utf8').split('\n').filter(Boolean);
    assert.equal(lines.length, 1);
    const record = JSON.parse(lines[0]) as {
      brave: Record<string, unknown> & { est_tokens: number };
      output: { est_tokens: number };
    };
    // 计时在适配行（D-10）：成功路径必回填且非负
    assert.equal(Object.hasOwn(record.brave, 'latency_ms'), true);
    assert.equal(typeof record.brave.latency_ms, 'number');
    assert.ok((record.brave.latency_ms as number) >= 0);
    // 过滤前 token 估算（TOOLS-04）：与 output.est_tokens 同一估算口径，过滤只删不增
    assert.ok(record.brave.est_tokens > 0);
    assert.ok(record.brave.est_tokens >= record.output.est_tokens);
  });
});

describe(`${name} (test mode sample recording, 04-02)`, () => {
  useIsolatedFilterEnv();

  const INTENT = 'What Brave Search is and how it differs from other engines';
  // 假 key 常量（照 dev/smoke_stdio.ts 的 FAKE_JEV_KEY 同式）：fetch 全程被桩拦截，
  // 占位假 key 不出网；用常量引用而非内联字面量，key 泄漏闸的字面形状零命中
  const FAKE_SAMPLE_KEY = 'test-sample-key';
  const logDirs: string[] = [];
  let savedKey: string | undefined;

  before(() => {
    // 样本链路要 Jev 分类器真实创建（no_key 会有另一条专用断言）
    savedKey = process.env.TYPESAFE_API_KEY;
    process.env.TYPESAFE_API_KEY = FAKE_SAMPLE_KEY;
  });

  after(() => {
    if (savedKey === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = savedKey;
    for (const dir of logDirs) rmSync(dir, { recursive: true, force: true });
  });

  const newLogDir = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'jev-sample-log-'));
    logDirs.push(dir);
    return dir;
  };

  const flushWrites = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

  /** Jev 回放桩：十道来源级题全 0（保留）、片段分全 2（保留）——对 ≤3 片段的夹具通吃。 */
  const jevReplay = {
    model: 'jev-1.13.0',
    answers: {
      worth_keeping: { type: 'noul', noul: 0 },
      is_primary: { type: 'noul', noul: 0 },
      has_original_reasoning: { type: 'noul', noul: 0 },
      is_attributed_rewrite: { type: 'noul', noul: 0 },
      is_template_filler: { type: 'noul', noul: 0 },
      is_off_topic: { type: 'noul', noul: 0 },
      is_listing: { type: 'noul', noul: 0 },
      self_deprecated: { type: 'noul', noul: 0 },
      stale: { type: 'noul', noul: 0 },
      paywalled: { type: 'noul', noul: 0 },
      snip0: { type: 'score', score: 2 },
      snip1: { type: 'score', score: 2 },
      snip2: { type: 'score', score: 2 },
    },
    usage: { input_tokens: 42, output_tokens: 3 },
  };

  // Brave 桩：drop case 有一个空来源（步 8 丢弃——样本 pre_filter 必须仍含它）；
  // clean case 无任何删除。
  const sampleDropResponse = {
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
        { url: 'https://empty.example/', title: 'Empty Page', snippets: ['   '] },
      ],
      map: [],
    },
    sources: {
      'https://good.example/post': { title: 'Good Post', hostname: 'good.example', age: [] },
      'https://empty.example/': { title: 'Empty Page', hostname: 'empty.example', age: [] },
    },
  };
  const sampleCleanResponse = {
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
      'https://search.brave.com/': { title: 'Brave Search', hostname: 'search.brave.com', age: [] },
    },
  };

  const getClient = useTestClient((url) => {
    if (url.pathname === '/res/v1/llm/context') {
      return url.searchParams.get('q') === 'drop case' ? sampleDropResponse : sampleCleanResponse;
    }
    if (url.pathname === '/v1/systemone') return jevReplay;
  });

  /** 读唯一 .jsonl 的首条记录。 */
  const firstRecord = (logDir: string): Record<string, unknown> => {
    const files = readdirSync(logDir).filter((file) => file.endsWith('.jsonl'));
    assert.equal(files.length, 1);
    const lines = readFileSync(join(logDir, files[0]), 'utf8').split('\n').filter(Boolean);
    assert.equal(lines.length, 1);
    return JSON.parse(lines[0]) as Record<string, unknown>;
  };

  it('writes a sample the status line points to, field-equal to the actual return, correlated by request_id', async () => {
    const logDir = newLogDir();
    useFilterConfig({ mode: 'test', log_dir: logDir });

    const result = await getClient().callTool({
      name,
      arguments: { query: 'drop case', intent: INTENT },
    });
    assert.equal(result.isError ?? false, false, JSON.stringify(result.content));
    const content = result.content as { text: string }[];
    assert.equal(content.length, 2);

    // 状态行末尾 sample: <绝对路径>，指向真实存在的文件（SC3）
    const statusLine = content[1].text;
    const marker = ' sample: ';
    const markerAt = statusLine.indexOf(marker);
    assert.ok(markerAt !== -1, `status line must carry the sample path: ${statusLine}`);
    const sampleAbsPath = statusLine.slice(markerAt + marker.length);
    assert.ok(existsSync(sampleAbsPath), `sample file must exist: ${sampleAbsPath}`);

    type SampleShape = {
      format_version: number;
      request_id: string;
      pre_filter: { grounding: { generic: Array<{ url: string }> } };
      final_return: { payload: unknown; status_line: string | null };
      jev: {
        status: string;
        per_source: Array<{ src: string; status: string }>;
        sent: Array<{ src: string; snippets: Array<{ snippet: string; sent: boolean }> }>;
      };
    };
    const sample = JSON.parse(readFileSync(sampleAbsPath, 'utf8')) as SampleShape;
    assert.equal(sample.format_version, 1);
    assert.match(
      sample.request_id,
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );

    // pre_filter 含后来被删的来源（schema 校验前捕获、未被管道修改）
    assert.deepEqual(
      sample.pre_filter.grounding.generic.map((item) => item.url),
      ['https://good.example/post', 'https://empty.example/']
    );

    // final_return 与实际返回逐字段一致（payload 含同一条 sample 路径的状态行）
    const payload = JSON.parse(content[0].text) as { output: { status_line?: string } };
    assert.deepEqual(sample.final_return.payload, payload);
    assert.equal(sample.final_return.status_line, statusLine);
    assert.equal(payload.output.status_line, statusLine);

    // jev 判断与实发映射：s0 answered、空源 s1 skipped；候选只有 s0
    assert.equal(sample.jev.status, 'ok');
    const rows = new Map(sample.jev.per_source.map((row) => [row.src, row.status]));
    assert.equal(rows.get('s0'), 'answered');
    assert.equal(rows.get('s1'), 'skipped');
    assert.deepEqual(
      sample.jev.sent.map((entry) => entry.src),
      ['s0']
    );
    assert.deepEqual(
      sample.jev.sent[0].snippets.map((snippet) => [snippet.snippet, snippet.sent]),
      [['0', true]]
    );

    // JSONL 关联：request_id 三处同值（样本文件名 / 信封 / 记录），信封指针 saved
    await flushWrites();
    const record = firstRecord(logDir);
    assert.equal(record.request_id, sample.request_id);
    assert.ok(sampleAbsPath.endsWith(`${sample.request_id}.json`));
    // 信封记相对 log_dir 路径：samples/<日期>/<request_id>.json（正斜杠口径）
    const relativePath = `samples/${basename(dirname(sampleAbsPath))}/${sample.request_id}.json`;
    assert.deepEqual(record.sample, { path: relativePath, status: 'saved' });
  });

  it('test and on tool returns are field-identical once the status-line sample suffix is stripped', async () => {
    const args = { query: 'drop case', intent: INTENT };
    const logDirTest = newLogDir();
    useFilterConfig({ mode: 'test', log_dir: logDirTest });
    const testResult = await getClient().callTool({ name, arguments: args });

    const logDirOn = newLogDir();
    useFilterConfig({ mode: 'on', log_dir: logDirOn });
    const onResult = await getClient().callTool({ name, arguments: args });

    // SC1 验收口径：比较前剥除状态行 sample 后缀（两载体：第二块文本与 JSON 块内
    // output.status_line），其余必须逐字段全等
    const normalize = (result: unknown): { payload: unknown; statusLine: string } => {
      const content = (result as { content: { text: string }[] }).content;
      const payload = JSON.parse(content[0].text) as { output?: { status_line?: string } };
      const cut = (line: string | undefined): string => {
        const at = line?.indexOf(' sample: ') ?? -1;
        return at === -1 || line === undefined ? (line ?? '') : line.slice(0, at);
      };
      if (payload.output?.status_line !== undefined) {
        payload.output.status_line = cut(payload.output.status_line);
      }
      return { payload, statusLine: cut(content[1]?.text) };
    };
    assert.deepEqual(normalize(testResult), normalize(onResult));

    // on 模式本来就没有后缀（剥除是 no-op）——顺带锁住
    const onPayload = JSON.parse((onResult as { content: { text: string }[] }).content[0].text) as {
      output: { status_line: string };
    };
    assert.ok(!onPayload.output.status_line.includes(' sample: '));
  });

  it('off mode never allocates or writes samples but still carries request_id in the JSONL envelope', async () => {
    const logDir = newLogDir();
    useFilterConfig({ mode: 'off', log_dir: logDir });

    const result = await getClient().callTool({
      name,
      arguments: { query: 'drop case', intent: INTENT },
    });
    assert.equal(result.isError ?? false, false, JSON.stringify(result.content));

    await flushWrites();
    assert.equal(existsSync(join(logDir, 'samples')), false, 'off must not create samples dir');
    const record = firstRecord(logDir);
    assert.match(
      String(record.request_id),
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
    assert.equal('sample' in record, false, 'off records carry no sample pointer');
  });
});

describe(`${name} (test mode error-path samples, 04-02)`, () => {
  useIsolatedFilterEnv();

  const INTENT = 'What Brave Search is';

  /** 从 logDir 读唯一错误样本（samples/<日期>/<request_id>.json），带回文件名对账。 */
  const readOnlySample = (
    logDir: string
  ): { sample: Record<string, unknown>; fileName: string } => {
    const samplesDir = join(logDir, 'samples');
    const dateDirs = readdirSync(samplesDir);
    assert.equal(dateDirs.length, 1);
    const files = readdirSync(join(samplesDir, dateDirs[0]));
    assert.equal(files.length, 1);
    const sample = JSON.parse(
      readFileSync(join(samplesDir, dateDirs[0], files[0]), 'utf8')
    ) as Record<string, unknown>;
    return { sample, fileName: files[0] };
  };

  it('coverage: a Brave 500 writes a failure sample with an explicit missing marker and the shared request_id', async () => {
    const logDir = mkdtempSync(join(tmpdir(), 'jev-sample-brave-error-'));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response('{"error":"boom"}', {
        status: 500,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;
    try {
      useFilterConfig({ mode: 'test', log_dir: logDir });
      const client = await connectTestClient();
      try {
        const result = await client.callTool({
          name,
          arguments: { query: 'brave browser', intent: INTENT },
        });
        assert.equal(result.isError, true);

        // 失败样本：final_return null + 显式缺失标记（绝不当零来源成功）
        const { sample, fileName } = readOnlySample(logDir);
        assert.equal(sample.final_return, null);
        const missing = sample.final_return_missing as { stage: string; message: string };
        assert.equal(missing.stage, 'brave');
        assert.match(missing.message, /500/);
        assert.equal(sample.pre_filter, null);
        assert.equal(
          (sample.request as { params: { query: string } }).params.query,
          'brave browser'
        );

        // JSONL 错误记录带同一 request_id（三处同值：文件名 / 信封 / 记录）
        await new Promise((resolve) => setImmediate(resolve));
        const jsonlFiles = readdirSync(logDir).filter((file) => file.endsWith('.jsonl'));
        assert.equal(jsonlFiles.length, 1);
        const lines = readFileSync(join(logDir, jsonlFiles[0]), 'utf8').split('\n').filter(Boolean);
        assert.equal(lines.length, 1);
        const record = JSON.parse(lines[0]) as Record<string, unknown>;
        assert.equal(record.request_id, sample.request_id);
        assert.equal((record.error as { stage: string }).stage, 'brave');
        // 样本文件名 = request_id.json（多进程唯一性的落点）
        assert.equal(fileName, `${sample.request_id}.json`);
      } finally {
        await client.close();
      }
    } finally {
      globalThis.fetch = originalFetch;
      rmSync(logDir, { recursive: true, force: true });
    }
  });

  // schema 失败的桩：200 但形状坏（`sources` 必填但缺失）——safeParse 失败（stage 'schema'）
  const getClient = useTestClient((url) => {
    if (url.pathname === '/res/v1/llm/context') {
      return { grounding: { generic: [], map: [] } };
    }
  });

  it('coverage: a schema-failing upstream keeps the raw response in the sample and marks the missing return', async () => {
    const logDir = mkdtempSync(join(tmpdir(), 'jev-sample-schema-error-'));

    useFilterConfig({ mode: 'test', log_dir: logDir });
    const result = await getClient().callTool({
      name,
      arguments: { query: 'brave browser', intent: INTENT },
    });
    assert.equal(result.isError, true);

    const { sample } = readOnlySample(logDir);
    // 可用原始响应保留（safeParse 前的快照原样）
    assert.deepEqual(sample.pre_filter, { grounding: { generic: [], map: [] } });
    assert.equal(sample.final_return, null);
    const missing = sample.final_return_missing as { stage: string; message: string };
    assert.equal(missing.stage, 'schema');
    assert.ok(missing.message.length > 0 && missing.message.length <= 200);

    // JSONL 错误记录带同一 request_id
    await new Promise((resolve) => setImmediate(resolve));
    const jsonlFiles = readdirSync(logDir).filter((file) => file.endsWith('.jsonl'));
    assert.equal(jsonlFiles.length, 1);
    const lines = readFileSync(join(logDir, jsonlFiles[0]), 'utf8').split('\n').filter(Boolean);
    assert.equal(lines.length, 1);
    const record = JSON.parse(lines[0]) as Record<string, unknown>;
    assert.equal(record.request_id, sample.request_id);
    assert.equal((record.error as { stage: string }).stage, 'schema');

    rmSync(logDir, { recursive: true, force: true });
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

describe(`${name} (no key warning dedup, WR-02)`, () => {
  useIsolatedFilterEnv();

  const getClient = useTestClient((url) => {
    if (url.pathname === '/res/v1/llm/context') return braveResponse;
  });

  it('warns once per process for a persistent missing key, and again after the test reset', async () => {
    // key 变量不在 FILTER_ENV_VARS 名单（全局约定名），本用例内单独装卸
    const savedKey = process.env.TYPESAFE_API_KEY;
    delete process.env.TYPESAFE_API_KEY;
    useFilterConfig({ mode: 'on' });

    const errors: unknown[][] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args);
    };
    try {
      const args = {
        query: 'brave browser',
        intent: 'What Brave Search is and how it differs from other engines',
      };
      await getClient().callTool({ name, arguments: args });
      await getClient().callTool({ name, arguments: args });
      // 缺 key 是进程级持续配置状态：两次请求只告警一次（每次请求仍各自落
      // no_key 日志、on 模式的未判定提示照常存在——降噪不是掩盖）
      assert.equal(errors.length, 1, `expected one warning across two calls, got ${errors.length}`);

      // 测试单例复位把告警标记一并复位：下一个进程级生命周期的首请求重新告警
      resetFilterStateForTest();
      await getClient().callTool({ name, arguments: args });
      assert.equal(errors.length, 2);
    } finally {
      console.error = originalError;
      if (savedKey === undefined) delete process.env.TYPESAFE_API_KEY;
      else process.env.TYPESAFE_API_KEY = savedKey;
      resetFilterStateForTest();
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

  const logDir = mkdtempSync(join(tmpdir(), 'jev-schema-log-'));

  after(() => {
    rmSync(logDir, { recursive: true, force: true });
  });

  const getClient = useTestClient((url) => {
    if (url.pathname === '/res/v1/llm/context') {
      // `sources` is required by the output schema; omitting it simulates
      // an upstream response that fails validation.
      return {
        grounding: { generic: [], map: [] },
      };
    }
  });

  const call = () =>
    getClient().callTool({
      name,
      arguments: { query: 'brave browser', intent: 'What Brave Search is' },
    });

  it('surfaces the validation failure as an error result', async () => {
    const result = await call();

    assert.equal(result.isError, true);
    assert.ok(JSON.stringify(result.content).includes('sources'), JSON.stringify(result.content));
  });

  it('records exactly one schema-stage error and no fabricated success stats (IN-05)', async () => {
    useFilterConfig({ mode: 'off', log_dir: logDir });
    await call();
    await new Promise((resolve) => setImmediate(resolve)); // 日志串行链落盘

    const files = readdirSync(logDir).filter((file) => file.endsWith('.jsonl'));
    assert.equal(files.length, 1);
    const lines = readFileSync(join(logDir, files[0]), 'utf8').split('\n').filter(Boolean);
    assert.equal(lines.length, 1); // 恰一条记录——schema 失败不产生第二条成功账
    const record = JSON.parse(lines[0]) as Record<string, unknown>;
    const error = record.error as { stage: string };
    assert.equal(error.stage, 'schema');
    // 无伪造成功统计：错误记录没有 stats 主体（sources / output / jev 全不在）
    for (const key of ['sources', 'output', 'jev', 'local', 'shadow_diff']) {
      assert.ok(!(key in record), `${key} must not appear in an error record`);
    }
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
