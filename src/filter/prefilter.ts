/**
 * 管道步 3：片段预筛谓词（样板行剥离、短且无实词、页内逐字重复）。
 *
 * 全部是无副作用纯函数：不读 `process.env`、不写文件、不改入参，同一输入重复
 * 调用返回深相等结果，可安全并发。实词集与前缀表由调用方（pipeline.ts）预算
 * 一次传入，谓词自身无状态——形态照 src/protocols/rebinding.ts 的 is* 谓词。
 *
 * 依据：notes/local-rules-design.md §3、01-RESEARCH.md「规则 3（步 3）」、
 * Assumptions A9（行级剥离）、A10（200 字符阈值）、A11（包含度）。
 */

import { containment, jaccard, tokenize } from './tokenize.js';

/** "短"阈值：长度判定统一用 String.length（UTF-16 码元）。 */
export const SHORT_SNIPPET_MAX = 200;

/** 页内逐字重复判定的 shingle 窗口宽度。 */
export const SHINGLE_N = 5;

/** Jaccard 严格大于该值才算重复（恰为 0.8 不删）。 */
export const NEAR_DUP_JACCARD = 0.8;

/** 包含度达到该值即算重复（恰为 0.8 删）。 */
export const NEAR_DUP_CONTAINMENT = 0.8;

/** 参与重复判定的最小 shingle 集合规模；更短的片段不做重复判定（保守留）。 */
export const MIN_SHINGLES = 8;

/**
 * 行归一化：去掉前导 `#`/`*`/`-` 标记（含其间空白）后 trim。
 * @returns 归一化后的行文本；不压缩行中空白、不改大小写
 * @example normalizeLine('## Frequently Asked Questions (FAQ)') === 'Frequently Asked Questions (FAQ)'
 * @example normalizeLine('   *Share') === 'Share'
 */
export function normalizeLine(line: string): string {
  return line.replace(/^[#*\s-]+/, '').trim();
}

/**
 * 行首前缀匹配：**行与前缀两侧都用同一个 normalizeLine 归一化**再忽略大小写比对。
 * 两侧同法归一化是必需的——前缀表里有 `## Frequently Asked Questions` 这种自带
 * 标记的条目，若只归一化行那一侧，它永远不命中。不用无界正则（ReDoS，T-01-03-01）。
 * @returns 归一化后的行以任一归一化前缀开头时为真
 * @example matchesPrefix('## Frequently Asked Questions (FAQ)', ['## Frequently Asked Questions']) === true
 * @example matchesPrefix('Read our READ MORE section', ['READ MORE']) === false
 */
export function matchesPrefix(normalizedLine: string, prefixes: readonly string[]): boolean {
  const line = normalizeLine(normalizedLine).toLowerCase();
  return prefixes.some((prefix) => line.startsWith(normalizeLine(prefix).toLowerCase()));
}

/**
 * 来源标题比较用的归一化：去前导标记、压缩连续空白、小写——与 jsonld.ts 的
 * `normalizeTitleForCompare` 同一语义，直接复用避免两套规则漂移。
 */
const normalizeForTitleCompare = (text: string): string =>
  text
    .trim()
    .replace(/^[#*-]+/, '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();

/**
 * 剥离后是否只剩来源标题（归一化后相等）。
 * @returns 文本与标题归一化后相等时为真（两者都为空串也算相等）
 * @example isTitleOnly('# Sanity Studio upgrade planner Skill', 'Sanity Studio upgrade planner Skill') === true
 * @example isTitleOnly('Body text', 'Title') === false
 */
export function isTitleOnly(text: string, sourceTitle: string): boolean {
  return normalizeForTitleCompare(text) === normalizeForTitleCompare(sourceTitle);
}

/**
 * 样板行剥离：删掉命中前缀的行后重新拼接并 `trim()`。
 * @returns 剥离后的文本；`emptied` 为真表示剥空或只剩来源标题——两种情形都整片删
 *   （原因 `boilerplate`），其余情形保留剥离后的文本（动作 `boilerplate_stripped`）
 * @example stripBoilerplateLines('Share\n\n正文', ['Share'], 'T') → { text: '正文', emptied: false }
 * @example stripBoilerplateLines('Share\n\n# T', ['Share'], 'T') → { text: 'T', emptied: true }
 */
export function stripBoilerplateLines(
  text: string,
  prefixes: readonly string[],
  sourceTitle: string
): { text: string; emptied: boolean } {
  const stripped = text
    .split(/\r?\n/)
    .filter((line) => !matchesPrefix(line, prefixes))
    .join('\n')
    .trim();

  return { text: stripped, emptied: stripped === '' || isTitleOnly(stripped, sourceTitle) };
}

/**
 * 短且无实词：长度 < maxLength 且实词集里没有任何词出现在片段 token 中，两条
 * **同时满足**才删。实词集为空时恒为假（保守留）；空串按长度 0 处理（真）。
 * @returns 判定为"短且无实词"时为真
 * @example isShortWithoutTerms('On this page', terms) === true（39 字符、无实词）
 * @example isShortWithoutTerms('x'.repeat(200), terms) === false（达到阈值不删）
 * @example isShortWithoutTerms('short', new Set()) === false
 */
export function isShortWithoutTerms(
  text: string,
  terms: ReadonlySet<string>,
  maxLength: number = SHORT_SNIPPET_MAX
): boolean {
  if (terms.size === 0) return false;
  if (text.length >= maxLength) return false;

  const tokens = new Set(tokenize(text));
  for (const term of terms) {
    if (tokens.has(term)) return false;
  }
  return true;
}

/**
 * 页内逐字重复：与已幸存片段的 5-gram 集合比，`jaccard > 0.8` **或**
 * `containment >= 0.8` 即重复（任一侧 shingle 少于 8 个不判——RESEARCH 实测真实
 * 重复表现为包含关系，纯 Jaccard 抓不到，见 Assumption A11）。
 * @returns 判定为近重复时为真（保留先出现者由调用方保证：按原序只与已幸存者比）
 * @example isNearDuplicate(sameShingles, sameShingles) === true
 * @example isNearDuplicate(sevenShingles, anything) === false（不足 MIN_SHINGLES 不判）
 */
export function isNearDuplicate(
  candidateShingles: ReadonlySet<string>,
  survivorShingles: ReadonlySet<string>
): boolean {
  if (survivorShingles.size < MIN_SHINGLES || candidateShingles.size < MIN_SHINGLES) {
    return false;
  }
  return (
    jaccard(candidateShingles, survivorShingles) > NEAR_DUP_JACCARD ||
    containment(candidateShingles, survivorShingles) >= NEAR_DUP_CONTAINMENT
  );
}
