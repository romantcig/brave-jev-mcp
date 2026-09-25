/**
 * 步 7 后半：跨来源 5-gram 逐字去重与片段级事实指纹增量新颖度（VERDICT-03）。
 *
 * 只依赖 tokenize.ts / prefilter.ts 的度量导出与最小行类型，不 import pipeline.ts
 * （budget.ts 先例：最小行类型结构上满足管道工作表，杜绝循环导入）。
 *
 * 依据：notes/dedup-and-rewrite-policy.md（元素定义、算法、播种顺序、论证段保护——
 * 逐字权威）、02-RESEARCH.md「片段级：score 删除与指纹新颖度」。
 */

import { isNearDuplicate, SHINGLE_N } from '../prefilter.js';
import { shingles, tokenize } from '../tokenize.js';
import type {
  FilterMode,
  FilterStats,
  JevThresholds,
  SnippetRemovalReason,
  SourceDropReason,
} from '../types.js';

/** 工作表里的一条片段（最小形状；pipeline 的 WorkSnippet 结构上满足）。 */
export type NoveltySnippetRow = {
  index: number;
  text: string;
  kept: boolean;
  reason?: SnippetRemovalReason;
};

/** 工作表里的一个来源（最小形状；pipeline 的 WorkSource 结构上满足）。 */
export type NoveltySourceRow = {
  index: number;
  url: string;
  snippets: NoveltySnippetRow[];
  verdict: 'keep' | 'drop';
  reason?: SourceDropReason;
};

/**
 * judged 行的最小形状：runJevStage 的 per_source 行（`JevPerSourceStats`）结构上
 * 满足。只读 `status` 与 `answers` 里的 is_primary（播种序）与
 * has_original_reasoning（论证段保护）——failed/skipped/breaker_open 来源按未判定
 * 殿后（保守，A3）。
 */
export type NoveltyJudgedRow = {
  status: 'answered' | 'failed' | 'skipped' | 'breaker_open';
  answers?: Record<string, number>;
};

/**
 * 逐源"是否发生 Jev 侧删除"的标记（applyNovelty 返回，供步 8 rewrite/empty 归因）。
 * 只在发生过对应删除时出现在映射里；两个键全 false 的来源不进映射。
 */
export type JevSideDeletionFlags = {
  novelty: boolean;
  crossSourceDup: boolean;
};

/**
 * 从片段文本提取事实指纹（五类元素，全部 toLowerCase 归一）：
 * n: 数字（含货币前后缀与 k/M/B/%/x 量词）、d: 日期串（ISO 与英文月份）、
 * c: 代码标识符（反引号内容与点分形态）、q: ≥ 6 词的引号原文、
 * p: 连续大写词组（滤常见功能词）。
 * @returns 指纹集合；空串返回空集
 */
export function extractFingerprints(text: string): Set<string> {
  return new Set();
}

/**
 * 播种顺序（与输出顺序分开）：off 模式或无 judged 答案时即 Brave 序；
 * on/shadow 按 is_primary 概率降序（同分按 Brave 序），未判定来源排已判定之后
 * 按 Brave 序（保守：不抢先占有事实扩大删除面，A3）。
 * @returns 参与播种的 keep 来源 index 序列（被丢来源不参与）
 */
export function seedingOrder(
  table: ReadonlyArray<NoveltySourceRow>,
  judged: ReadonlyMap<string, NoveltyJudgedRow> | undefined,
  mode: FilterMode
): number[] {
  return [];
}

/**
 * 步 7 后半：按播种序遍历 keep 来源的幸存片段。每片段先做跨来源 5-gram 逐字
 * 判定（isNearDuplicate 同一口径，命中 → reason 'dup'、独立计数），未命中再做
 * 指纹新颖度判定（fp.size >= minFacts 且 novel.size < noveltyMin 才删，reason
 * 'novelty'）；论证段保护（reasoning >= reasoningProtect）只豁免指纹新颖度，
 * 不豁免跨源 dup。幸存片段的 shingles 与指纹并入跨源并集。
 * @returns 逐源 Jev 侧删除标记表，供步 8 rewrite/empty 归因
 */
export function applyNovelty(
  table: NoveltySourceRow[],
  judged: ReadonlyMap<string, NoveltyJudgedRow> | undefined,
  mode: FilterMode,
  thresholds: JevThresholds,
  stats: FilterStats
): ReadonlyMap<number, JevSideDeletionFlags> {
  return new Map();
}
