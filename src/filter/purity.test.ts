import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

// 库目录就是本文件所在目录；递归列出，Phase 2 的 src/filter/jev/ 子目录也在扫描范围内
const libraryDir = fileURLToPath(new URL('./', import.meta.url));

const isLibrarySource = (file: string): boolean =>
  file.endsWith('.ts') && !file.endsWith('.test.ts') && !file.endsWith('.d.ts');

const listLibrarySources = (): string[] =>
  (readdirSync(libraryDir, { recursive: true }) as string[]).filter(isLibrarySource).sort();

describe('src/filter purity', () => {
  const files = listLibrarySources();

  it('finds library sources to scan', () => {
    // 扫描到 0 个文件必须失败，否则下面的逐文件断言会静默通过
    assert.ok(files.length > 0, 'no library sources found to scan');
  });

  for (const file of files) {
    describe(file, () => {
      const src = readFileSync(join(libraryDir, file), 'utf8');

      it('does not import the MCP SDK', () => {
        // 正则拆成两段写：验证配方对整个 src/filter 目录 grep 这个包名，本测试文件自己不能命中
        assert.doesNotMatch(src, /@modelcontext(?:protocol)/, `${file} imports the MCP SDK`);
      });

      it('does not statically import a host module', () => {
        // src/filter/ 不在 src/ 根下：任何 `../` 都落在宿主目录，白名单为空、不枚举文件名
        assert.doesNotMatch(
          src,
          /(?:^|[\s;{(])import[^\n]*?from\s*['"][^'"]*\.\.\//m,
          `${file} imports a host module`
        );
        // 多行 import / export … from 也要拦：只看 from 子句
        assert.doesNotMatch(src, /\bfrom\s*['"][^'"]*\.\.\//, `${file} imports a host module`);
      });

      it('does not dynamically import a host module', () => {
        // `[^)]*` 不限定引号字符，单双引号与模板字符串都覆盖
        assert.doesNotMatch(
          src,
          /(?:import|require)\s*\(\s*[^)]*\.\.\//,
          `${file} dynamically imports a host module`
        );
      });

      it('does not write to stdout', () => {
        assert.doesNotMatch(src, /console\.log/, `${file} writes to stdout`);
      });

      it('is UTF-8 without a byte order mark', () => {
        assert.equal(src.startsWith('﻿'), false, `${file} starts with a BOM`);
      });
    });
  }
});
