import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { applyCrossSourceDedup, type DedupSnippetRow, type DedupSourceRow } from './dedup.js';
import { createFilterStats } from './stats.js';
import type { FilterStats } from './types.js';

const makeStats = (): FilterStats =>
  createFilterStats(
    'off',
    { query: 'test query', intent: 'test intent', max_urls: 5, max_tokens: 4000 },
    { grounding: { generic: [] }, sources: {} }
  );

const snippet = (index: number, text: string, kept = true): DedupSnippetRow => ({
  index,
  text,
  kept,
});

const source = (
  index: number,
  snippets: DedupSnippetRow[],
  verdict: 'keep' | 'drop' = 'keep'
): DedupSourceRow => ({
  index,
  url: `https://example.com/s${index}`,
  snippets,
  verdict,
});

describe('applyCrossSourceDedup', () => {
  it('跨来源完全相同的文本删除后续片段并正确归因与计数', () => {
    const stats = makeStats();
    const table: DedupSourceRow[] = [
      source(0, [snippet(0, '这是第一篇文章的完整正文。')]),
      source(1, [snippet(0, '这是第一篇文章的完整正文。')]),
    ];

    const deletedSources = applyCrossSourceDedup(table, stats);

    assert.equal(table[0].snippets[0].kept, true);
    assert.equal(table[1].snippets[0].kept, false);
    assert.equal(table[1].snippets[0].reason, 'dup');
    assert.equal(stats.local.cross_source_dup_removed, 1);
    assert.deepEqual([...deletedSources], [1]);
  });

  it('非空短片段没有 shingle 门槛，完全相同也执行去重', () => {
    const stats = makeStats();
    const table: DedupSourceRow[] = [
      source(0, [snippet(0, '短文本')]),
      source(1, [snippet(0, '短文本')]),
    ];

    const deletedSources = applyCrossSourceDedup(table, stats);

    assert.equal(table[0].snippets[0].kept, true);
    assert.equal(table[1].snippets[0].kept, false);
    assert.equal(table[1].snippets[0].reason, 'dup');
    assert.equal(stats.local.cross_source_dup_removed, 1);
    assert.deepEqual([...deletedSources], [1]);
  });

  it('大小写、空格与代码缩进不同均视为不同文本，完整保留', () => {
    const stats = makeStats();
    const table: DedupSourceRow[] = [
      source(0, [snippet(0, 'const port = 8080;')]),
      source(1, [snippet(0, '  const port = 8080;')]),
      source(2, [snippet(0, 'CONST PORT = 8080;')]),
    ];

    const deletedSources = applyCrossSourceDedup(table, stats);

    assert.equal(table[0].snippets[0].kept, true);
    assert.equal(table[1].snippets[0].kept, true);
    assert.equal(table[2].snippets[0].kept, true);
    assert.equal(stats.local.cross_source_dup_removed, 0);
    assert.equal(deletedSources.size, 0);
  });

  it('负号不同或数值微调不因去重合并，完整保留', () => {
    const stats = makeStats();
    const table: DedupSourceRow[] = [
      source(0, [snippet(0, '温度为 5 度。')]),
      source(1, [snippet(0, '温度为 -5 度。')]),
    ];

    const deletedSources = applyCrossSourceDedup(table, stats);

    assert.equal(table[0].snippets[0].kept, true);
    assert.equal(table[1].snippets[0].kept, true);
    assert.equal(stats.local.cross_source_dup_removed, 0);
    assert.equal(deletedSources.size, 0);
  });

  it('中文同日不同事件均保留，不因日期相同删除', () => {
    const stats = makeStats();
    const table: DedupSourceRow[] = [
      source(0, [snippet(0, '项目于2026-09-30开放注册。')]),
      source(1, [snippet(0, '安全公告确认，2026-09-30发现权限绕过漏洞，建议立即撤销公开链接。')]),
    ];

    const deletedSources = applyCrossSourceDedup(table, stats);

    assert.equal(table[0].snippets[0].kept, true);
    assert.equal(table[1].snippets[0].kept, true);
    assert.equal(stats.local.cross_source_dup_removed, 0);
    assert.equal(deletedSources.size, 0);
  });

  it('长段原文后新增关键短句的片段完整保留', () => {
    const stats = makeStats();
    const baseText = '该架构采用分布式存储与实时同步机制，各节点通过 Raft 协议保证一致性。';
    const extendedText = `${baseText} 生产环境严禁直接开放公网访问。`;

    const table: DedupSourceRow[] = [
      source(0, [snippet(0, baseText)]),
      source(1, [snippet(0, extendedText)]),
    ];

    const deletedSources = applyCrossSourceDedup(table, stats);

    assert.equal(table[0].snippets[0].kept, true);
    assert.equal(table[1].snippets[0].kept, true);
    assert.equal(stats.local.cross_source_dup_removed, 0);
    assert.equal(deletedSources.size, 0);
  });

  it('被整源删除（verdict=drop）的来源不能作为参照集压掉后续来源', () => {
    const stats = makeStats();
    const text = '这段文本在前一个被丢弃的来源中出现过。';
    const table: DedupSourceRow[] = [
      source(0, [snippet(0, text)], 'drop'),
      source(1, [snippet(0, text)], 'keep'),
    ];

    const deletedSources = applyCrossSourceDedup(table, stats);

    assert.equal(table[1].snippets[0].kept, true);
    assert.equal(stats.local.cross_source_dup_removed, 0);
    assert.equal(deletedSources.size, 0);
  });

  it('来源内部已被删除的片段不能作为参照集', () => {
    const stats = makeStats();
    const text = '预筛已删片段文本';
    const table: DedupSourceRow[] = [
      source(0, [snippet(0, text, false)]), // kept=false
      source(1, [snippet(0, text, true)]),
    ];

    const deletedSources = applyCrossSourceDedup(table, stats);

    assert.equal(table[1].snippets[0].kept, true);
    assert.equal(stats.local.cross_source_dup_removed, 0);
    assert.equal(deletedSources.size, 0);
  });

  it('同来源片段在当前来源完全处理后才加入跨源参照集，不承担页内去重且正确删除后续跨源重复', () => {
    const stats = makeStats();
    // 来源 0 包含两个相同文本片段（页内重复由预筛负责，跨源模块不承担页内去重，来源 0 内两者均保留）
    // 来源 1 包含同款文本，在来源 0 处理完毕后才作为参照删除来源 1 的跨源重复
    const table: DedupSourceRow[] = [
      source(0, [snippet(0, '同源重复文本'), snippet(1, '同源重复文本')]),
      source(1, [snippet(0, '同源重复文本')]),
    ];

    const deletedSources = applyCrossSourceDedup(table, stats);

    assert.equal(table[0].snippets[0].kept, true);
    assert.equal(table[0].snippets[1].kept, true);
    assert.equal(table[1].snippets[0].kept, false);
    assert.equal(table[1].snippets[0].reason, 'dup');
    assert.equal(stats.local.cross_source_dup_removed, 1);
    assert.deepEqual([...deletedSources], [1]);
  });

  it('空文本不作为参照，也不被跨源去重错误标记', () => {
    const stats = makeStats();
    const table: DedupSourceRow[] = [source(0, [snippet(0, '')]), source(1, [snippet(0, '')])];

    const deletedSources = applyCrossSourceDedup(table, stats);

    assert.equal(table[0].snippets[0].kept, true);
    assert.equal(table[1].snippets[0].kept, true);
    assert.equal(stats.local.cross_source_dup_removed, 0);
    assert.equal(deletedSources.size, 0);
  });

  it('不同调用之间独立，参照集不跨调用积累', () => {
    const stats1 = makeStats();
    const table1: DedupSourceRow[] = [source(0, [snippet(0, '独立运行文本')])];
    applyCrossSourceDedup(table1, stats1);

    const stats2 = makeStats();
    const table2: DedupSourceRow[] = [source(0, [snippet(0, '独立运行文本')])];
    const deleted2 = applyCrossSourceDedup(table2, stats2);

    assert.equal(table2[0].snippets[0].kept, true);
    assert.equal(stats2.local.cross_source_dup_removed, 0);
    assert.equal(deleted2.size, 0);
  });
});
