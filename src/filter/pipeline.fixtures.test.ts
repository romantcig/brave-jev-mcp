/**
 * 十份手工标注夹具的 off 管道回归，核对逐步规则与最终输出。
 * 期望独立于本次运行输出；加载器兼容 wrapped、bare 与 noise 三种夹具形状。
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseFilterConfigObject } from './config.js';
import { splitJsonFragment } from './jsonld.js';
import { parseJevResponse } from './jev/client.js';
import { allQuestionKey } from './jev/context.js';
import { DEFAULT_JEV_MODEL, DEFAULT_THRESHOLDS, SOURCE_QUESTIONS } from './jev/questions.js';
import { filterLlmContext } from './pipeline.js';
import { zeroLocal } from './stats.js';
import type {
  BraveLlmContextResponse,
  ClassifyDeps,
  FilterRequest,
  JevAnswer,
  LocalStats,
  SnippetStats,
  SourceStats,
} from './types.js';

const fixtureRoot = fileURLToPath(new URL('../../fixtures/', import.meta.url));
const expectedRoot = join(fixtureRoot, 'expected');

/** 期望文件的一条 JSON-LD 标注。转换段的第一段以 `first_part_prefix` 开头。 */
type JsonldAnnotation = {
  url: string;
  snippet: number;
  action: 'converted' | 'dropped_meta';
  parts?: number;
  first_part_prefix?: string;
};

/** 片段级标注（预筛 / 去重 / 付费墙）；`snippet` 用整数索引，转换段用 `<index>.<part>`。 */
type PrefilterAnnotation = {
  url: string;
  snippet: number | string;
  action:
    | 'nav'
    | 'boilerplate'
    | 'boilerplate_stripped'
    | 'dup'
    | 'paywall_truncated'
    | 'paywall_empty';
  /** 被剥掉的那一行去掉前导标记与空白后的原文开头（仅 boilerplate_stripped）。 */
  stripped_prefix?: string;
  /** 剥后剩余文本的 String.length（仅 boilerplate_stripped）。 */
  stripped_length?: number;
};

/** 期望文件的 rules 节；每条标注由标注人按尺子手写。 */
type RuleAnnotations = {
  jsonld: JsonldAnnotation[];
  url_merge: { url: string; merged_from: number }[];
  prefilter: PrefilterAnnotation[];
  dedup: { url: string; snippet: number | string }[];
  feed_blocklist: { url: string; action: 'feed' | 'blocklist' }[];
  paywall: PrefilterAnnotation[];
  /** 步 8 归因：empty 表示空来源，rewrite 表示包含新颖度或跨源重复删除。 */
  empty_source: { url: string; action: 'empty' | 'rewrite' }[];
  /** 新颖度删除的片段。 */
  novelty: { url: string; snippet: number | string }[];
  /** 跨来源逐字重复删除的片段，reason 同为 dup。 */
  cross_source_dup: { url: string; snippet: number | string }[];
  budget: { dropped_sources: number; trimmed_snippets: number };
};

type ExpectedFixture = {
  fixture: string;
  query: string;
  intent: string;
  request: {
    maximum_number_of_urls?: number;
    maximum_number_of_tokens?: number;
    maximum_number_of_tokens_per_url?: number;
  };
  mode: 'off';
  note?: string;
  rules: RuleAnnotations;
  final: {
    urls: string[];
    kept_snippets: Record<string, (number | string)[]>;
    sources_keys: string[];
    sources_age: Record<string, string[]>;
    n_snippets: number;
    local: Partial<LocalStats>;
  };
};

/** 列举期望文件：递归 + 统一 `/` 分隔 + 排序，保证断言与遍历次序稳定。目录缺失返回空表，让清单用例在断言处失败。 */
const listExpectedFiles = (): string[] => {
  try {
    return readdirSync(expectedRoot, { recursive: true })
      .map((entry) => String(entry).split('\\').join('/'))
      .filter((entry) => entry.endsWith('.off.json'))
      .sort();
  } catch {
    return [];
  }
};

