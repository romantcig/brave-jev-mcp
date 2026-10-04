import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isEmptySource, isOneLiner } from './nonArticle.js';
import { contentTerms } from './tokenize.js';

describe('isEmptySource', () => {
  it('is true exactly when no snippet survived', () => {
    assert.equal(isEmptySource([]), true);
    assert.equal(isEmptySource([{ text: 'kept body.' }]), false);
  });
});

describe('isOneLiner', () => {
  const queryTerms = contentTerms('foo bar');

  it('drops a single short snippet that shares no query term', () => {
    assert.equal(isOneLiner([{ text: 'the current version' }], queryTerms), true);
  });

  it('keeps a single short snippet that contains a query term', () => {
    assert.equal(isOneLiner([{ text: 'foo explained' }], queryTerms), false);
  });

  it('never judges a source with two surviving snippets', () => {
    assert.equal(isOneLiner([{ text: 'a' }, { text: 'b' }], queryTerms), false);
  });

  it('keeps everything when the query term set is empty (conservative)', () => {
    assert.equal(isOneLiner([{ text: 'the current version' }], new Set()), false);
  });

  it('ignores a single long snippet at or above the threshold', () => {
    assert.equal(isOneLiner([{ text: 'x'.repeat(200) }], queryTerms), false);
  });
});
