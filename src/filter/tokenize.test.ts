import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { contentTerms, jaccard, containment, shingles, tokenize } from './tokenize.js';

describe('tokenize', () => {
  it('splits Latin and digit runs into lowercased tokens and keeps version tokens', () => {
    assert.deepEqual(tokenize('Jev TypeSafe v6 2026'), ['jev', 'typesafe', 'v6', '2026']);
  });

  it('cuts Han runs into character bigrams, never into one long token', () => {
    // RESEARCH Pitfall 9：[\p{L}]+ 会把整段汉字粘成一个 token，中文片段将永远"不含实词"
    assert.deepEqual(tokenize('内容发布'), ['内容', '容发', '发布']);
    assert.equal(tokenize('内容发布').includes('内容发布'), false);
  });

  it('keeps a single Han character as one token', () => {
    assert.deepEqual(tokenize('问'), ['问']);
  });

  it('cuts Kana runs into character bigrams', () => {
    assert.deepEqual(tokenize('こんにちは'), ['こん', 'んに', 'にち', 'ちは']);
  });

  it('cuts Hangul runs into character bigrams', () => {
    assert.deepEqual(tokenize('한글텍스트'), ['한글', '글텍', '텍스', '스트']);
  });

  it('splits mixed-script text at script boundaries', () => {
    assert.deepEqual(tokenize('Jev 内容发布 v6'), ['jev', '内容', '容发', '发布', 'v6']);
  });

  it('splits punctuation-delimited words', () => {
    assert.deepEqual(tokenize('sanity.config.ts'), ['sanity', 'config', 'ts']);
  });

  it('returns no tokens for empty or whitespace-only text', () => {
    assert.deepEqual(tokenize(''), []);
    assert.deepEqual(tokenize('  \n\t '), []);
  });
});

describe('contentTerms', () => {
  it('extracts content terms from the default fixture query', () => {
    const terms = contentTerms('Jev TypeSafe AI model release');

    assert.deepEqual([...terms].sort(), ['ai', 'jev', 'model', 'release', 'typesafe']);
  });

  it('drops English stopwords and search boilerplate', () => {
    const terms = contentTerms('the latest guide tutorial how what');

    assert.deepEqual([...terms], []);
  });

  it('drops Chinese boilerplate bigrams after tokenization', () => {
    // 「怎么」「如何」各成唯一二元，去停用词后为空
    assert.deepEqual([...contentTerms('怎么 如何')], []);
  });

  it('does not keep generic English filler in a realistic query', () => {
    const terms = contentTerms('Jev TypeSafe AI model release', '');

    assert.equal(terms.has('the'), false);
    assert.equal(terms.has('latest'), false);
    assert.equal(terms.has('jev'), true);
    assert.equal(terms.has('typesafe'), true);
    assert.equal(terms.has('release'), true);
  });

  it('merges several texts into one deduplicated term set', () => {
    const terms = contentTerms('Jev release', 'release how');

    assert.deepEqual([...terms].sort(), ['jev', 'release']);
  });
});

describe('shingles', () => {
  it('returns an empty set when there are fewer tokens than n', () => {
    assert.equal(shingles(['a', 'b', 'c', 'd']).size, 0);
  });

  it('builds n-token windows joined by single spaces', () => {
    assert.deepEqual([...shingles(['a', 'b', 'c', 'd', 'e'])], ['a b c d e']);
    assert.equal(shingles(['a', 'b', 'c', 'd', 'e', 'f', 'g']).size, 3);
  });

  it('dedupes identical windows', () => {
    assert.equal(shingles(['x', 'x', 'x', 'x', 'x', 'x']).size, 1);
  });
});

describe('jaccard', () => {
  it('returns 0 when either set is empty', () => {
    assert.equal(jaccard(new Set(), new Set(['a'])), 0);
    assert.equal(jaccard(new Set(['a']), new Set()), 0);
    assert.equal(jaccard(new Set(), new Set()), 0);
  });

  it('returns 1 for identical sets', () => {
    assert.equal(jaccard(new Set(['a', 'b']), new Set(['b', 'a'])), 1);
  });

  it('returns the intersection over the union', () => {
    assert.equal(jaccard(new Set(['a', 'b', 'c']), new Set(['a', 'b', 'd'])), 0.4);
  });

  it('returns 0 for disjoint sets', () => {
    assert.equal(jaccard(new Set(['a']), new Set(['b'])), 0);
  });
});

describe('containment', () => {
  it('returns 0 when either set is empty', () => {
    assert.equal(containment(new Set(), new Set(['a'])), 0);
    assert.equal(containment(new Set(['a']), new Set()), 0);
  });

  it('returns 1 when the smaller set is a subset, true or not', () => {
    // 真子集（A ⊊ B）→ 1
    assert.equal(containment(new Set(['a', 'b']), new Set(['a', 'b', 'c'])), 1);
    assert.equal(containment(new Set(['a', 'b', 'c']), new Set(['a', 'b'])), 1);
  });

  it('returns the intersection over the smaller set', () => {
    assert.equal(containment(new Set(['a', 'b', 'c', 'd', 'e']), new Set(['a', 'b', 'c'])), 0.6);
  });
});