/** 按三种形状装载 Brave 夹具（RESEARCH「三种夹具形状」）。 */
const loadBraveFixture = (rel: string): BraveLlmContextResponse => {
  const parsed: unknown = JSON.parse(readFileSync(join(fixtureRoot, rel), 'utf8'));
  if (typeof parsed === 'object' && parsed !== null && 'response' in parsed) {
    return (parsed as { response: BraveLlmContextResponse }).response;
  }
  if (Array.isArray((parsed as BraveLlmContextResponse)?.grounding?.generic)) {
    return parsed as BraveLlmContextResponse;
  }
  const noise = parsed as {
    generic: BraveLlmContextResponse['grounding']['generic'][number];
    source?: BraveLlmContextResponse['sources'];
  };
  return {
    grounding: { generic: [noise.generic], map: [] },
    sources: noise.source ?? {},
  };
};

const offConfig = parseFilterConfigObject({});

const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/** 按 index + part 在统计表里找一行；找不到时让断言失败。 */
const findRow = (source: SourceStats, snippet: number | string): SnippetStats | undefined => {
  const [indexText, partText] =
    typeof snippet === 'string' ? snippet.split('.') : [String(snippet)];
  return source.snippets.find(
    (row) =>
      row.index === Number(indexText) &&
      (partText === undefined ? row.part === undefined : row.part === Number(partText))
  );
};

// ---------------------------------------------------------------------------
// 期望文件清单门禁：数量变化时失败，防止期望文件被静默增删。
// ---------------------------------------------------------------------------

describe('expected fixture inventory', () => {
  it('has exactly ten annotated expectation files', () => {
    assert.equal(listExpectedFiles().length, 10, 'expected fixture files missing');
  });
});

// ---------------------------------------------------------------------------
// 每份期望文件一个 describe：闭包一次过滤结果，规则级 + 整卷逐条断言。
// ---------------------------------------------------------------------------

