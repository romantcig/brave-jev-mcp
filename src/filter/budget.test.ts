import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BRAVE_MAX_TOKENS, BRAVE_MAX_URLS, applyOverfetch } from './budget.js';
import type { FilterConfig } from './types.js';

const unit: FilterConfig = { mode: 'off', overfetchFactor: 1 };
const doubled: FilterConfig = { mode: 'off', overfetchFactor: 2 };

describe('applyOverfetch', () => {
  it('returns the very same object when the factor is 1', () => {
    const params = { query: 'q', maximum_number_of_urls: 5, maximum_number_of_tokens: 4000 };

    assert.equal(applyOverfetch(params, unit), params);
  });

  it('scales urls and tokens by the factor, rounding down', () => {
    const params = { query: 'q', maximum_number_of_urls: 5, maximum_number_of_tokens: 4001 };

    const result = applyOverfetch(params, { mode: 'off', overfetchFactor: 1.5 });

    assert.equal(result.maximum_number_of_urls, 7);
    assert.equal(result.maximum_number_of_tokens, 6001);
    assert.equal(result.query, 'q');
  });

  it('clamps to the Brave maximums', () => {
    const result = applyOverfetch(
      { maximum_number_of_urls: 50, maximum_number_of_tokens: 32768 },
      doubled
    );

    assert.equal(result.maximum_number_of_urls, BRAVE_MAX_URLS);
    assert.equal(result.maximum_number_of_tokens, BRAVE_MAX_TOKENS);
    assert.equal(BRAVE_MAX_URLS, 50);
    assert.equal(BRAVE_MAX_TOKENS, 32768);
  });

  it('does not invent keys that were absent', () => {
    const params: { query: string; maximum_number_of_urls?: number } = { query: 'q' };

    const result = applyOverfetch(params, doubled);

    assert.deepEqual(result, { query: 'q' });
    assert.equal(Object.hasOwn(result, 'maximum_number_of_urls'), false);
    assert.equal(Object.hasOwn(result, 'maximum_number_of_tokens'), false);
  });

  it('leaves maximum_number_of_tokens_per_url untouched', () => {
    const result = applyOverfetch(
      {
        maximum_number_of_urls: 5,
        maximum_number_of_tokens: 4000,
        maximum_number_of_tokens_per_url: 800,
      },
      doubled
    );

    assert.deepEqual(result, {
      maximum_number_of_urls: 10,
      maximum_number_of_tokens: 8000,
      maximum_number_of_tokens_per_url: 800,
    });
  });

  it('never mutates the input', () => {
    const params = { query: 'q', maximum_number_of_urls: 5, maximum_number_of_tokens: 4000 };
    const snapshot = structuredClone(params);

    const result = applyOverfetch(params, doubled);

    assert.notEqual(result, params);
    assert.deepEqual(params, snapshot);
  });
});
