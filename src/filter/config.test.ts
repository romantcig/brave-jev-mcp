/** 配置解析、默认回落与文件加载测试；使用临时真实文件，捕获 stderr 后恢复。 */

import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { JEV_CONFIG_FILE_ENV, loadFilterConfig, parseFilterConfigObject } from './config.js';
import {
  DEFAULT_JEV_CONCURRENCY,
  DEFAULT_JEV_MODEL,
  DEFAULT_JEV_TIMEOUT_MS,
  DEFAULT_THRESHOLDS,
} from './jev/questions.js';
import type { FilterConfig } from './types.js';

/**
 * stderr 捕获：[jev-filter] 告警走 console.error（stdout 是 stdio 协议通道，
 * 绝不能写）。用例结束必须恢复，避免污染同进程的其他测试。
 */
const captureStderr = (run: () => void): string[] => {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  };
  try {
    run();
  } finally {
    console.error = original;
  }
  return lines;
};

/** 临时目录与文件工具：每个 describe 一个独立目录，测后统一清理。 */
const makeTmpRoot = (): string => mkdtempSync(join(tmpdir(), 'jev-config-test-'));

const writeFixture = (dir: string, name: string, content: unknown): string => {
  const filePath = join(dir, name);
  writeFileSync(filePath, typeof content === 'string' ? content : JSON.stringify(content), 'utf8');
  return filePath;
};

const defaults = (): FilterConfig => ({
  mode: 'on',
  thresholds: { ...DEFAULT_THRESHOLDS },
  jev: {
    model: DEFAULT_JEV_MODEL,
    timeoutMs: DEFAULT_JEV_TIMEOUT_MS,
    concurrency: 12,
  },
  logDir: join(homedir(), '.brave-jev', 'logs'),
});

describe('parseFilterConfigObject: shape and defaults', () => {
  it('returns every default for an empty object without any warning', () => {
    let config: FilterConfig | undefined;
    const stderr = captureStderr(() => {
      config = parseFilterConfigObject({});
    });
    assert.equal(stderr.length, 0, stderr.join('\n'));
    assert.deepEqual(config, defaults());
  });

  it('falls back to all defaults for a non-object top level, with one warning', () => {
    for (const raw of [5, 'text', [1, 2], true]) {
      let config: FilterConfig | undefined;
      const stderr = captureStderr(() => {
        config = parseFilterConfigObject(raw);
      });
      assert.equal(stderr.length, 1, JSON.stringify(raw));
      assert.ok(stderr[0].startsWith('[jev-filter]'), stderr[0]);
      assert.deepEqual(config, defaults());
    }
  });

  it('treats undefined / null top level as an empty config without warning', () => {
    let fromUndefined: FilterConfig | undefined;
    let fromNull: FilterConfig | undefined;
    const stderr = captureStderr(() => {
      fromUndefined = parseFilterConfigObject(undefined);
      fromNull = parseFilterConfigObject(null);
    });
    assert.equal(stderr.length, 0);
    assert.deepEqual(fromUndefined, defaults());
    assert.deepEqual(fromNull, defaults());
  });

  it('carries the three DEFAULT_THRESHOLDS values verbatim', () => {
    assert.deepEqual(parseFilterConfigObject({}).thresholds, {
      fillerDrop: 0.8,
      groupKeepMin: 0.25,
      singleKeepMin: 0.5,
    });
  });

  it('is a pure function: the same input yields deep-equal results without mutating the input', () => {
    const raw = { mode: 'test', overfetch_factor: 2 };

    const first = parseFilterConfigObject(raw);
    const second = parseFilterConfigObject(raw);

    assert.deepEqual(first, second);
    assert.deepEqual(raw, { mode: 'test', overfetch_factor: 2 });
  });

  it('never reads process.env on its own', () => {
    const original = process.env[JEV_CONFIG_FILE_ENV];
    process.env[JEV_CONFIG_FILE_ENV] = 'C:/no/such/file.json';

    try {
      assert.equal(parseFilterConfigObject({}).mode, 'on');
    } finally {
      if (original === undefined) delete process.env[JEV_CONFIG_FILE_ENV];
      else process.env[JEV_CONFIG_FILE_ENV] = original;
    }
  });
});