for (const rel of listExpectedFiles()) {
  const parsed = JSON.parse(readFileSync(join(expectedRoot, rel), 'utf8')) as ExpectedFixture;
  // 允许旧期望省略新颖度和跨源去重小节，缺失时按空数组读取。
  const expected: ExpectedFixture = {
    ...parsed,
    rules: {
      ...parsed.rules,
      novelty: parsed.rules.novelty ?? [],
      cross_source_dup: parsed.rules.cross_source_dup ?? [],
    },
  };
  const data = loadBraveFixture(expected.fixture);
  // 模块求值时取得一次异步管道结果，供 describe 中的断言共享。
  const { result, stats } = await filterLlmContext(
    data,
    { params: { query: expected.query, ...expected.request }, intent: expected.intent },
    offConfig
  );

  describe(`off mode · ${expected.fixture}`, () => {
    const sourceStats = (url: string): SourceStats => {
      const source = stats.sources.find((entry) => entry.url === url);
      assert.ok(source, `source ${url} missing from stats table`);
      return source;
    };

    /** 幸存片段的最终文本：按统计表的幸存序映射回 result 的 snippets。 */
    const survivingText = (url: string, snippet: number | string): string => {
      const source = sourceStats(url);
      const row = findRow(source, snippet);
      assert.ok(row, `snippet ${snippet} of ${url} not found in stats`);
      assert.ok(row.kept, `snippet ${snippet} of ${url} did not survive`);
      const position = source.snippets.filter((entry) => entry.kept).indexOf(row);
      const genericItem = result.grounding.generic.find((entry) => entry.url === url);
      assert.ok(genericItem, `source ${url} missing from output`);
      return genericItem.snippets[position];
    };

    // ---- 规则级：每条手工标注一个具名用例 -------------------------------

    for (const item of expected.rules.jsonld) {
      it(`jsonld · ${hostOf(item.url)} #${item.snippet} ${item.action}`, () => {
        const source = sourceStats(item.url);
        const rows = source.snippets.filter((row) => row.index === item.snippet);
        assert.ok(rows.length > 0, `snippet #${item.snippet} not found for ${item.url}`);
        if (item.action === 'converted') {
          assert.equal(rows.length, item.parts);
          rows.forEach((row, part) => {
            assert.equal(row.part, part, 'converted parts must run 0..k in order');
          });
          // 直接对原片段核对 JSON-LD 转换；后续删除另行断言，避免转换测试依赖最终幸存。
          const rawItem = loadBraveFixture(expected.fixture).grounding.generic.find(
            (entry) => entry.url === item.url
          );
          const rawSnippet = rawItem?.snippets[item.snippet];
          assert.ok(
            typeof rawSnippet === 'string',
            `raw snippet #${item.snippet} of ${item.url} not found in fixture`
          );
          const split = splitJsonFragment(rawSnippet, rawItem?.title ?? '');
          assert.equal(split.action, 'converted');
          if (split.action === 'converted') {
            assert.ok(
              split.parts[0].startsWith(`${item.first_part_prefix}`),
              `first part should start with "${item.first_part_prefix}", got "${split.parts[0].slice(0, 60)}"`
            );
          }
        } else {
          assert.equal(rows.length, 1);
          assert.equal(rows[0].kept, false);
          assert.equal(rows[0].reason, 'jsonld_meta');
        }
      });
    }

    for (const item of expected.rules.prefilter) {
      it(`prefilter · ${hostOf(item.url)} #${item.snippet} ${item.action}`, () => {
        const source = sourceStats(item.url);
        const row = findRow(source, item.snippet);
        assert.ok(row, `snippet ${item.snippet} not found for ${item.url}`);
        if (item.action === 'boilerplate_stripped') {
          // 改写类：片段仍在输出里，但样板行确实被剥掉了，长度等于剥后值
          assert.equal(row.kept, true, 'stripped snippet must survive');
          const text = survivingText(item.url, item.snippet);
          assert.ok(
            !text.startsWith(`${item.stripped_prefix}`),
            'surviving text must not start with the stripped boilerplate line'
          );
          assert.equal(text.length, item.stripped_length);
        } else if (item.action === 'nav') {
          assert.equal(row.kept, false);
          assert.equal(row.reason, 'nav');
        } else if (item.action === 'boilerplate') {
          assert.equal(row.kept, false);
          assert.equal(row.reason, 'boilerplate');
        } else {
          // 重复与付费墙动作有独立标注节，放错节时必须失败。
          assert.fail(`unexpected prefilter action: ${item.action}`);
        }
      });
    }

    for (const item of expected.rules.dedup) {
      it(`dedup · ${hostOf(item.url)} #${item.snippet} dup`, () => {
        const row = findRow(sourceStats(item.url), item.snippet);
        assert.ok(row, `snippet ${item.snippet} not found for ${item.url}`);
        assert.equal(row.kept, false);
        assert.equal(row.reason, 'dup');
      });
    }

    for (const item of expected.rules.feed_blocklist) {
      it(`step4 · ${hostOf(item.url)} ${item.action}`, () => {
        const source = sourceStats(item.url);
        assert.equal(source.verdict, 'drop');
        assert.equal(source.reason, item.action);
      });
    }

    for (const item of expected.rules.paywall) {
      it(`paywall · ${hostOf(item.url)} #${item.snippet} ${item.action}`, () => {
        const row = findRow(sourceStats(item.url), item.snippet);
        assert.ok(row, `snippet ${item.snippet} not found for ${item.url}`);
        assert.equal(
          row.truncated,
          item.action.startsWith('paywall'),
          'both paywall actions truncate'
        );
        assert.equal(
          row.kept,
          item.action === 'paywall_truncated',
          'only truncations survive; paywall_empty rows are dropped'
        );
        if (item.action === 'paywall_empty') assert.equal(row.reason, 'paywall_empty');
      });
    }

    for (const item of expected.rules.empty_source) {
      it(`step8 · ${hostOf(item.url)} ${item.action}`, () => {
        const source = sourceStats(item.url);
        assert.equal(source.verdict, 'drop');
        // 区分空来源与包含新颖度或跨源重复删除的 rewrite。
        assert.equal(source.reason, item.action);
      });
    }

    for (const item of expected.rules.novelty) {
      it(`novelty · ${hostOf(item.url)} #${item.snippet}`, () => {
        const row = findRow(sourceStats(item.url), item.snippet);
        assert.ok(row, `snippet ${item.snippet} not found for ${item.url}`);
        assert.equal(row.kept, false);
        assert.equal(row.reason, 'novelty');
      });
    }

    for (const item of expected.rules.cross_source_dup) {
      it(`cross_source_dup · ${hostOf(item.url)} #${item.snippet}`, () => {
        const row = findRow(sourceStats(item.url), item.snippet);
        assert.ok(row, `snippet ${item.snippet} not found for ${item.url}`);
        assert.equal(row.kept, false);
        assert.equal(row.reason, 'dup');
      });
    }

    it('budget · counters', () => {
      assert.equal(stats.local.budget_dropped_sources, expected.rules.budget.dropped_sources);
      assert.equal(stats.local.budget_trimmed_snippets, expected.rules.budget.trimmed_snippets);
    });

    // ---- 整卷：顺序、sources 精简、计数对账 ----------------------------

    it('keeps Brave order', () => {
      assert.deepEqual(
        result.grounding.generic.map((item) => item.url),
        expected.final.urls
      );
    });

    it('keeps only surviving snippet indices in order', () => {
      for (const [url, indices] of Object.entries(expected.final.kept_snippets)) {
        const source = sourceStats(url);
        const surviving = source.snippets
          .filter((row) => row.kept)
          .map((row) => (row.part === undefined ? row.index : `${row.index}.${row.part}`));
        assert.deepEqual(surviving, indices, `surviving indices of ${url}`);
      }
    });

    it('trims sources to title/hostname/age', () => {
      const union = new Set<string>();
      for (const meta of Object.values(result.sources)) {
        for (const key of Object.keys(meta)) {
          union.add(key);
          assert.ok(['title', 'hostname', 'age'].includes(key), `unexpected source key ${key}`);
        }
      }
      assert.deepEqual([...union].sort(), expected.final.sources_keys.slice().sort());
    });

    it('keeps a single ISO date per source age', () => {
      for (const [url, age] of Object.entries(expected.final.sources_age)) {
        assert.deepEqual(result.sources[url]?.age, age, `age of ${url}`);
      }
      for (const [url, meta] of Object.entries(result.sources)) {
        if (!Object.hasOwn(expected.final.sources_age, url)) {
          assert.equal(Object.hasOwn(meta, 'age'), false, `unexpected age on ${url}`);
        }
      }
    });

    it('output scale matches', () => {
      assert.equal(stats.output.n_sources, expected.final.urls.length);
      assert.equal(stats.output.n_snippets, expected.final.n_snippets);
    });

    it('local counters match (novelty details asserted separately)', () => {
      // 计数与 novelty 明细分开核对；期望文件不写指纹清单，明细形状由下一用例验证。
      const expectedLocal: Record<string, unknown> = {
        ...zeroLocal,
        ...expected.final.local,
      };
      const actualLocal: Record<string, unknown> = { ...stats.local };
      delete expectedLocal.novelty;
      delete actualLocal.novelty;
      assert.deepEqual(actualLocal, expectedLocal);
    });

    it('novelty details cover exactly the sources that lost snippets to novelty', () => {
      // 条目集合 == 发生 novelty 片段删除的来源集合（src 对应统计表 index）
      const expectedSrcs = stats.sources
        .filter((source) => source.snippets.some((row) => !row.kept && row.reason === 'novelty'))
        .map((source) => `s${source.index}`)
        .sort();
      const actualSrcs = stats.local.novelty.map((entry) => entry.src).sort();
      assert.deepEqual(actualSrcs, expectedSrcs, 'novelty detail sources');

      // 发生新颖度删除时必须有明细；novel 可为空，表示相对参照集合没有新增指纹。
      // 没有新颖度删除时明细应为空。
      if (stats.local.novelty_removed > 0) {
        assert.ok(stats.local.novelty.length > 0, 'novelty details must exist');
        for (const entry of stats.local.novelty) {
          assert.ok(entry.fp_total >= 1, `fp_total of ${entry.src}`);
          assert.ok(Array.isArray(entry.novel), `novel of ${entry.src}`);
        }
      } else {
        assert.deepEqual(stats.local.novelty, []);
      }
    });
  });
}

