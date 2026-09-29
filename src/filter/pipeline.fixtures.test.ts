/**
 * 夹具驱动的逐条断言：十份 fixtures/expected/ 下的 .off.json 手工标注期望，
 * 对 `off` 模式管道做规则级与整卷两级对账（RULES-09）。
 * （注释里不写 `**` 开头的 glob——块注释会被 `*` 与 `/` 相邻构成的终止符截断。）
 *
 * 期望文件是按 notes/labeling-rubric.md 的问法**手工标注**的产物，不是运行输出
 * 的抄录；实现与标注不一致时，按尺子判规则错还是标注漏，两侧改到一致。
 *
 * 夹具三种形状的加载器按 01-RESEARCH.md「三种夹具形状」落地：wrapped（`response`
 * 键）、bare（`grounding.generic` 数组）、noise（`generic` 单对象 + `source` 单数）。
 * 加载器放在本文件内，不另建 `src/testUtils/`——保证 `src/` 除三处上游改动外
 * 只有 `src/filter/` 的新增文件（成功标准 1 / A21）。
 *
 * 依据：01-04-PLAN Task 2、01-RESEARCH.md「夹具与期望文件策略」、A19/A20。
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
import { DEFAULT_JEV_MODEL, DEFAULT_THRESHOLDS } from './jev/questions.js';
import { filterLlmContext } from './pipeline.js';
import { zeroLocal } from './stats.js';
import type {
  BraveLlmContextResponse,
  ClassifyDeps,
  FilterRequest,
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
  /** 步 8 空来源规则：'empty' 为本地原因清空，'rewrite' 为新颖度/跨源 dup 删光（02-04）。 */
  empty_source: { url: string; action: 'empty' | 'rewrite' }[];
  /** 步 7 后半被事实指纹新颖度删除的片段（02-04）。 */
  novelty: { url: string; snippet: number | string }[];
  /** 步 7 后半被跨来源 5-gram 逐字重复删除的片段（02-04；片段 reason 同 'dup' 键）。 */
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
  // 02-04 起新增 novelty / cross_source_dup 两节；过渡期期望文件缺节按空数组兼容
  // （两组循环零跳过零失败），Task 3 重标注后逐条生效
  const expected: ExpectedFixture = {
    ...parsed,
    rules: {
      ...parsed.rules,
      novelty: parsed.rules.novelty ?? [],
      cross_source_dup: parsed.rules.cross_source_dup ?? [],
    },
  };
  const data = loadBraveFixture(expected.fixture);
  // filterLlmContext 自 02-02 起异步：在模块顶层 await 一次结果，describe 闭包共享
  // （node:test 等模块求值完成后才开跑，顶层 await 不影响收集）
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
          // 步 1 只负责转换；个别段被步 3 再删由该节的 nav 标注单独断言（sample3 4.3/4.4），
          // 被步 7 新颖度/跨源 dup 再删由 novelty / cross_source_dup 两节单独断言（02-04）。
          // 转换内容对原始夹具文本直调同一 splitJsonFragment 验证——不依赖幸存，
          // 步 1 的验证力不因步 7 的删除而减弱。
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
          // dup / paywall_* 有自己的节（dedup、paywall）；标注放错节时必须当场报错，
          // 不能静默通过（审查测试缺口 14）
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
        // 'empty' = 本地原因清空；'rewrite' = 新颖度/跨源 dup 删光（02-04 归因）
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
      // D-10 起零值与实际值都带 novelty 明细数组：计数断言剔除该键逐条比对，
      // 明细的形状与覆盖由下一条用例独立锁定（期望文件不写指纹列表——零指纹污染）
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

      // A3 语义：novelty_removed > 0 时条目存在、fp_total >= 1（纯重复来源触发
      // 删除但对指纹并集零新贡献时 novel 为空数组是合法形态，不对 novel 设下限）；
      // novelty_removed === 0 时明细为空数组
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

// ---------------------------------------------------------------------------
// 裁剪正例：真实夹具加小预算（A2-a）。
// ---------------------------------------------------------------------------

