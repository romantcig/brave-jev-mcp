import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { TOOL_DESCRIPTION_FILE_ENV, resolveToolDescription } from './description.js';

const fallback = 'Built-in English description.';

describe('resolveToolDescription', () => {
  const originalConsoleError = console.error;
  // 真实临时目录、真实文件，不 mock fs
  const dir = mkdtempSync(join(tmpdir(), 'jev-filter-desc-'));

  before(() => {
    // 失败情形会 console.error 提示一次；静音以免污染测试输出
    console.error = () => {};
  });

  after(() => {
    console.error = originalConsoleError;
  });

  it('returns the fallback verbatim when the variable is unset', () => {
    assert.equal(resolveToolDescription(fallback, {}), fallback);
    assert.equal(resolveToolDescription(fallback, { [TOOL_DESCRIPTION_FILE_ENV]: '' }), fallback);
    assert.equal(
      resolveToolDescription(fallback, { [TOOL_DESCRIPTION_FILE_ENV]: '   ' }),
      fallback
    );
  });

  it('returns the trimmed file contents when the file is readable', () => {
    const filePath = join(dir, 'override.txt');
    writeFileSync(filePath, '\n  个人化描述（中文）。\nSecond line.\n\n', 'utf8');

    const result = resolveToolDescription(fallback, { [TOOL_DESCRIPTION_FILE_ENV]: filePath });

    assert.equal(result, '个人化描述（中文）。\nSecond line.');
  });

  it('falls back when the path does not exist', () => {
    const filePath = join(dir, 'definitely-missing.txt');

    const result = resolveToolDescription(fallback, { [TOOL_DESCRIPTION_FILE_ENV]: filePath });

    assert.equal(result, fallback);
  });

  it('falls back when the file is empty or whitespace-only', () => {
    const emptyPath = join(dir, 'empty.txt');
    const blankPath = join(dir, 'blank.txt');
    writeFileSync(emptyPath, '', 'utf8');
    writeFileSync(blankPath, ' \n\t\n', 'utf8');

    assert.equal(
      resolveToolDescription(fallback, { [TOOL_DESCRIPTION_FILE_ENV]: emptyPath }),
      fallback
    );
    assert.equal(
      resolveToolDescription(fallback, { [TOOL_DESCRIPTION_FILE_ENV]: blankPath }),
      fallback
    );
  });

  it('falls back when the file exceeds 8 KB', () => {
    const filePath = join(dir, 'huge.txt');
    writeFileSync(filePath, 'x'.repeat(8 * 1024 + 1), 'utf8');

    const result = resolveToolDescription(fallback, { [TOOL_DESCRIPTION_FILE_ENV]: filePath });

    assert.equal(result, fallback);
  });

  it('always returns a non-empty string', () => {
    const cases = [
      {},
      { [TOOL_DESCRIPTION_FILE_ENV]: join(dir, 'missing.txt') },
      { [TOOL_DESCRIPTION_FILE_ENV]: join(dir, 'empty.txt') },
      { [TOOL_DESCRIPTION_FILE_ENV]: join(dir, 'override.txt') },
    ];

    for (const env of cases) {
      const result = resolveToolDescription(fallback, env);
      assert.equal(typeof result, 'string', JSON.stringify(env));
      assert.ok(result.length > 0, JSON.stringify(env));
    }
  });
});
