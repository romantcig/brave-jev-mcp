import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_BLOCKLIST } from './blocklist.js';
import { JEV_BLOCKLIST_FILE_ENV, parseFilterConfig } from './config.js';
import {
  DEFAULT_JEV_MODEL,
  DEFAULT_THRESHOLDS,
  JEV_CONFIG_FILE_ENV,
  resolveThresholds,
} from './jev/questions.js';

describe('parseFilterConfig', () => {
  it('defaults to off with factor 1 when nothing is set', () => {
    assert.deepEqual(parseFilterConfig({}), {
      mode: 'off',
      overfetchFactor: 1,
      blocklist: new Set(),
      thresholds: { ...DEFAULT_THRESHOLDS },
      jev: { model: DEFAULT_JEV_MODEL, backend: 'typesafe', timeoutMs: 15000, concurrency: 12 },
    });
  });

  it('exposes the default blocklist, initially empty', () => {
    assert.deepEqual(parseFilterConfig({}).blocklist, DEFAULT_BLOCKLIST);
    assert.equal(DEFAULT_BLOCKLIST.size, 0);
  });

  it('carries the eleven DEFAULT_THRESHOLDS values verbatim when nothing overrides them (02-06 adds file overrides)', () => {
    assert.deepEqual(parseFilterConfig({}).thresholds, {
      offTopicDrop: 0.85,
      listingDrop: 0.8,
      selfDeprecated: 0.7,
      staleDrop: 0.85,
      fillerDrop: 0.8,
      reasoningProtect: 0.7,
      snippetMin: 1.0,
      minFacts: 4,
      noveltyMin: 2,
      cjkBonus: 0.1,
      cjkShare: 0.5,
    });
    assert.deepEqual(parseFilterConfig({}).thresholds, { ...DEFAULT_THRESHOLDS });
  });

  it('reads each valid mode', () => {
    assert.equal(parseFilterConfig({ JEV_FILTER_MODE: 'off' }).mode, 'off');
    assert.equal(parseFilterConfig({ JEV_FILTER_MODE: 'shadow' }).mode, 'shadow');
    assert.equal(parseFilterConfig({ JEV_FILTER_MODE: 'on' }).mode, 'on');
  });

  it('ignores case and surrounding whitespace in the mode', () => {
    assert.equal(parseFilterConfig({ JEV_FILTER_MODE: ' ON ' }).mode, 'on');
    assert.equal(parseFilterConfig({ JEV_FILTER_MODE: 'Shadow' }).mode, 'shadow');
  });

  it('falls back to off for unknown or empty modes', () => {
    assert.equal(parseFilterConfig({ JEV_FILTER_MODE: 'banana' }).mode, 'off');
    assert.equal(parseFilterConfig({ JEV_FILTER_MODE: '' }).mode, 'off');
    assert.equal(parseFilterConfig({ JEV_FILTER_MODE: undefined }).mode, 'off');
  });

  it('accepts overfetch factors of at least 1', () => {
    assert.equal(parseFilterConfig({ JEV_FILTER_OVERFETCH_FACTOR: '2' }).overfetchFactor, 2);
    assert.equal(parseFilterConfig({ JEV_FILTER_OVERFETCH_FACTOR: '1.5' }).overfetchFactor, 1.5);
    assert.equal(parseFilterConfig({ JEV_FILTER_OVERFETCH_FACTOR: '1' }).overfetchFactor, 1);
  });

  it('falls back to factor 1 for non-numeric or sub-1 values', () => {
    assert.equal(parseFilterConfig({ JEV_FILTER_OVERFETCH_FACTOR: '0.5' }).overfetchFactor, 1);
    assert.equal(parseFilterConfig({ JEV_FILTER_OVERFETCH_FACTOR: 'abc' }).overfetchFactor, 1);
    assert.equal(parseFilterConfig({ JEV_FILTER_OVERFETCH_FACTOR: '' }).overfetchFactor, 1);
    assert.equal(parseFilterConfig({ JEV_FILTER_OVERFETCH_FACTOR: '-3' }).overfetchFactor, 1);
    assert.equal(parseFilterConfig({ JEV_FILTER_OVERFETCH_FACTOR: 'Infinity' }).overfetchFactor, 1);
  });

  it('falls back to the pinned model for an empty or whitespace model value', () => {
    assert.equal(parseFilterConfig({ JEV_FILTER_JEV_MODEL: '' }).jev.model, 'jev-1.13.0');
    assert.equal(parseFilterConfig({ JEV_FILTER_JEV_MODEL: '   ' }).jev.model, 'jev-1.13.0');
    assert.equal(parseFilterConfig({}).jev.model, 'jev-1.13.0');
  });

  it('trims a custom model value', () => {
    assert.equal(
      parseFilterConfig({ JEV_FILTER_JEV_MODEL: ' jev-1.14.0 ' }).jev.model,
      'jev-1.14.0'
    );
  });

  it('falls back to the typesafe backend for values outside the backend set (JEV-01)', () => {
    assert.equal(
      parseFilterConfig({ JEV_FILTER_JEV_BACKEND: 'openrouter' }).jev.backend,
      'typesafe'
    );
    assert.equal(parseFilterConfig({ JEV_FILTER_JEV_BACKEND: '' }).jev.backend, 'typesafe');
    assert.equal(parseFilterConfig({ JEV_FILTER_JEV_BACKEND: 'typesafe' }).jev.backend, 'typesafe');
  });

  it('falls back to the 15000ms timeout for non-numeric or sub-1 values', () => {
    assert.equal(parseFilterConfig({ JEV_FILTER_JEV_TIMEOUT_MS: 'abc' }).jev.timeoutMs, 15000);
    assert.equal(parseFilterConfig({ JEV_FILTER_JEV_TIMEOUT_MS: '-5' }).jev.timeoutMs, 15000);
    assert.equal(parseFilterConfig({ JEV_FILTER_JEV_TIMEOUT_MS: '0' }).jev.timeoutMs, 15000);
    assert.equal(parseFilterConfig({ JEV_FILTER_JEV_TIMEOUT_MS: '' }).jev.timeoutMs, 15000);
    assert.equal(parseFilterConfig({ JEV_FILTER_JEV_TIMEOUT_MS: '30000' }).jev.timeoutMs, 30000);
  });

  it('falls back to the concurrency gate value of 12 for non-numeric or sub-1 values', () => {
    assert.equal(parseFilterConfig({ JEV_FILTER_JEV_CONCURRENCY: '0' }).jev.concurrency, 12);
    assert.equal(parseFilterConfig({ JEV_FILTER_JEV_CONCURRENCY: 'abc' }).jev.concurrency, 12);
    assert.equal(parseFilterConfig({ JEV_FILTER_JEV_CONCURRENCY: '-2' }).jev.concurrency, 12);
    assert.equal(parseFilterConfig({ JEV_FILTER_JEV_CONCURRENCY: '6' }).jev.concurrency, 6);
  });

  it('is a pure function: the same env yields deep-equal results', () => {
    const env = { JEV_FILTER_MODE: 'shadow', JEV_FILTER_OVERFETCH_FACTOR: '2' };

    const first = parseFilterConfig(env);
    const second = parseFilterConfig(env);

    assert.deepEqual(first, second);
    assert.notEqual(first, second);
    assert.deepEqual(env, { JEV_FILTER_MODE: 'shadow', JEV_FILTER_OVERFETCH_FACTOR: '2' });
  });

  it('never reads process.env on its own', () => {
    // 导入期与调用期都不读 process.env：只看传入的 env 对象
    const original = process.env.JEV_FILTER_MODE;
    process.env.JEV_FILTER_MODE = 'on';

    try {
      assert.equal(parseFilterConfig({}).mode, 'off');
    } finally {
      if (original === undefined) {
        delete process.env.JEV_FILTER_MODE;
      } else {
        process.env.JEV_FILTER_MODE = original;
      }
    }
  });
});

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
const makeTmpRoot = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'jev-config-test-'));
  return dir;
};

