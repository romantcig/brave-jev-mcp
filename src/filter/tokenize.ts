/**
 * 中英分词、实词集与 5-gram 相似度助手。
 *
 * 分词先按 Unicode script 切段（Han、假名、谚文各成连续段），CJK 段转**字符二元**
 * （「内容发布」→ 内容 / 容发 / 发布，单字保留），Latin 与数字段小写后整段输出——
 * 直接用 `[\p{L}]+` 会把整段汉字粘成一个 token（RESEARCH Pitfall 9），中文片段将
 * 永远"不含实词"。实词集 = token 去停用词；5-gram shingle 与两种相似度供页内
 * 逐字重复判定使用。
 *
 * 依据：01-RESEARCH.md「通用：分词与实词集」「Code Examples: 5-gram shingle 与两种相似度」、
 * notes/local-rules-design.md §3。
 */

/**
 * Unicode script 切段：Han / 假名 / 谚文各成连续段，其余按连续字母数字段。Han 必须在最前——
 * 假名与谚文字符同属 `\p{L}`，交替顺序决定归属。假名分支用 Script_Extensions（scx）：
 * 长音符 ー 的 Script 是 Common，scx 才把它收进假名段。最后一个分支逐字符**排除 CJK**——
 * 汉字/假名/谚文都属 `\p{L}`，不排除时 `Sanity发布了v6版本` 会被整段粘成一个 token，
 * 中文 query 实词全部丢失；前瞻逐字符判定是线性的，无嵌套回溯（ReDoS 安全）。
 */
export const SCRIPT_PATTERN: RegExp =
  /\p{Script=Han}+|[\p{scx=Hiragana}]+|[\p{scx=Katakana}]+|\p{Script=Hangul}+|(?:(?![\p{Script=Han}\p{scx=Hiragana}\p{scx=Katakana}\p{Script=Hangul}])[\p{L}\p{N}])+/gu;

/** 段是否为 CJK（Han / 假名 / 谚文，假名含 scx 收编的 ー）；此类段转字符二元，其余段按词输出。样板/标记表的中文条目判定也用它。 */
export const CJK_SEGMENT = /^[\p{Script=Han}\p{scx=Hiragana}\p{scx=Katakana}\p{Script=Hangul}]+$/u;

/**
 * 停用词：英文功能词与搜索套话、中文二元套话。
 * 列表**可增补**；出处 01-RESEARCH.md「通用：分词与实词集」（notes/local-rules-design.md §3）。
 */
export const STOPWORDS: ReadonlySet<string> = new Set([
  // 英文功能词与搜索套话
  'the',
  'a',
  'an',
  'of',
  'in',
  'on',
  'for',
  'to',
  'and',
  'or',
  'is',
  'are',
  'was',
  'be',
  'with',
  'by',
  'at',
  'from',
  'as',
  'it',
  'this',
  'that',
  'what',
  'how',
  'why',
  'when',
  'which',
  'who',
  'do',
  'does',
  'can',
  'about',
  'into',
  'than',
  'then',
  'not',
  'no',
  'vs',
  'versus',
  'new',
  'latest',
  'current',
  'best',
  'guide',
  'tutorial',
  'using',
  'use',
  'based',
  // 中文二元套话
  '怎么',
  '如何',
  '什么',
  '教程',
  '方法',
  '使用',
  '最新',
  '当前',
]);

/**
 * 按 Unicode script 切段分词：CJK 段转字符二元（长度 1 保留单字），其余段小写输出。
 * @returns token 数组；空串或纯空白输入返回空数组
 * @example tokenize('内容发布') → ['内容', '容发', '发布']
 * @example tokenize('Jev 内容发布 v6') → ['jev', '内容', '容发', '发布', 'v6']
 * @example tokenize('sanity.config.ts') → ['sanity', 'config', 'ts']
 */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  for (const { 0: segment } of text.matchAll(SCRIPT_PATTERN)) {
    if (!CJK_SEGMENT.test(segment)) {
      tokens.push(segment.toLowerCase());
      continue;
    }
    if (segment.length === 1) {
      tokens.push(segment);
      continue;
    }
    for (let i = 0; i + 1 < segment.length; i++) {
      tokens.push(segment.slice(i, i + 2));
    }
  }
  return tokens;
}

/**
 * 实词集：多段文本合并 tokenize 后去停用词。步 3 传 query ∪ intent，步 8 只传 query。
 * @returns 去重后的实词集合（新对象，不共享内部状态）
 * @example contentTerms('Jev TypeSafe AI model release') 含 'jev' 与 'release'，不含 'the'
 * @example contentTerms('怎么 如何') 为空集（中文套话二元全被剔除）
 */
export function contentTerms(...texts: string[]): Set<string> {
  const terms = new Set<string>();
  for (const text of texts) {
    for (const token of tokenize(text)) {
      if (!STOPWORDS.has(token)) terms.add(token);
    }
  }
  return terms;
}

/**
 * token 序列的 n-gram shingle 集合（窗口按单空格连接）。
 * @returns 去重后的 shingle 集合；少于 n 个 token 时为空集合
 * @example shingles(['a', 'b', 'c', 'd', 'e']) 为 {'a b c d e'}
 * @example shingles(['a', 'b', 'c', 'd']).size === 0
 */
export function shingles(tokens: string[], n = 5): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + n <= tokens.length; i++) {
    out.add(tokens.slice(i, i + n).join(' '));
  }
  return out;
}

/**
 * Jaccard 相似度：交并比。
 * @returns `|A∩B| / |A∪B|`；任一集合为空时返回 0
 * @example jaccard(new Set(['a', 'b', 'c']), new Set(['a', 'b', 'd'])) === 0.5
 * @example jaccard(new Set(), new Set(['a'])) === 0
 */
export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  return inter / (a.size + b.size - inter);
}

/**
 * 包含度：交集除以较小集合的大小（RESEARCH 规则 3 / Assumption A11 要求的两种相似度
 * 之一）。isNearDuplicate **不**用它：判定方向是"候选自身被幸存者覆盖的比例"（交/|候选|），
 * 若用 containment，候选是幸存者超集时包含度恒为 1，信息更全的后一条会被误删。
 * @returns `|A∩B| / min(|A|, |B|)`；任一集合为空时返回 0
 * @example containment(new Set(['a', 'b']), new Set(['a', 'b', 'c'])) === 1
 * @example containment(new Set(), new Set(['a'])) === 0
 */
export function containment(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  if (small.size === 0) return 0;
  let inter = 0;
  for (const x of small) if (big.has(x)) inter += 1;
  return inter / small.size;
}
