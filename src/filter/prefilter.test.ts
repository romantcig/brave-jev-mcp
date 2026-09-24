import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { normalizeTitleForCompare } from './jsonld.js';
import { BOILERPLATE_PREFIXES } from './markers.js';
import {
  isNearDuplicate,
  isShortWithoutTerms,
  isTitleOnly,
  matchesPrefix,
  MIN_SHINGLES,
  NEAR_DUP_CONTAINMENT,
  NEAR_DUP_JACCARD,
  normalizeLine,
  SHINGLE_N,
  SHORT_SNIPPET_MAX,
  stripBoilerplateLines,
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

  it('drops when containment is exactly 0.8', () => {
    // 候选 15 个、幸存 10 个、交 8 → containment = 8/10 = NEAR_DUP_CONTAINMENT，条件取 >= → 删
    const candidate = new Set([...sh('c', 8), ...sh('c2', 7)]);
    const survivor = new Set([...sh('c', 8), ...sh('x', 2)]);

    assert.equal(candidate.size >= MIN_SHINGLES && survivor.size >= MIN_SHINGLES, true);
    assert.equal(isNearDuplicate(candidate, survivor), true);
    assert.equal(NEAR_DUP_CONTAINMENT, 0.8);
  });

  it('does not drop when both similarities sit below the thresholds', () => {
    // 候选与幸存各 10 个、交 7 → jaccard = 0.7 < 0.8 且 containment = 0.7 < 0.8 → 保留。
    // 注：jaccard = 0.8 且 containment < 0.8 的集合对数学上不存在（containment = 交/min
    // ≥ 交/max ≥ 交/并 = jaccard 恒成立），jaccard 分支是冗余保险；"恰 0.8 不删"的严格
    // > 语义由 tokenize.test.ts 对 jaccard 本身的用例锁住，这里锁双阈值之下的保留。
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

  it('keeps a containment of 0.7 between real-size snippets', () => {
    // 候选与幸存各 10 个 shingle、交 7 → containment = 0.7 < 0.8 → 保留
    const candidate = new Set([...sh('c', 7), ...sh('c-only', 3)]);
    const survivor = new Set([...sh('c', 7), ...sh('s-only', 3)]);

    assert.equal(isNearDuplicate(candidate, survivor), false);
  });
});
