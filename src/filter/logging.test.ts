import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { THRESHOLD_SPECS, parseFilterConfigObject } from './config.js';
import { createFilterStats } from './stats.js';
import { createLogWriter, oneLineStderr } from './logging.js';
import { FILTER_RULES_VERSION } from './version.js';
import { DEFAULT_JEV_MODEL } from './jev/questions.js';
import type { BraveLlmContextResponse, FilterConfig, FilterStats } from './types.js';

/** 写入在进程内 promise 链里异步完成：让出一轮事件循环等它落盘。 */
const flushWrites = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** createFilterStats 需要的请求摘要。 */
const request: FilterStats['request'] = {
  query: 'test query',
  intent: 'test intent',
  max_urls: 10,
  max_tokens: 8192,
};

const emptyResponse: BraveLlmContextResponse = {
  grounding: { generic: [], map: [] },
  sources: {},
};

const statsOf = (mode: FilterStats['mode'] = 'off'): FilterStats =>
  createFilterStats(mode, request, emptyResponse);

/** 临时目录配置：只改 log_dir，其余全默认（model_config 即 DEFAULT_JEV_MODEL）。 */
const configOf = (mode: FilterConfig['mode'], logDir: string): FilterConfig =>
  parseFilterConfigObject({ mode, log_dir: logDir });

/** 读目录下唯一的 .jsonl 文件路径（给需要原文文本的断言用）。 */
const readRecordFile = (logDir: string): string => {
  const files = readdirSync(logDir).filter((name) => name.endsWith('.jsonl'));
  assert.equal(files.length, 1, `expected exactly one daily file, got ${files.join(', ')}`);
  return join(logDir, files[0]);
};

/** 读目录下唯一的 .jsonl 文件并解析成记录数组。 */
const readRecords = (logDir: string): Record<string, unknown>[] =>
  readFileSync(readRecordFile(logDir), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);

