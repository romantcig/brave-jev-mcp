import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cleanGitHubBoilerplate } from './githubCleanup.js';

/**
 * githubCleanup 的行为锁定（GITHUB_CLEANUP_PLAN「必须覆盖的行为」）：五条首批规则
 * 的正例与边界、页面类型与 URL 边界、成对/连续块的打断保留、保护区域、暂缓规则
 * 逐字保留、幂等与原序。测试文本以 2026-09-30..10-02 现场样本的真实形态为原型。
 */

const REPO_ROOT = 'https://github.com/HexRaysSA/ida-mcp';
const PR = 'https://github.com/HexRaysSA/ida-mcp/pull/8';
const ISSUE = 'https://github.com/ZainCheung/sift-x/issues/2';
const DISCUSSION = 'https://github.com/octocat/Hello-World/discussions/17';
const RELEASE = 'https://github.com/HexRaysSA/ida-mcp/releases/tag/v2026.916.1';

/** 真实样本形态：仓库首页片段（导航行 + 搜索界面块 + 面包屑混排）。 */
const REPO_SNIPPET = [
  '## Repository files navigation',
  '# Saved searches',
  '# Search code, repositories, users, issues, pull requests...',
  '',
  '# Provide feedback',
  '',
  'lotillc / **redlib-loti** Public',
  '',
  'Private front-end for Reddit',
].join('\n');

describe('页面类别与 URL 边界', () => {
  it('仅精确 hostname github.com / www.github.com 生效，相似域名与其它域名不动', () => {
    const snippet = '## Repository files navigation\n正文';
    for (const url of [
      'https://github.com.evil.com/a/b',
      'https://evil-github.com/a/b',
      'https://example.com/a/b',
      'not a url',
      '',
    ]) {
      const cleaned = cleanGitHubBoilerplate(snippet, url);
      assert.deepEqual(cleaned.actions, [], url);
      assert.equal(cleaned.text, snippet, url);
    }
    assert.equal(cleanGitHubBoilerplate(snippet, 'https://www.github.com/a/b').actions.length, 1);
  });

  it('仅支持明确页面路径：Topics、releases 列表、tree、未知路径均原样返回', () => {
    const snippet = '## Repository files navigation';
    for (const url of [
      'https://github.com/topics/redlib',
      'https://github.com/a/b/tree/main/docs',
      'https://github.com/a/b/blob/main/README.md',
      'https://github.com/a/b/wiki/Page',
      'https://github.com/a/b/releases', // release 列表页（非 tag 详情）
      'https://github.com/a/b/releases/latest',
      'https://github.com/a/b/issues', // Issue 列表页（无编号）
      'https://github.com/a/b/pull/abc', // 非数字编号
    ]) {
      const cleaned = cleanGitHubBoilerplate(snippet, url);
      assert.deepEqual(cleaned.actions, [], url);
      assert.equal(cleaned.text, snippet, url);
    }
  });

  it('尾斜杠、查询参数与 fragment 不影响页面类别判定', () => {
    const snippet = '## Repository files navigation';
    for (const url of [
      'https://github.com/a/b/',
      'https://github.com/a/b?tab=readme',
      'https://github.com/a/b#readme',
    ]) {
      assert.equal(cleanGitHubBoilerplate(snippet, url).actions.length, 1, url);
    }
  });
});

describe('规则 1：仓库导航行', () => {
  it('带标题标记的独立行精确等于时仅删该行，正文逐字保留', () => {
    const cleaned = cleanGitHubBoilerplate('## Repository files navigation\n实际用途', REPO_ROOT);
    assert.deepEqual(cleaned.actions, [{ rule: 'repo_nav', line: 1 }]);
    assert.equal(cleaned.text, '实际用途');
  });

  it('标题标记可省略（裸行）也可命中；正文句子仅包含相同词语时保留', () => {
    assert.deepEqual(cleanGitHubBoilerplate('Repository files navigation', REPO_ROOT).actions, [
      { rule: 'repo_nav', line: 1 },
    ]);
    const body = 'Repository files navigation is a GitHub label, see the sidebar.';
    const cleaned = cleanGitHubBoilerplate(body, REPO_ROOT);
    assert.deepEqual(cleaned.actions, []);
    assert.equal(cleaned.text, body);
  });

  it('同名行出现在非仓库首页（如 PR）不触发本规则', () => {
    const cleaned = cleanGitHubBoilerplate('## Repository files navigation', PR);
    assert.deepEqual(cleaned.actions, []);
    assert.equal(cleaned.text, '## Repository files navigation');
  });
});

