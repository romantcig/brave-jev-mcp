import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_BLOCKLIST } from './blocklist.js';
import { parseFilterConfig } from './config.js';
import { DEFAULT_JEV_MODEL, DEFAULT_THRESHOLDS } from './jev/questions.js';

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
