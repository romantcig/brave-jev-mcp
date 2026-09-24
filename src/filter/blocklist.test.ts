import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_BLOCKLIST, DEFAULT_BLOCKLIST_TEXT, parseBlocklist } from './blocklist.js';

describe('parseBlocklist', () => {
  it('parses one canonical host per line', () => {
    const parsed = parseBlocklist('farm.example\nmirrors.example');

    assert.deepEqual([...parsed].sort(), ['farm.example', 'mirrors.example']);
  });

  it('skips comment lines and blank lines', () => {
    const parsed = parseBlocklist('# a comment\n\nfarm.example\n   \n\t\n# another\n');

    assert.deepEqual([...parsed], ['farm.example']);
  });

  it('lowercases, strips www. and trims surrounding whitespace', () => {
    const parsed = parseBlocklist('  WWW.Farm.EXAMPLE  \n\tMirrors.EXAMPLE\n');

    assert.deepEqual([...parsed].sort(), ['farm.example', 'mirrors.example']);
  });
});

describe('DEFAULT_BLOCKLIST', () => {
  it('starts empty: only comments and a format example in the text', () => {
    assert.equal(DEFAULT_BLOCKLIST.size, 0);
  });

  it('is derived from DEFAULT_BLOCKLIST_TEXT', () => {
    assert.deepEqual([...DEFAULT_BLOCKLIST], [...parseBlocklist(DEFAULT_BLOCKLIST_TEXT)]);
  });
});
