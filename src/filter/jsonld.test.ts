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

/** 按 QAPage 夹具构造的正文答案，suggestedAnswer[].text 应被提取。 */
const QA_PAGE = JSON.stringify({
  name: 'How do I generate types?',
  dateCreated: '2023-02-24T19:28:00Z',
  dateModified: '2023-03-01T00:00:00Z',
  answerCount: 2,
  suggestedAnswer: [{ text: 'Use the typegen CLI.' }, { text: 'Or write them by hand.' }],
});

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
    for (const key of ['dateCreated', 'answerCount', 'duration', 'genre', 'offers']) {
      assert.ok(METADATA_KEYS.has(key), key);
    }
  });

  it('never lists a body key', () => {
    for (const key of ['articleBody', 'description', 'headline', 'mainEntity', 'step']) {
      assert.equal(METADATA_KEYS.has(key), false, key);
    }
  });
});

describe('extractBodyParts', () => {
  it('emits parts in the fixed order: articleBody, description, headline, FAQ, steps, answers', () => {
    const node = {
      acceptedAnswer: { text: 'Top-level answer.' },
      suggestedAnswer: [{ text: 'Suggested.' }],
      step: [{ text: 'Step one.' }],
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
      'Step one.',
      'Suggested.',
      'Top-level answer.',
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

  it('converts HowTo steps using text, falling back to name', () => {
    const fragment = JSON.stringify({
      '@type': 'HowTo',
      step: [{ text: 'Install the CLI.' }, { name: 'Run typegen' }, { position: 3 }],
    });

    assert.deepEqual(splitJsonFragment(fragment, TITLE), {
      action: 'converted',
      parts: ['Install the CLI.', 'Run typegen'],
    });
  });

  it('converts QAPage suggestedAnswer texts and a top-level acceptedAnswer text', () => {
    assert.deepEqual(splitJsonFragment(QA_PAGE, TITLE), {
      action: 'converted',
      parts: ['Use the typegen CLI.', 'Or write them by hand.'],
    });
    assert.deepEqual(
      splitJsonFragment(JSON.stringify({ acceptedAnswer: { text: 'Only answer.' } }), TITLE),
      { action: 'converted', parts: ['Only answer.'] }
    );
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

describe('mainEntity.text 正文回声（dev.to 站点模板）', () => {
  /** 仿 dev.to 真实样本：text 装整篇文章 HTML 回声，开头是章节标记。 */
  const echoHtml = (repeat: number): string =>
    `<h2><a name="why-teams">Why Teams Look for Alternatives</a></h2>\n<p>${'Review notes. '.repeat(repeat)}</p>`;

  it('drops an object-shaped mainEntity with a non-empty text as a body echo', () => {
    const fragment = JSON.stringify({ mainEntity: { text: echoHtml(3) } });

    assert.deepEqual(splitJsonFragment(fragment, TITLE), { action: 'dropped_meta' });
  });

  it('drops a truncated echo whose JSON.parse fails via the prefix fallback', () => {
    // 仿 Brave 截断：~4K 处在正文字符串中途切断，无收尾引号和括号
    const truncated = `{"mainEntity":{"text":"${echoHtml(300).slice(0, 4000)}`;
    assert.deepEqual(splitJsonFragment(truncated, TITLE), { action: 'dropped_meta' });

    // 键值间的空白变体同样兜底
    assert.deepEqual(
      splitJsonFragment('{"mainEntity": {"text": "Truncated mid-sentence…', TITLE),
      { action: 'dropped_meta' }
    );
  });

  it('still converts a FAQPage whose mainEntity is an array of questions', () => {
    assert.deepEqual(splitJsonFragment(FAQ, TITLE), {
      action: 'converted',
      parts: ['Q: What is Jev?\nA: Jev is a decision model.', 'A: It returns typed decisions.'],
    });
    // 数组形态被截断时解析失败，也不匹配回声前缀，维持普通文本
    assert.deepEqual(splitJsonFragment('{"mainEntity": [{"name": "What is', TITLE), {
      action: 'not_json',
    });
  });

  it('keeps the previous kept_raw verdict when mainEntity is not an echo shape', () => {
    // 无 text、text 为空白、mainEntity 为数组但抽不出问答：都不是回声
    assert.deepEqual(splitJsonFragment('{"mainEntity": {"@type": "WebPage"}}', TITLE), {
      action: 'kept_raw',
    });
    assert.deepEqual(splitJsonFragment('{"mainEntity": {"text": "   "}}', TITLE), {
      action: 'kept_raw',
    });
    assert.deepEqual(splitJsonFragment('{"mainEntity": [{"name": "No answer here"}]}', TITLE), {
      action: 'kept_raw',
    });
  });

  it('never drops a Question text that coexists with an acceptedAnswer', () => {
    // acceptedAnswer 是真实答案：converted 优先，不整体误删
    const fragment = JSON.stringify({
      mainEntity: { text: 'How do I generate types?', acceptedAnswer: { text: 'Use the typegen CLI.' } },
    });

    assert.deepEqual(splitJsonFragment(fragment, TITLE), {
      action: 'converted',
      parts: ['A: Use the typegen CLI.'],
    });
  });

  it('leaves plain text and non-leading echo shapes outside the JSON-LD branch', () => {
    assert.deepEqual(splitJsonFragment('Plain prose about Jev.', TITLE), { action: 'not_json' });
    // 前缀只锚定片段开头：正文里出现同形文本不算回声
    assert.deepEqual(splitJsonFragment('Read this: {"mainEntity":{"text":"echo"}}', TITLE), {
      action: 'not_json',
    });
  });
});