describe('parseFilterConfigObject: mode', () => {
  it('reads each valid mode', () => {
    assert.equal(parseFilterConfigObject({ mode: 'off' }).mode, 'off');
    assert.equal(parseFilterConfigObject({ mode: 'test' }).mode, 'test');
    assert.equal(parseFilterConfigObject({ mode: 'on' }).mode, 'on');
  });

  it('ignores case and surrounding whitespace', () => {
    assert.equal(parseFilterConfigObject({ mode: ' ON ' }).mode, 'on');
    assert.equal(parseFilterConfigObject({ mode: ' Test ' }).mode, 'test');
  });

  it('falls back to on for unknown, empty or non-string modes, warning once each', () => {
    for (const value of ['banana', '', '   ', 5, true, null]) {
      const lines: string[] = [];
      const config = parseFilterConfigObject({ mode: value }, (line) => lines.push(line));
      assert.equal(config.mode, 'on', JSON.stringify(value));
      assert.equal(lines.length, 1, JSON.stringify(value));
      assert.match(lines[0], /^\[jev-filter\] config: ignoring mode=/);
      assert.ok(lines[0].endsWith('using default "on"'), lines[0]);
    }
  });
});

describe('parseFilterConfigObject: jev group', () => {
  it('trims a custom model and falls back for blank or non-string values', () => {
    assert.equal(
      parseFilterConfigObject({ jev: { model: ' jev-1.14.0 ' } }).jev.model,
      'jev-1.14.0'
    );
    for (const value of ['', '   ', 5, null]) {
      const lines: string[] = [];
      const config = parseFilterConfigObject({ jev: { model: value } }, (line) => lines.push(line));
      assert.equal(config.jev.model, DEFAULT_JEV_MODEL, JSON.stringify(value));
      assert.equal(lines.length, 1, JSON.stringify(value));
      assert.match(lines[0], /ignoring jev\.model=/);
    }
  });

  it('accepts any positive integer timeout up to the runtime cap and rejects everything else', () => {
    assert.equal(parseFilterConfigObject({ jev: { timeout_ms: 1 } }).jev.timeoutMs, 1);
    assert.equal(parseFilterConfigObject({ jev: { timeout_ms: 30000 } }).jev.timeoutMs, 30000);
    assert.equal(
      parseFilterConfigObject({ jev: { timeout_ms: 2147483647 } }).jev.timeoutMs,
      2147483647
    );

    // 超时必须是 [1, 2^31-1] 的整数：AbortSignal.timeout 对更大值会截成 1ms 或抛 ERR_OUT_OF_RANGE。
    for (const value of [2147483648, 4294967296, 15000.5, 0, -5, '15000', null, true]) {
      const lines: string[] = [];
      const config = parseFilterConfigObject({ jev: { timeout_ms: value } }, (line) =>
        lines.push(line)
      );
      assert.equal(config.jev.timeoutMs, DEFAULT_JEV_TIMEOUT_MS, JSON.stringify(value));
      assert.equal(lines.length, 1, JSON.stringify(value));
      assert.match(lines[0], /ignoring jev\.timeout_ms=/);
    }
  });

  it('accepts any positive integer concurrency and rejects everything else', () => {
    assert.equal(parseFilterConfigObject({ jev: { concurrency: 1 } }).jev.concurrency, 1);
    assert.equal(parseFilterConfigObject({ jev: { concurrency: 6 } }).jev.concurrency, 6);
    assert.equal(parseFilterConfigObject({ jev: { concurrency: 200 } }).jev.concurrency, 200);

    for (const value of [0, -2, 12.5, '12', null, true]) {
      const lines: string[] = [];
      const config = parseFilterConfigObject({ jev: { concurrency: value } }, (line) =>
        lines.push(line)
      );
      assert.equal(config.jev.concurrency, DEFAULT_JEV_CONCURRENCY, JSON.stringify(value));
      assert.equal(lines.length, 1, JSON.stringify(value));
      assert.match(lines[0], /ignoring jev\.concurrency=/);
    }
  });

  it('falls back for the whole group when jev is not an object, with one warning', () => {
    const lines: string[] = [];
    const config = parseFilterConfigObject({ jev: 5 }, (line) => lines.push(line));
    assert.deepEqual(config.jev, {
      model: DEFAULT_JEV_MODEL,
      timeoutMs: DEFAULT_JEV_TIMEOUT_MS,
      concurrency: DEFAULT_JEV_CONCURRENCY,
    });
    assert.equal(lines.length, 1);
    assert.match(lines[0], /config: jev=5 is not an object/);
  });
});

