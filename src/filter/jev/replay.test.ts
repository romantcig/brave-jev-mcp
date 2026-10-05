/** 真实组合题响应回放：覆盖单片尾组、作者比较分析、页面删除与已知误删边界。 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { it } from 'node:test';
import { replayFrozen } from '../../../test-support/jev-replay.mjs';

const root = new URL('../../../fixtures/jev-three-in-one/', import.meta.url);
const files = readdirSync(root)
  .filter((name) => name.endsWith('.json'))
  .sort();
assert.equal(files.length, 3);
for (const file of files) {
  it(`冻结组合题请求与逐片裁决：${file}`, () => {
    replayFrozen(JSON.parse(readFileSync(new URL(file, root), 'utf8')));
  });
}