// 真实夹具的小预算裁剪。

describe('budget trimming on a real fixture', () => {
  const data = loadBraveFixture('jev_release_default.json');
  const query = 'Jev TypeSafe AI model release';
  const intent = 'What TypeSafe released with the Jev model and how it works';
  const braveUrls = data.grounding.generic.map((item) => item.url);

  it('keeps the first five sources in Brave order and trims from the tail', async () => {
    // 设置 2 倍抓取使步 9 生效；2400 token 预算低于本地过滤后的内容，确保触发裁剪。
    const { result, stats } = await filterLlmContext(
      data,
      { params: { query, maximum_number_of_urls: 5, maximum_number_of_tokens: 2400 }, intent },
      {
        mode: 'off',
        overfetchFactor: 2,
        blocklist: new Set(),
        thresholds: { ...DEFAULT_THRESHOLDS },
        jev: {
          model: DEFAULT_JEV_MODEL,
          timeoutMs: 15000,
          concurrency: 12,
        },
        logDir: join(homedir(), '.brave-jev', 'logs'),
      }
    );

    assert.deepEqual(
      result.grounding.generic.map((item) => item.url),
      braveUrls.slice(0, 5)
    );
    assert.equal(stats.local.budget_dropped_sources, braveUrls.length - 5);
    assert.ok(stats.local.budget_trimmed_snippets > 0, 'token budget must trim something');
    assert.ok(stats.output.est_tokens <= 2400, 'output must fit the token budget');

    // 前四源不受 token 裁剪影响；第 5 源从末尾开始裁
    for (const url of braveUrls.slice(0, 4)) {
      const source = stats.sources.find((entry) => entry.url === url);
      assert.ok(source, `source ${url} missing from stats`);
      assert.equal(
        source.snippets.some((row) => row.reason === 'budget'),
        false,
        `source ${url} must keep all its snippets`
      );
    }
    const fifth = stats.sources.find((entry) => entry.url === braveUrls[4]);
    assert.ok(fifth, 'fifth source missing from stats');
    const surviving = fifth.snippets.filter((row) => row.kept).map((row) => row.index);
    const all = fifth.snippets.map((row) => row.index);
    assert.deepEqual(surviving, all.slice(0, surviving.length), 'trimming must drop tail snippets');
    assert.ok(surviving.length < all.length, 'the fifth source must lose snippets');
  });
});

