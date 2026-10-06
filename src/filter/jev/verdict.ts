/**
 * 阶段 4 来源裁决与阶段 5 片段保留概率裁决。
 * 消费逐来源答案与阈值，更新工作表和对应统计，不重排或补回内容。
 * 使用最小结构类型，避免与 pipeline.ts 循环导入。
 */

import { PAGE_QUESTION_KEY } from './questions.js';
import { snippetDropVerdict, sourceDropVerdict } from './threshold.js';
import type {
  FilterStats,
  JevSnippetGroup,
  JevThresholds,
  SnippetJudgments,
  SnippetRemovalReason,
  SourceDropReason,
} from '../types.js';

/** 工作表里的一条片段（最小形状；pipeline 的 WorkSnippet 结构上满足）。 */
export type VerdictSnippetRow = {
  index: number;
  text: string;
  kept: boolean;
  reason?: SnippetRemovalReason;
  /** 临界规则删除时携带的实际补偿距离（含 0）；原判定删除不带。 */
  nearThresholdGap?: number;
};

/** 工作表里的一个来源（最小形状；pipeline 的 WorkSource 结构上满足）。 */
export type VerdictSourceRow = {
  index: number;
  url: string;
  title: string;
  snippets: VerdictSnippetRow[];
  verdict: 'keep' | 'drop';
  reason?: SourceDropReason;
};

/** 裁决所需的最小输入；失败、跳过和熔断来源保守保留。 */
export type VerdictJudgedRow = {
  status: 'answered' | 'failed' | 'skipped' | 'breaker_open';
  answers?: Record<string, number>;
  snippet_judgments?: SnippetJudgments;
};

/** 概率必须是 [0,1] 内的有限数，否则返回 undefined。 */
const usableProbability = (value: number | undefined): number | undefined =>
  value !== undefined && Number.isFinite(value) && value >= 0 && value <= 1 ? value : undefined;

/**
 * 按组大小选择片段保留门槛：二/三片组用 groupKeepMin，单片组用 singleKeepMin。
 * 裁决与样本记录共用，避免两处口径漂移。
 */
export const snippetKeepThreshold = (groupSize: number, thresholds: JevThresholds): number =>
  groupSize >= 2 ? thresholds.groupKeepMin : thresholds.singleKeepMin;

/**
 * 页面裁决：只判 filler，概率 >= fillerDrop 时整页删除，原因 filler；
 * 未达线但差距不超过临界上限时同样删除，并在来源统计行记录实际补偿距离。
 * 页面题缺答、错型、越界或非有限时保守保留整源，并将来源行标为 validation。
 */
export function applySourceVerdicts(
  table: VerdictSourceRow[],
  judged: ReadonlyMap<string, VerdictJudgedRow>,
  thresholds: JevThresholds,
  stats: FilterStats
): void {
  for (const source of table) {
    if (source.verdict !== 'keep') continue;

    const row = judged.get(`s${source.index}`);
    if (row === undefined || row.status !== 'answered') continue;

    const perSource = stats.jev?.per_source.find((entry) => entry.src === `s${source.index}`);
    if (perSource === undefined) continue;

    const pFiller = usableProbability(row.answers?.[PAGE_QUESTION_KEY]);

    if (pFiller === undefined) {
      perSource.verdict = 'keep';
      perSource.fail_kind = 'validation';
      continue;
    }

    const verdict = sourceDropVerdict(pFiller, thresholds.fillerDrop);
    if (verdict.drop) {
      source.verdict = 'drop';
      source.reason = 'filler';
      perSource.verdict = 'drop';
      perSource.reason = 'filler';
      if (verdict.nearThresholdGap !== undefined) {
        perSource.near_threshold_gap = verdict.nearThresholdGap;
      }
    } else {
      perSource.verdict = 'keep';
    }
  }
}

/**
 * 按候选位置对齐片段保留概率，低于所在组门槛时删除；
 * 门槛位于 (0,1) 内时，达到门槛且差距不超过临界上限也删除，记录实际距离（含 0）。
 * 门槛为 0 或 1 时仅执行严格小于判定；其余有效片段保留。
 * 判断数组与幸存片段不等长时整源跳过，不能把短数组当成有效前缀。
 * null 判断（缺答或坏组）与无组映射的位置保守保留；
 * 组大小由映射提供：二/三片组用 groupKeepMin，单片组用 singleKeepMin。
 */
export function applySnippetJudgments(
  table: VerdictSourceRow[],
  judged: ReadonlyMap<string, VerdictJudgedRow>,
  groupsBySource: ReadonlyMap<string, readonly JevSnippetGroup[]>,
  thresholds: JevThresholds,
  stats: FilterStats
): void {
  for (const source of table) {
    if (source.verdict !== 'keep') continue;

    const row = judged.get(`s${source.index}`);
    if (row === undefined || row.status !== 'answered') continue;

    const judgments = row.snippet_judgments;
    if (judgments === undefined) continue;

    // state 构建时的幸存片段序；runJevStage 构造 state 与本步之间无片段变更，位置对齐。
    // 等长契约：长度不匹配整源跳过，不套前缀、不猜对齐
    const survivors = source.snippets.filter((snippet) => snippet.kept);
    if (judgments.length !== survivors.length) continue;

    const groups = groupsBySource.get(`s${source.index}`);
    if (groups === undefined) continue;

    for (let i = 0; i < judgments.length; i += 1) {
      const judgment = judgments[i];
      if (judgment === null) continue;
      const group = groups.find((entry) => entry.start <= i && i < entry.start + entry.size);
      if (group === undefined) continue;
      const verdict = snippetDropVerdict(
        judgment.value,
        snippetKeepThreshold(group.size, thresholds)
      );
      if (verdict.drop) {
        survivors[i].kept = false;
        survivors[i].reason = 'keep_probability';
        if (verdict.nearThresholdGap !== undefined) {
          survivors[i].nearThresholdGap = verdict.nearThresholdGap;
        }
      }
    }
  }
}
