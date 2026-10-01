import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { normalizeTitleForCompare } from './jsonld.js';
import { BOILERPLATE_PREFIXES } from './markers.js';
import {
  isNearDuplicate,
  isShortWithoutTerms,
  isTitleOnly,
  isTitleRepeatLine,
  matchesPrefix,
  MIN_SHINGLES,
  NEAR_DUP_COVERAGE,
  NEAR_DUP_JACCARD,
  normalizeLine,
  SHINGLE_N,
  SHORT_SNIPPET_MAX,
  stripBoilerplateLines,
  TITLE_LINE_MIN,
  TITLE_RESIDUAL_MAX,
} from './prefilter.js';
import { contentTerms, shingles, tokenize } from './tokenize.js';

/**
 * 以下真实片段从入库夹具逐字抄录（01-04 的夹具加载器是 pipeline.fixtures.test.ts
 * 的私有助手，本文件拿不到；照 src/tools/local/formatOpeningHours.test.ts 的
 * Captured 注释形态内联）。断言的是"这段真实文本经预筛谓词处理后的结局"。
 */

/** Captured from fixtures/jev_release_default.json 来源 1（heise）片段 1：以样板行开头、剥后应保留正文的最小真实证据。 */
const HEISE_SNIPPET_1 =
  'Continue after ad\n\nTypeSafe AI demonstrates how Jev could help companies using customer service routing as an example. Jev decides there how an incoming request should be processed. A simple question about order status can go to normal program code, a product question to a language model, and a complex or uncertain case to a human.';
const HEISE_TITLE = 'AI model “Jev” to make machines decide faster';

/** Captured from fixtures/jev_release_default.json 来源 2（pasqualepillitteri）片段 2：样板前缀自带 `##` 标记的 FAQ 块。 */
const PASQUALE_SNIPPET_2 =
  '## Frequently Asked Questions (FAQ)\n#### 1. What is TypeSafe\'s Jev?\n**Jev is an AI model that doesn\'t chat.** Instead of generating text it returns a typed decision, picked from the options you supply, with a confidence score. TypeSafe calls it the first "System One Model," built for fast decisions inside software';

/** Captured from fixtures/jev_release_default.json 来源 7（kucoin）片段 0：剥后只剩来源标题 → 整片删的最小真实证据。 */
const KUCOIN_SNIPPET_0 =
  '# TypeSafe AI Launches Jev, a Non-Chat AI Model 193x Faster Than Claude\nRelease Time: 2026/09/16 05:34:40\nShare';
const KUCOIN_TITLE = 'TypeSafe AI Launches Jev, a Non-Chat AI Model 193x Faster Than Claude';

/** Captured from fixtures/jev_release_default.json 来源 10（mezha）片段 0：8 行站内导航块，长度 ≥ 200 且含实词，三条预筛规则都不删。 */
const MEZHA_SNIPPET_0 =
  '### Russian Drones Injure Two Men and Ignite Warehouses in Kyiv Region\n\n18 sep 2026, 23:45\n\n### Trump Announces White House Ban on CNN, MS NOW and Politico\n\n18 sep 2026, 23:30\n\n### Budanov Says Ukraine Can Resist Russia’s Information Warfare\n\n18 sep 2026, 23:01\n\n### TypeSafe AI Unveils Jev, a Fast AI Model Built for Software Automation\n\n18 sep 2026, 23:00';
const MEZHA_TITLE = 'TypeSafe AI Unveils Jev, a Fast AI Model Built for Software Automation';

/** Captured from fixtures/sanity/sample4_upgrade_guide.json 来源 2（sanity.io changelog）片段 1：39 字符导航片段，短且无实词。 */
const SAMPLE4_NAV_SNIPPET = 'On this page\nInstallation and upgrading';

