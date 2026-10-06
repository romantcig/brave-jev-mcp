import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isEmptySource } from './nonArticle.js';

describe('isEmptySource', () => {
  it('is true exactly when no snippet survived', () => {
    assert.equal(isEmptySource([]), true);
    assert.equal(isEmptySource([{ text: 'kept body.' }]), false);
  });
});