// 核对 empty 与 rewrite 的独立计数，避免将转述删除误记为空来源。

describe('no fixture is dropped as empty', () => {
  for (const fixture of ['jev_release_default.json', 'jev_release_strict.json']) {
    it(`${fixture} drops no source as empty in off mode`, async () => {
      const data = loadBraveFixture(fixture);
      const { result, stats } = await filterLlmContext(
        data,
        {
          params: { query: 'Jev TypeSafe AI model release' },
          intent: 'What TypeSafe released with the Jev model and how it works',
        },
        offConfig
      );
      assert.equal(stats.local.empty_dropped, 0);
      const rewriteDropped = stats.sources.filter(
        (source) => source.verdict === 'drop' && source.reason === 'rewrite'
      ).length;
      assert.equal(result.grounding.generic.length, data.grounding.generic.length - rewriteDropped);
    });
  }
});

// 同输入和固定回答下，test/on 的过滤结果与统计应相等，并与 off 有预期差异。
// 现有两份录制没有整源 Jev drop，不用空集合断言声称覆盖了该行为。

const isRecordValue = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** 录制装载（与 client.test.ts / dev/compare.ts 同形）。 */
const loadRecording = (rel: string): Record<string, { http: number; response: unknown }> => {
  const parsed: unknown = JSON.parse(readFileSync(join(fixtureRoot, rel), 'utf8'));
  assert.ok(isRecordValue(parsed) && isRecordValue(parsed.results), `${rel} has no results table`);
  return parsed.results as Record<string, { http: number; response: unknown }>;
};

/**
 * 固定回答桩：按候选 ID 和当前题键投影历史录制，不代表新题的真实回答。
 * 片段数与录制不一致时整源不给评分，避免按压缩位置错配。
 * 不带 dispatch，计零实发；合成 input_tokens 为 0，usage_complete 为 false。
 */
