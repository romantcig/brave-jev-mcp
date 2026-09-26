/**
 * 来源级裁决链（步 6）与片段 score 删除（步 7 前半）。
 *
 * 只消费单来源的 judged 答案与阈值——输入没有跨来源数据结构，Jev 裁决绝不越权做
 * 跨来源比较、重排或补回（PLAN §3.3）；工作表上只翻 `verdict` / `reason` /
 * `kept` 标记，不 sort、不 filter 出新数组（RULES-08）。裁决结果回写
 * `stats.jev.per_source` 对应行（Phase 3 状态行的共同来源；shadow 模式在拷贝表上
 * 跑本链时，per_source 记的就是 would 层裁决，正本不动）。
 *
 * 最小行类型照 `budget.ts` 先例：pipeline 的工作表结构上满足、又不产生
 * pipeline → verdict → pipeline 的循环导入（本文件不 import pipeline.ts）。
 *
 * 依据：PLAN §3.3、notes/shadow-mode-logging.md（阈值判据方向）、
 * 02-RESEARCH.md「裁决链实现」。
 */

import { CJK_SEGMENT, SCRIPT_PATTERN } from '../tokenize.js';
import type {
  FilterStats,
  JevThresholds,
  SnippetRemovalReason,
  SourceDropReason,
} from '../types.js';

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
 * 来源 CJK 占比：CJK 字符数除以标题加全部文本的总字符数（UTF-16 码元，与预算
 * 估算同一尺度）。CJK 判定复用 tokenize.ts 的 script 常量，不写新正则
 * （Don't Hand-Roll）；空格标点不属任何 script 段，只计进分母。
 * @returns 占比（0 到 1）；总字符数为 0 时返回 0
 * @example cjkShareOf('你好', ['ab']) → 0.5
 * @example cjkShareOf('', []) → 0
 */
export function cjkShareOf(title: string, texts: readonly string[]): number {
  const whole = title + texts.join('');
  if (whole.length === 0) return 0;

  let cjk = 0;
  for (const { 0: segment } of whole.matchAll(SCRIPT_PATTERN)) {
    if (CJK_SEGMENT.test(segment)) cjk += segment.length;
  }
  return cjk / whole.length;
}

/** T-02-03-1 防御：概率必须是 [0,1] 内的有限数值，否则视为异常（undefined）。 */
const usableProbability = (value: number | undefined): number | undefined =>
  value !== undefined && Number.isFinite(value) && value >= 0 && value <= 1 ? value : undefined;

