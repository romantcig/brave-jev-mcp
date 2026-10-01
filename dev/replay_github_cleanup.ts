/**
 * GitHub 界面清洗收窄版回放（GITHUB_CLEANUP_PLAN「回放要求」；filter-rules-10）。
 *
 * 用仓库内 cleanGitHubBoilerplate（五条首批规则）重放三天现场样本，分别报告原始
 * 返回（pre_filter）与历史最终返回（final_return.payload）的变化。
 *
 * 口径（审查 R3 返修）：三套分母严格分开——
 * - 全体来源：所有站点的来源出现次数、片段数与字符总数（清洗在非 GitHub 恒无动作）；
 * - GitHub 仓库：repoKeyOf 非 null（github.com / www.github.com 的 owner/repo 两段
 *   及以上页面）的来源次数、去重仓库数、片段数、字符数与全部规则命中——去重、
 *   次数、片段与字符的分母同一范围；
 * - GitHub Topics：单列来源数，不进仓库分母（repoKeyOf 对 topics 返回 null）。
 *
 * 样本分组（审查 R3 补充）：2026-09-30 与 2026-10-01 的样本与计划实验依据同批
 * （基线组 45 份）；2026-10-02 较计划基线多出若干份（当日全量组），两轮报告变化不能
 * 直接归因于规则——两组分开统计，manifest 固定每份样本的 sha256 供跨轮对齐。
 *
 * 产物（汇总 / 逐项 diff / 残留清单 / 样本 manifest）全部写显式指定的输出目录，
 * 本脚本不落任何样本内容进仓库。只是本地文本清洗回放——没有重跑 Jev，
 * 不能据此推断清洗后模型裁决的变化。
 *
 * 运行：npx tsx dev/replay_github_cleanup.ts <输出目录>（输出目录必填，不写死路径）
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanGitHubBoilerplate } from '../src/filter/githubCleanup.js';

const OUT_DIR = process.argv[2];
if (!OUT_DIR) {
  console.error(
    '用法：npx tsx dev/replay_github_cleanup.ts <输出目录>（显式指定，禁止写死会话路径）'
  );
  process.exit(1);
}
const SAMPLE_BASE = 'C:/Users/romantcig/.brave-jev/logs/samples';
const DAYS = ['2026-09-30', '2026-10-01', '2026-10-02'] as const;
/** 与计划实验依据同批的日期（基线组）；其余日期为增量组，单独统计。 */
const BASELINE_DAYS: ReadonlySet<string> = new Set(['2026-09-30', '2026-10-01']);

type SampleSource = { url?: unknown; snippets?: unknown };
type SampleRecord = {
  pre_filter?: { grounding?: { generic?: SampleSource[] } } | null;
  final_return?: { payload?: { grounding?: { generic?: SampleSource[] } } | null } | null;
  request?: { params?: { query?: unknown }; intent?: unknown };
};

/** 仓库键：github.com 的 owner/repo（小写）；非 GitHub 或 Topics 返回 null。 */
const repoKeyOf = (url: string): string | null => {
  try {
    const parsed = new URL(url);
    if (
      parsed.hostname.toLowerCase() !== 'github.com' &&
      parsed.hostname.toLowerCase() !== 'www.github.com'
    ) {
      return null;
    }
    const segments = parsed.pathname.split('/').filter(Boolean);
    if (segments.length < 2) return null;
    if (segments[0].toLowerCase() === 'topics') return null; // Topics 不计入仓库口径
    return `${segments[0]}/${segments[1]}`.toLowerCase();
  } catch {
    return null;
  }
};

const isTopics = (url: string): boolean => {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    return (
      (host === 'github.com' || host === 'www.github.com') &&
      parsed.pathname.split('/').filter(Boolean)[0]?.toLowerCase() === 'topics'
    );
  } catch {
    return false;
  }
};

