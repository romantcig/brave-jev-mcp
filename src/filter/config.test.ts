/** 配置解析、默认回落与文件加载测试；使用临时真实文件，捕获 stderr 后恢复。 */

import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
  mode: 'off',
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

  it('carries the seven DEFAULT_THRESHOLDS values verbatim', () => {
    assert.deepEqual(parseFilterConfigObject({}).thresholds, {
      offTopicDrop: 0.85,
      listingDrop: 0.8,
      fillerDrop: 0.8,
      reasoningProtect: 0.7,
      snippetMin: 1.0,
      cjkBonus: 0.1,
      cjkShare: 0.5,
    });
  });

  it('has no backend, context_mode or temporal_context fields any more', () => {
    // all-only 清理：Jev 组只剩 model / timeout_ms / concurrency，请求组织只有 all
    assert.equal(Object.hasOwn(parseFilterConfigObject({}).jev, 'backend'), false);
    assert.deepEqual(Object.keys(parseFilterConfigObject({}).jev), [
      'model',
      'timeoutMs',
      'concurrency',
    ]);
  });

  it('is a pure function: the same input yields deep-equal fresh objects', () => {
    const raw = { mode: 'test', overfetch_factor: 2 };

    const first = parseFilterConfigObject(raw);
    const second = parseFilterConfigObject(raw);

    assert.deepEqual(first, second);
    assert.notEqual(first, second);
    assert.notEqual(first.jev, second.jev);
    assert.deepEqual(raw, { mode: 'test', overfetch_factor: 2 });
  });

  it('never reads process.env on its own', () => {
    const original = process.env[JEV_CONFIG_FILE_ENV];
    process.env[JEV_CONFIG_FILE_ENV] = 'C:/no/such/file.json';

    try {
      assert.equal(parseFilterConfigObject({}).mode, 'off');
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

  it("maps the legacy alias 'shadow' to 'test' with exactly one migration warning", () => {
    // shadow 应映射到 test 并提示迁移，不能静默降为 off。
    const lines: string[] = [];
    const config = parseFilterConfigObject({ mode: 'shadow' }, (line) => lines.push(line));
    assert.equal(config.mode, 'test');
    assert.equal(lines.length, 1, lines.join('\n'));
    assert.match(lines[0], /mode 'shadow' is a legacy alias for 'test'/);
    assert.ok(lines[0].includes("update the config file to mode 'test'"), lines[0]);
  });

  it("maps case and whitespace variants of the alias ('SHADOW ') the same way", () => {
    const lines: string[] = [];
    const config = parseFilterConfigObject({ mode: '  SHADOW  ' }, (line) => lines.push(line));
    assert.equal(config.mode, 'test');
    assert.equal(lines.length, 1, lines.join('\n'));
    assert.match(lines[0], /mode 'shadow' is a legacy alias for 'test'/);
  });

  it('ignores case and surrounding whitespace', () => {
    assert.equal(parseFilterConfigObject({ mode: ' ON ' }).mode, 'on');
    assert.equal(parseFilterConfigObject({ mode: ' Test ' }).mode, 'test');
  });

  it('falls back to off for unknown, empty or non-string modes, warning once each', () => {
    for (const value of ['banana', '', '   ', 5, true, null]) {
      const lines: string[] = [];
      const config = parseFilterConfigObject({ mode: value }, (line) => lines.push(line));
      assert.equal(config.mode, 'off', JSON.stringify(value));
      assert.equal(lines.length, 1, JSON.stringify(value));
      assert.match(lines[0], /^\[jev-filter\] config: ignoring mode=/);
      assert.ok(lines[0].endsWith('using default "off"'), lines[0]);
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

  it('accepts integer timeouts inside [1000, 60000] and rejects everything else', () => {
    assert.equal(parseFilterConfigObject({ jev: { timeout_ms: 1000 } }).jev.timeoutMs, 1000);
    assert.equal(parseFilterConfigObject({ jev: { timeout_ms: 60000 } }).jev.timeoutMs, 60000);
    assert.equal(parseFilterConfigObject({ jev: { timeout_ms: 30000 } }).jev.timeoutMs, 30000);

    // 15000.5 能过旧校验，运行时会让 AbortSignal.timeout 抛 RangeError → Jev 静默失效
    for (const value of [15000.5, 999, 60001, 0, -5, '15000', null, true]) {
      const lines: string[] = [];
      const config = parseFilterConfigObject({ jev: { timeout_ms: value } }, (line) =>
        lines.push(line)
      );
      assert.equal(config.jev.timeoutMs, DEFAULT_JEV_TIMEOUT_MS, JSON.stringify(value));
      assert.equal(lines.length, 1, JSON.stringify(value));
      assert.match(lines[0], /ignoring jev\.timeout_ms=/);
    }
  });

  it('accepts integer concurrency inside [1, 64] and rejects everything else', () => {
    assert.equal(parseFilterConfigObject({ jev: { concurrency: 1 } }).jev.concurrency, 1);
    assert.equal(parseFilterConfigObject({ jev: { concurrency: 64 } }).jev.concurrency, 64);
    assert.equal(parseFilterConfigObject({ jev: { concurrency: 6 } }).jev.concurrency, 6);

    for (const value of [0, -2, 65, 12.5, '12', null, true]) {
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

  it('ignores the retired context_mode / temporal_context keys like any unknown key', () => {
    // 遗留请求开关按未知键忽略，各种旧取值均不改变配置，也不告警。
    const retired: Record<string, unknown>[] = [
      { context_mode: 'single' },
      { context_mode: 'all' },
      { temporal_context: false },
      { temporal_context: true },
      { context_mode: 'all', temporal_context: true },
    ];
    for (const keys of retired) {
      const lines: string[] = [];
      const config = parseFilterConfigObject({ jev: { ...keys, timeout_ms: 20000 } }, (line) =>
        lines.push(line)
      );
      assert.deepEqual(config.jev, {
        model: DEFAULT_JEV_MODEL,
        timeoutMs: 20000,
        concurrency: DEFAULT_JEV_CONCURRENCY,
      });
      assert.equal(lines.length, 0, JSON.stringify(keys));
    }
  });
});

describe('parseFilterConfigObject: thresholds group', () => {
  it('applies valid overrides and keeps the rest at defaults', () => {
    const lines: string[] = [];
    const config = parseFilterConfigObject(
      {
        thresholds: {
          off_topic_drop: 0.9,
          snippet_min: 1.2,
          cjk_share: 0,
        },
      },
      (line) => lines.push(line)
    );
    assert.equal(lines.length, 0, lines.join('\n'));
    assert.deepEqual(config.thresholds, {
      ...DEFAULT_THRESHOLDS,
      offTopicDrop: 0.9,
      snippetMin: 1.2,
      cjkShare: 0,
    });
    assert.ok(Object.isFrozen(config.thresholds));
  });

  it('accepts the boundary values of every range', () => {
    const lines: string[] = [];
    const config = parseFilterConfigObject(
      {
        thresholds: {
          off_topic_drop: 0,
          listing_drop: 1,
          filler_drop: 0,
          reasoning_protect: 1,
          snippet_min: 2,
          cjk_bonus: 0,
          cjk_share: 1,
        },
      },
      (line) => lines.push(line)
    );
    assert.equal(lines.length, 0, lines.join('\n'));
    assert.deepEqual(config.thresholds, {
      offTopicDrop: 0,
      listingDrop: 1,
      fillerDrop: 0,
      reasoningProtect: 1,
      snippetMin: 2,
      cjkBonus: 0,
      cjkShare: 1,
    });
  });

  it('falls back per key for out-of-range values while other file keys still apply', () => {
    const lines: string[] = [];
    const config = parseFilterConfigObject(
      {
        thresholds: {
          off_topic_drop: 1.5,
          filler_drop: -0.1,
          snippet_min: 1.2,
          cjk_share: 0.2,
        },
      },
      (line) => lines.push(line)
    );
    assert.equal(lines.length, 2, lines.join('\n'));
    assert.equal(config.thresholds.offTopicDrop, DEFAULT_THRESHOLDS.offTopicDrop);
    assert.equal(config.thresholds.fillerDrop, DEFAULT_THRESHOLDS.fillerDrop);
    assert.equal(config.thresholds.snippetMin, 1.2);
    assert.equal(config.thresholds.cjkShare, 0.2);
    assert.ok(lines.some((line) => line.includes('thresholds.off_topic_drop=1.5')));
    assert.ok(lines.some((line) => line.includes('thresholds.filler_drop=-0.1')));
  });

  it('caps snippet_min at 2 (score tops out at 2.0), falling back above it', () => {
    assert.equal(
      parseFilterConfigObject({ thresholds: { snippet_min: 2 } }).thresholds.snippetMin,
      2
    );

    const lines: string[] = [];
    const config = parseFilterConfigObject({ thresholds: { snippet_min: 2.01 } }, (line) =>
      lines.push(line)
    );
    assert.equal(config.thresholds.snippetMin, DEFAULT_THRESHOLDS.snippetMin);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /ignoring thresholds\.snippet_min=2\.01; using default 1/);

    // 旧口径 [0,3] 放行的 3 现在也回落
    const three = parseFilterConfigObject({ thresholds: { snippet_min: 3 } }, () => {});
    assert.equal(three.thresholds.snippetMin, DEFAULT_THRESHOLDS.snippetMin);
  });

  it('falls back for non-numeric and string values, warning once per key', () => {
    const lines: string[] = [];
    const config = parseFilterConfigObject(
      { thresholds: { reasoning_protect: 'high', cjk_bonus: 0.2, listing_drop: 'bad' } },
      (line) => lines.push(line)
    );
    assert.equal(config.thresholds.reasoningProtect, DEFAULT_THRESHOLDS.reasoningProtect);
    assert.equal(config.thresholds.cjkBonus, 0.2);
    assert.equal(config.thresholds.listingDrop, DEFAULT_THRESHOLDS.listingDrop);
    assert.equal(lines.length, 2, lines.join('\n'));
  });

  it('ignores retired min_facts and novelty_min keys without warning or affecting thresholds', () => {
    const lines: string[] = [];
    const config = parseFilterConfigObject(
      { thresholds: { min_facts: 6, novelty_min: 3, off_topic_drop: 0.9 } },
      (line) => lines.push(line)
    );
    assert.equal(lines.length, 0);
    assert.equal(config.thresholds.offTopicDrop, 0.9);
    assert.equal('minFacts' in config.thresholds, false);
    assert.equal('noveltyMin' in config.thresholds, false);
  });

  it('ignores unknown keys inside thresholds (fail-open direction)', () => {
    const lines: string[] = [];
    const config = parseFilterConfigObject(
      { thresholds: { unknown_key: 123, off_topic_drop: 0.9 } },
      (line) => lines.push(line)
    );
    assert.equal(lines.length, 0);
    assert.equal(config.thresholds.offTopicDrop, 0.9);
    assert.deepEqual(
      { ...config.thresholds, offTopicDrop: DEFAULT_THRESHOLDS.offTopicDrop },
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
        jev: { model: '', timeout_ms: 15000.5, concurrency: 65 },
        thresholds: { snippet_min: 2.01, listing_drop: 2, cjk_bonus: 7 },
        log_dir: '',
      },
      (line) => lines.push(line)
    );

    assert.equal(lines.length, 8, lines.join('\n'));
    for (const line of lines) {
      assert.ok(line.startsWith('[jev-filter] config: '), line);
      assert.ok(line.includes('; using default '), line);
    }
    assert.ok(lines.some((line) => line.includes('ignoring mode="banana"; using default "off"')));
    assert.ok(lines.some((line) => line.includes('ignoring thresholds.listing_drop=2')));
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

  it('returns all defaults when the variable is unset, blank or whitespace', () => {
    const stderr = captureStderr(() => {
      assert.deepEqual(loadFilterConfig({}), defaults());
      assert.deepEqual(loadFilterConfig({ [JEV_CONFIG_FILE_ENV]: '' }), defaults());
      assert.deepEqual(loadFilterConfig({ [JEV_CONFIG_FILE_ENV]: '   ' }), defaults());
    });
    assert.equal(stderr.length, 0, stderr.join('\n'));
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
    // 带 BOM 的合法配置应正常解析，避免意外回落 off。
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
      thresholds: { off_topic_drop: 0.9, snippet_min: 1.2 },
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
        offTopicDrop: 0.9,
        snippetMin: 1.2,
      },
      jev: {
        model: 'jev-1.14.0',
        timeoutMs: 20000,
        concurrency: 6,
      },
      logDir: 'C:/logs/jev',
    });
  });

  it('keeps parsing a config that still carries the retired keys (ignored silently)', () => {
    // 遗留配置带着退役键（overfetch_factor, blocklist_file, jev.context_mode, min_facts, novelty_min 等）照常解析：其余配置生效，退役键不影响任何行为
    const file = writeFixture(tmpRoot, 'retired-keys.json', {
      mode: 'test',
      overfetch_factor: 2,
      blocklist_file: '~/no-such-blocklist.txt',
      jev: { context_mode: 'all', temporal_context: true },
      thresholds: { min_facts: 6, novelty_min: 3 },
    });
    let config: FilterConfig | undefined;
    const stderr = captureStderr(() => {
      config = loadFilterConfig({ [JEV_CONFIG_FILE_ENV]: file });
    });
    assert.equal(stderr.length, 0, stderr.join('\n'));
    assert.equal(config?.mode, 'test');
    assert.deepEqual(config?.jev, {
      model: DEFAULT_JEV_MODEL,
      timeoutMs: DEFAULT_JEV_TIMEOUT_MS,
      concurrency: DEFAULT_JEV_CONCURRENCY,
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