const replayClassifier =
  (results: Record<string, { http: number; response: unknown }>): ClassifyDeps['classify'] =>
  async ({ state, questions }) => {
    const answers: Record<string, JevAnswer> = {};
    for (const source of state.sources) {
      const entry = results[source.id];
      if (!entry || entry.http !== 200) continue;
      const parsed = parseJevResponse(entry.http, JSON.stringify(entry.response));
      if (!parsed.ok) continue;
      const recorded = parsed.answers;
      // 来源级：按当前题库的来源级键查录制值，再按生产连接符映射到全局题键
      // （如 s0 的 is_off_topic → s0__is_off_topic）；录制缺键时缺答保守
      for (const localKey of Object.keys(SOURCE_QUESTIONS)) {
        const answer = recorded[localKey];
        if (answer?.kind === 'noul') answers[allQuestionKey(source.id, localKey)] = answer;
      }
      // 片段级：当前片段数与录制 snip 键数一致才按位置映射，否则整体缺答
      const recordedSnipCount = Object.keys(recorded).filter((key) => /^snip\d+$/.test(key)).length;
      if (recordedSnipCount === source.snippets.length) {
        for (let i = 0; i < source.snippets.length; i += 1) {
          const answer = recorded[`snip${i}`];
          if (answer?.kind === 'score') answers[allQuestionKey(source.id, `snip${i}`)] = answer;
        }
      }
    }
    return {
      status: 'answered',
      model: 'fixture-replay',
      answers,
      input_tokens: 0,
      usage_complete: false,
    };
  };

/** 期望文件头三件套（回放与 off 期望同参数，管道夹具测试同口径）。 */
const loadExpectedHeader = (
  rel: string
): { query: string; intent: string; request: Omit<FilterRequest, 'query'> } => {
  const parsed: unknown = JSON.parse(readFileSync(join(expectedRoot, rel), 'utf8'));
  assert.ok(isRecordValue(parsed), `${rel} is not an object`);
  return {
    query: parsed.query as string,
    intent: parsed.intent as string,
    request: parsed.request as Omit<FilterRequest, 'query'>,
  };
};

/** 由两次结果的来源统计推导 test 相对 off 的身份差集。 */
const deriveTestDiff = (
  offSources: SourceStats[],
  testSources: SourceStats[]
): {
  would_drop: string[];
  would_remove_snippets: number;
  would_restore: string[];
  would_restore_snippets: number;
} => {
  const offByIndex = new Map(offSources.map((source) => [source.index, source]));
  const wouldDrop: string[] = [];
  let wouldRemoveSnippets = 0;
  const wouldRestore: string[] = [];
  let wouldRestoreSnippets = 0;
  for (const testSource of testSources) {
    const offSource = offByIndex.get(testSource.index);
    assert.ok(offSource, `source ${testSource.index} missing from the off run`);
    if (offSource.verdict === 'keep' && testSource.verdict === 'drop') {
      wouldDrop.push(`s${testSource.index}`);
      continue;
    }
    if (offSource.verdict === 'drop' && testSource.verdict === 'keep') {
      wouldRestore.push(`s${testSource.index}`);
      continue;
    }
    if (offSource.verdict !== 'keep' || testSource.verdict !== 'keep') continue;
    const offKept = new Map(
      offSource.snippets.map((row) => [
        row.part === undefined ? String(row.index) : `${row.index}.${row.part}`,
        row.kept,
      ])
    );
    for (const testRow of testSource.snippets) {
      const key =
        testRow.part === undefined ? String(testRow.index) : `${testRow.index}.${testRow.part}`;
      if (!testRow.kept && offKept.get(key) === true) wouldRemoveSnippets += 1;
      if (testRow.kept && offKept.get(key) === false) wouldRestoreSnippets += 1;
    }
  }
  return {
    would_drop: wouldDrop,
    would_remove_snippets: wouldRemoveSnippets,
    would_restore: wouldRestore,
    would_restore_snippets: wouldRestoreSnippets,
  };
};

