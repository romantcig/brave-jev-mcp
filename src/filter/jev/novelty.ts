/**
 * 步 7 后半：按 Brave 原序执行跨来源 5-gram 去重与事实指纹新颖度判断。
 * 只更新片段标记，不重排；最小行类型避免与 pipeline.ts 循环导入。
 */

import { isNearDuplicate, SHINGLE_N } from '../prefilter.js';
import { STOPWORDS, shingles, tokenize } from '../tokenize.js';
import type {
  FilterStats,
  JevThresholds,
  NoveltySourceDetail,
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
 * 满足。只读 `status` 与 `answers` 里的 has_original_reasoning（论证段保护）——
 * failed/skipped/breaker_open 来源无论证答案，不享受保护。
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
 * 新颖度删除回调的载荷，保留判定当时的逐片段数值与表行引用。
 * 调用方可用 part / mergedFrom 构造原始片段身份。
 */
export type NoveltyDeletionInfo = {
  sourceIndex: number;
  snippet: NoveltySnippetRow & { part?: number; mergedFrom?: number };
  /** 片段指纹总数（判定的 fp 一侧）与当时 novel 数（noveltyMin 对照侧） */
  fpCount: number;
  novelCount: number;
};

/**
 * 数字指纹（n:）：含货币前后缀与 k/M/B/%/x 量词——$4.2M、193x、1,000、45%。
 * `i` 标志让大小写量词同收；小数点只在后随数字时才属于数字本身。
 */
const NUMBER_PATTERN = /\$?\d+(?:[.,]\d+)*(?:k|m|b|%|x)?/gi;

/** 日期指纹：ISO 串与英文月份日期；采用无嵌套量词的线性扫描。 */
const DATE_PATTERN =
  /\d{4}-\d{2}-\d{2}|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:,?\s+\d{4})?/gi;

/**
 * 代码标识符指纹（c:）：反引号内容（含反引号，不跨行）与 `sanity.config.ts` /
 * `foo.bar()` 形态的点分标识符。起始字母小写——代码标识符惯例，也避开句首大写词。
 */
