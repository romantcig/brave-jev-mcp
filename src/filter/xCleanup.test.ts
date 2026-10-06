import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cleanXBoilerplate, parseXPage } from './xCleanup.js';

const STATUS_URL = 'https://x.com/CarterWChurch/status/2105167567706816690';
const TRENDING_URL = 'https://x.com/i/trending/2105531656363016345';
const PROFILE_URL = 'https://x.com/HexRaysSA?lang=en';
const TWITTER_STATUS_URL = 'https://twitter.com/jack/status/20';

describe('X 页面类别与 URL 边界', () => {
  it('仅精确 hostname x.com / twitter.com 系列生效，相似假域名不动', () => {
    const snippet = '## Related Trending Stories on X\n正文';
    for (const url of [
      'https://x.com.evil.com/status/123',
      'https://evil-x.com/status/123',
      'https://twitter.com.attacker.com/status/123',
      'https://example.com/status/123',
      'not a url',
      '',
    ]) {
      const cleaned = cleanXBoilerplate(snippet, url);
      assert.deepEqual(cleaned.actions, [], url);
      assert.equal(cleaned.text, snippet, url);
    }

    assert.equal(cleanXBoilerplate(snippet, STATUS_URL).actions.length, 1);
    assert.equal(cleanXBoilerplate(snippet, TWITTER_STATUS_URL).actions.length, 1);
  });

  it('正确解析 status, trending, profile 页面类别，全局保留路由不清洗', () => {
    assert.deepEqual(parseXPage(STATUS_URL), { kind: 'status' });
    assert.deepEqual(parseXPage(TRENDING_URL), { kind: 'trending' });
    assert.deepEqual(parseXPage(PROFILE_URL), { kind: 'profile' });
    assert.deepEqual(parseXPage('https://twitter.com/i/trending/12345'), { kind: 'trending' });

    for (const url of [
      'https://x.com/home',
      'https://x.com/explore',
      'https://x.com/notifications',
      'https://x.com/messages',
      'https://x.com/settings',
      'https://x.com/search?q=test',
    ]) {
      assert.equal(parseXPage(url), null, url);
    }
  });

  it('尾斜杠、查询参数与 fragment 不影响解析', () => {
    const snippet = '## Related Trending Stories on X\n正文';
    for (const url of [
      'https://x.com/i/trending/123/',
      'https://x.com/i/trending/123?src=trend_click',
      'https://x.com/i/trending/123#top',
    ]) {
      assert.equal(cleanXBoilerplate(snippet, url).actions.length, 1, url);
    }
  });
});

describe('规则 1：相关热搜推荐标题行 (related_trending_heading)', () => {
  it('带标题标记的独立行精确匹配时整行删除，正文逐字保留', () => {
    const text = '## Related Trending Stories on X\n🚨MASSIVE: GPT-6 Astra cracked cipher';
    const cleaned = cleanXBoilerplate(text, TRENDING_URL);
    assert.deepEqual(cleaned.actions, [{ rule: 'related_trending_heading', line: 1 }]);
    assert.equal(cleaned.text, '🚨MASSIVE: GPT-6 Astra cracked cipher');
  });

  it('保留正文句中偶然包含该词组的长句', () => {
    const body = 'The section Related Trending Stories on X is often cluttered.';
    const cleaned = cleanXBoilerplate(body, TRENDING_URL);
    assert.deepEqual(cleaned.actions, []);
    assert.equal(cleaned.text, body);
  });
});

describe('规则 2：行尾展开按钮 (show_more_button)', () => {
  it('保留行尾同名正文，避免误删按钮说明和帖子文字', () => {
    for (const text of [
      'New button text: Show more',
      'A complete sentence. Show more',
      'Line Show more\n\nNext line',
    ]) {
      assert.deepEqual(cleanXBoilerplate(text, STATUS_URL), { text, actions: [] });
    }
  });

  it('独立整行 Show more 直接整行删除', () => {
    const text = 'First line\nShow more\nSecond line';
    const cleaned = cleanXBoilerplate(text, STATUS_URL);
    assert.deepEqual(cleaned.actions, [{ rule: 'show_more_button', line: 2 }]);
    assert.equal(cleaned.text, 'First line\nSecond line');
  });
});