describe('parseFilterConfigObject: thresholds group', () => {
  it('applies valid overrides and keeps the rest at defaults', () => {
    const lines: string[] = [];
    const config = parseFilterConfigObject(
      {
        thresholds: {
          filler_drop: 0.85,
          group_keep_min: 0.3,
          single_keep_min: 0.45,
        },
      },
      (line) => lines.push(line)
    );
    assert.equal(lines.length, 0, lines.join('\n'));
    assert.deepEqual(config.thresholds, {
      fillerDrop: 0.85,
      groupKeepMin: 0.3,
      singleKeepMin: 0.45,
    });
    assert.ok(Object.isFrozen(config.thresholds));
  });

  it('accepts the boundary values of every range', () => {
    const lines: string[] = [];
    const config = parseFilterConfigObject(
      {
        thresholds: {
          filler_drop: 0,
          group_keep_min: 1,
          single_keep_min: 0,
        },
      },
      (line) => lines.push(line)
    );
    assert.equal(lines.length, 0, lines.join('\n'));
    assert.deepEqual(config.thresholds, {
      fillerDrop: 0,
      groupKeepMin: 1,
      singleKeepMin: 0,
    });
  });

  it('falls back per key for out-of-range values while other file keys still apply', () => {
    const lines: string[] = [];
    const config = parseFilterConfigObject(
      {
        thresholds: {
          filler_drop: 1.5,
          group_keep_min: -0.1,
          single_keep_min: 0.6,
        },
      },
      (line) => lines.push(line)
    );
    assert.equal(lines.length, 2, lines.join('\n'));
    assert.equal(config.thresholds.fillerDrop, DEFAULT_THRESHOLDS.fillerDrop);
    assert.equal(config.thresholds.groupKeepMin, DEFAULT_THRESHOLDS.groupKeepMin);
    assert.equal(config.thresholds.singleKeepMin, 0.6);
    assert.ok(lines.some((line) => line.includes('thresholds.filler_drop=1.5')));
    assert.ok(lines.some((line) => line.includes('thresholds.group_keep_min=-0.1')));
  });

  it('falls back for non-numeric and string values, warning once per key', () => {
    const lines: string[] = [];
    const config = parseFilterConfigObject(
      { thresholds: { single_keep_min: 'high', filler_drop: 0.7, group_keep_min: 'bad' } },
      (line) => lines.push(line)
    );
    assert.equal(config.thresholds.singleKeepMin, DEFAULT_THRESHOLDS.singleKeepMin);
    assert.equal(config.thresholds.fillerDrop, 0.7);
    assert.equal(config.thresholds.groupKeepMin, DEFAULT_THRESHOLDS.groupKeepMin);
    assert.equal(lines.length, 2, lines.join('\n'));
  });

  it('ignores unknown keys inside thresholds (fail-open direction)', () => {
    const lines: string[] = [];
    const config = parseFilterConfigObject(
      { thresholds: { unknown_key: 123, filler_drop: 0.9 } },
      (line) => lines.push(line)
    );
    assert.equal(lines.length, 0);
    assert.equal(config.thresholds.fillerDrop, 0.9);
    assert.deepEqual(
      { ...config.thresholds, fillerDrop: DEFAULT_THRESHOLDS.fillerDrop },
      { ...DEFAULT_THRESHOLDS }
    );
  });

  it('falls back for the whole group when thresholds is not an object, with one warning', () => {
    const lines: string[] = [];
    const config = parseFilterConfigObject({ thresholds: [1, 2] }, (line) => lines.push(line));
    assert.deepEqual(config.thresholds, { ...DEFAULT_THRESHOLDS });
    assert.equal(lines.length, 1);
    assert.match(lines[0], /config: thresholds=\[1,2\] is not an object/);
  });
});