describe('createLogWriter', () => {
  const logDir = mkdtempSync(join(tmpdir(), 'jev-logging-test-'));

  after(() => {
    rmSync(logDir, { recursive: true, force: true });
  });

  it('appends one parseable JSONL line per call with a local-ISO ts and the stats body', async () => {
    createLogWriter(configOf('off', logDir)).write(statsOf('off'));

    await flushWrites();

    // 文件名与本地日期一致（本地 getter，UTC 系列会差时区）
    const now = new Date();
    const expectedName =
      `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-` +
      `${String(now.getDate()).padStart(2, '0')}.jsonl`;
    assert.deepEqual(
      readdirSync(logDir).filter((name) => name.endsWith('.jsonl')),
      [expectedName]
    );

    const lines = readFileSync(join(logDir, expectedName), 'utf8').split('\n');
    assert.equal(lines[lines.length - 1], ''); // 整行追加：文件以换行收尾
    const records = lines.slice(0, -1).map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(records.length, 1);

    const record = records[0];
    // 时间戳应带本地时区偏移。
    assert.match(String(record.ts), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/);
    // mode 等统计字段直接写在记录顶层。
    assert.equal(record.mode, 'off');
    assert.deepEqual(record.request, request);
    assert.deepEqual(record.sources, []);
  });

  it('writes the full envelope: backend, model_config, model_reported and the THRESHOLD_SPECS projection', async () => {
    const config = configOf('off', logDir);
    const stats = statsOf('off');
    stats.jev = {
      n_requests: 1,
      input_tokens: 0,
      latency_ms_total: 0,
      status: 'ok',
      n_http_attempts: 0,
      requests: [],
      per_source: [
        { src: 's0', url: 'https://a.example/', status: 'answered', model: 'jev-1.13.0' },
      ],
    };
    createLogWriter(config).write(stats);
    await flushWrites();

    const record = readRecords(logDir).at(-1) as Record<string, unknown>;
    assert.equal(record.backend, 'typesafe');
    // 核对配置中的钉版模型。
    assert.equal(record.model_config, DEFAULT_JEV_MODEL);
    assert.deepEqual(record.model_reported, ['jev-1.13.0']);
    // 阈值快照与 THRESHOLD_SPECS 的键集逐一相等（从源头比对，不手抄清单），
    // 值即生效阈值（全默认配置 → DEFAULT_THRESHOLDS 投影）
    const thresholds = record.thresholds as Record<string, number>;
    assert.deepEqual(
      Object.keys(thresholds).sort(),
      THRESHOLD_SPECS.map((spec) => spec.key).sort()
    );
    for (const spec of THRESHOLD_SPECS) {
      assert.equal(thresholds[spec.key], config.thresholds[spec.configKey]);
    }
    // 只读运行规则快照与规则版本：不依赖外部样本即可识别该记录的裁决语义。
    assert.deepEqual(record.decision_rules, { near_threshold_max_gap: 0.02 });
    assert.equal(record.filter_rules_version, FILTER_RULES_VERSION);
  });

  it('deduplicates model_reported across answered rows and drops failed rows', async () => {
    const dir = join(logDir, 'dedup');
    const stats = statsOf('off');
    stats.jev = {
      n_requests: 3,
      input_tokens: 0,
      latency_ms_total: 0,
      status: 'degraded',
      n_http_attempts: 0,
      requests: [],
      per_source: [
        { src: 's0', url: 'https://a.example/', status: 'answered', model: 'jev-1.13.0' },
        { src: 's1', url: 'https://b.example/', status: 'answered', model: 'jev-1.13.0' },
        { src: 's2', url: 'https://c.example/', status: 'failed', fail_kind: 'network' },
      ],
    };
    createLogWriter(configOf('off', dir)).write(stats);
    await flushWrites();

    const record = readRecords(dir).at(-1) as Record<string, unknown>;
    assert.deepEqual(record.model_reported, ['jev-1.13.0']);
  });

  it('writes an error record with stage and truncated message when no stats body exists', async () => {
    const dir = join(logDir, 'error-record');
    createLogWriter(configOf('test', dir)).writeError({
      stage: 'brave',
      message: '500 Internal Server Error'.padEnd(260, 'x'),
      query: 'test query',
      intent: 'test intent',
    });
    await flushWrites();

    const record = readRecords(dir).at(-1) as Record<string, unknown>;
    assert.equal(record.backend, 'typesafe');
    assert.equal(record.mode, 'test');
    assert.deepEqual(record.request, { query: 'test query', intent: 'test intent' });
    const error = record.error as { stage: string; message: string };
    assert.equal(error.stage, 'brave');
    assert.equal(error.message.length, 200); // 错误摘要截断到 200 字符，同时保留阈值快照和模型标识。
    assert.deepEqual(
      Object.keys(record.thresholds as Record<string, number>).sort(),
      THRESHOLD_SPECS.map((spec) => spec.key).sort()
    );
    // 错误路径同样携带规则快照与版本，且不得凭空出现逐项临界标记。
    assert.deepEqual(record.decision_rules, { near_threshold_max_gap: 0.02 });
    assert.equal(record.filter_rules_version, FILTER_RULES_VERSION);
    assert.equal(record.model_config, DEFAULT_JEV_MODEL);
  });

  it('fails open with exactly one [jev-filter] stderr line when the target is unwritable', async () => {
    // 必然失败场景：logDir 指向一个已存在的**文件**（不是目录），mkdir/append 都会炸
    const blockedPath = join(logDir, 'blocked.log');
    writeFileSync(blockedPath, 'not a directory', 'utf8');

    const errors: unknown[][] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args);
    };

    try {
      const writer = createLogWriter(configOf('off', blockedPath));
      assert.doesNotThrow(() => writer.write(statsOf('off')));
      await flushWrites();

      assert.equal(errors.length, 1, `expected one stderr line, got ${errors.length}`);
      assert.ok(
        errors[0].some((arg) => String(arg).includes('[jev-filter] ')),
        JSON.stringify(errors[0])
      );
      assert.ok(
        errors[0].some((arg) => String(arg).includes('search result is unaffected')),
        JSON.stringify(errors[0])
      );
    } finally {
      console.error = originalError;
    }
  });

  it('captures one Date per record so the ts date always equals the rolling file date (B-01)', async () => {
    const dir = join(logDir, 'b01-same-capture');
    const writer = createLogWriter(configOf('off', dir));
    const RealDate = globalThis.Date;
    // 时钟首读在午夜前，后续读在次日；时间戳和文件名必须使用同一次取时。
    const night = new RealDate('2026-09-28T23:59:59.999');
    const nextDay = new RealDate('2026-09-29T00:00:00.001');
    let calls = 0;
    const StubDate = function (...args: unknown[]) {
      if (args.length === 0) {
        calls += 1;
        return new RealDate(calls === 1 ? night : nextDay);
      }
      return new RealDate(...(args as []));
    } as unknown as DateConstructor;
    StubDate.parse = RealDate.parse;
    StubDate.UTC = RealDate.UTC;
    StubDate.now = RealDate.now;
    globalThis.Date = StubDate;
    try {
      // 成功与错误两入口都覆盖：每次入队只取一次 Date，各条记录自洽
      writer.write(statsOf('off'));
      writer.writeError({ stage: 'brave', message: 'boom', query: 'q', intent: 'i' });
      await flushWrites();
    } finally {
      globalThis.Date = RealDate;
    }

    const files = readdirSync(dir).filter((name) => name.endsWith('.jsonl'));
    assert.equal(files.length, 2); // 两条记录各落自己的日期文件（23:59 与次日零点）
    for (const file of files) {
      const records = readFileSync(join(dir, file), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { ts: string });
      assert.equal(records.length, 1);
      assert.equal(file, `${records[0].ts.slice(0, 10)}.jsonl`);
    }
  });

  it('folds stderr warning text to a single line (B-02)', () => {
    // 一次告警可能跨行、行数不固定是缺陷本身：路径与错误详情都单行化
    assert.equal(oneLineStderr('C:\\logs we\nird\\dir'), 'C:\\logs we ird\\dir');
    assert.equal(
      oneLineStderr('EIO\u2028broken\r\ncarriage\treturn'),
      'EIO broken carriage return'
    );
    assert.equal(oneLineStderr('plain path stays intact'), 'plain path stays intact');
  });

  it('never serializes snippet bodies into the record (LOG-03/D-12 red line)', async () => {
    const dir = join(logDir, 'no-body');
    // 含 TAB 与引号的正文必须按 JSON 转义形态检查，否则直接 includes 会漏检。
    const bodyText = 'SECRET-SNIPPET-BODY\twith "quotes" and-abcdefghijklmnopqrstuvwxyz-0123456789';
    const data: BraveLlmContextResponse = {
      grounding: {
        generic: [{ url: 'https://a.example/post', title: 'A Post', snippets: [bodyText] }],
        map: [],
      },
      sources: { 'https://a.example/post': { title: 'A Post', hostname: 'a.example' } },
    };
    createLogWriter(configOf('off', dir)).write(createFilterStats('off', request, data));
    await flushWrites();

    const serialized = readFileSync(readRecordFile(dir), 'utf8');
    const escapedPrefix = JSON.stringify(bodyText.slice(0, 30)).slice(1, -1);
    assert.ok(
      !serialized.includes(escapedPrefix),
      'snippet body must never reach the log (checked in its JSON-escaped form)'
    );
    // 统计面照常存在：URL 与计数在，正文不在
    assert.ok(serialized.includes('https://a.example/post'));
  });

  it('catches a real leak: the escaped-form check fires on a record that embeds the body (IN-03 negative)', () => {
    // 负例证明检查有效：同一检查逻辑作用在"真的嵌入了正文"的记录上必须命中——
    // 夹具自身不许假绿
    const bodyText = 'LEAKED\tBODY with "quotes" and enough length for a prefix cut';
    const leakedRecord = JSON.stringify({ request: { query: 'q' }, snippet_body: bodyText });
    assert.ok(
      leakedRecord.includes(JSON.stringify(bodyText.slice(0, 30)).slice(1, -1)),
      'the escaped-form check must detect an actual leak'
    );
  });

  it('writes a record for each of the three modes (D-16)', async () => {
    const dirs: Record<FilterConfig['mode'], string> = {
      off: join(logDir, 'mode-off'),
      test: join(logDir, 'mode-test'),
      on: join(logDir, 'mode-on'),
    };
    for (const mode of ['off', 'test', 'on'] as const) {
      createLogWriter(configOf(mode, dirs[mode])).write(statsOf(mode));
    }
    await flushWrites();

    for (const mode of ['off', 'test', 'on'] as const) {
      const records = readRecords(dirs[mode]);
      assert.equal(records.length, 1);
      assert.equal(records[0].mode, mode);
    }
  });

  it('carries request_id and the sample pointer in the envelope when meta is given (04-02)', async () => {
    const dir = join(logDir, 'sample-pointer');
    const writer = createLogWriter(configOf('test', dir));
    writer.write(statsOf('test'), {
      requestId: 'aaaaaaaa-1111-2222-3333-444444444444',
      sample: {
        path: 'samples/2026-09-29/aaaaaaaa-1111-2222-3333-444444444444.json',
        status: 'saved',
      },
    });
    await flushWrites();

    const record = readRecords(dir).at(-1) as Record<string, unknown>;
    assert.equal(record.request_id, 'aaaaaaaa-1111-2222-3333-444444444444');
    assert.deepEqual(record.sample, {
      path: 'samples/2026-09-29/aaaaaaaa-1111-2222-3333-444444444444.json',
      status: 'saved',
    });
  });

  it('omits request_id and sample keys for legacy-style calls without meta', async () => {
    const dir = join(logDir, 'legacy-envelope');
    createLogWriter(configOf('off', dir)).write(statsOf('off'));
    await flushWrites();

    const record = readRecords(dir).at(-1) as Record<string, unknown>;
    assert.equal('request_id' in record, false);
    assert.equal('sample' in record, false);
  });

  it('carries request_id on error records when provided (04-02)', async () => {
    const dir = join(logDir, 'error-request-id');
    createLogWriter(configOf('test', dir)).writeError({
      stage: 'brave',
      message: '500 Internal Server Error',
      query: 'test query',
      intent: 'test intent',
      requestId: 'bbbbbbbb-1111-2222-3333-444444444444',
    });
    await flushWrites();

    const record = readRecords(dir).at(-1) as Record<string, unknown>;
    assert.equal(record.request_id, 'bbbbbbbb-1111-2222-3333-444444444444');
    assert.equal((record.error as { stage: string }).stage, 'brave');
  });
});