describe('规则 3：侧边栏登录与推荐关注卡片 (auth_sidebar_card)', () => {
  it('首两行命中时只剥离标题，保留人物资料和后续正文', () => {
    const card = [
      '## Log in or sign up for X',
      '',
      '## Relevant people',
      '',
      'Avatar',
      '',
      'Carter Church@CarterWChurch Follow',
      '',
      'staff ai engineer',
    ].join('\n');

    const cleaned = cleanXBoilerplate(card, STATUS_URL);
    assert.equal(cleaned.actions.length, 2);
    assert.equal(
      cleaned.text,
      '\n\nAvatar\n\nCarter Church@CarterWChurch Follow\n\nstaff ai engineer'
    );
    assert.ok(cleaned.actions.every((a) => a.rule === 'auth_sidebar_card'));
  });

  it('若正文仅提及登录且不是以复合卡片呈现，则完整保留不误删', () => {
    const text = 'Users discuss Log in or sign up for X policies.';
    const cleaned = cleanXBoilerplate(text, STATUS_URL);
    assert.deepEqual(cleaned.actions, []);
    assert.equal(cleaned.text, text);
  });
});

describe('保护区域：代码与引用块不被清洗', () => {
  it('围栏代码块内的 Show more 和标题行完整保留', () => {
    const snippet = [
      '```python',
      '# ## Related Trending Stories on X',
      'print("Show more")',
      '```',
    ].join('\n');

    const cleaned = cleanXBoilerplate(snippet, STATUS_URL);
    assert.deepEqual(cleaned.actions, []);
    assert.equal(cleaned.text, snippet);
  });

  it('缩进代码块内的界面文字完整保留', () => {
    const snippet = ['    ## Related Trending Stories on X', '    Show more'].join('\n');
    const cleaned = cleanXBoilerplate(snippet, STATUS_URL);
    assert.deepEqual(cleaned.actions, []);
    assert.equal(cleaned.text, snippet);
  });

  it('Markdown 引用行及懒续行受保护不被删除', () => {
    const snippet = ['> ## Related Trending Stories on X', '> text line Show more'].join('\n');
    const cleaned = cleanXBoilerplate(snippet, STATUS_URL);
    assert.deepEqual(cleaned.actions, []);
    assert.equal(cleaned.text, snippet);
  });
});

describe('幂等性保证', () => {
  it('连续清洗多次输出一致且 actions 稳定', () => {
    const text = '## Related Trending Stories on X\nReal article content Show more';
    const first = cleanXBoilerplate(text, STATUS_URL);
    const second = cleanXBoilerplate(first.text, STATUS_URL);

    assert.equal(first.text, 'Real article content Show more');
    assert.equal(second.text, 'Real article content Show more');
    assert.deepEqual(second.actions, []);
  });
});

describe('X 审查回归', () => {
  it('侧栏后混有帖子正文时保留完整事实与 CRLF', () => {
    const body = 'Alice@alice Follow\r\nEngineer\r\n## Post\r\nVersion 2.4 fixes data corruption.';
    const result = cleanXBoilerplate(
      '## Log in or sign up for X\r\n## Relevant people\r\n' + body,
      STATUS_URL
    );
    assert.equal(result.text, body);
    assert.equal(result.actions.length, 2);
  });
  it('拒绝畸形路径和未知子页，接受明确的媒体详情页', () => {
    for (const path of [
      '/i/trending/abc',
      '/i/trending//other',
      '//status/123',
      '/alice/status/123/arbitrary',
      '/alice/status/123/photo/0',
      '/bad-name',
      '/home/status/123',
    ]) {
      assert.equal(parseXPage('https://x.com' + path), null, path);
    }
    for (const path of ['/alice/status/123/photo/1', '/alice/status/123/video/1']) {
      assert.deepEqual(parseXPage('https://x.com' + path), { kind: 'status' });
    }
  });
  it('引用懒续行、内联代码和嵌套清洗保持安全与幂等', () => {
    for (const text of [
      '> quote\nShow more',
      '`Show more`',
      'Log in or sign up for X\nLog in or sign up for X\nRelevant people\nRelevant people',
    ]) {
      assert.deepEqual(cleanXBoilerplate(text, STATUS_URL), { text, actions: [] });
    }
  });
});
