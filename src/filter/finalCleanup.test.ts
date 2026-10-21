/** 最终清理边界：代表必须幸存，文本差异与代码受保护，不改写输入。 */
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { cleanFinalSnippets } from './finalCleanup.js';

const phrase =
  'The released compiler provides a stable programmatic interface starting with version 7.1.';
const clean = (texts: string[], title = 'Example') =>
  cleanFinalSnippets(
    texts.map((text, i) => ({ key: String(i), text })),
    title
  );

it('三重覆盖的动作均指向最长幸存代表，JSON-LD 身份原样返回', () => {
  const input = [
    { key: '13.0', text: phrase },
    { key: '13.1', text: '# Example\n' + phrase },
    { key: '14', text: '# Example\n' + phrase + ' Official roadmap.' },
  ];
  const before = structuredClone(input);
  assert.deepEqual(cleanFinalSnippets(input, 'Title'), [
    { rule: 'same_source_exact_coverage', snippet: '13.1', covered_by: '14' },
    { rule: 'same_source_exact_coverage', snippet: '13.0', covered_by: '14' },
  ]);
  assert.deepEqual(input, before);
});

it('相等文本保留较早片段，有限 Markdown 和空白归一不会重写正文', () => {
  assert.deepEqual(clean([phrase, 'Separate detail.', '**' + phrase + '**']), [
    { rule: 'same_source_exact_coverage', snippet: '2', covered_by: '0' },
  ]);
  assert.equal(clean(['# ' + phrase, phrase.replaceAll(' ', '\n')]).length, 1);
  assert.equal(clean(['a'.repeat(39), 'a'.repeat(39)]).length, 0);
  assert.equal(clean(['a'.repeat(40), 'a'.repeat(40)]).length, 1);
});

it('数字、版本、否定、大小写、单位与标点差异保留', () => {
  for (const other of [
    phrase.replace('provides', 'does not provide'),
    phrase.replace('7.1', '7.0'),
    phrase.toLowerCase(),
    phrase.replace('.', '!'),
    phrase.replace('7.1', '7.1 ms'),
  ])
    assert.deepEqual(clean([phrase, other]), [], other);
});

it('完整包含要求 Unicode 词边界，中文、数字、下划线不能被截成词的一部分', () => {
  const text = 'Stable version 7.1 provides a programmatic interface';
  for (const char of ['文', 'é', '2', '_', '𐐀']) {
    assert.deepEqual(clean([text, char + text]), []);
    assert.deepEqual(clean([text, text + char]), []);
  }
  assert.equal(clean([text, '(' + text + ')']).length, 1);
});

it('代码保护覆盖反引号、波浪号围栏、四空格、Tab 与混合缩进', () => {
  for (const text of [
    '`' + phrase + '`',
    '```text\n' + phrase + '\n```',
    '~~~text\n' + phrase + '\n~~~',
    '~~~\n' + phrase,
    '    ' + phrase,
    '\t' + phrase,
    '  \t' + phrase,
    phrase + '\n    code',
  ]) {
    assert.deepEqual(clean([text, text]), [], text);
    assert.deepEqual(clean([phrase, text]), [], text);
  }
});

it('空栏目仅接受重复一级标题和无正文栏目，支持既定站点后缀与格式', () => {
  for (const title of ['Example', 'Example - Site', 'Example | Site']) {
    for (const section of [
      'Key takeaways',
      '**Key takeaways**',
      '## KEY TAKEAWAYS',
      '### **Key takeaways**',
    ]) {
      assert.deepEqual(clean(['\n# Example\n\n' + section + '\n'], title), [
        { rule: 'empty_takeaways', snippet: '0' },
      ]);
    }
  }
  for (const text of [
    '# Example\n**Key takeaways**\nThe price is $2.',
    '# Example\n**Key takeaways**\n- Specific fact.',
    '# Example\n**Key takeaways**: fact',
    '# Other\nKey takeaways',
    '## Example\nKey takeaways',
    '# Example\nVersion 7.1 is unavailable',
    '    # Example\n    Key takeaways',
  ])
    assert.deepEqual(clean([text]), [], text);
  assert.deepEqual(clean(['# Example\nKey takeaways'], 'Example: Site'), []);
});
