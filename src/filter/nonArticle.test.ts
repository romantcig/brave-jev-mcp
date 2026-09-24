import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PAYWALL_MARKERS_EN, PAYWALL_MARKERS_ZH } from './markers.js';
import { truncateAtPaywall } from './nonArticle.js';

describe('truncateAtPaywall', () => {
  it('truncates at an English marker line, keeping only the text before it', () => {
    const text = 'Para one.\n\nSubscribe to continue reading\nGarbage after the marker.';

    const result = truncateAtPaywall(text, PAYWALL_MARKERS_EN);

    assert.deepEqual(result, { text: 'Para one.', truncated: true });
    assert.equal(result.text.length, 'Para one.'.length);
  });

  it('truncates at a Chinese marker line', () => {
    const result = truncateAtPaywall('正文第一段。\n以下为付费内容\n隐藏部分', PAYWALL_MARKERS_ZH);

    assert.deepEqual(result, { text: '正文第一段。', truncated: true });
  });

  it('matches markers case-insensitively after stripping leading markdown markers', () => {
    const result = truncateAtPaywall('## Members only\nrest', PAYWALL_MARKERS_EN);

    // 标记出现在首行行首、前无内容 → 截断为空串（调用方按 paywall_empty 删）
    assert.deepEqual(result, { text: '', truncated: true });
  });

  it('does not truncate when the marker appears mid-line', () => {
    const text = 'We discuss "Subscribe to continue reading" policies in this article.';

    const result = truncateAtPaywall(text, PAYWALL_MARKERS_EN);

    assert.deepEqual(result, { text, truncated: false });
  });

  it('returns the text unchanged when no marker is present', () => {
    const text = '# Heading\n\nNormal body text.';

    const result = truncateAtPaywall(text, PAYWALL_MARKERS_EN);

    assert.deepEqual(result, { text, truncated: false });
  });

  it('truncates at the first matching line only', () => {
    const text = 'Intro\nSign in to read\nmore\nMembers only\ntail';

    const result = truncateAtPaywall(text, PAYWALL_MARKERS_EN);

    assert.deepEqual(result, { text: 'Intro', truncated: true });
  });
});