/** 残留候选标记（清洗后仍含这些内容的片段进入残留清单，供逐条人工判读）。 */
const RESIDUAL_MARKERS: readonly [string, RegExp][] = [
  ['Repository files navigation', /Repository files navigation/i],
  ['Saved searches', /Saved searches/],
  ['Search code, repositories', /Search code, repositories/],
  ['Provide feedback', /Provide feedback/],
  ['Choose a tag to compare', /Choose a tag to compare/],
  ['No results found', /No results found/],
  ['Reactions are currently unavailable', /Reactions are currently unavailable/],
  ['Copy head branch … clipboard', /Copy head branch name to clipboard/],
  ['Uh oh!', /Uh oh!/],
  ['Public 面包屑', /Public( archive| fork)?\b/],
  ['Contribute to … 账户邀请', /Contribute to .* development by creating an account on GitHub/],
];

interface StageStats {
  // —— 全体口径（所有站点）——
  allSourceOccurrences: number;
  allSnippets: number;
  allTotalChars: number;
  // —— GitHub 仓库口径（repoKeyOf 非 null；去重 / 次数 / 片段 / 字符同范围）——
  sourceOccurrences: number;
  repos: Set<string>;
  snippets: number;
  changedSnippets: number;
  emptiedSnippets: number;
  removedLines: number;
  partialSuffix: number;
  removedChars: number;
  totalChars: number;
  ruleHits: Map<string, number>;
  ruleRepos: Map<string, Set<string>>;
  // —— GitHub Topics（单列，不进仓库分母）——
  topicsSources: number;
}

const newStageStats = (): StageStats => ({
  allSourceOccurrences: 0,
  allSnippets: 0,
  allTotalChars: 0,
  sourceOccurrences: 0,
  repos: new Set<string>(),
  snippets: 0,
  changedSnippets: 0,
  emptiedSnippets: 0,
  removedLines: 0,
  partialSuffix: 0,
  removedChars: 0,
  totalChars: 0,
  ruleHits: new Map(),
  ruleRepos: new Map(),
  topicsSources: 0,
});

const replaySource = (
  url: string,
  snippets: string[],
  query: string,
  intent: string,
  fileLabel: string,
  stage: 'pre' | 'final',
  stats: StageStats,
  diffRows: string[],
  residualRows: string[]
): void => {
  const repo = repoKeyOf(url);
  stats.allSourceOccurrences += 1;
  if (repo !== null) {
    stats.repos.add(repo);
    stats.sourceOccurrences += 1;
  } else if (isTopics(url)) {
    stats.topicsSources += 1;
  }

  for (let index = 0; index < snippets.length; index += 1) {
    const original = snippets[index];
    stats.allSnippets += 1;
    stats.allTotalChars += original.length;
    const cleaned = cleanGitHubBoilerplate(original, url);

    // 残留清单覆盖全部片段（含未改动者与非 GitHub 来源）：清洗后文本仍含候选
    // 标记的都列出，供逐条人工判读——不等于都应删除
    const residuals = RESIDUAL_MARKERS.filter(([, pattern]) => pattern.test(cleaned.text)).map(
      ([name]) => name
    );
    if (residuals.length > 0) {
      residualRows.push(
        [
          `- ${stage} | ${fileLabel} | 片段 ${index} | ${url}`,
          `  残留标记: ${residuals.join('、')}`,
        ].join('\n')
      );
    }

    // 仓库口径分母：只对仓库来源累加（清洗在非仓库恒无动作，diff 也不会产生）
    if (repo === null) continue;
    stats.snippets += 1;
    stats.totalChars += original.length;
    if (cleaned.actions.length === 0) continue;

    stats.changedSnippets += 1;
    stats.removedChars += original.length - cleaned.text.length;
    if (cleaned.text.trim() === '') stats.emptiedSnippets += 1;
    for (const action of cleaned.actions) {
      stats.ruleHits.set(action.rule, (stats.ruleHits.get(action.rule) ?? 0) + 1);
      if (action.partial) stats.partialSuffix += 1;
      else stats.removedLines += 1;
      const repoSet = stats.ruleRepos.get(action.rule) ?? new Set<string>();
      repoSet.add(repo);
      stats.ruleRepos.set(action.rule, repoSet);
    }

    // 逐项 diff（行级 unified）
    const diffLines: string[] = [];
    const a = original.split('\n');
    const b = cleaned.text.split('\n');
    let cursorA = 0;
    let cursorB = 0;
    while (cursorA < a.length || cursorB < b.length) {
      if (a[cursorA] === b[cursorB]) {
        cursorA += 1;
        cursorB += 1;
        continue;
      }
      // 该行在原文有、清洗后缺失（或被改写）——打出 -/+ 对
      diffLines.push(`- L${cursorA + 1}: ${a[cursorA] ?? ''}`);
      if (b[cursorB] !== undefined && a[cursorA + 1] !== b[cursorB]) {
        diffLines.push(`+ L${cursorB + 1}: ${b[cursorB]}`);
        cursorB += 1;
      }
      cursorA += 1;
    }
    diffRows.push(
      [
        `## ${stage} | ${fileLabel} | 片段 ${index} | ${url}`,
        '',
        `- query: ${query || '(空)'}`,
        `- intent: ${intent || '(空)'}`,
        `- 动作: ${cleaned.actions
          .map((action) => `${action.rule}@L${action.line}${action.partial ? '(partial)' : ''}`)
          .join('、')}`,
        `- 字符: ${original.length} → ${cleaned.text.length}（删 ${original.length - cleaned.text.length}）`,
        '',
        '```diff',
        ...diffLines,
        '```',
      ].join('\n')
    );
  }
};