/** test 相对 off 被删片段的逐 URL 身份（`<url>#<index>`，转换段为 `<url>#<index>.<part>`）：仅统计两链都保留的来源里 off 幸存、test 删除的片段。 */
const deriveRemovedSnippetIds = (
  offSources: SourceStats[],
  testSources: SourceStats[]
): string[] => {
  const offByUrl = new Map(offSources.map((source) => [source.url, source]));
  const removed: string[] = [];
  for (const testSource of testSources) {
    if (testSource.verdict !== 'keep') continue;
    const offSource = offByUrl.get(testSource.url);
    if (offSource === undefined || offSource.verdict !== 'keep') continue;
    const offKept = new Map(
      offSource.snippets.map((row) => [
        row.part === undefined ? String(row.index) : `${row.index}.${row.part}`,
        row.kept,
      ])
    );
    for (const testRow of testSource.snippets) {
      const key =
        testRow.part === undefined ? String(testRow.index) : `${testRow.index}.${testRow.part}`;
      if (!testRow.kept && offKept.get(key) === true) removed.push(`${testSource.url}#${key}`);
    }
  }
  return removed;
};

/**
 * test 相对 off 的固定差集期望。两者按相同 Brave 原序去重，
 * 差异来自 Jev 来源裁决、片段评分和论证保护。
 */
const TEST_DIFF_EXPECTED: Record<
  string,
  {
    would_drop: string[];
    would_remove_snippets: number;
    would_restore: string[];
    would_restore_snippets: number;
  }
> = {
  jev_release_default: {
    would_drop: [],
    would_remove_snippets: 9,
    would_restore: [],
    would_restore_snippets: 9,
  },
  jev_release_strict: {
    would_drop: [],
    would_remove_snippets: 2,
    would_restore: [],
    would_restore_snippets: 4,
  },
};

// default 夹具 test 相对 off 的 9 条片段删减逐 URL 身份——与 dev/smoke_stdio.ts
// const 区的差集注释互指同步（off−on 删 9 = typesafe.ai#4/#5/#6/#7、ua.news#1/#4/#6、
// mezha#0/#2）。改动任一侧时必须同步另一侧。
const TEST_REMOVED_SNIPPET_IDS: Record<string, string[]> = {
  jev_release_default: [
    'https://typesafe.ai/blog/introducing-system-one-models-and-jev#4',
    'https://typesafe.ai/blog/introducing-system-one-models-and-jev#5',
    'https://typesafe.ai/blog/introducing-system-one-models-and-jev#6',
    'https://typesafe.ai/blog/introducing-system-one-models-and-jev#7',
    'https://ua.news/en/technologies/typesafe-predstaviv-model-jev-dlia-avtomatizatsiyi-pz-techcrunch#1',
    'https://ua.news/en/technologies/typesafe-predstaviv-model-jev-dlia-avtomatizatsiyi-pz-techcrunch#4',
    'https://ua.news/en/technologies/typesafe-predstaviv-model-jev-dlia-avtomatizatsiyi-pz-techcrunch#6',
    'https://mezha.net/eng/news/d559e594_typesafe_ai_unveils/#0',
    'https://mezha.net/eng/news/d559e594_typesafe_ai_unveils/#2',
  ],
};

