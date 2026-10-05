import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cleanGitHubBoilerplate } from './githubCleanup.js';

describe('比较页菜单和 PR 加载占位清理', () => {
  it('d3efa04b 日志：比较菜单使用七位短 SHA，保留提交事实与标识', () => {
    const head = '1. remove hacks @joamatab joamatab committed Aug 11, 2023';
    const text =
      head +
      ' Configuration menu Copy the full SHA b3193f7 View commit details Browse the repository at this point in the history';
    const result = cleanGitHubBoilerplate(
      text,
      'https://github.com/gdsfactory/gdsfactory/compare/v7.2.1...v7.3.0'
    );
    assert.equal(result.text, head + ' b3193f7');
    assert.deepEqual(result.actions, [{ rule: 'compare_commit_menu', line: 1, partial: true }]);
  });
  const compare = 'https://github.com/team/project/compare/main...fix';
  const pull = 'https://github.com/team/project/pull/42';
  const sha = 'aB12'.repeat(10);
  const menu = `Configuration menu Copy the full SHA ${sha} View commit details Browse the repository at this point in the history`;
  const error = 'There was an error while loading. Please reload this page.';

  it('连续提交逐条剥菜单，保留说明、SHA、顺序和 CRLF', () => {
    const text = `Fix corruption ${menu}\r\nAdd regression ${menu}\r\n`;
    const result = cleanGitHubBoilerplate(text, compare);
    assert.equal(result.text, `Fix corruption ${sha}\r\nAdd regression ${sha}\r\n`);
    assert.deepEqual(
      result.actions,
      [1, 2].map((line) => ({ rule: 'compare_commit_menu', line, partial: true }))
    );
    assert.deepEqual(cleanGitHubBoilerplate(result.text, compare), {
      text: result.text,
      actions: [],
    });
    assert.equal(
      cleanGitHubBoilerplate(menu, 'https://github.com/team/project/compare?expand=1').text,
      sha
    );
  });

  it('残缺菜单、未知域名、其它页面与受保护内容保留', () => {
    for (const text of [
      menu.replace(sha, 'abc123'),
      menu + ' is the menu text.',
      `> ${menu}`,
      `    ${menu}`,
      `\`\`\`\n${menu}\n\`\`\``,
      `\`${menu}\``,
      `> quoted\n${menu}`,
    ]) {
      assert.deepEqual(cleanGitHubBoilerplate(text, compare), { text, actions: [] });
    }
    for (const url of [
      pull,
      'https://github.com/team/project',
      'https://github.com.evil.test/team/project/compare',
      'https://github.com/team/project//compare',
    ]) {
      assert.deepEqual(cleanGitHubBoilerplate(menu, url), { text: menu, actions: [] });
    }
  });

  it('PR 成对占位只删界面行，保留合并元数据、反应数、关联问题和正文', () => {
    const before = 'alice wants to merge 2 commits into main from fix\r\n';
    const after =
      '👍 3\r\n### Reviewers\r\nbob\r\n### Development\r\nFixes #7\r\nActual fix details';
    const result = cleanGitHubBoilerplate(
      before + error + '\r\n\r\nAll reactions\r\n' + after,
      pull
    );
    assert.equal(result.text, before + '\r\n' + after);
    assert.deepEqual(
      result.actions,
      [2, 4].map((line) => ({ rule: 'pr_loading_placeholder', line }))
    );
    assert.deepEqual(cleanGitHubBoilerplate(result.text, pull), { text: result.text, actions: [] });
  });

  it('孤立提示、正文隔断、引用与代码中的提示不删', () => {
    for (const text of [
      error,
      'All reactions',
      `${error}\nExplanation\nAll reactions`,
      `> ${error}\nAll reactions`,
      `\`\`\`\n${error}\nAll reactions\n\`\`\``,
      `${error}\n    All reactions`,
    ]) {
      assert.deepEqual(cleanGitHubBoilerplate(text, pull), { text, actions: [] });
    }
    for (const url of [compare, pull + '/files', 'https://github.com/team/project/issues/42']) {
      const text = `${error}\nAll reactions`;
      assert.deepEqual(cleanGitHubBoilerplate(text, url), { text, actions: [] });
    }
  });
});

/** GitHub 清洗的命中、保护区域、原序与幂等回归。 */

