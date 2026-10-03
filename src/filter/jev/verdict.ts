/**
 * 步 6 来源裁决与步 7 片段评分删除。
 * 消费逐来源答案与阈值，更新工作表和对应统计，不重排或补回内容。
 * 使用最小结构类型，避免与 pipeline.ts 循环导入。
 */

import { CJK_SEGMENT, SCRIPT_PATTERN } from '../tokenize.js';
import { SNIPPET_CRITERIA } from './questions.js';
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

/** 裁决所需的最小输入；失败、跳过和熔断来源保守保留。 */
export type VerdictJudgedRow = {
  status: 'answered' | 'failed' | 'skipped' | 'breaker_open';
  answers?: Record<string, number>;
  snippet_scores?: number[];
};

/**
 * CJK 字符数占标题与片段总 UTF-16 码元数的比例；空输入为 0。
 * 复用 tokenize.ts 的字符分类，空格和标点只计入分母。
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

/** 概率必须是 [0,1] 内的有限数，否则返回 undefined。 */
const usableProbability = (value: number | undefined): number | undefined =>
  value !== undefined && Number.isFinite(value) && value >= 0 && value <= 1 ? value : undefined;

/** 评分题的合法范围由唯一评分题的三档 criteria 决定；记录与裁决共用，异常分数保守保留。 */
export const isUsableSnippetScore = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isFinite(value) &&
  value >= 0 &&
  value <= SNIPPET_CRITERIA.length - 1;

/**
 * 固定顺序 off_topic → listing → filler，首个命中原因生效。
 * 三道删除概率 >= 对应门槛时删除；filler 还要求 reasoning < reasoningProtect。
 * CJK 占比 > cjkShare 时，只给三道来源门槛加 cjkBonus。
 * 当前四题任一缺失或越界时保守跳过整源，并将来源行标为 validation。
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
    const pFiller = usableProbability(answers.is_template_filler);
    const pReasoning = usableProbability(answers.has_original_reasoning);

    if (
      pOffTopic === undefined ||
      pListing === undefined ||
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

    // 先判先停；论证保护仅豁免 filler。
    const gates: ReadonlyArray<readonly [number, number, SourceDropReason]> = [
      [pOffTopic, thresholds.offTopicDrop + bonus, 'off_topic'],
      [pListing, thresholds.listingDrop + bonus, 'listing'],
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
 * 按候选位置对齐片段评分，连续分值 score < snippetMin 时删除，等于门槛保留。
 * 评分数组与幸存片段不等长时整源跳过，不能把短数组当成有效前缀。
 * 超出 [0,2] 或非有限的分数不用于删除，逐题收到的值仍可供样本记录。
 * CJK 加成不提高片段门槛，提高它会使删除更激进。
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

    // state 构建时的幸存片段序；runJevStage 构造 state 与本步之间无片段变更，位置对齐。
    // 等长契约：长度不匹配整源跳过，不套前缀、不猜对齐
    const survivors = source.snippets.filter((snippet) => snippet.kept);
    if (scores.length !== survivors.length) continue;

    for (let i = 0; i < scores.length; i += 1) {
      const score = scores[i];
      if (!isUsableSnippetScore(score)) continue;
      if (score < thresholds.snippetMin) {
        survivors[i].kept = false;
        survivors[i].reason = 'score';
        continue;
      }
    }
  }
}
