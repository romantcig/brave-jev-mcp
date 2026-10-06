import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { normalizeTitleForCompare } from './jsonld.js';
import { BOILERPLATE_PREFIXES } from './markers.js';
import {
  isTitleOnly,
  isTitleRepeatLine,
  matchesPrefix,
  normalizeLine,
  stripBoilerplateLines,
  TITLE_LINE_MIN,
  TITLE_RESIDUAL_MAX,
} from './prefilter.js';

/** 从入库夹具逐字取出的片段，用于直接验证预筛谓词。 */

/** 内联摘录自 Git 历史中的 fixtures/jev_release_default.json 来源 1（heise）片段 1：以样板行开头、剥后应保留正文的最小真实证据。 */
const HEISE_SNIPPET_1 =
  'Continue after ad\n\nTypeSafe AI demonstrates how Jev could help companies using customer service routing as an example. Jev decides there how an incoming request should be processed. A simple question about order status can go to normal program code, a product question to a language model, and a complex or uncertain case to a human.';
const HEISE_TITLE = 'AI model “Jev” to make machines decide faster';

/** 内联摘录自 Git 历史中的 fixtures/jev_release_default.json 来源 2（pasqualepillitteri）片段 2：样板前缀自带 `##` 标记的 FAQ 块。 */
const PASQUALE_SNIPPET_2 =
  '## Frequently Asked Questions (FAQ)\n#### 1. What is TypeSafe\'s Jev?\n**Jev is an AI model that doesn\'t chat.** Instead of generating text it returns a typed decision, picked from the options you supply, with a confidence score. TypeSafe calls it the first "System One Model," built for fast decisions inside software';

/** 内联摘录自 Git 历史中的 fixtures/jev_release_default.json 来源 7（kucoin）片段 0：剥后只剩来源标题 → 整片删的最小真实证据。 */
const KUCOIN_SNIPPET_0 =
  '# TypeSafe AI Launches Jev, a Non-Chat AI Model 193x Faster Than Claude\nRelease Time: 2026/09/16 05:34:40\nShare';
const KUCOIN_TITLE = 'TypeSafe AI Launches Jev, a Non-Chat AI Model 193x Faster Than Claude';

/** 内联摘录自 Git 历史中的 fixtures/jev_release_default.json 来源 10（mezha）片段 0：8 行站内导航块，长度 ≥ 200，预筛规则都不删。 */
const MEZHA_SNIPPET_0 =
  '### Russian Drones Injure Two Men and Ignite Warehouses in Kyiv Region\n\n18 sep 2026, 23:45\n\n### Trump Announces White House Ban on CNN, MS NOW and Politico\n\n18 sep 2026, 23:30\n\n### Budanov Says Ukraine Can Resist Russia’s Information Warfare\n\n18 sep 2026, 23:01\n\n### TypeSafe AI Unveils Jev, a Fast AI Model Built for Software Automation\n\n18 sep 2026, 23:00';
const MEZHA_TITLE = 'TypeSafe AI Unveils Jev, a Fast AI Model Built for Software Automation';

describe('normalizeLine', () => {
  it('strips leading markdown markers and whitespace', () => {
    assert.equal(
      normalizeLine('## Frequently Asked Questions (FAQ)'),
      'Frequently Asked Questions (FAQ)'
    );
    assert.equal(normalizeLine('   *Share'), 'Share');
    assert.equal(normalizeLine('- Release Time: x'), 'Release Time: x');
  });
});

describe('matchesPrefix', () => {
  it('normalizes both sides, so a prefix carrying its own ## marker still matches', () => {
    // 前缀表本身含 Markdown 标记，因此匹配两侧都必须归一化。
    assert.equal(
      matchesPrefix('## Frequently Asked Questions (FAQ)', ['## Frequently Asked Questions']),
      true
    );
  });

  it('compares case-insensitively after stripping leading markers', () => {
    assert.equal(matchesPrefix('READ MORE: the full story', ['Read more']), true);
  });

  it('does not match when the prefix appears mid-line', () => {
    assert.equal(matchesPrefix('Read our READ MORE section first', ['READ MORE']), false);
  });

  it('does not match long body lines that merely begin with a table entry', () => {
    // Share 这类词可出现在正文句首，不能无条件 startsWith 删除。
    assert.equal(
      matchesPrefix('Shares of Nvidia fell 5% on Tuesday after weaker guidance.', ['Share']),
      false
    );
    assert.equal(
      matchesPrefix('SharePoint Online now supports the new API for list formatting.', ['Share']),
      false
    );
    assert.equal(
      matchesPrefix('On this page, we explain how the v6 migration works.', ['On this page']),
      false
    );
    assert.equal(
      matchesPrefix('Sponsored by the NSF, this study measured the effect.', ['Sponsored']),
      false
    );
  });

  it('still matches whole-line entries and short prefixed lines', () => {
    // 独立样板行（整行相等，行末标点忽略）
    assert.equal(matchesPrefix('Share', ['Share']), true);
    assert.equal(matchesPrefix('Read next.', ['Read next']), true);
    assert.equal(matchesPrefix('Release time', ['Release Time:']), true);
    // 短行 + 英文词边界：'Share' 不吞 'Shares'/'SharePoint'
    assert.equal(matchesPrefix('Share this article', ['Share']), true);
    assert.equal(matchesPrefix('READ MORE: the full story', ['Read more']), true);
  });
});

