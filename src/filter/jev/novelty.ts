/**
 * 步 7 后半：跨来源 5-gram 逐字去重与片段级事实指纹增量新颖度（VERDICT-03）。
 *
 * 只依赖 tokenize.ts / prefilter.ts 的度量导出与最小行类型，不 import pipeline.ts
 * （budget.ts 先例：最小行类型结构上满足管道工作表，杜绝循环导入）。按 Brave 原序
 * 遍历只翻 `kept` / `reason` 标记，不 sort、不 filter 出新数组（RULES-08）——
 * 幸存者保持 Brave 原序由调用方重建输出保证。
 *
 * 播种序即 Brave 原序（filter-rules-5，2026-10-01）：v3 曾按 is_primary 概率降序
 * 播种，两轮五题删除实验的七个场景消融均未显示该排序的独立输出收益，随当事方题
 * 退出请求一并取消——去重谁先参与与最终输出排列都按原始来源索引。
 *
 * 依据：notes/dedup-and-rewrite-policy.md（元素定义、算法、播种顺序、论证段保护——
 * 逐字权威）、02-RESEARCH.md「片段级：score 删除与指纹新颖度」、用户已定决策 5
 * （跨源 5-gram 通道：指纹之前、播种序一致、独立计数 cross_source_dup_removed）。
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
 * novelty 删除的上报载荷（R-06）：判定当时的逐片段数值——调用方拿它做逐片段
 * 记账（旧影子双链退役后管道本体不再传回调，参数保留给需要判定时数值的调用方）；
 * snippet 是表行引用，pipeline 的 WorkSnippet 结构上满足
 * （可读 part / mergedFrom 拼配对身份）。
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

/**
 * 日期指纹（d:）：ISO 串与英文月份日期（缩写或全称，"September 25, 2026"）。
 * 线性扫描、无嵌套量词（ReDoS 安全，T-02-04-2）。
 */
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
 * 从片段文本提取事实指纹（五类元素，全部 toLowerCase 归一）：
 * n: 数字（含货币前后缀与 k/M/B/%/x 量词）、d: 日期串（ISO 与英文月份）、
 * c: 代码标识符（反引号内容与点分形态）、q: ≥ 6 词的引号原文、
 * p: 连续大写词组（滤常见功能词）。
 *
 * 指纹只进计数与比对（键 = 'n:'/'d:'/'c:'/'q:'/'p:' 前缀 + 归一原文）；进日志的
 * 是指纹串本身——LOG-03/D-10 允许的记录面（只存 URL、标题、指纹与概率），
 * 片段正文绝不进日志。
 * @returns 指纹集合；空串返回空集
 * @example extractFingerprints('raised $4.2M at 193x speed') 含 'n:$4.2m' 与 'n:193x'
 * @example extractFingerprints('the launch was smooth') 为空集
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
 * 步 7 后半：按 Brave 原序遍历 keep 来源的幸存片段（score 删除后的 kept 片段）。
 *
 * 每片段的判定顺序固定：
 * 1. **跨来源 5-gram 逐字 dup 先行**（通稿转载、页内标题导语重抽）——片段的
 *    shingles 与"已幸存 shingle 并集"按 isNearDuplicate 同一口径比较（步 3 与步 7
 *    同一度量，否则"先于指纹"失去可比性），命中 → kept=false、reason 'dup'、
 *    cross_source_dup_removed 加一；论证段保护**不豁免**——逐字转载不是原创论证
 *    （用户已定决策 5 / 计划 flagged）；
 * 2. 未命中再做**指纹新颖度**判定：novel = fp(片段) − 幸存指纹并集，
 *    `fp.size >= minFacts 且 novel.size < noveltyMin` 才删（事实太少不判，交给
 *    片段级评分；NOVELTY_MIN 含 2——novel=2 保留）、reason 'novelty'、
 *    novelty_removed 加一；`reasoning >= reasoningProtect` 的来源免于此判（论证段
 *    也含公司名等专名指纹，会被误当重复）；
 * 3. 幸存片段的 shingles 与指纹并入并集（被删片段不并入）。
 *
 * 管道不重排幸存者：只翻 kept/reason 标记，输出仍按 Brave 原序重建（RULES-08）。
 * shingle 只进比对、绝不外流；指纹进比对之外，新颖度删除的指纹明细按 D-10 记进
 * `stats.local.novelty`（LOG-03 允许的记录面——只存 URL、标题、指纹与概率）。
 * @returns 逐源 Jev 侧删除标记表（novelty / crossSourceDup 两个布尔），供步 8
 *   rewrite/empty 归因——只在发生过对应删除时含该来源
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

  // D-10 明细（A3 聚合口径）：只为发生过指纹新颖度删除的来源记条目；fp_total =
  // 该来源被删片段指纹的并集大小；novel = 条目并集减去幸存指纹并集（在每次删除
  // 时重算——增量语义"对指纹并集而言首次出现 novel"，删除后 union 只增不减，
  // 最后一次删除后的条目即最终态）。证据在被删片段的指纹里，幸存片段聚合会把
  // 证据丢掉；cross_source_dup 删除不建条目（明细只指新颖度指纹通道）。
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
          // 判定当时的逐片段数值只在此时可得（事后无法从聚合复原，C-02）
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
  // 明细写回（替换式，绝不 mutate 载体浅拷贝共享的 zeroLocal.novelty 空数组）；
  // 条目按首次命中删除的顺序排列——即 Brave 原序；统计投影与输出同序，不为此重排
  // 数据（C-03）
  if (noveltyDetails.length > 0) {
    stats.local.novelty = noveltyDetails;
  }
  return flags;
}
