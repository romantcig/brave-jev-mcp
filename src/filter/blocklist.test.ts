import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_BLOCKLIST, DEFAULT_BLOCKLIST_TEXT, parseBlocklist } from './blocklist.js';

describe('parseBlocklist', () => {
  it('parses one canonical host per line', () => {
    const parsed = parseBlocklist('farm.example\nmirrors.example');

    assert.deepEqual([...parsed].sort(), ['farm.example', 'mirrors.example']);
  });

  it('skips comment lines and blank lines', () => {
    const parsed = parseBlocklist('# a comment\n\nfarm.example\n   \n\t\n# another\n');

    assert.deepEqual([...parsed], ['farm.example']);
  });

  it('lowercases, strips www. and trims surrounding whitespace', () => {
    const parsed = parseBlocklist('  WWW.Farm.EXAMPLE  \n\tMirrors.EXAMPLE\n');

    assert.deepEqual([...parsed].sort(), ['farm.example', 'mirrors.example']);
  });
});

describe('DEFAULT_BLOCKLIST', () => {
  it('starts empty: only comments and a format example in the text', () => {
    assert.equal(DEFAULT_BLOCKLIST.size, 0);
  });

  it('is derived from DEFAULT_BLOCKLIST_TEXT', () => {
    assert.deepEqual([...DEFAULT_BLOCKLIST], [...parseBlocklist(DEFAULT_BLOCKLIST_TEXT)]);
  });
});

describe('页面与栏目名单解析', () => {
  it('规范主机但保留路径大小写与末尾斜杠', () => {
    assert.deepEqual(
      [...parseBlocklist('https://WWW.Farm.EXAMPLE/News/flash/\nhttps://farm.example/News/item')],
      ['https://farm.example/News/flash/', 'https://farm.example/News/item']
    );
  });
  it('含鉴权、查询、片段或自定义端口的 URL 条目不参与屏蔽', () => {
    assert.equal(
      parseBlocklist(
        'https://user:pass@farm.example/x\nhttps://farm.example/x?q=1\nhttps://farm.example/x#part\nhttps://farm.example:123/x'
      ).size,
      0
    );
  });
});