/**
 * 步 6：来源级裁决链，固定顺序 off_topic → listing → self_deprecated → stale →
 * filler（且 p_reasoning < reasoningProtect 严格小于才丢——>= 即保护），p >=
 * 门槛 + CJK 加成即丢、命中即停，首个命中的判定是 reason；全不命中 keep。
 *
 * 只处理 verdict 为 keep 且 judged 为 answered 的来源（失败/跳过/熔断按"留"，
 * SAFE-01）；is_attributed_rewrite / paywalled / worth_keeping 三题只记答案
 * （02-02 已记进 per_source.answers）不丢来源（VERDICT-01）。CJK 占比 >
 * cjkShare（严格大于）时五道丢弃门槛各加 cjkBonus（VERDICT-04，方向保守：
 * 中文来源更难被丢；加成不抬片段 score 门槛）。
 *
 * 裁决回写 `stats.jev.per_source` 对应行的 verdict/reason；判定相关六道概率
 * 任一缺失或超出 [0,1] 时整来源防御式跳过（保守不丢）并在该行记 fail_kind
 * `'validation'` 备查（T-02-03-1——02-02 解析层是第一道闸，本层防御式兜底）。
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

    const answers = row.answers ?? {};
    const pOffTopic = usableProbability(answers.is_off_topic);
    const pListing = usableProbability(answers.is_listing);
    const pSelfDeprecated = usableProbability(answers.self_deprecated);
    const pStale = usableProbability(answers.stale);
    const pFiller = usableProbability(answers.is_template_filler);
    const pReasoning = usableProbability(answers.has_original_reasoning);

    if (
      pOffTopic === undefined ||
      pListing === undefined ||
      pSelfDeprecated === undefined ||
      pStale === undefined ||
      pFiller === undefined ||
      pReasoning === undefined
    ) {
      perSource.verdict = 'keep';
      perSource.fail_kind = 'validation';
      continue;
    }

    // CJK 占比与 state 口径一致：标题加幸存片段文本（state 只发幸存片段）
    const cjkShare = cjkShareOf(
      source.title,
      source.snippets.filter((snippet) => snippet.kept).map((snippet) => snippet.text)
    );
    const bonus = cjkShare > thresholds.cjkShare ? thresholds.cjkBonus : 0;

    // 固定顺序（PLAN §3.3）：先判先停；filler 保护挡下时该判定不成立（continue）
    const gates: ReadonlyArray<readonly [number, number, SourceDropReason]> = [
      [pOffTopic, thresholds.offTopicDrop + bonus, 'off_topic'],
      [pListing, thresholds.listingDrop + bonus, 'listing'],
      [pSelfDeprecated, thresholds.selfDeprecated + bonus, 'self_deprecated'],
      [pStale, thresholds.staleDrop + bonus, 'stale'],
      [pFiller, thresholds.fillerDrop + bonus, 'filler'],
    ];
    for (const [p, dropAt, reason] of gates) {
      if (p < dropAt) continue;
      if (reason === 'filler' && pReasoning >= thresholds.reasoningProtect) continue;
      source.verdict = 'drop';
      source.reason = reason;
      perSource.verdict = 'drop';
      perSource.reason = reason;
      break;
    }
    if (source.verdict !== 'drop') {
      perSource.verdict = 'keep';
    }
  }
}

/**
 * 步 7 前半：片段 score 删除。state 构建时的幸存片段序（runJevStage 按 kept
 * 过滤后的顺序）与 per_source.snippet_scores 按位置对齐，score < snippetMin
 * （严格小于，连续值比较——夹具实证 1.62/1.77，不是整数档位，Pitfall 3）的
 * 片段置 kept = false、reason = 'score'；等于保留。
 *
 * 长度口径（JEV-05）：`scores.length > survivors.length` 整源跳过（防御——
 * 分数比实际片段多，说明对齐依据不成立）；`≤` 时按位置对齐**前 scores.length
 * 个**幸存片段，其后未发送给 Jev 的片段保留（32k 砍尾降级后回来的分数就比
 * 幸存片段少，被砍掉的片段本来也不该有分数，没砍的片段分数照常生效）。
 * 等长时行为与逐条对齐完全一致。异常 score（负值/非有限数，同 T-02-03-1
 * 防御）保守保留该片段。CJK 加成只抬来源级五道门槛，不抬本门槛（A4 落定：
 * 抬 SNIPPET_MIN 是更激进的方向，与保守原则相反）。
 */
export function applySnippetScores(
  table: VerdictSourceRow[],
  judged: ReadonlyMap<string, VerdictJudgedRow>,
  thresholds: JevThresholds,
  stats: FilterStats
): void {
  for (const source of table) {
    if (source.verdict !== 'keep') continue;

    const row = judged.get(`s${source.index}`);
    if (row === undefined || row.status !== 'answered') continue;

    const scores = row.snippet_scores;
    if (scores === undefined) continue;

    // state 构建时的幸存片段序；runJevStage 构造 state 与本步之间无片段变更，位置对齐
    const survivors = source.snippets.filter((snippet) => snippet.kept);
    if (scores.length > survivors.length) continue;

    for (let i = 0; i < scores.length; i += 1) {
      const score = scores[i];
      if (!Number.isFinite(score) || score < 0) continue;
      if (score < thresholds.snippetMin) {
        survivors[i].kept = false;
        survivors[i].reason = 'score';
      }
    }
  }
}