describe('规则 2：分支复制按钮后缀（PR）', () => {
  it('剥离末尾按钮后缀，完整保留分支引用与行首文本', () => {
    const line = 'migrate-mcp HexRaysSA/ida-mcp:migrate-mcp Copy head branch name to clipboard';
    const cleaned = cleanGitHubBoilerplate(line, PR);
    assert.deepEqual(cleaned.actions, [{ rule: 'copy_branch_button', line: 1, partial: true }]);
    assert.equal(cleaned.text, 'migrate-mcp HexRaysSA/ida-mcp:migrate-mcp');
  });

  it('其它仓库的分支引用不匹配，按钮行原样保留', () => {
    const line = 'main other/repo:main Copy head branch name to clipboard';
    const cleaned = cleanGitHubBoilerplate(line, PR);
    assert.deepEqual(cleaned.actions, []);
    assert.equal(cleaned.text, line);
  });

  it('分支名不被吞掉：子串形式的仓库名（前缀名称字符）不命中', () => {
    const line = 'xHexRaysSA/ida-mcp:main Copy head branch name to clipboard';
    const cleaned = cleanGitHubBoilerplate(line, PR);
    assert.deepEqual(cleaned.actions, []);
    assert.equal(cleaned.text, line);
  });

  it('按钮文字不在行尾（后接正文）不剥离', () => {
    const line = 'HexRaysSA/ida-mcp:main Copy head branch name to clipboard 再见';
    const cleaned = cleanGitHubBoilerplate(line, PR);
    assert.deepEqual(cleaned.actions, []);
    assert.equal(cleaned.text, line);
  });

  it('分支引用冒号后必须有分支名：残缺引用（冒号后直接按钮后缀）不剥离', () => {
    const line = 'HexRaysSA/ida-mcp: Copy head branch name to clipboard';
    const cleaned = cleanGitHubBoilerplate(line, PR);
    assert.deepEqual(cleaned.actions, []);
    assert.equal(cleaned.text, line);
  });
});

describe('规则 3：搜索界面连续块', () => {
  it('三个标记同块（允许空行）时仅删三个标记行，块前面包屑与尾部正文保留', () => {
    const cleaned = cleanGitHubBoilerplate(REPO_SNIPPET, REPO_ROOT);
    assert.deepEqual(
      cleaned.actions.map((action) => [action.rule, action.line]),
      [
        ['repo_nav', 1],
        ['search_block', 2],
        ['search_block', 3],
        ['search_block', 5],
      ]
    );
    assert.equal(
      cleaned.text,
      '\n\nlotillc / **redlib-loti** Public\n\nPrivate front-end for Reddit'
    );
  });

  it('缺少任一标记的不完整块保留', () => {
    const snippet = '# Saved searches\n\n# Provide feedback\n\n正文说明';
    const cleaned = cleanGitHubBoilerplate(snippet, REPO_ROOT);
    assert.deepEqual(cleaned.actions, []);
    assert.equal(cleaned.text, snippet);
  });

  it('实质正文打断连续块时整块保留', () => {
    const snippet = [
      '# Saved searches',
      '这里有一段实质性说明文字',
      '# Search code, repositories, users, issues, pull requests...',
      '',
      '# Provide feedback',
    ].join('\n');
    const cleaned = cleanGitHubBoilerplate(snippet, REPO_ROOT);
    assert.deepEqual(cleaned.actions, []);
    assert.equal(cleaned.text, snippet);
  });
});

