import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_BLOCKLIST } from './blocklist.js';
import { parseFilterConfig } from './config.js';

describe('parseFilterConfig', () => {
  it('defaults to off with factor 1 when nothing is set', () => {
    assert.deepEqual(parseFilterConfig({}), {
      mode: 'off',
      overfetchFactor: 1,
      blocklist: new Set(),
    });
  });

  it('exposes the default blocklist, initially empty', () => {
    assert.deepEqual(parseFilterConfig({}).blocklist, DEFAULT_BLOCKLIST);
    assert.equal(DEFAULT_BLOCKLIST.size, 0);
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