describe('isTitleOnly', () => {
  it('matches after stripping markers, compressing whitespace and lowercasing', () => {
    assert.equal(isTitleOnly(`# ${KUCOIN_TITLE}`, KUCOIN_TITLE), true);
    assert.equal(isTitleOnly('sanity   studio', 'Sanity Studio'), true);
  });

  it('rejects text that carries anything besides the title', () => {
    assert.equal(isTitleOnly(`${KUCOIN_TITLE}\nRelease Time: 2026/09/16`, KUCOIN_TITLE), false);
    assert.equal(isTitleOnly('Some body text', 'Title'), false);
  });
});

describe('stripBoilerplateLines', () => {
  it('empties the kucoin flash snippet down to its source title', () => {
    const result = stripBoilerplateLines(KUCOIN_SNIPPET_0, BOILERPLATE_PREFIXES, KUCOIN_TITLE);

    // 剩余文本归一化后等于标题（只剩标题），整片判删
    assert.equal(normalizeTitleForCompare(result.text), normalizeTitleForCompare(KUCOIN_TITLE));
    assert.equal(result.emptied, true);
  });

  it('keeps the heise body after stripping the ad line', () => {
    const result = stripBoilerplateLines(HEISE_SNIPPET_1, BOILERPLATE_PREFIXES, HEISE_TITLE);

    assert.equal(result.emptied, false);
    // 首行不再是样板行，而是正文首句
    assert.equal(result.text.startsWith('Continue after ad'), false);
    assert.equal(result.text.startsWith('TypeSafe AI demonstrates'), true);
  });

  it('strips the self-marked FAQ heading and keeps the pasqualepillitteri answer', () => {
    const result = stripBoilerplateLines(PASQUALE_SNIPPET_2, BOILERPLATE_PREFIXES, 'Some title');

    assert.equal(result.emptied, false);
    const firstLine = result.text.split('\n')[0];
    assert.equal(
      normalizeLine(firstLine).toLowerCase().startsWith('frequently asked questions'),
      false
    );
    assert.equal(normalizeLine(firstLine).startsWith("1. What is TypeSafe's Jev?"), true);
  });

  it('keeps the mezha navigation block (long and full of content terms)', () => {
    const result = stripBoilerplateLines(MEZHA_SNIPPET_0, BOILERPLATE_PREFIXES, MEZHA_TITLE);

    assert.equal(result.emptied, false);
    assert.equal(result.text, MEZHA_SNIPPET_0);
  });

  it('keeps body lines that merely begin with a table entry (multi-line snippet)', () => {
    // 整行删语义下，这种行不该被剥掉——片段其余行依赖它保持完整
    const result = stripBoilerplateLines(
      'Shares of Nvidia fell 5% on Tuesday.\nAnalysts blamed the weaker guidance.',
      BOILERPLATE_PREFIXES,
      'Title'
    );

    assert.equal(result.emptied, false);
    assert.equal(result.text.startsWith('Shares of Nvidia fell 5%'), true);
  });

  it('reports emptied for a snippet made only of boilerplate lines', () => {
    const result = stripBoilerplateLines(
      'Share\n\nTable of contents\n\nOn this page',
      BOILERPLATE_PREFIXES,
      'Title'
    );

    assert.deepEqual(result, { text: '', emptied: true });
  });

  it('reports emptied when stripping leaves only the source title', () => {
    const result = stripBoilerplateLines(
      `Share\n\n# ${KUCOIN_TITLE}`,
      BOILERPLATE_PREFIXES,
      KUCOIN_TITLE
    );

    assert.equal(result.emptied, true);
    assert.equal(normalizeTitleForCompare(result.text), normalizeTitleForCompare(KUCOIN_TITLE));
  });
});