describe('规则 4：版本比较成对提示（Release tag）', () => {
  it('成对出现（允许空行）时仅删两个提示行，发布事实保留', () => {
    const snippet = [
      '# Choose a tag to compare',
      '## No results found',
      '@github-actions github-actions released this 16 Sep 14:29',
      '',
      '· 2 commits to main since this release',
      '',
      'v2026.916.1',
    ].join('\n');
    const cleaned = cleanGitHubBoilerplate(snippet, RELEASE);
    assert.deepEqual(
      cleaned.actions.map((action) => [action.rule, action.line]),
      [
        ['tag_compare', 1],
        ['tag_compare', 2],
      ]
    );
    assert.equal(
      cleaned.text,
      '@github-actions github-actions released this 16 Sep 14:29\n\n· 2 commits to main since this release\n\nv2026.916.1'
    );
  });

  it('单独出现 Choose a tag to compare（无紧随 No results found）保留', () => {
    const snippet = '# Choose a tag to compare\n请选择一个标签来比较版本差异。';
    const cleaned = cleanGitHubBoilerplate(snippet, RELEASE);
    assert.deepEqual(cleaned.actions, []);
    assert.equal(cleaned.text, snippet);
  });

  it('单独出现 No results found 保留', () => {
    const snippet = '## No results found\nSearch failed.';
    const cleaned = cleanGitHubBoilerplate(snippet, RELEASE);
    assert.deepEqual(cleaned.actions, []);
    assert.equal(cleaned.text, snippet);
  });

  it('两提示之间被正文隔开时不成对、都保留', () => {
    const snippet = '# Choose a tag to compare\n中间隔了一句话\n## No results found';
    const cleaned = cleanGitHubBoilerplate(snippet, RELEASE);
    assert.deepEqual(cleaned.actions, []);
    assert.equal(cleaned.text, snippet);
  });
});

describe('规则 5：反应按钮状态行（Issue / PR / Discussion）', () => {
  it('独立行精确等于时仅删该行，三种详情页都生效', () => {
    for (const url of [ISSUE, PR, DISCUSSION]) {
      const cleaned = cleanGitHubBoilerplate('报告正文\nReactions are currently unavailable', url);
      assert.deepEqual(cleaned.actions, [{ rule: 'reactions_unavailable', line: 2 }], url);
      assert.equal(cleaned.text, '报告正文\n', url);
    }
  });

  it('行内包含同词的正文句子保留', () => {
    const body = 'The banner said: Reactions are currently unavailable on this instance.';
    const cleaned = cleanGitHubBoilerplate(body, ISSUE);
    assert.deepEqual(cleaned.actions, []);
    assert.equal(cleaned.text, body);
  });

  it('仓库首页与 Release 页不触发本规则', () => {
    for (const url of [REPO_ROOT, RELEASE]) {
      const cleaned = cleanGitHubBoilerplate('Reactions are currently unavailable', url);
      assert.deepEqual(cleaned.actions, [], url);
    }
  });
});

