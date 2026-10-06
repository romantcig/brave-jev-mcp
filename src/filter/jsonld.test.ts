import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { METADATA_KEYS, extractBodyParts, parseJsonFragment, splitJsonFragment } from './jsonld.js';

const TITLE = 'TypeSafe launches Jev, a chatless AI model that claims to beat Claude 193x';

/**
 * 仿 Git 历史中的 fixtures/jev_release_default.json 来源 2 片段 4（pasqualepillitteri）的形状：
 * `headline` 与来源标题逐字相同，其余八个键全在笔记 §1 的"删除的键"里 → 整片删。
 */
const ARTICLE_META_ONLY = JSON.stringify({
  headline: TITLE,
  datePublished: '2026-09-16T10:00:00+02:00',
  dateModified: '2026-09-16T10:00:00+02:00',
  author: { '@type': 'Person', name: 'Pasquale Pillitteri' },
  isAccessibleForFree: true,
  keywords: ['jev', 'typesafe'],
  articleSection: 'news',
  inLanguage: 'en',
});

/**
 * 仿 explainx 来源片段 1 的 FAQPage：`mainEntity[]` 每项 `name` + `acceptedAnswer.text`。
 * 第二项故意缺 `name`（只出 "A: …"），第三项 `text` 不是字符串（跳过）。
 */
const FAQ = JSON.stringify({
  mainEntity: [
    { name: 'What is Jev?', acceptedAnswer: { text: 'Jev is a decision model.' } },
    { acceptedAnswer: { text: 'It returns typed decisions.' } },
    { name: 'Ignored', acceptedAnswer: { text: 42 } },
  ],
});

/** 仿 explainx 来源片段 2 的面包屑：`name` 与 `item` 都是笔记元数据表的原条目。 */
const BREADCRUMB = JSON.stringify({ name: 'Blog', item: 'https://www.explainx.ai/blog' });

describe('parseJsonFragment', () => {
  it('returns the parsed object for an object literal, ignoring surrounding whitespace', () => {
    assert.deepEqual(parseJsonFragment('  {"a": 1}\n'), { a: 1 });
  });

  it('returns the parsed array for an array literal', () => {
    assert.deepEqual(parseJsonFragment('[{"a": 1}, 2]'), [{ a: 1 }, 2]);
  });

  it('returns null for scalar JSON', () => {
    assert.equal(parseJsonFragment('42'), null);
    assert.equal(parseJsonFragment('"text"'), null);
    assert.equal(parseJsonFragment('true'), null);
    assert.equal(parseJsonFragment('null'), null);
  });

  it('returns null for text that does not start with { or [', () => {
    assert.equal(parseJsonFragment('Jev is a decision model.'), null);
    assert.equal(parseJsonFragment('# Heading {"a": 1}'), null);
  });

  it('returns null for malformed JSON without throwing', () => {
    assert.equal(parseJsonFragment('{not json'), null);
    assert.equal(parseJsonFragment('[1, 2,'), null);
    assert.equal(parseJsonFragment('{"a": 1} trailing'), null);
  });

  it('returns null for empty or whitespace-only text', () => {
    assert.equal(parseJsonFragment(''), null);
    assert.equal(parseJsonFragment('   \n\t'), null);
  });
});

describe('METADATA_KEYS', () => {
  it('holds the notes §1 metadata keys plus the fixture-observed additions (A8)', () => {
    for (const key of ['author', 'publisher', '@context', '@type', 'name', 'item', 'breadcrumb']) {
      assert.ok(METADATA_KEYS.has(key), key);
    }
  });

  it('never lists a body key', () => {
    for (const key of ['articleBody', 'description', 'headline', 'mainEntity']) {
      assert.equal(METADATA_KEYS.has(key), false, key);
    }
  });
});

describe('extractBodyParts', () => {
  it('emits parts in the fixed order: articleBody, description, headline, FAQ', () => {
    const node = {
      mainEntity: [{ name: 'Q1', acceptedAnswer: { text: 'A1' } }],
      headline: 'A different headline',
      description: 'd'.repeat(201),
      articleBody: 'Body.',
    };

    assert.deepEqual(extractBodyParts(node, TITLE), [
      'Body.',
      'd'.repeat(201),
      'A different headline',
      'Q: Q1\nA: A1',
    ]);
  });

  it('returns no parts for scalars and non-schema objects', () => {
    assert.deepEqual(extractBodyParts(42, TITLE), []);
    assert.deepEqual(extractBodyParts(null, TITLE), []);
    assert.deepEqual(extractBodyParts({ rows: [[1, 2]] }, TITLE), []);
  });
});

