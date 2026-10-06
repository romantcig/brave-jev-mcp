import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { resolveToolDescription } from './description.js';

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
    // 测试结束清理临时目录。
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns the fallback verbatim when no path is configured', () => {
    // 覆盖文件路径来自配置对象。
    assert.equal(resolveToolDescription(fallback, undefined), fallback);
    assert.equal(resolveToolDescription(fallback, ''), fallback);
    assert.equal(resolveToolDescription(fallback, '   '), fallback);
  });

  it('returns the trimmed file contents when the file is readable', () => {
    const filePath = join(dir, 'override.txt');
    writeFileSync(filePath, '\n  个人化描述（中文）。\nSecond line.\n\n', 'utf8');

    assert.equal(resolveToolDescription(fallback, filePath), '个人化描述（中文）。\nSecond line.');
  });

  it('falls back when the path does not exist', () => {
    assert.equal(resolveToolDescription(fallback, join(dir, 'definitely-missing.txt')), fallback);
  });

  it('falls back when the file is empty or whitespace-only', () => {
    const emptyPath = join(dir, 'empty.txt');
    const blankPath = join(dir, 'blank.txt');
    writeFileSync(emptyPath, '', 'utf8');
    writeFileSync(blankPath, ' \n\t\n', 'utf8');

    assert.equal(resolveToolDescription(fallback, emptyPath), fallback);
    assert.equal(resolveToolDescription(fallback, blankPath), fallback);
  });

  it('falls back when the file exceeds 8 KB', () => {
    const filePath = join(dir, 'huge.txt');
    writeFileSync(filePath, 'x'.repeat(8 * 1024 + 1), 'utf8');

    assert.equal(resolveToolDescription(fallback, filePath), fallback);
  });

  it('always returns a non-empty string', () => {
    const cases: Array<string | undefined> = [
      undefined,
      join(dir, 'missing.txt'),
      join(dir, 'empty.txt'),
      join(dir, 'override.txt'),
    ];

    for (const path of cases) {
      const result = resolveToolDescription(fallback, path);
      assert.equal(typeof result, 'string', String(path));
      assert.ok(result.length > 0, String(path));
    }
  });
});