describe('保护区域', () => {
  const MARK = 'Repository files navigation';

  it('跨度外转义反引号不扰乱真正的跨行代码配对', () => {
    const tick = String.fromCharCode(96);
    const slash = String.fromCharCode(92);
    for (const count of [1, 3]) {
      const snippet = `Use ${slash.repeat(count)}${tick} literally, then ${tick}first\n${MARK}\nlast${tick}`;
      assert.deepEqual(cleanGitHubBoilerplate(snippet, REPO_ROOT), {
        text: snippet,
        actions: [],
      });
    }
  });

  it('偶数反斜杠不转义跨度起点，跨度内反斜杠不转义闭合标记', () => {
    const tick = String.fromCharCode(96);
    const slash = String.fromCharCode(92);
    const snippet = `Use ${slash.repeat(2)}${tick}first\n${MARK}\nlast${slash}${tick}\n${MARK}`;
    const cleaned = cleanGitHubBoilerplate(snippet, REPO_ROOT);
    assert.equal(cleaned.text, snippet.slice(0, -MARK.length));
    assert.deepEqual(cleaned.actions, [{ rule: 'repo_nav', line: 4 }]);
  });

  it('围栏代码内的标记行不触发外部删除（反引号围栏、波浪线围栏、闭栏过短不闭合）', () => {
    for (const snippet of [
      '```md\n## ' + MARK + '\n```',
      // 闭栏 `~~` 短于开栏 `~~~`（CommonMark），围栏未闭合，两行标记都在栏内
      '~~~\n' + MARK + '\n~~\n' + MARK,
      '````\n### ' + MARK + '\n````',
    ]) {
      const cleaned = cleanGitHubBoilerplate(snippet, REPO_ROOT);
      assert.deepEqual(cleaned.actions, [], JSON.stringify(snippet));
      assert.equal(cleaned.text, snippet);
    }
  });

  it('未闭合围栏保护到末尾', () => {
    const snippet = '```md\n## ' + MARK + '\n示例内容';
    const cleaned = cleanGitHubBoilerplate(snippet, REPO_ROOT);
    assert.deepEqual(cleaned.actions, []);
    assert.equal(cleaned.text, snippet);
  });

  it('缩进代码与引用行内的标记不触发；引用内的搜索标记也不能充当块成员', () => {
    for (const snippet of [
      '    ' + MARK,
      '> ' + MARK,
      '> Saved searches\n> Search code, repositories, users, issues, pull requests...\n> Provide feedback',
    ]) {
      const cleaned = cleanGitHubBoilerplate(snippet, REPO_ROOT);
      assert.deepEqual(cleaned.actions, [], JSON.stringify(snippet));
      assert.equal(cleaned.text, snippet);
    }
  });

  it('内联代码整行不精确等于界面文字，天然保留', () => {
    const snippet = '`Repository files navigation`';
    const cleaned = cleanGitHubBoilerplate(snippet, REPO_ROOT);
    assert.deepEqual(cleaned.actions, []);
    assert.equal(cleaned.text, snippet);
  });

  it('Tab 与混合缩进按列数判定为缩进代码（审查 R1：字符数判断会误删单 Tab 行）', () => {
    for (const snippet of ['\t' + MARK, '  \t' + MARK, ' \t ' + MARK]) {
      const cleaned = cleanGitHubBoilerplate(snippet, REPO_ROOT);
      assert.deepEqual(cleaned.actions, [], JSON.stringify(snippet));
      assert.equal(cleaned.text, snippet);
    }
  });

  it('跨行内联代码跨度：开启行、内部行、闭合行整体保护（审查 R1）', () => {
    const snippet = '说明 `first\n' + MARK + '\nlast`';
    const cleaned = cleanGitHubBoilerplate(snippet, REPO_ROOT);
    assert.deepEqual(cleaned.actions, []);
    assert.equal(cleaned.text, snippet);
  });

  it('引用段落的懒续行受保护（审查 R1）；空行或 ATX 标题打断后续行照常判定', () => {
    const lazy = '> GitHub displays this message:\nReactions are currently unavailable';
    const lazyCleaned = cleanGitHubBoilerplate(lazy, ISSUE);
    assert.deepEqual(lazyCleaned.actions, []);
    assert.equal(lazyCleaned.text, lazy);

    // 空行结束引用段落，其后的独立行不受续行保护
    const blank = '> 引用说明\n\nReactions are currently unavailable';
    const blankCleaned = cleanGitHubBoilerplate(blank, ISSUE);
    assert.deepEqual(blankCleaned.actions, [{ rule: 'reactions_unavailable', line: 3 }]);
    assert.equal(blankCleaned.text, '> 引用说明\n\n');

    // ATX 标题是明确的新块开始，不是引用续行
    const heading = '> 引用说明\n# ' + MARK;
    const headingCleaned = cleanGitHubBoilerplate(heading, REPO_ROOT);
    assert.deepEqual(headingCleaned.actions, [{ rule: 'repo_nav', line: 2 }]);
    assert.equal(headingCleaned.text, '> 引用说明\n');
  });

  it('代码区内的按钮后缀与反应状态行同样受保护', () => {
    const button = '    HexRaysSA/ida-mcp:main Copy head branch name to clipboard';
    assert.deepEqual(cleanGitHubBoilerplate(button, PR).actions, []);
    const fenced = '```\nReactions are currently unavailable\n```';
    assert.deepEqual(cleanGitHubBoilerplate(fenced, ISSUE).actions, []);
  });
});

describe('暂缓规则逐字保留', () => {
  it('Uh oh!、Public 面包屑、注册邀请后缀、Awesome 重复尾词、许可证、归档与 fork 信息全部不动', () => {
    for (const [url, snippet] of [
      [PR, '### Uh oh!\nThis error means a timeout.'],
      [REPO_ROOT, 'a / **b** Public'],
      [REPO_ROOT, 'a / **b** Public archive'],
      [
        REPO_ROOT,
        'Private front-end for Reddit . Contribute to a/b development by creating an account on GitHub.',
      ],
      [REPO_ROOT, '# Awesome Jev Awesome'],
      [REPO_ROOT, '# About\nPublic\nmain\nREADME\nLicense'],
      [REPO_ROOT, 'v1.2\nreleased Sep 16\ncommit abc123\nforked from c/d'],
    ] as const) {
      const cleaned = cleanGitHubBoilerplate(snippet, url);
      assert.deepEqual(cleaned.actions, [], JSON.stringify(snippet));
      assert.equal(cleaned.text, snippet, JSON.stringify(snippet));
    }
  });
});

