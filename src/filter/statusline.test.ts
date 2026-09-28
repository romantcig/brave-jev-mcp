import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createFilterStats } from './stats.js';
import { buildStatusLine } from './statusline.js';
import type { BraveLlmContextResponse, FilterStats, SourceDropReason } from './types.js';

/** createFilterStats 需要的请求摘要（上限缺省已填 Brave 默认值的形状）。 */
const request: FilterStats['request'] = {
  query: 'test query',
  intent: 'test intent',
  max_urls: 10,
  max_tokens: 8192,
  overfetch_factor: 1,
};

/** 用片段文本建一份最小 Brave 响应。 */
const dataOf = (...sources: { url: string; snippets: string[] }[]): BraveLlmContextResponse => ({
  grounding: {
    generic: sources.map((source) => ({
      url: source.url,
      title: '',
      snippets: source.snippets,
    })),
    map: [],
  },
  sources: {},
});

const statsOf = (...sources: { url: string; snippets: string[] }[]): FilterStats =>
  createFilterStats('off', request, dataOf(...sources));

/** 把统计表里的一个来源翻成丢弃（管道各步的最终落账形状）。 */
const dropSource = (stats: FilterStats, index: number, reason: SourceDropReason): void => {
  const row = stats.sources[index];
  row.verdict = 'drop';
  row.reason = reason;
};

/** 把统计表里幸存来源的一个片段翻成删除。 */
const dropSnippet = (stats: FilterStats, sourceIndex: number, snippetIndex: number): void => {
  stats.sources[sourceIndex].snippets[snippetIndex].kept = false;
};

describe('buildStatusLine', () => {
  it('returns undefined when nothing was dropped or removed', () => {
    const stats = statsOf(
      { url: 'https://a.example/', snippets: ['one', 'two'] },
      { url: 'https://b.example/', snippets: ['three'] }
    );
    assert.equal(buildStatusLine(stats), undefined);
  });

  it('counts dropped sources by reason with SourceDropReason keys verbatim', () => {
    const stats = statsOf(
      { url: 'https://a.example/', snippets: ['one'] },
      { url: 'https://b.example/', snippets: ['two'] },
      { url: 'https://c.example/', snippets: ['three'] }
    );
    dropSource(stats, 0, 'rewrite');
    dropSource(stats, 1, 'rewrite');
    dropSource(stats, 2, 'blocklist');
    assert.equal(
      buildStatusLine(stats),
      '[filter] dropped 3 of 3 sources: 2 rewrite, 1 blocklist'
    );
  });

  it('does not count merged as a drop', () => {
    const stats = statsOf(
      { url: 'https://a.example/', snippets: ['one'] },
      { url: 'https://b.example/', snippets: ['two'] }
    );
    dropSource(stats, 1, 'merged');
    // 唯一的"丢弃"是 merged → 不算丢弃、无附加内容 → 不附状态行
    assert.equal(buildStatusLine(stats), undefined);
  });

  it('counts removed snippets inside surviving sources only', () => {
    const stats = statsOf(
      { url: 'https://a.example/', snippets: ['one', 'two', 'three'] },
      { url: 'https://b.example/', snippets: ['four', 'five'] }
    );
    dropSnippet(stats, 0, 1);
    dropSource(stats, 1, 'empty'); // 被丢来源的片段不重复计
    dropSnippet(stats, 1, 0);
    assert.equal(buildStatusLine(stats), '[filter] dropped 1 of 2 sources: 1 empty; 1 snippets removed');
  });

  it('lists paywall-truncated snippets as its own item after the removal count', () => {
    const stats = statsOf({ url: 'https://a.example/', snippets: ['one', 'two'] });
    dropSnippet(stats, 0, 0);
    stats.local.paywall_truncated = 2;
    assert.equal(
      buildStatusLine(stats),
      '[filter] 1 snippets removed; 2 snippets paywall-truncated'
    );
  });
});