describe('splitJsonFragment', () => {
  it('converts articleBody into a single body part', () => {
    const fragment = JSON.stringify({
      '@type': 'NewsArticle',
      articleBody: 'TypeSafe released Jev on September 15, 2026.',
      author: { name: 'x' },
    });

    assert.deepEqual(splitJsonFragment(fragment, TITLE), {
      action: 'converted',
      parts: ['TypeSafe released Jev on September 15, 2026.'],
    });
  });

  it('converts description only when it is longer than 200 characters', () => {
    const withDescription = (length: number): string =>
      JSON.stringify({ '@type': 'Article', description: 'x'.repeat(length) });

    // 199 与 200 都不转；`description` 不在元数据表里，所以按保守方向原样保留
    assert.deepEqual(splitJsonFragment(withDescription(199), TITLE), { action: 'kept_raw' });
    assert.deepEqual(splitJsonFragment(withDescription(200), TITLE), { action: 'kept_raw' });
    assert.deepEqual(splitJsonFragment(withDescription(201), TITLE), {
      action: 'converted',
      parts: ['x'.repeat(201)],
    });
  });

  it('drops a headline equal to the source title after normalization', () => {
    // 前导 `#`、连续空白与大小写差异都视为同一标题（并入标题去重）
    const fragment = JSON.stringify({ headline: `#  ${TITLE.toUpperCase()}  `, author: 'x' });

    assert.deepEqual(splitJsonFragment(fragment, TITLE), { action: 'dropped_meta' });
  });

  it('keeps a headline that differs from the source title as a body part', () => {
    const fragment = JSON.stringify({
      headline: 'Jev beats Claude on typed decisions',
      author: 'x',
    });

    assert.deepEqual(splitJsonFragment(fragment, TITLE), {
      action: 'converted',
      parts: ['Jev beats Claude on typed decisions'],
    });
  });

  it('formats FAQ pairs as "Q: <name>\\nA: <text>" and tolerates a missing name', () => {
    assert.deepEqual(splitJsonFragment(FAQ, TITLE), {
      action: 'converted',
      parts: ['Q: What is Jev?\nA: Jev is a decision model.', 'A: It returns typed decisions.'],
    });
  });

  it('recurses into a top-level array and collects body parts from every element', () => {
    const fragment = `[${BREADCRUMB}, ${JSON.stringify({ articleBody: 'From the array.' })}]`;

    assert.deepEqual(splitJsonFragment(fragment, TITLE), {
      action: 'converted',
      parts: ['From the array.'],
    });
  });

  it('drops a fragment whose keys are all in the metadata table', () => {
    assert.deepEqual(splitJsonFragment(ARTICLE_META_ONLY, TITLE), { action: 'dropped_meta' });
    assert.deepEqual(splitJsonFragment(BREADCRUMB, TITLE), { action: 'dropped_meta' });
  });

  it('drops empty containers (empty key set is a subset of the metadata table)', () => {
    assert.deepEqual(splitJsonFragment('{}', TITLE), { action: 'dropped_meta' });
    assert.deepEqual(splitJsonFragment('[]', TITLE), { action: 'dropped_meta' });
    assert.deepEqual(splitJsonFragment(' { } ', TITLE), { action: 'dropped_meta' });
  });

  it('keeps raw JSON that has keys outside the table but yields no body', () => {
    // 表格 / 代码块类 JSON：没有 schema.org 键，笔记 §1 要求原样保留
    assert.deepEqual(splitJsonFragment('{"rows": [[1, 2], [3, 4]]}', TITLE), {
      action: 'kept_raw',
    });
    assert.deepEqual(splitJsonFragment('[1, 2, 3]', TITLE), { action: 'kept_raw' });
    assert.deepEqual(splitJsonFragment('[{"author": "x"}, "loose string"]', TITLE), {
      action: 'kept_raw',
    });
  });

  it('treats unparsable text as plain text outside the JSON-LD branch', () => {
    assert.deepEqual(splitJsonFragment('{not json', TITLE), { action: 'not_json' });
    assert.deepEqual(splitJsonFragment('Plain prose about Jev.', TITLE), { action: 'not_json' });
  });

  it('treats __proto__ like any other key and never pollutes Object.prototype', () => {
    const polluting = '{"__proto__": {"polluted": true}, "author": "x"}';

    assert.deepEqual(splitJsonFragment(polluting, TITLE), { action: 'kept_raw' });
    assert.deepEqual(
      splitJsonFragment('{"__proto__": {"polluted": true}, "articleBody": "Body."}', TITLE),
      { action: 'converted', parts: ['Body.'] }
    );
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
  });

  it('preserves non-ASCII body text verbatim', () => {
    const chinese = JSON.stringify({
      mainEntity: [{ name: 'Jev 是什么？', acceptedAnswer: { text: 'TypeSafe 发布的决策模型。' } }],
    });
    const mixed = JSON.stringify({ articleBody: 'Jev — “System One” モデル 🚀 café' });

    assert.deepEqual(splitJsonFragment(chinese, TITLE), {
      action: 'converted',
      parts: ['Q: Jev 是什么？\nA: TypeSafe 发布的决策模型。'],
    });
    assert.deepEqual(splitJsonFragment(mixed, TITLE), {
      action: 'converted',
      parts: ['Jev — “System One” モデル 🚀 café'],
    });
  });
});

describe('mainEntity.text 的通用分流', () => {
  it('保留只有 text 的正文和含未知数据字段的对象', () => {
    for (const node of [
      { mainEntity: { text: 'Schema version 8 requires rebuilding the search index.' } },
      { mainEntity: { text: 'Migration details.' }, rows: [['Latency', '12ms']] },
    ]) {
      assert.deepEqual(splitJsonFragment(JSON.stringify(node), TITLE), { action: 'kept_raw' });
    }
  });

  it('截断正文和截断问答按普通文本保留', () => {
    for (const fragment of [
      '{"mainEntity":{"text":"Truncated mid-sentence',
      '{"mainEntity":{"text":"How to recover?","acceptedAnswer":{"text":"Rebuild the index',
    ]) {
      assert.deepEqual(splitJsonFragment(fragment, TITLE), { action: 'not_json' });
    }
  });
});