/** Captured from fixtures/sanity/sample4_upgrade_guide.json 来源 3（agent-skills.md）片段 0 与片段 2：片段 2 几乎整段包含于片段 0（RESEARCH 实测包含度 0.875）。 */
const SAMPLE4_SKILL_0 =
  "# Agent Skills: Sanity Studio upgrade planner\nProduces a tailored Sanity Studio upgrade plan by inspecting the repository's installed versions, config, and source, then reporting only the breaking changes that actually apply. Covers Studio v3 and later; v2 projects are identified and redirected, not planned. Use this skill whenever someone wants to upgrade, migrate, or modernize a Sanity Studio across one or more major versions from v3 onward, asks what will break if they bump the `sanity` package, asks why their Studio broke after an upgrade, or asks how far behind their Studio is";
const SAMPLE4_SKILL_2 =
  "**Name**: sanity-studio-upgrade\n**Description**: Produces a tailored Sanity Studio upgrade plan by inspecting the repository's installed versions, config, and source, then reporting only the breaking changes that actually apply. Covers Studio v3 and later; v2 projects are identified and redirected, not planned";
const SAMPLE4_SKILL_TITLE = 'Sanity Studio upgrade planner Skill';

/** query ∪ intent 实词集（步 3 的判定输入，取 default 夹具同形构造）。 */
const TERMS = contentTerms(
  'sanity studio upgrade guide',
  'current Sanity Studio (v6, sanity.config.ts based)'
);

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
    // 前缀表条目原文含 `##`；只归一化行会让它永远不命中（01-03-PLAN 行级剥离的坑）
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
    // 裸 startsWith 会把正常句子开头当样板删整行：Share/分享/广告/On this page/Sponsored
    // 都常出现在正文句首（审查问题 2 的六条真实反例）
    assert.equal(
      matchesPrefix('Shares of Nvidia fell 5% on Tuesday after weaker guidance.', ['Share']),
      false
    );
    assert.equal(
      matchesPrefix('SharePoint Online now supports the new API for list formatting.', ['Share']),
      false
    );
    assert.equal(
      matchesPrefix('分享一下我的 Claude Code hooks 配置，关键是 PostToolUse 的写法。', ['分享']),
      false
    );
    assert.equal(
      matchesPrefix('广告投放的新规则从下个月开始生效，涉及所有搜索引擎。', ['广告']),
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

  it('still matches whole-line entries, short prefixed lines and Chinese short lines', () => {
    // 独立样板行（整行相等，行末标点忽略）
    assert.equal(matchesPrefix('Share', ['Share']), true);
    assert.equal(matchesPrefix('Read next.', ['Read next']), true);
    assert.equal(matchesPrefix('Release time', ['Release Time:']), true);
    // 短行 + 英文词边界：'Share' 不吞 'Shares'/'SharePoint'
    assert.equal(matchesPrefix('Share this article', ['Share']), true);
    assert.equal(matchesPrefix('READ MORE: the full story', ['Read more']), true);
    // 中文表项只在短行命中（阈值远小于英文）
    assert.equal(matchesPrefix('分享到微博', ['分享']), true);
    assert.equal(matchesPrefix('相关阅读：往期回顾', ['相关阅读']), true);
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
      'Share\n\nAdvertisement\n\nWe use cookies',
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

describe('isShortWithoutTerms', () => {
  it('drops the sample4 navigation snippet (39 chars, no content term)', () => {
    assert.equal(isShortWithoutTerms(SAMPLE4_NAV_SNIPPET, TERMS, SHORT_SNIPPET_MAX), true);
  });

  it('respects the 199/200/201 boundary with String.length', () => {
    const terms = new Set(['word']);

    assert.equal(isShortWithoutTerms('x'.repeat(SHORT_SNIPPET_MAX - 1), terms), true);
    assert.equal(isShortWithoutTerms('x'.repeat(SHORT_SNIPPET_MAX), terms), false);
    assert.equal(isShortWithoutTerms('x'.repeat(SHORT_SNIPPET_MAX + 1), terms), false);
  });

  it('never deletes when the term set is empty (conservative)', () => {
    assert.equal(isShortWithoutTerms('any short snippet', new Set(), SHORT_SNIPPET_MAX), false);
  });

  it('treats empty text as short without terms', () => {
    assert.equal(isShortWithoutTerms('', TERMS, SHORT_SNIPPET_MAX), true);
  });

  it('keeps a short snippet that contains a content term', () => {
    assert.equal(
      isShortWithoutTerms('This mentions jev briefly', contentTerms('Jev'), SHORT_SNIPPET_MAX),
      false
    );
  });

  it('keeps a Chinese snippet whose terms are glued to Latin words', () => {
    // 分词曾把 "Sanity发布了v6版本" 整段粘成一个 token，query 实词 sanity/版本/发布
    // 全部匹配不上，这条含实词的中文短片段曾被判"短且无实词"删掉
    const terms = contentTerms('Sanity 版本 发布', 'What changed in the Sanity v6 release');
    assert.equal(
      isShortWithoutTerms('Sanity发布了v6版本，主要变化是配置文件迁移到新的格式。', terms),
      false
    );
  });
});

describe('isNearDuplicate', () => {
  /** 造 n 个不重复的 5-gram shingle 字符串。 */
  const sh = (prefix: string, n: number): Set<string> =>
    new Set(Array.from({ length: n }, (_, i) => `${prefix} ${i} ${i + 1} ${i + 2} ${i + 3}`));

  it('never judges either side with fewer than 8 shingles', () => {
    assert.equal(isNearDuplicate(sh('a', MIN_SHINGLES - 1), sh('a', MIN_SHINGLES)), false);
    assert.equal(isNearDuplicate(sh('a', MIN_SHINGLES), sh('a', MIN_SHINGLES - 1)), false);
  });

  it('drops a true duplicate (jaccard 1)', () => {
    const set = sh('s', MIN_SHINGLES);

    assert.equal(isNearDuplicate(new Set(set), set), true);
  });

  it('drops when the candidate is 80% covered by the survivor', () => {
    // 候选 10 个、幸存 15 个、交 8 → 候选被覆盖率 = 8/10 = NEAR_DUP_COVERAGE，条件取 >= → 删
    const candidate = new Set([...sh('c', 8), ...sh('c2', 2)]);
    const survivor = new Set([...sh('c', 8), ...sh('x', 7)]);

    assert.equal(candidate.size >= MIN_SHINGLES && survivor.size >= MIN_SHINGLES, true);
    assert.equal(isNearDuplicate(candidate, survivor), true);
    assert.equal(NEAR_DUP_COVERAGE, 0.8);
  });

  it('keeps a candidate that is a superset of the survivor', () => {
    // 审查问题 4：原 containment（交/min）口径下，后出现的超集（导语 + 扩展段）包含度
    // 恒为 1，信息更全的后一条被删。口径改为"候选自身被幸存者覆盖的比例"后，超集候选
    // 保留（14 个 shingle 的导语 + 20 个新 shingle → 覆盖率 14/34 ≈ 0.41）
    const lead = sh('lead', MIN_SHINGLES + 6);
    const longer = new Set([...sh('lead', MIN_SHINGLES + 6), ...sh('extra', 20)]);

    assert.equal(longer.size, 34);
    assert.equal(isNearDuplicate(longer, lead), false);
  });

  it('does not drop when both similarities sit below the thresholds', () => {
    // 候选与幸存各 10 个、交 7 → jaccard = 0.7 < 0.8 且覆盖率 = 0.7 < 0.8 → 保留。
    // 注：jaccard = 0.8 且覆盖率 < 0.8 的集合对数学上不存在（覆盖率 = 交/|候选| ≥ 交/并
    // = jaccard 恒成立），jaccard 分支是冗余保险；jaccard 语义本身由 tokenize.test.ts 锁住，
    // 这里锁双阈值之下的保留。
    const candidate = new Set([...sh('c', 7), ...sh('c-only', 3)]);
    const survivor = new Set([...sh('c', 7), ...sh('s-only', 3)]);

    assert.equal(isNearDuplicate(candidate, survivor), false);
    assert.equal(NEAR_DUP_JACCARD, 0.8);
  });

  it('drops the sample4 skill snippet against its own lead (containment 0.875)', () => {
    const candidate = shingles(tokenize(SAMPLE4_SKILL_2), SHINGLE_N);
    const survivor = shingles(tokenize(SAMPLE4_SKILL_0), SHINGLE_N);

    assert.equal(isNearDuplicate(candidate, survivor), true);
  });
});

// ---------------------------------------------------------------------------
// 第二十轮（2026-10-01 四类漏网）：标题重复行、引用块
//
// 以下合成片段按 2026-10-01 真实搜索样本（仓库外落盘）的漏网形态**改写**而成，
// 形状保真、正文不入库。GPT-6 审核 F2 修正后：标题行只在同片段出现 ≥2 次才剥
// （保留首次，唯一命中可能是面包屑后的正文 H1 或代码区域里的同名命令），署名残差
// 必须带署名/分隔记号；引用块复审 R1 收紧为"间隔号分段后除首段外全是 ≤20 码元的
// 无标点来源标签 + 条目 ≥2 整块统一"，摘要条目（含无句号与中文）整块保留；复审
// R2 后标题与引用共用代码区域识别（围栏字符/长度/闭栏规则 + 缩进代码）。乱码碎词
// 原型经审核证实误删真实代码与品牌名短句（F1），整条撤下未接入。
// ---------------------------------------------------------------------------

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
    // 正常页面片段以自己的 H1 开头是 2026-10 语料 114 个片段的形态，绝不碰
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

describe('stripBoilerplateLines — reference blocks (第二十轮)', () => {
  it('strips a heading plus its signature items and lets the orphan heading die downstream', () => {
    // my-ssl 形态：列表符 + 间隔号 + Accessed 月 年 的纯书目条目整块剥掉，
    // 剩下的孤立小节标题由短无实词兜底
    const snippet = [
      '## Next steps',
      '### Sources & References',
      '- Building a certificate authority for the whole Internet Cloudflare·Official·Accessed September 2026',
      '- Building a post-quantum certificate authority Cloudflare Investor Relations·Official·Accessed September 2026',
    ].join('\n');

    const { text } = stripBoilerplateLines(
      snippet,
      BOILERPLATE_PREFIXES,
      'Cloudflare Is Becoming a Certificate Authority'
    );

    assert.equal(text, '## Next steps');
  });

  it('keeps the whole block when an item carries a factual summary (audit F3)', () => {
    // 审核反例：条目本体含句读 = 有信息量的内容说明，格式签名证明不了它是占位符；
    // 拿不准就整块保留
    const snippet = [
      '### Sources & References',
      '- Cloudflare · The acquisition transfers an existing trust anchor; it does not automatically enable post-quantum browser certificates. · Accessed September 2026',
    ].join('\n');

    const { text } = stripBoilerplateLines(
      snippet,
      BOILERPLATE_PREFIXES,
      'Cloudflare Is Becoming a Certificate Authority'
    );

    assert.equal(text, snippet);
  });

  it('keeps summaries without an English period and Chinese summaries (复审 R1)', () => {
    // 复审反例：去掉英文句号、换成中文句读，信息量不变——句读判据之外的
    // 分段结构判据（长文本落在中间段）必须同样拦住
    const periodless = [
      '### Sources & References',
      '- Cloudflare · The acquisition transfers an existing trust anchor; it does not automatically enable post-quantum browser certificates · Accessed September 2026',
    ].join('\n');
    const chinese = [
      '### Sources & References',
      '- Cloudflare · 此次交易收购已有信任锚，不会自动启用后量子浏览器证书。 · Accessed September 2026',
    ].join('\n');

    assert.equal(
      stripBoilerplateLines(
        periodless,
        BOILERPLATE_PREFIXES,
        'Cloudflare Is Becoming a Certificate Authority'
      ).text,
      periodless
    );
    assert.equal(
      stripBoilerplateLines(
        chinese,
        BOILERPLATE_PREFIXES,
        'Cloudflare Is Becoming a Certificate Authority'
      ).text,
      chinese
    );
  });

  it('keeps the whole block when a uniform prefix block is followed by a summary item (复审 R1)', () => {
    // "整块保护"合同：先收集整块再决定——纯书目条目 + 带摘要条目混排时，
    // 标题行与纯书目条目不许被先行剥掉
    const snippet = [
      '### Sources & References',
      '- Building a certificate authority for the whole Internet Cloudflare·Official·Accessed September 2026',
      '- Cloudflare · The acquisition transfers an existing trust anchor; it does not automatically enable post-quantum browser certificates. · Accessed September 2026',
    ].join('\n');

    const { text } = stripBoilerplateLines(
      snippet,
      BOILERPLATE_PREFIXES,
      'Cloudflare Is Becoming a Certificate Authority'
    );

    assert.equal(text, snippet);
  });

  for (const [label, summaries] of [
    [
      '英文条件与依赖关系',
      [
        'Cloudflare must obtain browser approval before issuing classical certificates',
        'Post quantum certificate issuance remains dependent on client support',
      ],
    ],
    [
      '英文否定与限制',
      [
        'Purchasing a root does not automatically enable browser certificate issuance',
        'Classical certificates become available only after browser approval',
      ],
    ],
    ['中文无标点摘要', ['签发传统证书需要先取得浏览器批准', '后量子证书仍依赖客户端支持']],
  ] as const) {
    it(`保留首段含${label}的多条引用`, () => {
      const snippet = [
        '### Sources & References',
        ...summaries.map((summary) => `- ${summary} · Official · Accessed September 2026`),
      ].join('\n');

      assert.deepEqual(stripBoilerplateLines(snippet, BOILERPLATE_PREFIXES, 'CA evidence'), {
        text: snippet,
        emptied: false,
      });
    });
  }

  const twoReferences = [
    '### Sources & References',
    '- CA application Cloudflare·Official·Accessed September 2026',
    '- CA deployment guide Cloudflare·Official·Accessed September 2026',
  ];

  for (const [label, explanation] of [
    [
      '第三条含摘要',
      '- Cloudflare · The acquisition transfers an existing trust anchor; browser approval is still required. · Accessed September 2026',
    ],
    ['条目后有说明段', 'Browser approval is still required before certificate issuance.'],
    ['下级小节含说明', '#### Limits\nBrowser approval is still required.'],
  ]) {
    it(`两条纯书目后${label}时整块保留`, () => {
      const snippet = [...twoReferences, '', explanation].join('\n');

      assert.equal(
        stripBoilerplateLines(snippet, BOILERPLATE_PREFIXES, 'CA evidence').text,
        snippet
      );
    });
  }

  it('完整纯书目块在下一同级小节前结束，保留后续小节', () => {
    const nextSection = '### Deployment\nCloudflare still needs browser approval.';
    const snippet = [...twoReferences, '', nextSection].join('\n');

    assert.equal(
      stripBoilerplateLines(snippet, BOILERPLATE_PREFIXES, 'CA evidence').text,
      nextSection
    );
  });

  it('keeps a single-item reference block (复审 R1: 模板依据不足)', () => {
    // 一条条目构不成"统一模板列表"的证据，保守保留
    const snippet = [
      '### Sources & References',
      '- Building a certificate authority for the whole Internet Cloudflare·Official·Accessed September 2026',
    ].join('\n');

    const { text } = stripBoilerplateLines(
      snippet,
      BOILERPLATE_PREFIXES,
      'Cloudflare Is Becoming a Certificate Authority'
    );

    assert.equal(text, snippet);
  });

  it('keeps a reference example inside a code fence (复审 R2)', () => {
    // 围栏里的 Sources & References 示例是文档内容，标题与条目都不参与判定
    const snippet = [
      '```markdown',
      '### Sources & References',
      '- CA application Cloudflare·Official·Accessed September 2026',
      '- CA guide Cloudflare·Official·Accessed September 2026',
      '```',
    ].join('\n');

    const { text } = stripBoilerplateLines(
      snippet,
      BOILERPLATE_PREFIXES,
      'Cloudflare Is Becoming a Certificate Authority'
    );

    assert.equal(text, snippet);
  });

  it('leaves a heading alone when no item carries the reference signature', () => {
    // 无间隔号、无 accessed/年份的普通列表是真实内容，双条件不齐就不动
    const snippet = [
      '## Further reading',
      '- A deep essay about certificate lifetimes and revocation',
    ].join('\n');

    const { text } = stripBoilerplateLines(snippet, BOILERPLATE_PREFIXES, 'Some title');

    assert.equal(text, snippet);
  });
});