for (const stem of ['jev_release_default', 'jev_release_strict']) {
  const recording = loadRecording(`${stem}.jev.json`);
  const expected = loadExpectedHeader(`${stem}.off.json`);
  const fixtureRequest = {
    params: { ...expected.request, query: expected.query },
    intent: expected.intent,
  };

  // 顶层 await：三模式各跑一次，describe 闭包共享（node:test 等模块求值完成后开跑）
  const offRun = await filterLlmContext(
    loadBraveFixture(`${stem}.json`),
    fixtureRequest,
    offConfig
  );
  // testRun 的注入桩带调用计数：验证一次共享请求覆盖全部候选（任务 E 固定回答契约）
  let classifyCalls = 0;
  let classifiedSourceCount = 0;
  const innerClassify = replayClassifier(recording);
  const testRun = await filterLlmContext(
    loadBraveFixture(`${stem}.json`),
    fixtureRequest,
    { ...offConfig, mode: 'test' },
    {
      classify: async (req) => {
        classifyCalls += 1;
        classifiedSourceCount = req.state.sources.length;
        return innerClassify(req);
      },
    }
  );
  const onRun = await filterLlmContext(
    loadBraveFixture(`${stem}.json`),
    fixtureRequest,
    { ...offConfig, mode: 'on' },
    { classify: replayClassifier(recording) }
  );

  describe(`test equals on · ${stem}`, () => {
    it('returns a result identical to the on run field by field', () => {
      assert.deepEqual(testRun.result, onRun.result);
    });

    it('records stats.local identical to the on run', () => {
      assert.deepEqual(testRun.stats.local, onRun.stats.local);
    });

    it('records stats.sources identical to the on run', () => {
      assert.deepEqual(testRun.stats.sources, onRun.stats.sources);
    });

    it('sends one shared request covering every candidate and books verdict/reason in per_source', () => {
      // 一次共享请求：classify 恰被调用一次、载荷带全部候选（§3.1）；纯回答注入
      // 不带 dispatch（§3.3）→ n_requests 计零实发，per_source 行仍逐来源记账
      assert.equal(classifyCalls, 1, 'classify must be called exactly once per filter run');
      assert.equal(
        classifiedSourceCount,
        Object.keys(recording).length,
        'the shared request must cover every candidate'
      );
      assert.equal(
        testRun.stats.jev?.n_requests,
        0,
        'pure answer injection without dispatch books zero requests (§3.3)'
      );
      const rows = testRun.stats.jev?.per_source ?? [];
      assert.equal(rows.length, Object.keys(recording).length);
      for (const row of rows) {
        assert.ok(
          row.verdict === 'keep' || row.verdict === 'drop',
          `${row.src} must carry a verdict`
        );
        if (row.verdict === 'drop') {
          assert.ok(typeof row.reason === 'string', `${row.src} drop must carry a reason`);
        }
      }
    });

    it('derives the test-vs-off diff from the off and test tables (verdicts really apply)', () => {
      // Jev 裁决真实生效的判别力：裁决不生效（旧 shadow"只算不丢"）时 test 正本走
      // off 链，差集恒为 0，与这里的 9/9、2/4 不等。filter-rules-5 起播种序 Brave 化，
      // 差异只剩裁决/评分/论证保护通道（值随 TEST_DIFF_EXPECTED 注释重标定）
      assert.deepEqual(
        deriveTestDiff(offRun.stats.sources, testRun.stats.sources),
        TEST_DIFF_EXPECTED[stem]
      );
    });

    if (stem === 'jev_release_default') {
      it('pins the per-URL identity of the 9 snippets test removes relative to off', () => {
        assert.deepEqual(
          deriveRemovedSnippetIds(offRun.stats.sources, testRun.stats.sources),
          TEST_REMOVED_SNIPPET_IDS[stem]
        );
      });
    }

    if (stem === 'jev_release_strict') {
      it('no longer rescues s11 (therundown): with identity seeding gone test matches off', () => {
        // filter-rules-4 时 test 按 is_primary 播种让当事方 s11 抢先幸存、救回整源；
        // filter-rules-5 起播种序 Brave 化，s11 与 Brave 在前的同事实来源同序比较、
        // 仍被指纹新颖度删光——off 与 test 同判 rewrite（重复的代表来源随排序取消
        // 而变化：Brave 在前的来源先参与去重，见 notes/dedup-and-rewrite-policy.md）
        const s11Url = 'https://www.therundown.ai/news/typesafe-jev-ai-decisions-software';
        const offRow = offRun.stats.sources.find((source) => source.url === s11Url);
        const testRow = testRun.stats.sources.find((source) => source.url === s11Url);
        assert.equal(offRow?.verdict, 'drop');
        assert.equal(offRow?.reason, 'rewrite');
        assert.equal(testRow?.verdict, 'drop', 'test must match off after seeding change');
        assert.equal(testRow?.reason, 'rewrite');
        assert.equal(
          testRun.result.grounding.generic.some((item) => item.url === s11Url),
          false,
          's11 must be absent from the test result too'
        );
      });
    }
  });
}
