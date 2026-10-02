/**
 * 配置解析单测（02-FIX 批 B）：单一 JSON 配置文件 → FilterConfig。
 * - `parseFilterConfigObject` 是纯函数主力：逐键合法值、边界值、坏值回落与 stderr 行。
 * - `loadFilterConfig` 覆盖文件读取、黑名单文件并集与 fail-open。
 * 真实临时目录 + 真实文件，不 mock fs；stderr 捕获后必须恢复。
 */

import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_BLOCKLIST } from './blocklist.js';
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
  overfetchFactor: 1,
  blocklist: DEFAULT_BLOCKLIST,
  thresholds: { ...DEFAULT_THRESHOLDS },
  jev: {
    model: DEFAULT_JEV_MODEL,
    timeoutMs: DEFAULT_JEV_TIMEOUT_MS,
    concurrency: 12,
    contextMode: 'single',
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

  it('exposes the default blocklist, initially empty', () => {
    assert.deepEqual(parseFilterConfigObject({}).blocklist, DEFAULT_BLOCKLIST);
    assert.equal(DEFAULT_BLOCKLIST.size, 0);
  });

  it('carries the nine DEFAULT_THRESHOLDS values verbatim', () => {
    assert.deepEqual(parseFilterConfigObject({}).thresholds, {
      offTopicDrop: 0.85,
      listingDrop: 0.8,
      fillerDrop: 0.8,
      reasoningProtect: 0.7,
      snippetMin: 1.0,
      minFacts: 4,
      noveltyMin: 2,
      cjkBonus: 0.1,
      cjkShare: 0.5,
    });
  });

  it('has no backend field any more (JEV-01 single backend)', () => {
    assert.equal(Object.hasOwn(parseFilterConfigObject({}).jev, 'backend'), false);
    assert.deepEqual(Object.keys(parseFilterConfigObject({}).jev), [
      'model',
      'timeoutMs',
      'concurrency',
      'contextMode',
    ]);
  });

  it('is a pure function: the same input yields deep-equal fresh objects', () => {
    const raw = { mode: 'shadow', overfetch_factor: 2 };

    const first = parseFilterConfigObject(raw);
    const second = parseFilterConfigObject(raw);

    assert.deepEqual(first, second);
    assert.notEqual(first, second);
    assert.notEqual(first.jev, second.jev);
    assert.deepEqual(raw, { mode: 'shadow', overfetch_factor: 2 });
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
    // 04-CONTEXT 模式与兼容节：旧 shadow 是 test 的别名（实际应用 Jev 裁决），
    // 解析到时向 warn 出口发一行迁移诊断；别名绝不能落成 off（T-04-01-1）
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

describe('parseFilterConfigObject: overfetch_factor', () => {
  it('accepts finite numbers of at least 1', () => {
    assert.equal(parseFilterConfigObject({ overfetch_factor: 2 }).overfetchFactor, 2);
    assert.equal(parseFilterConfigObject({ overfetch_factor: 1.5 }).overfetchFactor, 1.5);
    assert.equal(parseFilterConfigObject({ overfetch_factor: 1 }).overfetchFactor, 1);
  });

  it('falls back to 1 for sub-1, non-finite, string or missing values', () => {
    for (const value of [0.5, 0, -3, Number.POSITIVE_INFINITY, '2', null, true, {}]) {
      const lines: string[] = [];
      const config = parseFilterConfigObject({ overfetch_factor: value }, (line) =>
        lines.push(line)
      );
      assert.equal(config.overfetchFactor, 1, JSON.stringify(value));
      assert.equal(lines.length, 1, JSON.stringify(value));
      assert.match(lines[0], /ignoring overfetch_factor=/);
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
      contextMode: 'single',
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
          off_topic_drop: 0.9,
          snippet_min: 1.2,
          min_facts: 6,
          novelty_min: 3,
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
      minFacts: 6,
      noveltyMin: 3,
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
          min_facts: 1,
          novelty_min: 1,
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
      minFacts: 1,
      noveltyMin: 1,
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
          min_facts: 6,
        },
      },
      (line) => lines.push(line)
    );
    assert.equal(lines.length, 2, lines.join('\n'));
    assert.equal(config.thresholds.offTopicDrop, DEFAULT_THRESHOLDS.offTopicDrop);
    assert.equal(config.thresholds.fillerDrop, DEFAULT_THRESHOLDS.fillerDrop);
    assert.equal(config.thresholds.snippetMin, 1.2);
    assert.equal(config.thresholds.minFacts, 6);
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
      { thresholds: { reasoning_protect: 'high', cjk_bonus: 0.2, min_facts: 4.5 } },
      (line) => lines.push(line)
    );
    assert.equal(config.thresholds.reasoningProtect, DEFAULT_THRESHOLDS.reasoningProtect);
    assert.equal(config.thresholds.cjkBonus, 0.2);
    assert.equal(config.thresholds.minFacts, DEFAULT_THRESHOLDS.minFacts);
    assert.equal(lines.length, 2, lines.join('\n'));
  });

  it('requires integers for min_facts and novelty_min', () => {
    for (const value of [4.5, 2.0000001, '4', null]) {
      const lines: string[] = [];
      const config = parseFilterConfigObject({ thresholds: { min_facts: value } }, (line) =>
        lines.push(line)
      );
      assert.equal(config.thresholds.minFacts, DEFAULT_THRESHOLDS.minFacts, JSON.stringify(value));
      assert.equal(lines.length, 1, JSON.stringify(value));
    }
    const zero = parseFilterConfigObject({ thresholds: { novelty_min: 0 } }, () => {});
    assert.equal(zero.thresholds.noveltyMin, DEFAULT_THRESHOLDS.noveltyMin);
    const negative = parseFilterConfigObject({ thresholds: { novelty_min: -1 } }, () => {});
    assert.equal(negative.thresholds.noveltyMin, DEFAULT_THRESHOLDS.noveltyMin);
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
      blocklist_file: '  C:/farms.txt  ',
      tool_description_file: ' C:/desc.txt ',
    });
    assert.equal(config.toolDescriptionFile, 'C:/desc.txt');

    const lines: string[] = [];
    const bad = parseFilterConfigObject({ blocklist_file: '', tool_description_file: 5 }, (line) =>
      lines.push(line)
    );
    assert.equal(bad.toolDescriptionFile, undefined);
    assert.equal(lines.length, 2, lines.join('\n'));
    assert.ok(lines.some((line) => line.includes('ignoring blocklist_file=')));
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

  it('expands a leading ~ in blocklist_file before reading it (R8)', () => {
    // 黑名单路径不进 FilterConfig，loadFilterConfig 直接按它读文件：写一份真文件
    // 到临时目录，路径用 `~/` 形式没意义（不在 home 下），所以这里断言的是"读不到
    // 时 stderr 里的路径已展开"——写 `~\no-such-bl-<rand>.txt`，报错行必须是绝对路径
    const dir = mkdtempSync(join(tmpdir(), 'jev-config-test-r8-'));
    const name = `no-such-bl-${Math.random().toString(36).slice(2)}.txt`;
    let stderr: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      stderr.push(args.map(String).join(' '));
    };
    try {
      const file = join(dir, 'cfg.json');
      writeFileSync(file, JSON.stringify({ blocklist_file: `~\\${name}` }), 'utf8');
      loadFilterConfig({ [JEV_CONFIG_FILE_ENV]: file });
    } finally {
      console.error = original;
      rmSync(dir, { recursive: true, force: true });
    }
    assert.equal(stderr.length, 1, stderr.join('\n'));
    assert.ok(
      stderr[0].includes(join(homedir(), name)),
      `blocklist path must be ~-expanded: ${stderr[0]}`
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
        overfetch_factor: '2',
        jev: { model: '', timeout_ms: 15000.5, concurrency: 65 },
        thresholds: { snippet_min: 2.01, min_facts: 4.5, cjk_bonus: 7 },
        log_dir: '',
      },
      (line) => lines.push(line)
    );

    assert.equal(lines.length, 9, lines.join('\n'));
    for (const line of lines) {
      assert.ok(line.startsWith('[jev-filter] config: '), line);
      assert.ok(line.includes('; using default '), line);
    }
    assert.ok(lines.some((line) => line.includes('ignoring mode="banana"; using default "off"')));
    assert.ok(lines.some((line) => line.includes('ignoring thresholds.min_facts=4.5')));
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
// loadFilterConfig：文件读取、fail-open 与黑名单文件并集
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
    // JSON 文本 `null` 解析成功但顶层不是对象——必须与数组/标量同待遇，报同一行，
    // 不能静默回落（审查 R3：静默失效违背 EMBED-05"坏值要看得见"）
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
    // PowerShell 5.1 的 `-Encoding UTF8` 写出的文件带 BOM；JSON.parse 会报错，
    // 整份配置回落 off——去 BOM 后照常解析（审查 R4）
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
      overfetch_factor: 2,
      jev: { model: 'jev-1.14.0', timeout_ms: 20000, concurrency: 6 },
      thresholds: { off_topic_drop: 0.9, snippet_min: 1.2, min_facts: 6, novelty_min: 3 },
      log_dir: 'C:/logs/jev',
    });
    let config: FilterConfig | undefined;
    const stderr = captureStderr(() => {
      config = loadFilterConfig({ [JEV_CONFIG_FILE_ENV]: file });
    });
    assert.equal(stderr.length, 0, stderr.join('\n'));
    assert.deepEqual(config, {
      mode: 'test',
      overfetchFactor: 2,
      blocklist: DEFAULT_BLOCKLIST,
      thresholds: {
        ...DEFAULT_THRESHOLDS,
        offTopicDrop: 0.9,
        snippetMin: 1.2,
        minFacts: 6,
        noveltyMin: 3,
      },
      jev: { model: 'jev-1.14.0', timeoutMs: 20000, concurrency: 6, contextMode: 'single' },
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

  it('merges the blocklist file named by the config with the built-in blocklist', () => {
    const blocklistFile = writeFixture(
      tmpRoot,
      'blocklist.txt',
      '# farm candidates\nfarm-a.example\nWWW.Farm-B.EXAMPLE\n\n'
    );
    const file = writeFixture(tmpRoot, 'with-blocklist.json', { blocklist_file: blocklistFile });
    let config: FilterConfig | undefined;
    const stderr = captureStderr(() => {
      config = loadFilterConfig({ [JEV_CONFIG_FILE_ENV]: file });
    });
    assert.equal(stderr.length, 0, stderr.join('\n'));
    // parseBlocklist 复用（不写第二份解析器）：去 www、小写、跳注释与空行
    assert.ok(config?.blocklist.has('farm-a.example'));
    assert.ok(config?.blocklist.has('farm-b.example'));
    // 与内置求并集：内置成员全部仍在；每次调用新建 Set，内置常量不被改写
    for (const host of DEFAULT_BLOCKLIST) assert.ok(config?.blocklist.has(host));
    assert.notEqual(config?.blocklist, DEFAULT_BLOCKLIST);
    assert.equal(DEFAULT_BLOCKLIST.size, 0);

    const second = captureStderr(() => {
      assert.notEqual(
        loadFilterConfig({ [JEV_CONFIG_FILE_ENV]: file }).blocklist,
        config?.blocklist
      );
    });
    assert.equal(second.length, 0);
  });

  it('falls back to the built-in blocklist when the named file is missing', () => {
    const file = writeFixture(tmpRoot, 'missing-blocklist.json', {
      blocklist_file: join(tmpRoot, 'no-such-blocklist.txt'),
    });
    let config: FilterConfig | undefined;
    const stderr = captureStderr(() => {
      config = loadFilterConfig({ [JEV_CONFIG_FILE_ENV]: file });
    });
    assert.deepEqual(config?.blocklist, DEFAULT_BLOCKLIST);
    assert.equal(stderr.length, 1, stderr.join('\n'));
    assert.ok(stderr[0].includes('no-such-blocklist.txt'), stderr[0]);
  });

  it('passes a configured tool_description_file through to the config', () => {
    const file = writeFixture(tmpRoot, 'with-description.json', {
      tool_description_file: ' C:/desc.txt ',
    });
    const config = loadFilterConfig({ [JEV_CONFIG_FILE_ENV]: file });
    assert.equal(config.toolDescriptionFile, 'C:/desc.txt');
  });
});