// 标题重复行的合成边界用例，保留真实样本形态，正文经过改写。
// 覆盖重复次数、署名边界及代码区域保护。

describe('stripBoilerplateLines — title-repeat lines (第二十轮)', () => {
  const NEWS_TITLE = 'Cloudflare to launch public certificate authority with quantum-safe tech';

  it('strips repeats after the first when the title line occurs twice or more (byline tolerance)', () => {
    // 投资站形态：Brave 的 title 字段带署名后缀（by 记号），片段内三次重复不带；
    // 重复 ≥2 剥首次之后的所有命中——×3 堆叠降为 ×1 + 发布时间行
    const snippet = [
      `# ${NEWS_TITLE}`,
      'Published Sep 29, 2026, 09:04 AM',
      NEWS_TITLE,
      NEWS_TITLE,
    ].join('\n');

    const { text, emptied } = stripBoilerplateLines(
      snippet,
      BOILERPLATE_PREFIXES,
      `${NEWS_TITLE} By Investing.com`
    );

    assert.equal(text, `# ${NEWS_TITLE}\nPublished Sep 29, 2026, 09:04 AM`);
    assert.equal(emptied, false);
  });

  it('empties a pure title stack so the whole snippet dies (isTitleOnly fallback)', () => {
    // aivy 形态：标题连抄两遍、无任何正文——剥重复后只剩标题行，按标题唯一语义整片删
    const { text, emptied } = stripBoilerplateLines(
      `${NEWS_TITLE}\n${NEWS_TITLE}`,
      BOILERPLATE_PREFIXES,
      NEWS_TITLE
    );

    assert.equal(text, NEWS_TITLE);
    assert.equal(emptied, true);
  });

  it('keeps the H1 lead and byline while stripping the repeated title (ua.news fixture shape)', () => {
    // 夹具实测形态：H1 + 署名行 + 重复标题——首次出现是正文结构，重复的才剥
    const snippet = [
      `# ${NEWS_TITLE}`,
      'Lev Shevtsov 18 September 2026 21:58',
      '',
      NEWS_TITLE,
    ].join('\n');

    const { text, emptied } = stripBoilerplateLines(snippet, BOILERPLATE_PREFIXES, NEWS_TITLE);

    assert.equal(text, `# ${NEWS_TITLE}\nLev Shevtsov 18 September 2026 21:58`);
    assert.equal(emptied, false);
  });

  it('keeps a snippet whose only title line is the first non-empty line (H1 lead)', () => {
    // 正文以自己的 H1 开头不等于重复，单次命中应保留。
    const snippet = [
      '# Reddit API Shut Down in 2026: What Still Works',
      'Reddit killed unauthenticated requests in May 2026 — here is what still works now.',
    ].join('\n');

    const { text, emptied } = stripBoilerplateLines(
      snippet,
      BOILERPLATE_PREFIXES,
      'Reddit API Shut Down in 2026: What Still Works'
    );

    assert.equal(text, snippet);
    assert.equal(emptied, false);
  });

  it('keeps a single trailing title line: one occurrence proves no repetition (audit F2)', () => {
    // "非第一行"不是重复证明——正文后的唯一标题行可能是页面结构的一部分，
    // 审核反例（围栏代码里的同名命令）与面包屑 H1 都靠这条保命
    const snippet = [
      'The announcement comes as quantum computers capable of breaking encryption are anticipated within years.',
      NEWS_TITLE,
    ].join('\n');

    const { text } = stripBoilerplateLines(snippet, BOILERPLATE_PREFIXES, NEWS_TITLE);

    assert.equal(text, snippet);
  });

  it('keeps a breadcrumb-led snippet whose only H1 equals the source title (audit F2)', () => {
    // The Register 夹具实测形态：栏目标签在 H1 之前，H1 是正文唯一的标题行
    const snippet = [
      'ai and ml',
      '# TypeSafe AI debuts model for machines that plays Doom',
      "Jev doesn't chat. It produces typed probabilistic decisions.",
    ].join('\n');

    const { text } = stripBoilerplateLines(
      snippet,
      BOILERPLATE_PREFIXES,
      'TypeSafe AI debuts model for machines that plays Doom'
    );

    assert.equal(text, snippet);
  });

  it('keeps fenced code whose command equals the source title, even twice (audit F2)', () => {
    // 审核反例：来源标题 git status --short，围栏代码里同名命令出现两次——
    // 围栏内的行不是 SEO 堆叠
    const snippet = ['```sh', 'git status --short', 'echo done', 'git status --short', '```'].join(
      '\n'
    );

    const { text } = stripBoilerplateLines(snippet, BOILERPLATE_PREFIXES, 'git status --short');

    assert.equal(text, snippet);
  });

  it('tracks fence length and char: inner triple fence inside quadruple fence is content (复审 R2)', () => {
    // 外层四反引号包"用三反引号演示围栏"的 Markdown 文档——内层围栏与它的闭栏
    // 都是示例内容，布尔翻转会把内层第二次出现的命令误当堆叠剥掉
    const snippet = [
      '````markdown',
      '```sh',
      'git status --short',
      'echo done',
      'git status --short',
      '```',
      '````',
    ].join('\n');

    const { text } = stripBoilerplateLines(snippet, BOILERPLATE_PREFIXES, 'git status --short');

    assert.equal(text, snippet);
  });

  it('does not let a tilde fence be closed by backticks and protects indented code (复审 R2)', () => {
    const tildeSnippet = [
      '~~~~',
      '```sh',
      'git status --short',
      '```',
      'git status --short',
      '~~~~',
    ].join('\n');
    assert.equal(
      stripBoilerplateLines(tildeSnippet, BOILERPLATE_PREFIXES, 'git status --short').text,
      tildeSnippet
    );

    // 四空格缩进代码（无围栏）里的重复命令同样保护
    const indented = [
      'Try it:',
      '    git status --short',
      '    echo done',
      '    git status --short',
    ].join('\n');
    assert.equal(
      stripBoilerplateLines(indented, BOILERPLATE_PREFIXES, 'git status --short').text,
      indented
    );
  });

  it('protects tab-indented code by indent columns, not char count (filter-rules-9 审查 R1)', () => {
    // 单个 Tab 即达 4 列（CommonMark tab stop）——字符数判断会把缩进代码行
    // 误放行给标题重复行剥离；"2 空格 + Tab"的混合缩进同样 4 列
    const tabbed = ['Try it:', '\tgit status --short', '\techo done', '\tgit status --short'].join(
      '\n'
    );
    assert.equal(
      stripBoilerplateLines(tabbed, BOILERPLATE_PREFIXES, 'git status --short').text,
      tabbed
    );

    const mixed = ['Try it:', '  \tgit status --short'].join('\n');
    assert.equal(
      stripBoilerplateLines(mixed, BOILERPLATE_PREFIXES, 'git status --short').text,
      mixed
    );
  });

  it('protects lines inside a cross-line inline code span (filter-rules-9 审查 R1)', () => {
    // 开启行、跨行内部行与闭合行整体受保护——删任何一行都会拆散 code span；
    // 标题重复行剥离不得把跨度内与来源标题同名的文本当堆叠剥掉
    const snippet = ['Run `git', 'status --short', 'now` to check.'].join('\n');
    assert.equal(
      stripBoilerplateLines(snippet, BOILERPLATE_PREFIXES, 'status --short').text,
      snippet
    );
  });

  it('转义反引号不使跨行代码中的重复标题失去保护', () => {
    const tick = String.fromCharCode(96);
    const slash = String.fromCharCode(92);
    const snippet = `Use ${slash}${tick} literally, then ${tick}first\nstatus --short\nstatus --short\nlast${tick}`;
    assert.equal(
      stripBoilerplateLines(snippet, BOILERPLATE_PREFIXES, 'status --short').text,
      snippet
    );
  });

  it('rejects byline matches whose residual is longer than the line or lacks a marker', () => {
    // 回放实测回归："- reddit API shut down" 这类短标签行与 title 的前缀残差
    // （26 码元）比行（20 码元）还长——不是署名；": 10 outlets compared" 是副标题
    // 续写，长度条件证明不了署名，必须带 by/via/分隔记号（审核 F2）
    assert.equal(TITLE_LINE_MIN, 20);
    assert.equal(TITLE_RESIDUAL_MAX, 40);
    assert.equal(
      isTitleRepeatLine('reddit API shut down', 'reddit api shut down in 2026: what still works'),
      false
    );
    assert.equal(
      isTitleRepeatLine(
        'Google Unveils Gemini 4 Argon With 1M-Token Limit, Launching Soon for Subscribers',
        'google unveils gemini 4 argon with 1m-token limit, launching soon for subscribers: 10 outlets compared'
      ),
      false
    );
    assert.equal(
      isTitleRepeatLine(NEWS_TITLE, `${NEWS_TITLE.toLowerCase()} by investing.com`),
      true
    );
  });
});
