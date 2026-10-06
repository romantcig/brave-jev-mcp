import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { cleanDevToBoilerplate } from './devtoCleanup.js';
import type { BraveLlmContextGenericItem } from './types.js';

/** 2026-10-06 的三个真实来源：纯提纲及两个带 headline / author 的变体。 */
const sources: BraveLlmContextGenericItem[] = JSON.parse(
  readFileSync(new URL('../../fixtures/log-derived/devto-outlines.json', import.meta.url), 'utf8')
);
const source = sources[0];
const outline = source.snippets.at(-1)!;
const body = source.snippets.slice(0, -1);
const clean = (text: string, others: readonly string[] = body) =>
  cleanDevToBoilerplate(text, source.url, source.title, others);

describe('dev.to 目录提纲清理', () => {
  it('清理三个真实提纲，普通正文逐字保留', () => {
    for (const item of sources) {
      for (const [index, text] of item.snippets.entries()) {
        const others = item.snippets.filter((_, at) => at !== index);
        const result = cleanDevToBoilerplate(text, item.url, item.title, others);
        assert.deepEqual(
          result,
          index === item.snippets.length - 1
            ? { text: '', actions: [{ rule: 'article_outline' }] }
            : { text, actions: [] },
          `${item.url} / ${index}`
        );
      }
    }
  });

  it('仅限 dev.to 文章页，站外同形内容和非文章路径保留', () => {
    for (const url of [
      'https://example.com/author/article',
      'https://dev.to.example.com/author/article',
      'https://dev.to/author',
      'https://dev.to/t/python',
      'https://dev.to/settings/profile',
      'https://dev.to/author/article/comments',
      'invalid url',
    ]) {
      assert.deepEqual(cleanDevToBoilerplate(outline, url, source.title, body), {
        text: outline,
        actions: [],
      });
    }
    assert.equal(
      cleanDevToBoilerplate(outline, `${source.url}/?ref=search#section`, source.title, body).text,
      ''
    );
  });

  it('独有正文、长段落、HTML 和截断片段保持原样', () => {
    const parsed = JSON.parse(outline);
    for (const text of [
      JSON.stringify({
        mainEntity: { text: 'Schema version 8 requires rebuilding the search index.' },
      }),
      JSON.stringify({
        mainEntity: { text: parsed.mainEntity.text + '\n' + 'Long prose. '.repeat(20) },
      }),
      JSON.stringify({ mainEntity: { text: `<p>${parsed.mainEntity.text}</p>` } }),
      outline.slice(0, 4000),
    ]) {
      assert.deepEqual(clean(text), { text, actions: [] });
    }
  });

  it('存在问答、额外正文、未知字段或不同标题时不作为提纲删除', () => {
    const parsed = JSON.parse(outline);
    for (const node of [
      { ...parsed, articleBody: 'An independent migration requirement.' },
      { ...parsed, rows: [['Latency', '12ms']] },
      { ...parsed, headline: 'Another article' },
      { mainEntity: { ...parsed.mainEntity, acceptedAnswer: { text: 'Rebuild the index.' } } },
      { mainEntity: { ...parsed.mainEntity, articleBody: 'Detailed evidence.' } },
      { mainEntity: [parsed.mainEntity] },
    ]) {
      const text = JSON.stringify(node);
      assert.deepEqual(clean(text), { text, actions: [] });
    }
  });

  it('同页缺少对应正文时保留，代码中的章节和单个重复章节不提供充分依据', () => {
    for (const others of [
      [],
      ['## Unrelated section\nAn unrelated explanation.'],
      ['## Quick Comparison Table', '## Pricing Comparison'],
      ['```md\n## Quick Comparison Table\nBody\n## Pricing Comparison\nBody\n```'],
      ['## Quick Comparison Table\nBody', '## Quick Comparison Table\nMore body'],
    ]) {
      assert.deepEqual(clean(outline, others), { text: outline, actions: [] });
    }
  });

  it('清理幂等，不修改输入片段数组', () => {
    const before = [...body];
    const result = clean(outline);
    assert.deepEqual(clean(result.text), { text: '', actions: [] });
    assert.deepEqual(body, before);
  });
});