describe('幂等验证（审查 R2：删除不得制造原本不成立的匹配）', () => {
  it('tag_compare 同规则嵌套：删中间一对会让首尾接壤成新对，整轮保守放弃', () => {
    const snippet = [
      'Choose a tag to compare',
      'Choose a tag to compare',
      'No results found',
      'No results found',
    ].join('\n');
    const cleaned = cleanGitHubBoilerplate(snippet, RELEASE);
    assert.deepEqual(cleaned.actions, []);
    assert.equal(cleaned.text, snippet);
  });

  it('search_block 跨规则接壤：导航行打断搜索块时，删导航行会让三标记连续，整轮保守放弃', () => {
    const snippet = [
      'Saved searches',
      'Repository files navigation',
      'Search code, repositories, users, issues, pull requests...',
      'Provide feedback',
    ].join('\n');
    const cleaned = cleanGitHubBoilerplate(snippet, REPO_ROOT);
    assert.deepEqual(cleaned.actions, []);
    assert.equal(cleaned.text, snippet);
  });

  it('放弃场景重复清洗不变（clean(clean(x)) 深相等 clean(x)）', () => {
    const nested = [
      'Choose a tag to compare',
      'Choose a tag to compare',
      'No results found',
      'No results found',
    ].join('\n');
    const navBetween = [
      'Saved searches',
      'Repository files navigation',
      'Search code, repositories, users, issues, pull requests...',
      'Provide feedback',
    ].join('\n');
    for (const [snippet, url] of [
      [nested, RELEASE],
      [navBetween, REPO_ROOT],
    ] as const) {
      const once = cleanGitHubBoilerplate(snippet, url);
      const twice = cleanGitHubBoilerplate(once.text, url);
      assert.equal(twice.text, once.text, url);
      assert.deepEqual(twice.actions, [], url);
    }
  });

  it('正常成对/成块删除不受验证影响：删除后无新命中照常应用', () => {
    const paired = 'Choose a tag to compare\n\nNo results found\n发布说明正文';
    const once = cleanGitHubBoilerplate(paired, RELEASE);
    assert.deepEqual(
      once.actions.map((action) => [action.rule, action.line]),
      [
        ['tag_compare', 1],
        ['tag_compare', 3],
      ]
    );
    const twice = cleanGitHubBoilerplate(once.text, RELEASE);
    assert.deepEqual(twice.actions, []);
    assert.equal(twice.text, once.text);
  });
});

describe('幂等与未命中原样', () => {
  it('清洗一次后再清洗结果不变（含混合片段）', () => {
    const once = cleanGitHubBoilerplate(REPO_SNIPPET, REPO_ROOT);
    const twice = cleanGitHubBoilerplate(once.text, REPO_ROOT);
    assert.deepEqual(twice.actions, []);
    assert.equal(twice.text, once.text);

    const prLine = 'migrate-mcp HexRaysSA/ida-mcp:migrate-mcp Copy head branch name to clipboard';
    const prOnce = cleanGitHubBoilerplate(prLine, PR);
    const prTwice = cleanGitHubBoilerplate(prOnce.text, PR);
    assert.deepEqual(prTwice.actions, []);
    assert.equal(prTwice.text, prOnce.text);
  });

  it('未命中的 GitHub 片段返回同一引用且逐字不变', () => {
    const snippet = 'README 说明正文，没有界面行。';
    const cleaned = cleanGitHubBoilerplate(snippet, REPO_ROOT);
    assert.equal(cleaned.text, snippet);
    assert.equal(cleaned.actions.length, 0);
  });

  it('CRLF 行尾的幸存行逐字保留（删行连行尾一起删）', () => {
    const snippet = '## Repository files navigation\r\n实际用途';
    const cleaned = cleanGitHubBoilerplate(snippet, REPO_ROOT);
    assert.deepEqual(cleaned.actions, [{ rule: 'repo_nav', line: 1 }]);
    assert.equal(cleaned.text, '实际用途');
  });

  it('空文本原样返回', () => {
    assert.deepEqual(cleanGitHubBoilerplate('', REPO_ROOT), { text: '', actions: [] });
  });
});
