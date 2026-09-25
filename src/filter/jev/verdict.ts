/**
 * 来源级裁决链（步 6）与片段 score 删除（步 7 前半）。
 *
 * 只消费单来源的 judged 答案与阈值——输入没有跨来源数据结构，Jev 裁决绝不越权做
 * 跨来源比较、重排或补回（PLAN §3.3）；工作表上只翻 `verdict` / `reason` /
 * `kept` 标记，不 sort、不 filter 出新数组（RULES-08）。
 *
 * 最小行类型照 `budget.ts` 先例：pipeline 的工作表结构上满足、又不产生
 * pipeline → verdict → pipeline 的循环导入（本文件不 import pipeline.ts）。
 *
 * 依据：PLAN §3.3、notes/shadow-mode-logging.md（阈值判据方向）、
 * 02-RESEARCH.md「裁决链实现」。
 */

import type { FilterStats, JevThresholds, SnippetRemovalReason, SourceDropReason } from '../types.js';

/** 工作表里的一条片段（最小形状；pipeline 的 WorkSnippet 结构上满足）。 */
export type VerdictSnippetRow = {
  index: number;
  text: string;
  kept: boolean;
  reason?: SnippetRemovalReason;
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

/**
 * judged 行的最小形状：runJevStage 的 per_source 行（`JevPerSourceStats`）结构上
 * 满足。只读 `status` / `answers` / `snippet_scores`——failed/skipped/breaker_open
 * 的来源按"留"（SAFE-01）。
 */
export type VerdictJudgedRow = {
  status: 'answered' | 'failed' | 'skipped' | 'breaker_open';
  answers?: Record<string, number>;
  snippet_scores?: number[];
};

/**
 * 来源 CJK 占比：CJK 字符数除以标题加全部文本的总字符数（UTF-16 码元）。
 * CJK 判定复用 tokenize.ts 的 script 常量，不写新正则（Don't Hand-Roll）。
 * @example cjkShareOf('你好', ['ab']) → 2/4
 */
export function cjkShareOf(title: string, texts: readonly string[]): number {
  return 0;
}

/**
 * 步 6：来源级裁决链，固定顺序 off_topic → listing → self_deprecated → stale →
 * filler（且 p_reasoning < reasoningProtect 严格小于才丢），p >= 门槛 + CJK 加成
 * 即丢、命中即停。只处理 verdict 为 keep 且 judged 为 answered 的来源；is_
 * attributed_rewrite / paywalled / worth_keeping 三题只记答案不丢来源。
 */
export function applySourceVerdicts(
  table: VerdictSourceRow[],
  judged: ReadonlyMap<string, VerdictJudgedRow>,
  thresholds: JevThresholds,
  stats: FilterStats
): void {}

/**
 * 步 7 前半：片段 score 删除。state 构建时的幸存片段序与 per_source.snippet_scores
 * 按位置对齐，score < snippetMin（严格小于，连续值比较）的片段置 kept = false、
 * reason = 'score'；长度不一致时整来源跳过（保守留）。
 */
export function applySnippetScores(
  table: VerdictSourceRow[],
  judged: ReadonlyMap<string, VerdictJudgedRow>,
  thresholds: JevThresholds,
  stats: FilterStats
): void {}
