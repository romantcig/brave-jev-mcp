import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import {
  connectTestClient,
  useTestClient as useSharedTestClient,
} from '../../testUtils/mcpTestHarness.js';
import { JEV_CONFIG_FILE_ENV } from '../../filter/config.js';
import { localIsoWithOffset } from '../../filter/logging.js';
import { FILTER_RULES_VERSION } from '../../filter/version.js';
import type { SampleRecord } from '../../filter/sample.js';
import type { JevState, JevQuestion } from '../../filter/types.js';
import { name, resetFilterStateForTest } from './index.js';
import { LlmContextInputSchema, RequestParamsSchema } from './schemas/input.js';

// 每个用例前后清理配置单例并隔离 JEV_FILTER_CONFIG_FILE，避免测试间共享状态。
const FILTER_ENV_VARS = [JEV_CONFIG_FILE_ENV, 'TYPESAFE_API_KEY'] as const;

/** 临时配置目录：整个文件一个，测后统一清理。 */
const configDir = mkdtempSync(join(tmpdir(), 'jev-llm-context-test-'));

// 测试日志统一写临时目录，避免污染真实日志；其余配置默认 off。
const defaultLogDir = mkdtempSync(join(tmpdir(), 'jev-llm-context-logs-'));
const defaultConfigPath = join(configDir, 'default-config.json');
writeFileSync(defaultConfigPath, JSON.stringify({ mode: 'off', log_dir: defaultLogDir }), 'utf8');

after(() => {
  rmSync(configDir, { recursive: true, force: true });
  rmSync(defaultLogDir, { recursive: true, force: true });
});

/**
 * 写入配置 JSON 并让适配行重新读一次：设 `JEV_FILTER_CONFIG_FILE` 指向新文件、
 * 清掉惰性单例。返回文件路径，供"改内容后再搜索"的用例复用同一路径。
 * 配置对象默认注入临时 `log_dir`（用例显式给出时以用例为准）。
 */
let configRevision = 0;

const useFilterConfig = (
  value: unknown,
  filename = `config-${Date.now()}-${Math.random()}.json`
) => {
  const filePath = join(configDir, filename);
  const withLogDir = { log_dir: defaultLogDir, ...(value as Record<string, unknown>) };
  writeFileSync(filePath, JSON.stringify(withLogDir), 'utf8');
  process.env[JEV_CONFIG_FILE_ENV] = filePath;
  resetFilterStateForTest();
  configRevision++;
  return filePath;
};