describe('parseFilterConfigObject: file paths and log_dir', () => {
  it('keeps non-empty string paths and drops blank or non-string ones', () => {
    const config = parseFilterConfigObject({
      tool_description_file: ' C:/desc.txt ',
    });
    assert.equal(config.toolDescriptionFile, 'C:/desc.txt');

    const lines: string[] = [];
    const bad = parseFilterConfigObject({ tool_description_file: 5 }, (line) => lines.push(line));
    assert.equal(bad.toolDescriptionFile, undefined);
    assert.equal(lines.length, 1, lines.join('\n'));
    assert.ok(lines.some((line) => line.includes('ignoring tool_description_file=5')));
  });

  it('defaults log_dir to ~/.brave-jev/logs with the home expanded', () => {
    assert.equal(parseFilterConfigObject({}).logDir, join(homedir(), '.brave-jev', 'logs'));
  });

  it('expands a leading ~ in log_dir and trims it', () => {
    assert.equal(
      parseFilterConfigObject({ log_dir: ' ~/logs/jev ' }).logDir,
      join(homedir(), 'logs', 'jev')
    );
    assert.equal(
      parseFilterConfigObject({ log_dir: '~\\jev-logs' }).logDir,
      join(homedir(), 'jev-logs')
    );
    assert.equal(parseFilterConfigObject({ log_dir: '~' }).logDir, homedir());
    assert.equal(parseFilterConfigObject({ log_dir: 'C:/logs' }).logDir, 'C:/logs');
  });

  it('expands a leading ~ in tool_description_file with the same rule (R8)', () => {
    assert.equal(
      parseFilterConfigObject({ tool_description_file: '~/desc.txt' }).toolDescriptionFile,
      join(homedir(), 'desc.txt')
    );
    assert.equal(
      parseFilterConfigObject({ tool_description_file: '~\\desc.txt' }).toolDescriptionFile,
      join(homedir(), 'desc.txt')
    );
    assert.equal(
      parseFilterConfigObject({ tool_description_file: '~' }).toolDescriptionFile,
      homedir()
    );
    // `~foo` 不是 home 引用，原样保留
    assert.equal(
      parseFilterConfigObject({ tool_description_file: '~foo/desc.txt' }).toolDescriptionFile,
      '~foo/desc.txt'
    );
  });

  it('falls back to the default log_dir for blank or non-string values', () => {
    const lines: string[] = [];
    const config = parseFilterConfigObject({ log_dir: '   ' }, (line) => lines.push(line));
    assert.equal(config.logDir, join(homedir(), '.brave-jev', 'logs'));
    assert.equal(lines.length, 1);
    const bad = parseFilterConfigObject({ log_dir: 5 }, () => {});
    assert.equal(bad.logDir, join(homedir(), '.brave-jev', 'logs'));
  });
});

