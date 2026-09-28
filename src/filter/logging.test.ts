import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createFilterStats } from './stats.js';
import { createLogWriter } from './logging.js';
import type { BraveLlmContextResponse, FilterStats } from './types.js';

/** 写入在进程内 promise 链里异步完成：让出一轮事件循环等它落盘。 */
const flushWrites = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** createFilterStats 需要的请求摘要。 */
const request: FilterStats['request'] = {
  query: 'test query',
  intent: 'test intent',
  max_urls: 10,
  max_tokens: 8192,
  overfetch_factor: 1,
};

const emptyResponse: BraveLlmContextResponse = {
  grounding: { generic: [], map: [] },
  sources: {},
};

const statsOf = (mode: FilterStats['mode']): FilterStats =>
  createFilterStats(mode, request, emptyResponse);

describe('createLogWriter', () => {
  const logDir = mkdtempSync(join(tmpdir(), 'jev-logging-test-'));

  after(() => {
    rmSync(logDir, { recursive: true, force: true });
  });

  it('appends one parseable JSONL line per call with a local-ISO ts and the stats body', async () => {
    const write = createLogWriter(logDir);
    write(statsOf('off'));

    await flushWrites();

    const files = readdirSync(logDir).filter((name) => name.endsWith('.jsonl'));
    assert.equal(files.length, 1);
    assert.match(files[0], /^\d{4}-\d{2}-\d{2}\.jsonl$/);

    const lines = readFileSync(join(logDir, files[0]), 'utf8').split('\n');
    assert.equal(lines[lines.length - 1], ''); // 整行追加：文件以换行收尾
    const records = lines.slice(0, -1).map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(records.length, 1);

    const record = records[0];
    // ts 带时区偏移（D-11）：toISOString 的 UTC 形态不满足
    assert.match(String(record.ts), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/);
    // FilterStats 直接序列化（D-09）：mode 等统计字段在记录顶层
    assert.equal(record.mode, 'off');
    assert.deepEqual(record.request, request);
    assert.deepEqual(record.sources, []);
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
      const write = createLogWriter(blockedPath);
      assert.doesNotThrow(() => write(statsOf('off')));
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
});