const writeFixture = (dir: string, name: string, content: unknown): string => {
  const filePath = join(dir, name);
  writeFileSync(filePath, typeof content === 'string' ? content : JSON.stringify(content), 'utf8');
  return filePath;
};

describe('resolveThresholds via JEV_FILTER_CONFIG_FILE (02-06)', () => {
  const tmpRoot = makeTmpRoot();
  after(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('returns a frozen shallow copy of the defaults when the variable is unset', () => {
    const thresholds = resolveThresholds({});
    assert.deepEqual(thresholds, { ...DEFAULT_THRESHOLDS });
    assert.notEqual(thresholds, DEFAULT_THRESHOLDS);
    assert.ok(Object.isFrozen(thresholds));
    // 未设时空串与纯空白同样按未设处理（description.ts 先例）
    assert.deepEqual(resolveThresholds({ [JEV_CONFIG_FILE_ENV]: '' }), { ...DEFAULT_THRESHOLDS });
    assert.deepEqual(resolveThresholds({ [JEV_CONFIG_FILE_ENV]: '   ' }), {
      ...DEFAULT_THRESHOLDS,
    });
  });

  it('falls back to every default when the file does not exist, with one stderr line', () => {
    const missing = join(tmpRoot, 'no-such-config.json');
    let thresholds: ReturnType<typeof resolveThresholds> | undefined;
    const stderr = captureStderr(() => {
      thresholds = resolveThresholds({ [JEV_CONFIG_FILE_ENV]: missing });
    });
    assert.deepEqual(thresholds, { ...DEFAULT_THRESHOLDS });
    assert.equal(stderr.length, 1);
    assert.ok(stderr[0].startsWith('[jev-filter]'), stderr[0]);
    assert.ok(stderr[0].includes(missing), stderr[0]);
  });

  it('falls back to every default when the file is not valid JSON', () => {
    const bad = writeFixture(tmpRoot, 'bad.json', '{not valid json');
    let thresholds: ReturnType<typeof resolveThresholds> | undefined;
    const stderr = captureStderr(() => {
      thresholds = resolveThresholds({ [JEV_CONFIG_FILE_ENV]: bad });
    });
    assert.deepEqual(thresholds, { ...DEFAULT_THRESHOLDS });
    assert.equal(stderr.length, 1);
    assert.ok(stderr[0].startsWith('[jev-filter]'), stderr[0]);
  });

  it('falls back to every default when the file is not a JSON object', () => {
    const array = writeFixture(tmpRoot, 'array.json', [1, 2]);
    let thresholds: ReturnType<typeof resolveThresholds> | undefined;
    const stderr = captureStderr(() => {
      thresholds = resolveThresholds({ [JEV_CONFIG_FILE_ENV]: array });
    });
    assert.deepEqual(thresholds, { ...DEFAULT_THRESHOLDS });
    assert.equal(stderr.length, 1);
  });

  it('applies the overridden values from a valid file and keeps the rest at defaults', () => {
    const file = writeFixture(tmpRoot, 'valid.json', {
      off_topic_drop: 0.9,
      snippet_min: 1.2,
      min_facts: 6,
    });
    let thresholds: ReturnType<typeof resolveThresholds> | undefined;
    const stderr = captureStderr(() => {
      thresholds = resolveThresholds({ [JEV_CONFIG_FILE_ENV]: file });
    });
    assert.equal(stderr.length, 0);
    assert.deepEqual(thresholds, {
      ...DEFAULT_THRESHOLDS,
      offTopicDrop: 0.9,
      snippetMin: 1.2,
      minFacts: 6,
    });
  });

  it('keeps the default for keys missing from the config file', () => {
    const partial = writeFixture(tmpRoot, 'partial.json', { off_topic_drop: 0.9 });
    let thresholds: ReturnType<typeof resolveThresholds> | undefined;
    const stderr = captureStderr(() => {
      thresholds = resolveThresholds({ [JEV_CONFIG_FILE_ENV]: partial });
    });
    assert.equal(stderr.length, 0);
    assert.equal(thresholds?.offTopicDrop, 0.9);
    assert.deepEqual(
      { ...thresholds, offTopicDrop: DEFAULT_THRESHOLDS.offTopicDrop },
      { ...DEFAULT_THRESHOLDS }
    );
  });

  it('falls back per-key for an out-of-range upper bound while other file keys still apply', () => {
    const mixed = writeFixture(tmpRoot, 'mixed.json', {
      off_topic_drop: 1.5,
      snippet_min: 1.2,
      min_facts: 6,
    });
    let thresholds: ReturnType<typeof resolveThresholds> | undefined;
    const stderr = captureStderr(() => {
      thresholds = resolveThresholds({ [JEV_CONFIG_FILE_ENV]: mixed });
    });
    assert.equal(stderr.length, 0);
    // 坏值只回落该项；其余文件项仍生效（T-02-06-1：坏值绝不拖垮整层）
    assert.equal(thresholds?.offTopicDrop, DEFAULT_THRESHOLDS.offTopicDrop);
    assert.equal(thresholds?.snippetMin, 1.2);
    assert.equal(thresholds?.minFacts, 6);
  });

  it("falls back per-key for a non-numeric value (reasoning_protect 'high')", () => {
    const nonNumeric = writeFixture(tmpRoot, 'non-numeric.json', {
      reasoning_protect: 'high',
      cjk_bonus: 0.2,
    });
    let thresholds: ReturnType<typeof resolveThresholds> | undefined;
    const stderr = captureStderr(() => {
      thresholds = resolveThresholds({ [JEV_CONFIG_FILE_ENV]: nonNumeric });
    });
    assert.equal(stderr.length, 0);
    assert.equal(thresholds?.reasoningProtect, DEFAULT_THRESHOLDS.reasoningProtect);
    assert.equal(thresholds?.cjkBonus, 0.2);
  });

  it('falls back per-key for an out-of-range snippet_min 5', () => {
    const file = writeFixture(tmpRoot, 'snippet-max.json', { snippet_min: 5 });
    let thresholds: ReturnType<typeof resolveThresholds> | undefined;
    const stderr = captureStderr(() => {
      thresholds = resolveThresholds({ [JEV_CONFIG_FILE_ENV]: file });
    });
    assert.equal(stderr.length, 0);
    assert.equal(thresholds?.snippetMin, DEFAULT_THRESHOLDS.snippetMin);
  });

  it('falls back per-key for min_facts below one (0)', () => {
    const file = writeFixture(tmpRoot, 'min-facts.json', { min_facts: 0 });
    let thresholds: ReturnType<typeof resolveThresholds> | undefined;
    const stderr = captureStderr(() => {
      thresholds = resolveThresholds({ [JEV_CONFIG_FILE_ENV]: file });
    });
    assert.equal(stderr.length, 0);
    assert.equal(thresholds?.minFacts, DEFAULT_THRESHOLDS.minFacts);
  });

  it('falls back per-key for negative novelty_min (-1)', () => {
    const file = writeFixture(tmpRoot, 'novelty-min.json', { novelty_min: -1 });
    let thresholds: ReturnType<typeof resolveThresholds> | undefined;
    const stderr = captureStderr(() => {
      thresholds = resolveThresholds({ [JEV_CONFIG_FILE_ENV]: file });
    });
    assert.equal(stderr.length, 0);
    assert.equal(thresholds?.noveltyMin, DEFAULT_THRESHOLDS.noveltyMin);
  });

  it('accepts boundary values of 0 and 1 for cjk_share', () => {
    const zero = writeFixture(tmpRoot, 'cjk-share-zero.json', { cjk_share: 0 });
    let thresholds: ReturnType<typeof resolveThresholds> | undefined;
    const stderr = captureStderr(() => {
      thresholds = resolveThresholds({ [JEV_CONFIG_FILE_ENV]: zero });
    });
    assert.equal(stderr.length, 0);
    assert.equal(thresholds?.cjkShare, 0);

    const one = writeFixture(tmpRoot, 'cjk-share-one.json', { cjk_share: 1 });
    const stderrOne = captureStderr(() => {
      thresholds = resolveThresholds({ [JEV_CONFIG_FILE_ENV]: one });
    });
    assert.equal(stderrOne.length, 0);
    assert.equal(thresholds?.cjkShare, 1);
  });

  it('ignores unknown keys in the config file (fail-open direction)', () => {
    const unknown = writeFixture(tmpRoot, 'unknown-keys.json', {
      unknown_key: 123,
      off_topic_drop: 0.9,
    });
    let thresholds: ReturnType<typeof resolveThresholds> | undefined;
    const stderr = captureStderr(() => {
      thresholds = resolveThresholds({ [JEV_CONFIG_FILE_ENV]: unknown });
    });
    assert.equal(stderr.length, 0);
    assert.equal(thresholds?.offTopicDrop, 0.9);
    assert.deepEqual(
      { ...thresholds, offTopicDrop: DEFAULT_THRESHOLDS.offTopicDrop },
      { ...DEFAULT_THRESHOLDS }
    );
  });

  it('wires the config file through parseFilterConfig (thresholds override merged)', () => {
    const file = writeFixture(tmpRoot, 'wired.json', { off_topic_drop: 0.9, snippet_min: 1.2 });
    let config: ReturnType<typeof parseFilterConfig> | undefined;
    const stderr = captureStderr(() => {
      config = parseFilterConfig({ [JEV_CONFIG_FILE_ENV]: file });
    });
    assert.equal(stderr.length, 0);
    assert.deepEqual(config?.thresholds, {
      ...DEFAULT_THRESHOLDS,
      offTopicDrop: 0.9,
      snippetMin: 1.2,
    });
  });
});

describe('blocklist file via JEV_FILTER_BLOCKLIST_FILE (02-06)', () => {
  const tmpRoot = makeTmpRoot();
  after(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('merges the blocklist file hosts with the built-in blocklist', () => {
    const file = writeFixture(
      tmpRoot,
      'blocklist.txt',
      '# farm candidates\nfarm-a.example\nWWW.Farm-B.EXAMPLE\n\n'
    );
    let blocklist: ReadonlySet<string> | undefined;
    const stderr = captureStderr(() => {
      blocklist = parseFilterConfig({ [JEV_BLOCKLIST_FILE_ENV]: file }).blocklist;
    });
    assert.equal(stderr.length, 0);
    // parseBlocklist 复用（不写第二份解析器）：去 www、小写、跳注释与空行
    assert.ok(blocklist?.has('farm-a.example'));
    assert.ok(blocklist?.has('farm-b.example'));
    // 与内置求并集：内置成员全部仍在；每次调用新建 Set，内置常量不被改写
    for (const host of DEFAULT_BLOCKLIST) {
      assert.ok(blocklist?.has(host));
    }
    assert.notEqual(blocklist, DEFAULT_BLOCKLIST);
    assert.equal(DEFAULT_BLOCKLIST.size, 0);

    const second = captureStderr(() => {
      assert.notEqual(parseFilterConfig({ [JEV_BLOCKLIST_FILE_ENV]: file }).blocklist, blocklist);
    });
    assert.equal(second.length, 0);
  });

  it('falls back to the built-in blocklist only when the file is missing', () => {
    const missing = join(tmpRoot, 'no-such-blocklist.txt');
    let blocklist: ReadonlySet<string> | undefined;
    const stderr = captureStderr(() => {
      blocklist = parseFilterConfig({ [JEV_BLOCKLIST_FILE_ENV]: missing }).blocklist;
    });
    assert.deepEqual(blocklist, DEFAULT_BLOCKLIST);
    assert.equal(stderr.length, 1);
    assert.ok(stderr[0].startsWith('[jev-filter]'), stderr[0]);
    assert.ok(stderr[0].includes(missing), stderr[0]);
  });
});