const CODE_PATTERN = /`[^`\n]+`|\b[a-z][\w-]*(?:\.[a-zA-Z_][\w]*)+(?:\(\))?/g;

/**
 * 引文指纹（q:）：直引号或弯引号包裹的 ≥ 10 码元原文，词数 ≥ 6 才收（6 词引文
 * 至少 11 码元，长度下界与词数下界不冲突）。
 */
const QUOTE_PATTERN = /["\u201c\u201d]([^\u201c\u201d"]{10,})["\u201c\u201d]/g;

/**
 * 专名词组指纹（p:）：连续大写词组（句首单词也算候选——Brave 片段里公司名、
 * 产品名常在句首）。逐词滤常见功能词后按剩余词组收进指纹。
 */
const PROPER_NOUN_PATTERN = /\b[A-Z][\w&'-]{1,}(?:\s+[A-Z][\w&'-]{1,})*/g;

/**
 * p: 类的功能词表：tokenize.ts 的 STOPWORDS（英文功能词与搜索套话）再补口语
 * 代词、助动词等句首常客。共用一张表是刻意选择——"常见功能词"不写第二份权威。
 */
const PROPER_NOUN_STOP_EXTRA: ReadonlySet<string> = new Set([
  'if',
  'we',
  'our',
  'you',
  'your',
  'they',
  'their',
  'he',
  'she',
  'his',
  'her',
  'its',
  "it's",
  'but',
  'there',
  'here',
  'more',
  'most',
  'some',
  'all',
  'any',
  'may',
  'might',
  'will',
  'would',
  'could',
  'should',
  'shall',
  'must',
  'has',
  'have',
  'had',
  'did',
  'i',
]);
const PROPER_NOUN_STOPWORDS: ReadonlySet<string> = new Set([
  ...STOPWORDS,
  ...PROPER_NOUN_STOP_EXTRA,
]);

/**
 * 提取五类事实指纹并转小写：数字 n、日期 d、代码 c、引文 q、专名 p。
 * 引文至少六词，专名剔除常见功能词；空文本返回空集。
 * 日志仅记录带类别前缀的指纹，不记录完整片段正文。
 */
export function extractFingerprints(text: string): Set<string> {
  const fp = new Set<string>();
  for (const { 0: match } of text.matchAll(NUMBER_PATTERN)) {
    fp.add('n:' + match.toLowerCase());
  }
  for (const { 0: match } of text.matchAll(DATE_PATTERN)) {
    fp.add('d:' + match.toLowerCase());
  }
  for (const { 0: match } of text.matchAll(CODE_PATTERN)) {
    fp.add('c:' + match.toLowerCase());
  }
  for (const { 1: quote } of text.matchAll(QUOTE_PATTERN)) {
    const trimmed = quote.trim();
    if (trimmed.split(/\s+/).length >= 6) fp.add('q:' + trimmed.toLowerCase());
  }
  for (const { 0: match } of text.matchAll(PROPER_NOUN_PATTERN)) {
    const words = match
      .split(/\s+/)
      .filter((word) => !PROPER_NOUN_STOPWORDS.has(word.toLowerCase()));
    if (words.length > 0) fp.add('p:' + words.join(' ').toLowerCase());
  }
  return fp;
}

/**
 * 按 Brave 原序遍历 score 删除后的幸存片段，判定顺序固定：
 * 1. 先与幸存 shingle 并集比较逐字重复，论证保护不豁免转载。
 * 2. 再比较事实指纹；fp.size >= minFacts 且 novel.size < noveltyMin 才删。
 *    reasoning >= reasoningProtect 时免于新颖度删除，避免将共享专名误作重复论证。
 * 3. 仅幸存片段加入 shingle 与指纹参照集合。
 * 返回发生过 novelty / crossSourceDup 删除的来源标记，供步 8 区分 rewrite 与 empty。
 */
export function applyNovelty(
  table: NoveltySourceRow[],
  judged: ReadonlyMap<string, NoveltyJudgedRow> | undefined,
  thresholds: JevThresholds,
  stats: FilterStats,
  onNoveltyDeletion?: (info: NoveltyDeletionInfo) => void
): ReadonlyMap<number, JevSideDeletionFlags> {
  const flags = new Map<number, JevSideDeletionFlags>();
  const shingleUnion = new Set<string>();
  const fingerprintUnion = new Set<string>();

  // 仅为新颖度删除建立明细：fp_total 是该来源被删片段的指纹并集大小。
  // novel 在每次删除时相对当时幸存指纹并集重算，最后一次删除的值作为结果。
  // 跨源逐字去重不写此明细。
  const noveltyDetail = new Map<number, Set<string>>();
  let noveltyDetails: NoveltySourceDetail[] = [];
  const recordNoveltyDetail = (index: number, fingerprints: ReadonlySet<string>): void => {
    const union = noveltyDetail.get(index) ?? new Set<string>();
    for (const fingerprint of fingerprints) union.add(fingerprint);
    noveltyDetail.set(index, union);
    const src = `s${index}`;
    const novel = [...union].filter((fingerprint) => !fingerprintUnion.has(fingerprint));
    noveltyDetails = noveltyDetails.some((entry) => entry.src === src)
      ? noveltyDetails.map((entry) =>
          entry.src === src ? { src, fp_total: union.size, novel } : entry
        )
      : [...noveltyDetails, { src, fp_total: union.size, novel }];
  };

  const mark = (index: number, key: keyof JevSideDeletionFlags): void => {
    const entry = flags.get(index) ?? { novelty: false, crossSourceDup: false };
    entry[key] = true;
    flags.set(index, entry);
  };

  /** 论证段保护：reasoning >= reasoningProtect（恰等即保护）→ 免于指纹新颖度删除。 */
  const reasoningProtected = (index: number): boolean => {
    if (judged === undefined) return false;
    const row = judged.get(`s${index}`);
    if (row === undefined || row.status !== 'answered') return false;
    const reasoning = row.answers?.has_original_reasoning;
    return (
      reasoning !== undefined &&
      Number.isFinite(reasoning) &&
      reasoning >= thresholds.reasoningProtect
    );
  };

  for (const sourceRow of table) {
    if (sourceRow.verdict !== 'keep') continue;
    const index = sourceRow.index;
    const exempt = reasoningProtected(index);

    for (const snippet of sourceRow.snippets) {
      if (!snippet.kept) continue;

      const shingleSet = shingles(tokenize(snippet.text), SHINGLE_N);

      // 跨来源 5-gram 逐字 dup 先于指纹（用户已定决策 5）；论证段保护不豁免
      if (isNearDuplicate(shingleSet, shingleUnion)) {
        snippet.kept = false;
        snippet.reason = 'dup';
        stats.local.cross_source_dup_removed += 1;
        mark(index, 'crossSourceDup');
        continue;
      }

      const fingerprints = extractFingerprints(snippet.text);
      if (!exempt) {
        let novelCount = 0;
        for (const fingerprint of fingerprints) {
          if (!fingerprintUnion.has(fingerprint)) novelCount += 1;
        }
        if (fingerprints.size >= thresholds.minFacts && novelCount < thresholds.noveltyMin) {
          snippet.kept = false;
          snippet.reason = 'novelty';
          stats.local.novelty_removed += 1;
          mark(index, 'novelty');
          recordNoveltyDetail(index, fingerprints);
          // 逐片段判定数值只在此时可得，事后无法从来源聚合复原。
          onNoveltyDeletion?.({
            sourceIndex: index,
            snippet,
            fpCount: fingerprints.size,
            novelCount,
          });
          continue;
        }
      }

      // 幸存片段的 shingles 与指纹并入并集（被删片段不并入）
      for (const shingle of shingleSet) shingleUnion.add(shingle);
      for (const fingerprint of fingerprints) fingerprintUnion.add(fingerprint);
    }
  }
  // 替换明细数组以隔离共享引用；条目按首次删除顺序排列。
  if (noveltyDetails.length > 0) {
    stats.local.novelty = noveltyDetails;
  }
  return flags;
}
