import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { estimateTokens } from './tokens.js';

/** 读一份 wrapped 夹具（两份 Jev 夹具顶层都是 { request, response }）。 */
const loadWrapped = (rel: string): {
  request: { maximum_number_of_tokens?: number };
  response: { grounding: { generic: { snippets: string[] }[] } };
} => JSON.parse(readFileSync(fileURLToPath(new URL(`../../fixtures/${rel}`, import.meta.url)), 'utf8'));

const rawSnippets = (fixture: ReturnType<typeof loadWrapped>): string[] =>
  fixture.response.grounding.generic.flatMap((item) => item.snippets);

describe('estimateTokens', () => {
  it('returns 0 for an empty string', () => {
    assert.equal(estimateTokens(''), 0);
  });

  it('counts a short English word as one token', () => {
    assert.equal(estimateTokens('brave'), 1);
  });

  it('adds one extra token per full 6 letters across the 5/6/11/12 boundaries', () => {
    assert.equal(estimateTokens('hello'), 1); // 5 字母 → 1 + 0
    assert.equal(estimateTokens('models'), 2); // 6 字母 → 1 + 1
    assert.equal(estimateTokens('temperature'), 2); // 11 字母 → 1 + 1
    assert.equal(estimateTokens('optimization'), 3); // 12 字母 → 1 + 2
  });

  it('counts digits as half a token each', () => {
    assert.ok(Math.abs(estimateTokens('2026') - 2) < 1e-9);
  });

  it('counts CJK characters as 0.9 each', () => {
    const text = '今天天气不错我们出去玩吧'; // 12 个汉字
    assert.ok(Math.abs(estimateTokens(text) - text.length * 0.9) < 1e-9);
  });

  it('handles a mixed string of latin words, digits and punctuation', () => {
    // 'Jev' → 1，'2026' → 2，'!' → 0.9，空白不计
    assert.ok(Math.abs(estimateTokens('Jev 2026!') - (1 + 2 + 0.9)) < 1e-9);
  });

  it('never charges whitespace on its own', () => {
    assert.equal(estimateTokens('  \n\t '), 0);
  });

  it('estimates text with whitespace the same as the same text without it', () => {
    // 选 CJK 保证去空白不会合并出新的"词"
    assert.equal(estimateTokens('你好 世界'), estimateTokens('你好世界'));
  });

  it('charges whitespace-heavy text no more than its squeezed form', () => {
    // 换行、连续空格、制表符都不加分（空白量变化不影响估算）
    const text = [
      'Brave Search launched a new LLM context endpoint today,',
      '  and the release notes mention budget trimming.',
    ].join('\n\n      ');
    assert.equal(estimateTokens(text), estimateTokens(text.replace(/\s+/g, ' ')));
    assert.equal(estimateTokens('a\tb'), estimateTokens('a b'));
    assert.equal(estimateTokens('a\nb'), estimateTokens('a b'));
    assert.equal(estimateTokens('a  b'), estimateTokens('a b'));
  });

  it('keeps the default fixture raw total in the 8.0k–9.0k band, below its own budget', () => {
    const fixture = loadWrapped('jev_release_default.json');
    const snippets = rawSnippets(fixture);
    assert.equal(snippets.length, 76);

    const total = snippets.reduce((sum, text) => sum + estimateTokens(text), 0);
    assert.ok(total >= 8000 && total < 9000, `default raw estimate ${total} out of band`);
    assert.ok(
      total < (fixture.request.maximum_number_of_tokens ?? Infinity),
      'default fixture must not trigger trimming under its own request'
    );
  });

  it('keeps the strict fixture raw total below 6000 and its own budget', () => {
    const fixture = loadWrapped('jev_release_strict.json');
    const snippets = rawSnippets(fixture);
    assert.equal(snippets.length, 41);

    const total = snippets.reduce((sum, text) => sum + estimateTokens(text), 0);
    assert.ok(total < 6000, `strict raw estimate ${total} not below 6000`);
    assert.ok(
      total < (fixture.request.maximum_number_of_tokens ?? Infinity),
      'strict fixture must not trigger trimming under its own request'
    );
  });
});