describe('budget trimming on a real fixture', () => {
  const data = loadBraveFixture('jev_release_default.json');
  const query = 'Jev TypeSafe AI model release';
  const intent = 'What TypeSafe released with the Jev model and how it works';
  const braveUrls = data.grounding.generic.map((item) => item.url);

  it('keeps the first five sources in Brave order and trims from the tail', async () => {
    // 步 9 只在超量倍数 > 1 时执行（倍数 1 时 Brave 已按请求上限返回，估算裁剪只会
    // 误砍——审查问题 6）；这里用 2x 超量抓取后按模型原始请求（5 源 / 2400 token）裁回。
    // 预算从 Phase 1 的 3000 降到 2400：02-04 起步 7 新颖度先清掉低新颖度片段，
    // 首 5 源幸存内容 ≈2670 token，3000 不再触发裁剪（2400 落在第 5 源区间内）。
    const { result, stats } = await filterLlmContext(
      data,
      { params: { query, maximum_number_of_urls: 5, maximum_number_of_tokens: 2400 }, intent },
      {
        mode: 'off',
        overfetchFactor: 2,
        blocklist: new Set(),
        thresholds: { ...DEFAULT_THRESHOLDS },
        jev: { model: DEFAULT_JEV_MODEL, timeoutMs: 15000, concurrency: 12 },
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

// ---------------------------------------------------------------------------
// off 模式不做"空来源"误判：步 8 的 empty 计数必须为 0。02-04 起新颖度/跨源 dup
// 可以把转述稿整源清空（步 8 记 'rewrite'，设计意图非回归）——输出来源数按
// rewrite 差额对账。
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// test 模式端到端（04-01 单链语义）：test 与 on 共用 runOnChain——同输入同回放桩下
// 两模式 result / stats.local / stats.sources 逐字段 deepEqual（本计划尚无样本元
// 信息层，应为全等）；裁决真实生效以 test 相对 off 的差异推导钉死（旧 shadow
// "只算不丢"行为退役，Jev 裁决不生效时差集为 0，断言有判别力）。
// 范围备忘：现有两份录制夹具的 would_drop 均为空——全仓没有整源 Jev drop 的录制，
// 这里不写"整源 drop 被删"的空真断言；将来需要时必须先新增录制夹具（范围变更，
// 显式提出后再做，不得执行期即兴）。
// ---------------------------------------------------------------------------

const isRecordValue = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** 录制装载（与 client.test.ts / dev/compare.ts 同形）。 */
const loadRecording = (rel: string): Record<string, { http: number; response: unknown }> => {
  const parsed: unknown = JSON.parse(readFileSync(join(fixtureRoot, rel), 'utf8'));
  assert.ok(isRecordValue(parsed) && isRecordValue(parsed.results), `${rel} has no results table`);
  return parsed.results as Record<string, { http: number; response: unknown }>;
};

/** 回放传输：按 state.source.id 取录制条目，200 走生产同一条 parseJevResponse。 */
const replayClassifier =
  (results: Record<string, { http: number; response: unknown }>): ClassifyDeps['classify'] =>
  async ({ state }) => {
    const entry = results[state.source.id];
    if (!entry || entry.http !== 200) return { status: 'failed', kind: 'network' };
    const parsed = parseJevResponse(entry.http, JSON.stringify(entry.response));
    return parsed.ok
      ? {
          status: 'answered',
          model: parsed.model,
          answers: parsed.answers,
          input_tokens: parsed.input_tokens,
        }
      : { status: 'failed', kind: 'validation' };
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

/** 由两次运行的 stats.sources 独立推导 test 相对 off 的差异（不复制实现；身份口径与退役前的双链 diffShadow 一致）。 */
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

/** test 相对 off 的差集真值常数（checker 2026-09-29 修订：随 test 语义改名，值不变）。 */
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
    would_restore_snippets: 11,
  },
  jev_release_strict: {
    would_drop: [],
    would_remove_snippets: 5,
    would_restore: ['s11'],
    would_restore_snippets: 5,
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
  const testRun = await filterLlmContext(
    loadBraveFixture(`${stem}.json`),
    fixtureRequest,
    { ...offConfig, mode: 'test' },
    { classify: replayClassifier(recording) }
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

    it('still calls Jev for every candidate and books verdict/reason in per_source', () => {
      assert.equal(testRun.stats.jev?.n_requests, Object.keys(recording).length);
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
      // off 链，差集恒为 0，与这里的 9/5 + s11 救回不等
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
      it('rescues s11 (therundown) as a whole source: off drops it as rewrite, test keeps it', () => {
        // test 按 is_primary 播种、保护原创论证段，会救回 off 删掉的内容（审查 R10
        // 同源）：strict 的 s11（therundown）被 off 判 rewrite 整源丢掉，test 保留
        const s11Url = 'https://www.therundown.ai/news/typesafe-jev-ai-decisions-software';
        const offRow = offRun.stats.sources.find((source) => source.url === s11Url);
        assert.equal(offRow?.verdict, 'drop');
        assert.equal(offRow?.reason, 'rewrite');
        assert.equal(
          offRun.result.grounding.generic.some((item) => item.url === s11Url),
          false,
          's11 must be absent from the off result'
        );
        assert.equal(
          testRun.result.grounding.generic.some((item) => item.url === s11Url),
          true,
          's11 must be present in the test result'
        );
      });
    }
  });
}
