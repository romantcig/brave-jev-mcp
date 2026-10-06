/** 页面日期选择、归并冲突与检索时间测试；合法值原样保留，非法或缺失值不补当前时间。 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { normalizeRetrievalTime, selectPageDate } from './temporal.js';

describe('selectPageDate', () => {
  it('拒绝不存在的日期和残缺时间，并继续寻找合法日期', () => {
    for (const bad of [
      '2026-02-29',
      '2026-04-31',
      '2026-13-01',
      '2026-00-01',
      '2026-01-00',
      '2026-02-30T12:00:00Z',
      '2026-10-01T',
      '2026-10-01T25:00:00Z',
      '2026-10-01T12:60:00Z',
      '2026-10-01T12:00:00+99:00',
      '2026-10-01\n',
      '2026-10-01T12:00:00Z\n',
    ]) {
      assert.equal(selectPageDate({ age: [bad] }), null, bad);
      assert.equal(selectPageDate({ age: [bad, '2026-10-01'] }), '2026-10-01', bad);
    }
    assert.equal(selectPageDate({ age: ['2024-02-29'] }), '2024-02-29');
    assert.equal(selectPageDate({ age: ['1900-02-29'] }), null);
    assert.equal(selectPageDate({ age: ['2000-02-29'] }), '2000-02-29');
    assert.equal(selectPageDate({ age: ['2026-10-01T00:00:00'] }), '2026-10-01T00:00:00');
  });
  it('prefers the first absolute ISO time element and keeps the original string', () => {
    assert.equal(
      selectPageDate({ age: ['2026-10-01', '2026-10-01T13:00:00Z'] }),
      '2026-10-01T13:00:00Z'
    );
    assert.equal(
      selectPageDate({ age: ['Wed', '2026-09-16T00:00:00Z', '1 week ago'] }),
      '2026-09-16T00:00:00Z'
    );
  });

  it('falls back to the first plain YYYY-MM-DD element when no absolute time exists', () => {
    assert.equal(selectPageDate({ age: ['Wed', '2026-09-16', '1 week ago'] }), '2026-09-16');
    assert.equal(selectPageDate({ age: ['3 days ago', '2024-01-12'] }), '2024-01-12');
  });

  it('returns null for relative-only ages: no day-counting, no today substitution', () => {
    assert.equal(selectPageDate({ age: ['3 days ago'] }), null);
    assert.equal(selectPageDate({ age: [] }), null);
    assert.equal(selectPageDate({ age: ['Wednesday, September 16, 2026'] }), null);
  });

  it('returns null for missing or malformed metadata without throwing', () => {
    assert.equal(selectPageDate(undefined), null);
    assert.equal(selectPageDate({}), null);
  });

  it('does not let a date-only string match the absolute pattern or vice versa', () => {
    // 纯日期不满足绝对时间判定（要求 T 开头的时间部分）；带时间的字串也不会
    // 落进纯日期分支——优先级由两个独立模式保证
    assert.equal(selectPageDate({ age: ['2026-09-16T00:00:00Z'] }), '2026-09-16T00:00:00Z');
    assert.equal(selectPageDate({ age: ['2026-09-16'] }), '2026-09-16');
  });
});

describe('normalizeRetrievalTime', () => {
  it('拒绝伪日期、缺少时区和宽松 Date.parse 接受的非 ISO 值', () => {
    for (const value of [
      '2026-02-30T12:00:00Z',
      '2026-10-01',
      '2026-10-01T00:00:00',
      '10/01/2026',
      '42',
      '2026-10-01T24:00:00Z',
      '2026-10-01T12:00:00+99:00',
    ]) {
      assert.equal(normalizeRetrievalTime(value), undefined, value);
    }
  });
  it('passes through valid ISO timestamps verbatim (replay uses the log ts unchanged)', () => {
    assert.equal(
      normalizeRetrievalTime('2026-10-02T04:26:27.787+08:00'),
      '2026-10-02T04:26:27.787+08:00'
    );
    assert.equal(normalizeRetrievalTime('2026-10-02T04:26:27Z'), '2026-10-02T04:26:27Z');
  });

  it('rejects blank, garbage, and non-string values so the field is omitted', () => {
    assert.equal(normalizeRetrievalTime(''), undefined);
    assert.equal(normalizeRetrievalTime('   '), undefined);
    assert.equal(normalizeRetrievalTime('not a date'), undefined);
    assert.equal(normalizeRetrievalTime(42), undefined);
    assert.equal(normalizeRetrievalTime(null), undefined);
    assert.equal(normalizeRetrievalTime(undefined), undefined);
  });
});