describe('parseFilterConfigObject: warning format', () => {
  it('names the key path, the offending value and the default on every bad value', () => {
    const lines: string[] = [];
    parseFilterConfigObject(
      {
        mode: 'banana',
        jev: { model: '', timeout_ms: 15000.5, concurrency: 0 },
        thresholds: { single_keep_min: 2.01, group_keep_min: 2 },
        log_dir: '',
      },
      (line) => lines.push(line)
    );

    assert.equal(lines.length, 7, lines.join('\n'));
    for (const line of lines) {
      assert.ok(line.startsWith('[jev-filter] config: '), line);
      assert.ok(line.includes('; using default '), line);
    }
    assert.ok(lines.some((line) => line.includes('ignoring mode="banana"; using default "on"')));
    assert.ok(lines.some((line) => line.includes('ignoring thresholds.group_keep_min=2')));
  });

  it('truncates very long offending values', () => {
    const lines: string[] = [];
    parseFilterConfigObject({ mode: 'x'.repeat(500) }, (line) => lines.push(line));
    assert.equal(lines.length, 1);
    assert.ok(lines[0].length < 200, `warning too long: ${lines[0].length}`);
    assert.ok(lines[0].includes('...'));
  });
});

// ---------------------------------------------------------------------------
// loadFilterConfig：文件读取与 fail-open
// ---------------------------------------------------------------------------