const main = (): void => {
  mkdirSync(OUT_DIR, { recursive: true });
  /** 每组 × 每阶段一套统计：baseline = 9-30 + 10-01（与计划实验同批），oct02 = 10-02 全部。 */
  const groups = {
    baseline: {
      pre: newStageStats(),
      final: newStageStats(),
    },
    oct02: {
      pre: newStageStats(),
      final: newStageStats(),
    },
  } as const;
  const diffRows: string[] = [];
  const residualRows: string[] = [];
  const manifest: { file: string; sha256: string }[] = [];
  const sampleCounts: Record<string, number> = {};

  for (const day of DAYS) {
    const files = readdirSync(join(SAMPLE_BASE, day)).filter((name) => name.endsWith('.json'));
    sampleCounts[day] = files.length;
    const group = BASELINE_DAYS.has(day) ? groups.baseline : groups.oct02;
    for (const name of files) {
      const fullPath = join(SAMPLE_BASE, day, name);
      const raw = readFileSync(fullPath);
      manifest.push({ file: fullPath, sha256: createHash('sha256').update(raw).digest('hex') });
      const sample = JSON.parse(raw.toString('utf8')) as SampleRecord;
      const query =
        typeof sample.request?.params?.query === 'string' ? sample.request.params.query : '';
      const intent = typeof sample.request?.intent === 'string' ? sample.request.intent : '';
      const fileLabel = `${day}/${name}`;

      const preGeneric = Array.isArray(sample.pre_filter?.grounding?.generic)
        ? sample.pre_filter.grounding.generic
        : [];
      for (const [sourceIndex, source] of preGeneric.entries()) {
        const url = typeof source?.url === 'string' ? source.url : '';
        const snippets = Array.isArray(source?.snippets)
          ? source.snippets.filter((text): text is string => typeof text === 'string')
          : [];
        replaySource(
          url,
          snippets,
          query,
          intent,
          `${fileLabel}#s${sourceIndex}`,
          'pre',
          group.pre,
          diffRows,
          residualRows
        );
      }

      const finalGeneric = Array.isArray(sample.final_return?.payload?.grounding?.generic)
        ? sample.final_return.payload.grounding.generic
        : [];
      for (const [sourceIndex, source] of finalGeneric.entries()) {
        const url = typeof source?.url === 'string' ? source.url : '';
        const snippets = Array.isArray(source?.snippets)
          ? source.snippets.filter((text): text is string => typeof text === 'string')
          : [];
        replaySource(
          url,
          snippets,
          query,
          intent,
          `${fileLabel}#s${sourceIndex}`,
          'final',
          group.final,
          diffRows,
          residualRows
        );
      }
    }
  }

  const stageReport = (stage: StageStats): Record<string, unknown> => ({
    全体来源: {
      来源出现次数: stage.allSourceOccurrences,
      片段数: stage.allSnippets,
      原始字符: stage.allTotalChars,
    },
    GitHub仓库: {
      不同仓库数: stage.repos.size,
      来源出现次数: stage.sourceOccurrences,
      片段数: stage.snippets,
      原始字符: stage.totalChars,
      改动片段: stage.changedSnippets,
      整片清空: stage.emptiedSnippets,
      删行数: stage.removedLines,
      剥按钮后缀数: stage.partialSuffix,
      删除字符: stage.removedChars,
      规则命中: Object.fromEntries([...stage.ruleHits.entries()].sort()),
      规则命中仓库数: Object.fromEntries(
        [...stage.ruleRepos.entries()].sort().map(([rule, repos]) => [rule, repos.size])
      ),
    },
    GitHub_Topics: {
      来源数: stage.topicsSources,
    },
  });

  const summary = {
    说明:
      'filter-rules-10 收窄版回放（仓库内 cleanGitHubBoilerplate；filter-rules-8 的返修：' +
      'Tab/混合缩进列数保护、跨行内联代码跨度保护、引用懒续行保护、清洗幂等验证、' +
      '分支引用冒号后非空检查）。未重跑 Jev——清洗对模型裁决的影响未验证。' +
      '规则较 2026-10-02 实验版收窄：无 Uh oh!、无 Public 面包屑、无注册邀请后缀、' +
      '无 Awesome 改写。口径：全体来源 / GitHub 仓库 / Topics 三套分母分开，' +
      '仓库去重、来源次数、片段与字符同一范围；Topics 单列不进仓库分母。',
    样本分组说明:
      'baseline = 2026-09-30 + 2026-10-01（与计划实验依据同批）；oct02 = 2026-10-02 全部' +
      '（较计划基线多出新增记录，两轮变化不直接归因于规则，manifest 固定 sha256 供对齐）。',
    样本数: sampleCounts,
  };
  // 全量 = 基线组 + 10 月 2 日全量组：单独汇总一套总量口径
  const totalPre = newStageStats();
  const totalFinal = newStageStats();
  const mergeStats = (target: StageStats, source: StageStats): void => {
    target.allSourceOccurrences += source.allSourceOccurrences;
    target.allSnippets += source.allSnippets;
    target.allTotalChars += source.allTotalChars;
    target.sourceOccurrences += source.sourceOccurrences;
    target.snippets += source.snippets;
    target.changedSnippets += source.changedSnippets;
    target.emptiedSnippets += source.emptiedSnippets;
    target.removedLines += source.removedLines;
    target.partialSuffix += source.partialSuffix;
    target.removedChars += source.removedChars;
    target.totalChars += source.totalChars;
    target.topicsSources += source.topicsSources;
    for (const repo of source.repos) target.repos.add(repo);
    for (const [rule, count] of source.ruleHits) {
      target.ruleHits.set(rule, (target.ruleHits.get(rule) ?? 0) + count);
    }
    for (const [rule, repos] of source.ruleRepos) {
      const merged = target.ruleRepos.get(rule) ?? new Set<string>();
      for (const repo of repos) merged.add(repo);
      target.ruleRepos.set(rule, merged);
    }
  };
  mergeStats(totalPre, groups.baseline.pre);
  mergeStats(totalPre, groups.oct02.pre);
  mergeStats(totalFinal, groups.baseline.final);
  mergeStats(totalFinal, groups.oct02.final);

  const fullSummary = {
    ...summary,
    全量_原始返回: stageReport(totalPre),
    全量_历史最终返回: stageReport(totalFinal),
    基线组_0930_1001_原始返回: stageReport(groups.baseline.pre),
    基线组_0930_1001_历史最终返回: stageReport(groups.baseline.final),
    当日全量组_1002_原始返回: stageReport(groups.oct02.pre),
    当日全量组_1002_历史最终返回: stageReport(groups.oct02.final),
  };

  writeFileSync(join(OUT_DIR, 'replay-summary.json'), `${JSON.stringify(fullSummary, null, 2)}\n`);
  writeFileSync(
    join(OUT_DIR, 'replay-diff.md'),
    `${['# 收窄版清洗逐项差异', '', ...diffRows].join('\n')}\n`
  );
  writeFileSync(
    join(OUT_DIR, 'replay-residuals.md'),
    `${['# 清洗后候选残留（不等于都应删除）', '', ...residualRows].join('\n')}\n`
  );
  writeFileSync(join(OUT_DIR, 'replay-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(JSON.stringify(fullSummary, null, 2));
};

main();
