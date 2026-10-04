/**
 * 按 Unicode script 分词，提供实词集合。
 * CJK 连续段拆成字符二元，避免整句汉字成为单个 token；其他词段转小写。
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

/** 英文功能词、搜索套话与中文二元停用词。 */
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

/** 多段文本分词后去除停用词，返回新的实词集合；一句话来源判断只传 query。 */
export function contentTerms(...texts: string[]): Set<string> {
  const terms = new Set<string>();
  for (const text of texts) {
    for (const token of tokenize(text)) {
      if (!STOPWORDS.has(token)) terms.add(token);
    }
  }
  return terms;
}