const REPO_ROOT = 'https://github.com/HexRaysSA/ida-mcp';
const PR = 'https://github.com/HexRaysSA/ida-mcp/pull/8';
const ISSUE = 'https://github.com/ZainCheung/sift-x/issues/2';
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

  it('仅支持明确页面路径：Topics、tree、未知路径不清洗，其他页面不误用仓库首页规则', () => {
    const snippet = '## Repository files navigation';
    for (const url of [
      'https://github.com/topics/redlib',
      'https://github.com/a/b/tree/main/docs',
      'https://github.com/a/b/blob/main/README.md',
      'https://github.com/a/b/wiki/Page',
      'https://github.com/a/b/releases', // Release 列表不套用仓库导航规则
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
    const lazy = '> GitHub displays this message:\nUh oh!';
    const lazyCleaned = cleanGitHubBoilerplate(lazy, PR);
    assert.deepEqual(lazyCleaned.actions, []);
    assert.equal(lazyCleaned.text, lazy);

    // 空行结束引用段落，其后的独立行不受续行保护
    const blank = '> 引用说明\n\nUh oh!';
    const blankCleaned = cleanGitHubBoilerplate(blank, PR);
    assert.deepEqual(blankCleaned.actions, [{ rule: 'pr_uh_oh', line: 3 }]);
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
      [ISSUE, '### Uh oh!\nThis error means a timeout.'],
      [PR, '## Conversation\n讨论正文'],
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
describe('新增 GitHub 清洗边界', () => {
  it('PR 的 Uh oh! 独立行被剥离，提交信息与流程图逐字保留', () => {
    const body = '@author merged commit abc123\r\n```mermaid\r\nflowchart TD\r\nA --> B\r\n```';
    assert.deepEqual(cleanGitHubBoilerplate('### Uh oh!\r\n' + body, PR), {
      text: body,
      actions: [{ rule: 'pr_uh_oh', line: 1 }],
    });
    for (const text of [
      'Uh oh! means a timeout.',
      '    Uh oh!',
      '> Uh oh!',
      '`Uh oh!`',
      '```\nUh oh!\n```',
    ]) {
      assert.deepEqual(cleanGitHubBoilerplate(text, PR), { text, actions: [] });
    }
    for (const url of [
      REPO_ROOT,
      ISSUE,
      RELEASE,
      PR + '/files',
      'https://example.com/a/b/pull/8',
    ]) {
      assert.deepEqual(cleanGitHubBoilerplate('### Uh oh!', url), {
        text: '### Uh oh!',
        actions: [],
      });
    }
  });

  it('Release 列表复用成对规则，单独提示、正文隔断和真实提交表格保留', () => {
    const url = 'https://github.com/team/project/releases/?page=2';
    const body =
      'v8.3.0\nreleased Sep 3\n| Author | Message | Commit |\n| a | fix: keep field | abc123 |';
    assert.equal(
      cleanGitHubBoilerplate('# Choose a tag to compare\n\n## No results found\n' + body, url).text,
      '\n' + body
    );
    for (const text of [
      'No results found\n' + body,
      'Choose a tag to compare\nPre-release\nNo results found',
      '```\nChoose a tag to compare\nNo results found\n```',
    ]) {
      assert.deepEqual(cleanGitHubBoilerplate(text, url), { text, actions: [] });
    }
  });

  const topics = '## About\n### Topics\nbrowser-extension privacy typescript';
  it('仓库首页只清理完整独立 Topics 卡片，混有正文或许可证的片段保留', () => {
    const cleaned = cleanGitHubBoilerplate(topics, REPO_ROOT);
    assert.equal(cleaned.text, '');
    assert.deepEqual(
      cleaned.actions,
      [1, 2, 3].map((line) => ({ rule: 'repo_topics', line }))
    );
    for (const text of [
      topics + '\nSupports offline mode.',
      '## License\nMIT\n' + topics,
      '项目说明\n' + topics,
      '## About\n### Topics\nThis is a full sentence.',
      '```\n' + topics + '\n```',
      topics.replace('browser-extension', '    browser-extension'),
    ]) {
      assert.deepEqual(cleanGitHubBoilerplate(text, REPO_ROOT), { text, actions: [] });
    }
    for (const url of [
      PR,
      'https://github.com/topics/privacy',
      REPO_ROOT + '/blob/main/README.md',
      'https://github.com.evil.test/a/b',
    ]) {
      assert.deepEqual(cleanGitHubBoilerplate(topics, url), { text: topics, actions: [] });
    }
  });

  const intro = 'Private front-end for Reddit';
  it('About 回声不受 shingle 短文本门槛限制，但要求前序完整覆盖', () => {
    for (const text of [
      '## About\n' + intro,
      '# Configuration\n## About\n' + intro,
      '## License\n\n## About\n' + intro,
    ]) {
      const before = [intro + ' .'];
      assert.equal(cleanGitHubBoilerplate(text, REPO_ROOT, before).text, '');
      assert.ok(
        cleanGitHubBoilerplate(text, REPO_ROOT, before).actions.every(
          (a) => a.rule === 'about_echo'
        )
      );
      assert.deepEqual(before, [intro + ' .']);
      assert.deepEqual(cleanGitHubBoilerplate(text, REPO_ROOT), { text, actions: [] });
    }
  });

  it('About 的许可证、链接、新增限制、数字、代码与正文扩展不被包含比较吞掉', () => {
    for (const text of [
      '## License\nCC0 1.0\n## About\n' + intro,
      '## About\n' + intro + '\nhttps://example.com',
      '## About\n' + intro + ' for non-commercial use only',
      '## About\nNot ' + intro,
      '## About\n' + intro + ' version 2',
      '## About\n' + intro + '\nAdditional functionality.',
      '> ## About\n> ' + intro,
      '```\n## About\n' + intro + '\n```',
      '## About\n    ' + intro,
    ])
      assert.deepEqual(cleanGitHubBoilerplate(text, REPO_ROOT, [intro]), { text, actions: [] });
    const text = '## About\n' + intro;
    assert.deepEqual(cleanGitHubBoilerplate(text, REPO_ROOT, ['X' + intro, intro + 'Extra']), {
      text,
      actions: [],
    });
    assert.deepEqual(cleanGitHubBoilerplate(text, PR, [intro]), { text, actions: [] });
  });

  it('新增规则保持幂等，删除导航不得制造新的整片卡片匹配', () => {
    for (const [text, url] of [
      [topics, REPO_ROOT],
      ['## About\n' + intro, REPO_ROOT],
      ['### Uh oh!\n正文', PR],
      ['Repository files navigation\n' + topics, REPO_ROOT],
    ]) {
      const first = cleanGitHubBoilerplate(text, url, [intro]);
      assert.equal(cleanGitHubBoilerplate(first.text, url, [intro]).text, first.text);
    }
    const text = 'Repository files navigation\n' + topics;
    assert.deepEqual(cleanGitHubBoilerplate(text, REPO_ROOT), { text, actions: [] });
  });
});