// 在 describe 体内注册一对 before/after，把配置文件变量指到默认隔离配置（不再
// 指向真实配置）、清单例；after 恢复原值
const useIsolatedFilterEnv = () => {
  const originalEnv = Object.fromEntries(FILTER_ENV_VARS.map((key) => [key, process.env[key]]));

  before(() => {
    for (const key of FILTER_ENV_VARS) delete process.env[key];
    process.env[JEV_CONFIG_FILE_ENV] = defaultConfigPath;
    process.env.TYPESAFE_API_KEY = 'test-jev-key';
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

// 用例更换启动配置后重建 MCP，确保实际注册的参数与配置一致。
const useTestClient = (responder: Parameters<typeof useSharedTestClient>[0]) => {
  const initialClient = useSharedTestClient(responder);
  let active: Awaited<ReturnType<typeof connectTestClient>>;
  let revision: number;
  let reconnecting: Promise<void> | undefined;
  before(() => {
    active = initialClient();
    revision = configRevision;
  });
  after(async () => {
    if (active !== initialClient()) await active.close();
  });
  const current = async () => {
    if (revision !== configRevision) {
      revision = configRevision;
      reconnecting = (async () => {
        await active.close();
        active = await connectTestClient();
      })();
    }
    await reconnecting;
    return active;
  };
  return () => ({
    callTool: async (...args: Parameters<typeof active.callTool>) =>
      (await current()).callTool(...args),
    listTools: async () => (await current()).listTools(),
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

const EXPECTED_DEFAULT_BUDGET = {
  count: 10,
  maximum_number_of_urls: 5,
  maximum_number_of_tokens: 4000,
  maximum_number_of_tokens_per_url: 800,
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

  it('off exposes only search parameters and removes intent from the description', async () => {
    const { tools } = await getClient().listTools();
    const tool = tools.find((t) => t.name === name);

    assert.ok(tool, `${name} is not listed`);
    assert.deepEqual(
      Object.keys(tool.inputSchema.properties ?? {}).sort(),
      WHITELIST.slice().sort()
    );
    assert.deepEqual(tool.inputSchema.required, ['query']);
    assert.equal(tool.outputSchema, undefined);
    assert.doesNotMatch(tool.description ?? '', /intent/);
    // 方言补丁仍然生效
    assert.equal(tool.inputSchema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  });

  it('返回正文及日期，省略重复来源表与规模统计，只请求一次 Brave', async () => {
    const result = await getClient().callTool({
      name,
      arguments: {
        query: 'brave browser',
      },
    });

    assert.equal(result.isError ?? false, false, JSON.stringify(result.content));
    assert.equal(result.structuredContent, undefined);

    const content = result.content as { text: string }[];
    const payload = JSON.parse(content[0].text);

    // off 模式正文不变，元数据中的 ISO 日期移动到对应条目。
    assert.deepEqual(payload.grounding.generic, [
      { ...braveResponse.grounding.generic[0], age: ['2026-09-16'] },
      braveResponse.grounding.generic[1],
    ]);
    assert.deepEqual(payload.grounding.map, []);
    assert.equal(Object.hasOwn(payload, 'sources'), false);
    assert.equal(Object.hasOwn(payload, 'output'), false);

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

  // 有丢弃的载荷：第二个来源只有空白片段（预筛删光 → 空来源丢弃）。
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
    // 无状态行时 content 只有一块。
    assert.equal(content.length, 1);

    // 临时 log_dir 恰一个按天文件、恰一行、可解析、含 mode 与 ts
    await flushWrites();
    const files = readdirSync(logDir).filter((file) => file.endsWith('.jsonl'));
    assert.equal(files.length, 1);
    const lines = readFileSync(join(logDir, files[0]), 'utf8').split('\n').filter(Boolean);
    assert.equal(lines.length, 1);
    const record = JSON.parse(lines[0]) as Record<string, unknown>;
    assert.equal(record.mode, 'off');
    const request = record.request as { max_urls: number; max_tokens: number };
    assert.equal(request.max_urls, 5);
    assert.equal(request.max_tokens, 4000);
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

    // 状态行只返回一次，并与日志逐字同源
    const payload = JSON.parse(content[0].text) as Record<string, unknown>;
    assert.equal(Object.hasOwn(payload, 'output'), false);
    await flushWrites();
    const logFile = readdirSync(logDir).find((file) => file.endsWith('.jsonl'))!;
    const loggedOutput = JSON.parse(readFileSync(join(logDir, logFile), 'utf8').trim()).output as {
      status_line: string;
    };
    assert.equal(loggedOutput.status_line, statusLine);
  });

  it('records freshness only when the request carries it and omits both optional request keys otherwise', async () => {
    const logDir = newLogDir();
    useFilterConfig({ mode: 'off', log_dir: logDir });

    // 仅在请求带 freshness 时记录该键。
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

  it('books brave.latency_ms and the pre-filter chars into the record', async () => {
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
      brave: Record<string, unknown> & { chars: number };
      output: { chars: number };
    };
    // 成功路径的 Brave 耗时应由宿主回填且非负。
    assert.equal(Object.hasOwn(record.brave, 'latency_ms'), true);
    assert.equal(typeof record.brave.latency_ms, 'number');
    assert.ok((record.brave.latency_ms as number) >= 0);
    // 核对过滤前后的规模统计。
    assert.ok(record.brave.chars > 0);
    assert.ok(record.brave.chars >= record.output.chars);
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

  /** choice 全保留分布：概率 1 全给最长字母标签（none 为 0）。 */
  const choiceAllKeep = (criteria: Record<string, null>): Record<string, number> => {
    const labels = Object.keys(criteria);
    const full = labels
      .filter((label) => label !== 'none')
      .reduce((best, label) => (label.length > best.length ? label : best), '');
    return Object.fromEntries(labels.map((label) => [label, label === full ? 1 : 0]));
  };

  // 回答桩按现行题目形状提供保守保留答案：filler 概率 0、单片组合题全保留。
  // 夹具的候选只有 s0 一片片段；未提问的键由显式映射忽略。
  const jevReplay = {
    model: 'jev-1.13.0',
    answers: {
      s0__filler: { type: 'noul', noul: 0 },
      s0__group0: { type: 'choice', probabilities: { none: 0, A: 1 } },
    },
    usage: { input_tokens: 42, output_tokens: 3 },
  };

  // Brave 桩：drop case 有一个空来源（最终丢弃，样本 pre_filter 必须仍含它）；
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

  // 全删除夹具：两个来源都只有空白片段 → 预筛删光片段、空来源全部丢弃 → 输出为空
  const sampleAllDroppedResponse = {
    grounding: {
      generic: [
        { url: 'https://void.example/one', title: 'Void One', snippets: ['   '] },
        { url: 'https://void.example/two', title: 'Void Two', snippets: ['   '] },
      ],
      map: [],
    },
    sources: {
      'https://void.example/one': { title: 'Void One', hostname: 'void.example', age: [] },
      'https://void.example/two': { title: 'Void Two', hostname: 'void.example', age: [] },
    },
  };

  const getClient = useTestClient((url) => {
    if (url.pathname === '/res/v1/llm/context') {
      const q = url.searchParams.get('q');
      if (q === 'drop case') return sampleDropResponse;
      if (q === 'all drop case') return sampleAllDroppedResponse;
      return sampleCleanResponse;
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

  /** 读 logDir 下唯一样本（samples/<日期>/<文件>）。 */
  const readSingleSample = (
    logDir: string
  ): { sample: Record<string, unknown>; sampleAbsPath: string } => {
    const samplesDir = join(logDir, 'samples');
    const dateDirs = readdirSync(samplesDir);
    assert.equal(dateDirs.length, 1);
    const files = readdirSync(join(samplesDir, dateDirs[0]));
    assert.equal(files.length, 1);
    const sampleAbsPath = join(samplesDir, dateDirs[0], files[0]);
    return {
      sample: JSON.parse(readFileSync(sampleAbsPath, 'utf8')) as Record<string, unknown>,
      sampleAbsPath,
    };
  };

  /** 从返回第二块剥出 sample 绝对路径（无后缀返回 undefined）。 */
  const samplePathOf = (content: { text: string }[]): string | undefined => {
    if (content.length < 2) return undefined;
    const marker =
      ' sample for filter debugging - original results, filtered results, Jev decisions: ';
    const at = content[1].text.indexOf(marker);
    return at === -1 ? undefined : content[1].text.slice(at + marker.length);
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

    // 状态行中的样本路径应指向已保存文件。
    const statusLine = content[1].text;
    const marker =
      ' sample for filter debugging - original results, filtered results, Jev decisions: ';
    const markerAt = statusLine.indexOf(marker);
    assert.ok(markerAt !== -1, `status line must carry the sample path: ${statusLine}`);
    const sampleAbsPath = statusLine.slice(markerAt + marker.length);
    assert.ok(!sampleAbsPath.includes('\\'), '展示路径不能包含反斜杠');
    assert.ok(existsSync(sampleAbsPath), `sample file must exist: ${sampleAbsPath}`);

    type SampleShape = {
      format_version: number;
      request_id: string;
      pre_filter: { grounding: { generic: Array<{ url: string }> } };
      final_return: { payload: unknown; status_line: string | null };
      jev: {
        status: string;
        per_source: Array<{ src: string; status: string }>;
        sent: Array<{
          src: string;
          dispatched: boolean;
          answered: boolean;
          state: string | null;
          request_id?: string;
          snippets: Array<{
            snippet: string;
            in_state: boolean;
            question_sent: boolean;
            valid: boolean;
          }>;
        }>;
      };
    };
    const sample = JSON.parse(readFileSync(sampleAbsPath, 'utf8')) as SampleShape;
    // 请求级载荷 + 来源级映射引用（全量共享请求，一次搜索零或一条）
    assert.equal(sample.format_version, 8);
    assert.match(
      sample.request_id,
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );

    // pre_filter 含后来被删的来源（schema 校验前捕获、未被管道修改）
    assert.deepEqual(
      sample.pre_filter.grounding.generic.map((item) => item.url),
      ['https://good.example/post', 'https://empty.example/']
    );

    // final_return 与实际返回逐字段一致，状态行只存在于第二块
    const payload = JSON.parse(content[0].text) as Record<string, unknown>;
    assert.deepEqual(sample.final_return.payload, payload);
    assert.equal(sample.final_return.status_line, statusLine);
    assert.equal(Object.hasOwn(payload, 'output'), false);
    await flushWrites();
    const loggedOutput = firstRecord(logDir).output as { status_line: string };
    assert.equal(loggedOutput.status_line, statusLine);

    // Jev 判断与实发映射：s0 answered、空源 s1 是 skipped 派发记录
    assert.equal(sample.jev.status, 'ok');
    const rows = new Map(sample.jev.per_source.map((row) => [row.src, row.status]));
    assert.equal(rows.get('s0'), 'answered');
    assert.equal(rows.get('s1'), 'skipped');
    assert.deepEqual(
      sample.jev.sent.map((entry) => [entry.src, entry.dispatched, entry.answered]),
      [
        ['s0', true, true],
        ['s1', false, false],
      ]
    );
    // s1 的 skipped 记录无请求可引用（无内容可派发，不伪造输入证据）
    assert.equal(sample.jev.sent[1]?.request_id, undefined);
    assert.deepEqual(
      sample.jev.sent[0]?.snippets.map((snippet) => [
        snippet.snippet,
        snippet.in_state,
        snippet.question_sent,
        snippet.valid,
      ]),
      [['0', true, true, true]]
    );

    // JSONL 关联：样本与日志 request_id 同值，信封指针指向短文件名
    await flushWrites();
    const record = firstRecord(logDir);
    assert.equal(record.request_id, sample.request_id);
    assert.match(basename(sampleAbsPath), /^[0-9a-f]{8}\.json$/);
    // 信封记相对 log_dir 路径：samples/<日期>/<8位十六进制摘要>.json（正斜杠口径）
    const relativePath = `samples/${basename(dirname(sampleAbsPath))}/${basename(sampleAbsPath)}`;
    assert.deepEqual(record.sample, { path: relativePath, status: 'saved' });
  });

  it('跨午夜仍复用 Brave 请求前的检索时间，test/on 同链且样本等于实发与实际返回', async (t) => {
    const start = new Date(2026, 9, 3, 23, 59, 59, 900);
    const anchor = localIsoWithOffset(start);
    t.mock.timers.enable({ apis: ['Date'], now: start });
    const savedFetch = globalThis.fetch;
    const returns: unknown[] = [];
    try {
      for (const mode of ['test', 'on'] as const) {
        t.mock.timers.setTime(start.getTime());
        const logDir = newLogDir();
        useFilterConfig({ mode, log_dir: logDir });
        const sent: Array<{ state: JevState; questions: Record<string, JevQuestion> }> = [];
        globalThis.fetch = async (input, init) => {
          const url = new URL(input instanceof Request ? input.url : String(input));
          if (url.pathname === '/res/v1/llm/context') {
            assert.equal(url.searchParams.has('retrieval_time'), false);
            assert.equal(url.searchParams.has('retrievalTime'), false);
            assert.equal(Date.now(), start.getTime(), '捕获发生在 Brave 出站之前');
            t.mock.timers.setTime(start.getTime() + 200);
            return new Response(JSON.stringify(braveResponse));
          }
          assert.equal(url.pathname, '/v1/systemone');
          const body = JSON.parse(String(init?.body));
          sent.push(body);
          const answers = Object.fromEntries(
            Object.entries(body.questions as Record<string, JevQuestion>).map(([key, q]) => [
              key,
              q.type === 'choice'
                ? {
                    type: 'choice',
                    probabilities: choiceAllKeep(q.criteria),
                  }
                : { type: 'noul', noul: 0.1 },
            ])
          );
          return new Response(
            JSON.stringify({ model: 'jev-1.13.0', answers, usage: { input_tokens: 42 } })
          );
        };
        const result = await getClient().callTool({
          name,
          arguments: { query: 'brave browser', intent: INTENT },
        });
        assert.equal(result.isError ?? false, false);
        assert.equal(result.structuredContent, undefined);
        const content = result.content as { text: string }[];
        assert.equal(content.length, mode === 'test' ? 2 : 1);
        assert.equal(sent.length, 1);
        assert.equal(sent[0].state.retrieval_time, anchor);
        assert.equal(sent[0].state.sources[0].brave_page_date, '2026-09-16T00:00:00');
        assert.equal(sent[0].state.sources[1].brave_page_date, null);
        assert.match(sent[0].questions.s1__group0.instructions, /^A=`sources\[1\]/);
        returns.push(JSON.parse(content[0].text));
        if (mode === 'test') {
          const { sample: raw } = readSingleSample(logDir);
          const sample = raw as unknown as SampleRecord;
          assert.equal(sample.ts, anchor);
          // Jev 配置快照仅包含模型、超时和并发。
          assert.deepEqual(Object.keys(sample.config_snapshot.jev).sort(), [
            'concurrency',
            'model',
            'timeout_ms',
          ]);
          assert.deepEqual(sample.pre_filter, braveResponse);
          assert.deepEqual(sample.final_return, {
            payload: JSON.parse(content[0].text),
            status_line: content[1].text,
          });
          assert.equal(sample.jev?.requests.length, 1);
          const recorded = sample.jev!.requests[0];
          assert.deepEqual(JSON.parse(recorded.state!), sent[0].state);
          assert.deepEqual(recorded.questions, sent[0].questions);
          assert.equal(recorded.dispatched, true);
          assert.deepEqual(recorded.source_ids, ['s0', 's1']);
          assert.equal(sample.context_layout_id, 'jev-context-4');
          assert.equal(sample.filter_rules_version, FILTER_RULES_VERSION);
        }
      }
      assert.deepEqual(returns[0], returns[1]);
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  it('test and on tool returns are field-identical once the sample location metadata is stripped', async () => {
    const args = { query: 'drop case', intent: INTENT };
    const logDirTest = newLogDir();
    useFilterConfig({ mode: 'test', log_dir: logDirTest });
    const testResult = await getClient().callTool({ name, arguments: args });

    const logDirOn = newLogDir();
    useFilterConfig({ mode: 'on', log_dir: logDirOn });
    const onResult = await getClient().callTool({ name, arguments: args });

    // 比较过滤内容时剥除 test 的样本定位后缀；纯样本状态行视为无过滤状态行。
    const normalize = (result: unknown): { payload: unknown; statusLine: string } => {
      const content = (result as { content: { text: string }[] }).content;
      const payload = JSON.parse(content[0].text) as Record<string, unknown>;
      assert.equal(Object.hasOwn(payload, 'output'), false);
      const cut = (line: string | undefined): string | undefined => {
        if (line === undefined) return undefined;
        if (
          line.startsWith(
            '[filter] sample for filter debugging - original results, filtered results, Jev decisions: '
          )
        )
          return undefined; // test 独有的纯样本行
        const at = line.indexOf(
          ' sample for filter debugging - original results, filtered results, Jev decisions: '
        );
        return at === -1 ? line : line.slice(0, at);
      };
      return { payload, statusLine: cut(content[1]?.text) ?? '' };
    };
    assert.deepEqual(normalize(testResult), normalize(onResult));

    // on 模式本来就没有后缀（剥除是 no-op）——顺带锁住
    const onPayload = JSON.parse(
      (onResult as { content: { text: string }[] }).content[0].text
    ) as Record<string, unknown>;
    assert.equal(Object.hasOwn(onPayload, 'output'), false);
  });

  it('a zero-removal on search has no status line while its test twin gains the sample-only entry', async () => {
    const args = { query: 'brave browser', intent: INTENT }; // clean 夹具：零删除
    const logDirTest = newLogDir();
    useFilterConfig({ mode: 'test', log_dir: logDirTest });
    const testResult = await getClient().callTool({ name, arguments: args });

    const logDirOn = newLogDir();
    useFilterConfig({ mode: 'on', log_dir: logDirOn });
    const onResult = await getClient().callTool({ name, arguments: args });

    // on 无状态行（单块返回）；test 多一条仅含样本定位的状态行——样本定位元信息
    // 是 test 独有允许项，剥离后过滤内容必须逐字段一致
    const onContent = (onResult as { content: { text: string }[] }).content;
    assert.equal(onContent.length, 1);
    const testContent = (testResult as { content: { text: string }[] }).content;
    assert.equal(testContent.length, 2);
    assert.match(
      testContent[1]?.text ?? '',
      /^\[filter\] sample for filter debugging - original results, filtered results, Jev decisions: /
    );
    const testPayload = JSON.parse(testContent[0].text) as Record<string, unknown>;
    const onPayloadZero = JSON.parse(onContent[0].text) as Record<string, unknown>;
    assert.equal(Object.hasOwn(testPayload, 'output'), false);
    assert.equal(Object.hasOwn(onPayloadZero, 'output'), false);
    assert.deepEqual(
      testPayload,
      onPayloadZero,
      'filtered payload must be identical; only the sample pointer differs'
    );
    const sampleAbsPath = samplePathOf(testContent);
    assert.ok(sampleAbsPath, 'the sample-only status line must carry the path');
    assert.ok(existsSync(sampleAbsPath), `sample file must exist: ${sampleAbsPath}`);
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

  it('coverage: sample write failure strips the path from both carriers and the JSONL records failed (review R2)', async () => {
    // 用文件占用 samples 目录制造保存失败；日志仍应记录失败，返回不能带成功路径。
    const logDir = newLogDir();
    writeFileSync(join(logDir, 'samples'), 'occupied by a file, not a directory', 'utf8');
    useFilterConfig({ mode: 'test', log_dir: logDir });

    const originalError = console.error;
    const errors: unknown[][] = [];
    console.error = (...args: unknown[]) => {
      errors.push(args);
    };

    try {
      const result = await getClient().callTool({
        name,
        arguments: { query: 'drop case', intent: INTENT },
      });
      assert.equal(result.isError ?? false, false, JSON.stringify(result.content));
      const content = result.content as { text: string }[];
      // 状态行第二块仍在（drop case 本有状态行），但绝无 sample 路径（两载体同源剥净）
      assert.equal(content.length, 2);
      assert.ok(
        !content[1]?.text.includes(
          ' sample for filter debugging - original results, filtered results, Jev decisions: '
        ),
        JSON.stringify(content)
      );
      const payload = JSON.parse(content[0].text) as Record<string, unknown>;
      assert.equal(Object.hasOwn(payload, 'output'), false);

      await flushWrites();
      const record = firstRecord(logDir);
      const sample = record.sample as { path: string; status: string };
      assert.equal(sample.status, 'failed');
      assert.match(sample.path, /^samples\//, 'the relative pointer is still recorded');
      assert.ok(errors.some((args) => String(args[0]).includes('Unable to write sample')));
    } finally {
      console.error = originalError;
    }
  });

  it('coverage: all-removed search returns empty, still writes a sample, and maps no candidates', async () => {
    const logDir = newLogDir();
    useFilterConfig({ mode: 'test', log_dir: logDir });

    const result = await getClient().callTool({
      name,
      arguments: { query: 'all drop case', intent: INTENT },
    });
    assert.equal(result.isError ?? false, false, JSON.stringify(result.content));
    const content = result.content as { text: string }[];
    // 过滤后为空返回空（不补回），状态行第二块仍在（2 of 2 丢弃）
    const payload = JSON.parse(content[0].text) as {
      grounding: { generic: unknown[] };
    };
    assert.deepEqual(payload.grounding.generic, []);
    assert.equal(Object.hasOwn(payload, 'sources'), false);
    assert.equal(Object.hasOwn(payload, 'output'), false);
    assert.match(content[1].text, /dropped 2 of 2 sources: 2 empty/);
    assert.ok(samplePathOf(content) !== undefined);

    const { sample, sampleAbsPath } = readSingleSample(logDir);
    assert.ok(existsSync(sampleAbsPath));
    const finalReturn = sample.final_return as { payload: unknown; status_line: string };
    assert.deepEqual(finalReturn.payload, payload);
    // 原始样本保留全部来源；无候选时逐来源记 skipped，不伪造实发载荷。
    const preFilter = sample.pre_filter as { grounding: { generic: unknown[] } };
    assert.equal(preFilter.grounding.generic.length, 2);
    const jev = sample.jev as {
      status: string;
      per_source: Array<{ src: string; status: string }>;
      sent: Array<{
        src: string;
        dispatched: boolean;
        not_dispatched_reason?: string;
        request_id?: string;
      }>;
      requests: unknown[];
    };
    assert.equal(jev.status, 'ok');
    assert.ok(jev.per_source.every((row) => row.status === 'skipped'));
    assert.deepEqual(
      jev.sent.map((entry) => [
        entry.src,
        entry.dispatched,
        entry.not_dispatched_reason,
        entry.request_id,
      ]),
      [
        ['s0', false, 'skipped', undefined],
        ['s1', false, 'skipped', undefined],
      ]
    );
    // 零候选不构造请求或记录。
    assert.deepEqual(jev.requests, []);
  });

  it('coverage: concurrent requests land distinct sample files that never cross-write', async () => {
    const logDir = newLogDir();
    useFilterConfig({ mode: 'test', log_dir: logDir });

    const results = await Promise.all([
      getClient().callTool({ name, arguments: { query: 'drop case', intent: INTENT } }),
      getClient().callTool({ name, arguments: { query: 'all drop case', intent: INTENT } }),
      getClient().callTool({ name, arguments: { query: 'drop case', intent: INTENT } }),
    ]);

    // 每个返回的状态行指向自己的样本：三份路径互不相同、文件都真实存在
    const samplePaths = results.map((result) => {
      const path = samplePathOf(result.content as { text: string }[]);
      assert.ok(path !== undefined, 'each concurrent test-mode return must carry a sample path');
      assert.ok(existsSync(path), `sample file must exist: ${path}`);
      return path as string;
    });
    assert.equal(new Set(samplePaths).size, 3, 'request_id filenames must be unique');

    // 每份样本的 final_return 与各自的实际返回逐字段一致（互不串写）
    const sampleRequestIds = samplePaths.map((path, index) => {
      const sample = JSON.parse(readFileSync(path, 'utf8')) as {
        request_id: string;
        final_return: { payload: unknown };
      };
      const payload = JSON.parse((results[index].content as { text: string }[])[0].text);
      assert.deepEqual(sample.final_return.payload, payload, `sample #${index} cross-write check`);
      return sample.request_id;
    });
    assert.equal(new Set(sampleRequestIds).size, 3);

    // JSONL：三条记录、request_id 与三份样本一一对应（串行链不混账）
    await flushWrites();
    const files = readdirSync(logDir).filter((file) => file.endsWith('.jsonl'));
    assert.equal(files.length, 1);
    const lines = readFileSync(join(logDir, files[0]), 'utf8').split('\n').filter(Boolean);
    assert.equal(lines.length, 3);
    const recordIds = lines.map((line) =>
      String((JSON.parse(line) as Record<string, unknown>).request_id)
    );
    assert.deepEqual(
      [...recordIds].sort(),
      [...sampleRequestIds].sort(),
      'JSONL request_ids must pair with the sample files'
    );

    // 清理：本用例的样本目录随 logDirs 统一清理，无额外动作
    void readSingleSample;
  });
});

describe(`${name} (test mode error-path samples, 04-02)`, () => {
  useIsolatedFilterEnv();

  const INTENT = 'What Brave Search is';

  /** 从 logDir 读唯一错误样本（samples/<日期>/<8位十六进制摘要>.json），带回文件名对账。 */
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

        // JSONL 错误记录带同一 request_id（样本记录 / 信封 / 记录）
        await new Promise((resolve) => setImmediate(resolve));
        const jsonlFiles = readdirSync(logDir).filter((file) => file.endsWith('.jsonl'));
        assert.equal(jsonlFiles.length, 1);
        const lines = readFileSync(join(logDir, jsonlFiles[0]), 'utf8').split('\n').filter(Boolean);
        assert.equal(lines.length, 1);
        const record = JSON.parse(lines[0]) as Record<string, unknown>;
        assert.equal(record.request_id, sample.request_id);
        assert.equal((record.error as { stage: string }).stage, 'brave');
        // 文件名采用 8 位小写十六进制摘要；完整 request_id 仍在样本与日志中关联
        assert.match(fileName, /^[0-9a-f]{8}\.json$/);
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

  it('coverage: a Brave failure with a failing sample write records status failed and keeps the search error (review R3)', async () => {
    // Brave 500 + 样本写入失败（samples 被文件占用）叠加：错误 JSONL 必须写
    // sample { path, status: 'failed' }，同时原始错误语义原样（isError、stage）
    const logDir = mkdtempSync(join(tmpdir(), 'jev-sample-brave-err-fail-'));
    writeFileSync(join(logDir, 'samples'), 'occupied by a file, not a directory', 'utf8');
    const originalFetch = globalThis.fetch;
    const originalError = console.error;
    const errors: unknown[][] = [];
    console.error = (...args: unknown[]) => {
      errors.push(args);
    };
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
        // 原始搜索错误语义不被样本保存失败覆盖
        assert.equal(result.isError, true);

        await new Promise((resolve) => setImmediate(resolve));
        const jsonlFiles = readdirSync(logDir).filter((file) => file.endsWith('.jsonl'));
        assert.equal(jsonlFiles.length, 1);
        const record = JSON.parse(readFileSync(join(logDir, jsonlFiles[0]), 'utf8')) as Record<
          string,
          unknown
        >;
        assert.equal((record.error as { stage: string }).stage, 'brave');
        // 同一 request_id 关联 + 保存失败如实入账
        assert.match(String(record.request_id), /^[0-9a-f-]{36}$/);
        const sample = record.sample as { path: string; status: string };
        assert.equal(sample.status, 'failed');
        assert.match(sample.path, /^samples\//);
        // 样本确实不存在（写入失败，无半截文件冒充）
        assert.equal(existsSync(join(logDir, sample.path)), false);
        assert.ok(errors.some((args) => String(args[0]).includes('Unable to write sample')));
      } finally {
        await client.close();
      }
    } finally {
      globalThis.fetch = originalFetch;
      console.error = originalError;
      rmSync(logDir, { recursive: true, force: true });
    }
  });

  it('coverage: a schema failure with a failing sample write records status failed and keeps the search error (review R3)', async () => {
    // schema 失败 + 样本写入失败叠加：saved / failed 必须能从错误 JSONL 区分
    const logDir = mkdtempSync(join(tmpdir(), 'jev-sample-schema-err-fail-'));
    writeFileSync(join(logDir, 'samples'), 'occupied by a file, not a directory', 'utf8');
    const originalError = console.error;
    const errors: unknown[][] = [];
    console.error = (...args: unknown[]) => {
      errors.push(args);
    };
    try {
      useFilterConfig({ mode: 'test', log_dir: logDir });
      const result = await getClient().callTool({
        name,
        arguments: { query: 'brave browser', intent: INTENT },
      });
      assert.equal(result.isError, true);

      await new Promise((resolve) => setImmediate(resolve));
      const jsonlFiles = readdirSync(logDir).filter((file) => file.endsWith('.jsonl'));
      assert.equal(jsonlFiles.length, 1);
      const record = JSON.parse(readFileSync(join(logDir, jsonlFiles[0]), 'utf8')) as Record<
        string,
        unknown
      >;
      assert.equal((record.error as { stage: string }).stage, 'schema');
      const sample = record.sample as { path: string; status: string };
      assert.equal(sample.status, 'failed');
      assert.match(sample.path, /^samples\//);
      assert.ok(errors.some((args) => String(args[0]).includes('Unable to write sample')));
    } finally {
      console.error = originalError;
      rmSync(logDir, { recursive: true, force: true });
    }
  });

  it('coverage: a schema failure with a succeeding sample write records status saved (review R3)', async () => {
    const logDir = mkdtempSync(join(tmpdir(), 'jev-sample-schema-err-ok-'));
    try {
      useFilterConfig({ mode: 'test', log_dir: logDir });
      const result = await getClient().callTool({
        name,
        arguments: { query: 'brave browser', intent: INTENT },
      });
      assert.equal(result.isError, true);

      await new Promise((resolve) => setImmediate(resolve));
      const jsonlFiles = readdirSync(logDir).filter((file) => file.endsWith('.jsonl'));
      assert.equal(jsonlFiles.length, 1);
      const record = JSON.parse(readFileSync(join(logDir, jsonlFiles[0]), 'utf8')) as Record<
        string,
        unknown
      >;
      const sample = record.sample as { path: string; status: string };
      assert.equal(sample.status, 'saved');
      // 指针对得上真实文件：samples/<日期>/<8位十六进制摘要>.json 且 request_id 同值
      assert.ok(existsSync(join(logDir, sample.path)));
      const saved = JSON.parse(readFileSync(join(logDir, sample.path), 'utf8'));
      assert.equal(saved.request_id, record.request_id);
    } finally {
      rmSync(logDir, { recursive: true, force: true });
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
  before(() => {
    useFilterConfig({ mode: 'on' });
  });

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

describe(`${name} (startup tool definitions)`, () => {
  useIsolatedFilterEnv();

  for (const mode of ['off', 'on', 'test'] as const) {
    for (const key of ['test-jev-key', '', '   ', undefined]) {
      it(`${mode} with ${key?.trim() ? 'a key' : JSON.stringify(key)} exposes the matching definition`, async () => {
        if (key === undefined) delete process.env.TYPESAFE_API_KEY;
        else process.env.TYPESAFE_API_KEY = key;
        useFilterConfig({ mode });
        const client = await connectTestClient();
        try {
          const tool = (await client.listTools()).tools.find((tool) => tool.name === name)!;
          const filtering = mode !== 'off' && Boolean(key?.trim());
          assert.deepEqual(tool.inputSchema.required, filtering ? ['query', 'intent'] : ['query']);
          assert.deepEqual(
            Object.keys(tool.inputSchema.properties ?? {}).sort(),
            [...WHITELIST, ...(filtering ? ['intent'] : [])].sort()
          );
          if (filtering) {
            assert.match(tool.description ?? '', /Required: `intent`/);
          } else {
            assert.doesNotMatch(tool.description ?? '', /intent/);
          }
          assert.equal(tool.outputSchema, undefined);
          assert.equal(tool.inputSchema.$schema, 'https://json-schema.org/draft/2020-12/schema');
          for (const [key, value] of Object.entries(EXPECTED_DEFAULT_BUDGET)) {
            const property = tool.inputSchema.properties?.[key] as Record<string, unknown>;
            assert.equal(property.default, value);
            assert.equal(Object.hasOwn(property, 'minimum'), false);
            assert.equal(Object.hasOwn(property, 'maximum'), false);
          }
        } finally {
          await client.close();
        }
      });
    }
  }
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

  it('returns search results without intent and explains how to configure the missing key', async () => {
    // 本用例临时清除密钥，测试缺少配置的启动状态：
    // delete 覆盖本机 shell 里设的 key
    const savedKeys: Array<[string, string | undefined]> = ['TYPESAFE_API_KEY'].map((key) => [
      key,
      process.env[key],
    ]);
    for (const [key] of savedKeys) delete process.env[key];
    // mode 来自配置文件
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
        },
      });

      // 输出正常（no_key 等价 off：本地规则对夹具零删减，stats.jev 由管道记 no_key
      // 零值对象——pipeline.test.ts 的未注入 classify 用例已锁该记账）
      assert.equal(result.isError ?? false, false, JSON.stringify(result.content));
      const payload = JSON.parse((result.content as { text: string }[])[0].text);
      assert.deepEqual(payload.grounding.generic, [
        { ...braveResponse.grounding.generic[0], age: ['2026-09-16'] },
        braveResponse.grounding.generic[1],
      ]);

      const { tools } = await getClient().listTools();
      const tool = tools.find((tool) => tool.name === name)!;
      assert.deepEqual(tool.inputSchema.required, ['query']);
      assert.equal(Object.hasOwn(tool.inputSchema.properties ?? {}, 'intent'), false);
      assert.doesNotMatch(tool.description ?? '', /intent/);
      const guidance = (result.content as { text: string }[])[1].text;
      assert.match(guidance, /TYPESAFE_API_KEY/);
      assert.match(guidance, /MCP server's env configuration/);
      assert.match(guidance, /restart the MCP server/);
      assert.match(guidance, /JEV_FILTER_CONFIG_FILE/);
      assert.match(guidance, /~\/\.brave-jev\/config\.json/);
      assert.match(guidance, /"mode": "off"/);
      assert.match(String(errors[0]), /TYPESAFE_API_KEY.*restart the MCP server/);

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
    const filePath = useFilterConfig({ mode: 'off' });
    assert.equal((await call()).isError ?? false, false);
    assert.equal(forwarded[0].searchParams.get('maximum_number_of_urls'), '5');

    // 改写同一个文件（mode: 'on'），不重启：进程级单例仍在，行为不变
    writeFileSync(filePath, JSON.stringify({ mode: 'on' }), 'utf8');
    assert.equal((await call()).isError ?? false, false);
    assert.equal(calls, 2);
    assert.equal(forwarded[1].searchParams.get('maximum_number_of_urls'), '5');
    const running = (await getClient().listTools()).tools.find((tool) => tool.name === name)!;
    assert.deepEqual(running.inputSchema.required, ['query']);

    // 模拟重启后重新注册，读取相同路径下的新配置。
    resetFilterStateForTest();
    const restarted = await connectTestClient();
    try {
      const tool = (await restarted.listTools()).tools.find((tool) => tool.name === name)!;
      assert.deepEqual(tool.inputSchema.required, ['query', 'intent']);
      assert.match(tool.description ?? '', /Required: `intent`/);
    } finally {
      await restarted.close();
    }
  });
});

describe(`${name} (tool_description_file from config)`, () => {
  useIsolatedFilterEnv();

  it('overrides the tool description with the file named in the config', async () => {
    // 注册时应使用配置中的描述文件路径。
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

  it('uses the unfiltered description when off even if the custom description requires intent', async () => {
    const descPath = join(configDir, 'filtered-description.md');
    writeFileSync(descPath, 'Custom filtering: intent is required.', 'utf8');
    useFilterConfig({ mode: 'off', tool_description_file: descPath });
    const client = await connectTestClient();
    try {
      const tool = (await client.listTools()).tools.find((tool) => tool.name === name)!;
      assert.doesNotMatch(tool.description ?? '', /intent/);
      assert.deepEqual(tool.inputSchema.required, ['query']);
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
    for (const key of ['sources', 'output', 'jev', 'local']) {
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

describe(`${name} (search budgets)`, () => {
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

  it('sends the four default budgets to Brave when they are omitted', async () => {
    const result = await getClient().callTool({ name, arguments: { query: 'brave browser' } });
    assert.equal(result.isError ?? false, false, JSON.stringify(result.content));
    const params = forwarded.at(-1)!.searchParams;
    for (const [key, value] of Object.entries(EXPECTED_DEFAULT_BUDGET)) {
      assert.equal(params.get(key), String(value));
    }
    const payload = JSON.parse((result.content as { text: string }[])[0].text);
    assert.equal(payload.parameter_adjustments, undefined);
  });

  it('fills only omitted budgets and preserves explicit values independently', async () => {
    const overrides = { maximum_number_of_urls: 2, maximum_number_of_tokens: 3200 };
    const result = await getClient().callTool({
      name,
      arguments: { query: 'brave browser', ...overrides },
    });
    assert.equal(result.isError ?? false, false, JSON.stringify(result.content));
    const params = forwarded.at(-1)!.searchParams;
    for (const [key, value] of Object.entries({ ...EXPECTED_DEFAULT_BUDGET, ...overrides })) {
      assert.equal(params.get(key), String(value));
    }
  });

  it('preserves explicitly increased budgets', async () => {
    const overrides = {
      count: 12,
      maximum_number_of_urls: 6,
      maximum_number_of_tokens: 4800,
      maximum_number_of_tokens_per_url: 1000,
    };
    const result = await getClient().callTool({
      name,
      arguments: { query: 'brave browser', ...overrides },
    });
    assert.equal(result.isError ?? false, false, JSON.stringify(result.content));
    for (const [key, value] of Object.entries(overrides)) {
      assert.equal(forwarded.at(-1)!.searchParams.get(key), String(value));
    }
  });

  it('defaults undefined values but rejects null or text instead of treating them as omitted', async () => {
    const emptyBudgets = Object.fromEntries(
      Object.keys(EXPECTED_DEFAULT_BUDGET).map((key) => [key, undefined])
    );
    assert.deepEqual(RequestParamsSchema.parse({ query: 'q', ...emptyBudgets }), {
      query: 'q',
      ...EXPECTED_DEFAULT_BUDGET,
    });
    const before = calls;
    for (const key of Object.keys(EXPECTED_DEFAULT_BUDGET)) {
      for (const value of [null, '10']) {
        const result = await getClient().callTool({
          name,
          arguments: { query: 'q', [key]: value },
        });
        assert.equal(result.isError, true);
      }
    }
    assert.equal(calls, before);
  });

  it('raises below-minimum values, forwards the clamped ones, and reports the adjustment', async () => {
    const originalError = console.error;
    const errors: unknown[][] = [];
    console.error = (...args: unknown[]) => {
      errors.push(args);
    };
    try {
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
      assert.ok(errors.some((args) => String(args[0]).includes('raised below-minimum parameters')));
    } finally {
      console.error = originalError;
    }
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

  it('advertises optional defaults without range numbers and still validates limits', async () => {
    const { tools } = await getClient().listTools();
    const tool = tools.find((t) => t.name === name);

    assert.ok(tool, `${name} is not listed`);
    const properties = (tool.inputSchema.properties ?? {}) as Record<
      string,
      { maximum?: number; minimum?: number; default?: number; description?: string }
    >;
    // 工具展示默认值，运行时仍保留整数、上限校验与下限钳位。
    for (const [key, value] of Object.entries(EXPECTED_DEFAULT_BUDGET)) {
      assert.equal(
        Object.hasOwn(properties[key] ?? {}, 'minimum'),
        false,
        `${key} must not advertise a minimum`
      );
      assert.ok(properties[key], `${key} must be advertised`);
      assert.equal(Object.hasOwn(properties[key], 'maximum'), false);
      assert.equal(properties[key].default, value);
      assert.equal(tool.inputSchema.required?.includes(key), false);
      assert.match(properties[key].description ?? '', /Omit to use the default/);
      assert.doesNotMatch(
        properties[key].description ?? '',
        /minimum|maximum|below|raised|32768|8192|1024|512/
      );
    }
    assert.match(
      tool.description ?? '',
      /For routine calls, omit the four search budget parameters/
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