describe('loadFilterConfig via JEV_FILTER_CONFIG_FILE', () => {
  const tmpRoot = makeTmpRoot();
  after(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('creates the default JSON with mode on when the variable is unset, blank or whitespace', () => {
    for (const value of [undefined, '', '   ']) {
      const home = mkdtempSync(join(tmpRoot, 'home-'));
      const stderr = captureStderr(() => {
        assert.deepEqual(loadFilterConfig({ [JEV_CONFIG_FILE_ENV]: value }, home), defaults());
      });
      const file = join(home, '.brave-jev', 'config.json');
      assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { mode: 'on' });
      assert.equal(stderr.length, 0, stderr.join('\n'));
    }
  });

  it('reads the existing default file without overwriting its settings', () => {
    const home = mkdtempSync(join(tmpRoot, 'existing-home-'));
    const dir = join(home, '.brave-jev');
    mkdirSync(dir);
    const text = '{ "mode": "off", "jev": { "concurrency": 3 } }';
    const file = writeFixture(dir, 'config.json', text);
    for (let i = 0; i < 2; i++) {
      const config = loadFilterConfig({}, home);
      assert.equal(config.mode, 'off');
      assert.equal(config.jev.concurrency, 3);
      assert.equal(readFileSync(file, 'utf8'), text);
    }
  });

  it('uses an explicit path without creating the default file', () => {
    const home = mkdtempSync(join(tmpRoot, 'override-home-'));
    const file = writeFixture(tmpRoot, 'override.json', { mode: 'test' });
    assert.equal(loadFilterConfig({ [JEV_CONFIG_FILE_ENV]: ` ${file} ` }, home).mode, 'test');
    assert.equal(existsSync(join(home, '.brave-jev')), false);
  });

  it('warns and keeps in-memory defaults if the default directory cannot be created', () => {
    const home = mkdtempSync(join(tmpRoot, 'blocked-home-'));
    writeFixture(home, '.brave-jev', 'a file blocks the directory');
    const stderr = captureStderr(() => {
      assert.deepEqual(loadFilterConfig({}, home), defaults());
    });
    assert.equal(stderr.length, 1);
    assert.match(stderr[0], /Unable to create or read config file/);
    assert.equal(readFileSync(join(home, '.brave-jev'), 'utf8'), 'a file blocks the directory');
  });

  it('falls back to all defaults when the file does not exist, with one stderr line', () => {
    const missing = join(tmpRoot, 'no-such-config.json');
    let config: FilterConfig | undefined;
    const stderr = captureStderr(() => {
      config = loadFilterConfig({ [JEV_CONFIG_FILE_ENV]: missing });
    });
    assert.deepEqual(config, defaults());
    assert.equal(stderr.length, 1, stderr.join('\n'));
    assert.ok(stderr[0].startsWith('[jev-filter]'), stderr[0]);
    assert.ok(stderr[0].includes(missing), stderr[0]);
  });

  it('falls back to all defaults when the file is not valid JSON', () => {
    const bad = writeFixture(tmpRoot, 'bad.json', '{not valid json');
    let config: FilterConfig | undefined;
    const stderr = captureStderr(() => {
      config = loadFilterConfig({ [JEV_CONFIG_FILE_ENV]: bad });
    });
    assert.deepEqual(config, defaults());
    assert.equal(stderr.length, 1, stderr.join('\n'));
  });

  it('falls back to all defaults when the top level is not a JSON object', () => {
    const array = writeFixture(tmpRoot, 'array.json', [1, 2]);
    let config: FilterConfig | undefined;
    const stderr = captureStderr(() => {
      config = loadFilterConfig({ [JEV_CONFIG_FILE_ENV]: array });
    });
    assert.deepEqual(config, defaults());
    assert.equal(stderr.length, 1, stderr.join('\n'));
  });

  it('warns instead of falling back silently when the file content is JSON null (R3)', () => {
    // 顶层 null 与其他非对象值一样告警，不能静默回落。
    const file = writeFixture(tmpRoot, 'null.json', null);
    let config: FilterConfig | undefined;
    const stderr = captureStderr(() => {
      config = loadFilterConfig({ [JEV_CONFIG_FILE_ENV]: file });
    });
    assert.deepEqual(config, defaults());
    assert.equal(stderr.length, 1, stderr.join('\n'));
    assert.match(stderr[0], /top level is not a JSON object/, stderr[0]);
  });

  it('tolerates a UTF-8 BOM instead of discarding the whole file (R4)', () => {
    // 带 BOM 的合法配置应正常解析，确保读取实际配置。
    const file = join(tmpRoot, 'bom.json');
    writeFileSync(file, `\uFEFF${JSON.stringify({ mode: 'on' })}`, 'utf8');
    let config: FilterConfig | undefined;
    const stderr = captureStderr(() => {
      config = loadFilterConfig({ [JEV_CONFIG_FILE_ENV]: file });
    });
    assert.equal(config?.mode, 'on');
    assert.equal(stderr.length, 0, stderr.join('\n'));
  });

  it('parses a full config file into the documented shape', () => {
    const file = writeFixture(tmpRoot, 'full.json', {
      mode: 'test',
      jev: { model: 'jev-1.14.0', timeout_ms: 20000, concurrency: 6 },
      thresholds: { filler_drop: 0.85, group_keep_min: 0.3 },
      log_dir: 'C:/logs/jev',
    });
    let config: FilterConfig | undefined;
    const stderr = captureStderr(() => {
      config = loadFilterConfig({ [JEV_CONFIG_FILE_ENV]: file });
    });
    assert.equal(stderr.length, 0, stderr.join('\n'));
    assert.deepEqual(config, {
      mode: 'test',
      thresholds: {
        ...DEFAULT_THRESHOLDS,
        fillerDrop: 0.85,
        groupKeepMin: 0.3,
      },
      jev: {
        model: 'jev-1.14.0',
        timeoutMs: 20000,
        concurrency: 6,
      },
      logDir: 'C:/logs/jev',
    });
  });

  it('ignores unknown top-level keys', () => {
    const file = writeFixture(tmpRoot, 'unknown.json', { unknown_key: 123, mode: 'on' });
    let config: FilterConfig | undefined;
    const stderr = captureStderr(() => {
      config = loadFilterConfig({ [JEV_CONFIG_FILE_ENV]: file });
    });
    assert.equal(stderr.length, 0);
    assert.equal(config?.mode, 'on');
  });

  it('passes a configured tool_description_file through to the config', () => {
    const file = writeFixture(tmpRoot, 'with-description.json', {
      tool_description_file: ' C:/desc.txt ',
    });
    const config = loadFilterConfig({ [JEV_CONFIG_FILE_ENV]: file });
    assert.equal(config.toolDescriptionFile, 'C:/desc.txt');
  });
});
