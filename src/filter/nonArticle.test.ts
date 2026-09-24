import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PAYWALL_MARKERS_EN, PAYWALL_MARKERS_ZH } from './markers.js';
import {
  isBlocklisted,
  isEmptySource,
  isFeedUrl,
  isOneLiner,
  truncateAtPaywall,
} from './nonArticle.js';
import { contentTerms } from './tokenize.js';

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

  it('does not truncate when a body line merely begins with a marker', () => {
    // 裸 startsWith 会把以 "Premium content" 开头的正文行当标记，截掉其后全部内容
    const text =
      'Headline\nPremium content is the main revenue source for many outlets.\nSecond paragraph with unique facts.';

    const result = truncateAtPaywall(text, PAYWALL_MARKERS_EN);

    assert.deepEqual(result, { text, truncated: false });
  });

  it('ignores trailing punctuation when matching a marker line', () => {
    const result = truncateAtPaywall(
      'Para one.\n\nSubscribe to continue reading.\nAfter.',
      PAYWALL_MARKERS_EN
    );

    assert.deepEqual(result, { text: 'Para one.', truncated: true });
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

describe('isFeedUrl', () => {
  it('matches feed-shaped hosts, paths, suffixes and the feed query param', () => {
    assert.equal(isFeedUrl('https://feeds.example.com/rss.xml'), true);
    assert.equal(isFeedUrl('https://example.com/blog/feed/'), true);
    assert.equal(isFeedUrl('https://example.com/x?feed=rss2'), true);
    assert.equal(isFeedUrl('https://example.com/atom.xml'), true);
  });

  it('does not judge substring look-alikes as feeds', () => {
    // 子串匹配会误杀这三类（RESEARCH Pitfall 8），token 匹配不得命中
    assert.equal(isFeedUrl('https://example.com/feedback-form'), false);
    assert.equal(isFeedUrl('https://example.com/newsfeed-article'), false);
    assert.equal(isFeedUrl('https://example.com/grassroots'), false);
  });

  it('leaves ordinary article URLs and unparseable input alone', () => {
    assert.equal(isFeedUrl('https://example.com/blog/post'), false);
    assert.equal(isFeedUrl('not a url'), false);
  });
});

describe('isBlocklisted', () => {
  const blocklist = new Set(['farm.example']);

  it('hits the entry itself and any of its subdomains', () => {
    assert.equal(isBlocklisted('farm.example', blocklist), true);
    assert.equal(isBlocklisted('sub.farm.example', blocklist), true);
  });

  it('does not hit hosts that merely end with similar text', () => {
    assert.equal(isBlocklisted('notfarm.example', blocklist), false);
    assert.equal(isBlocklisted('example.com', blocklist), false);
  });

  it('never hits an empty blocklist', () => {
    assert.equal(isBlocklisted('farm.example', new Set()), false);
  });
});

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
