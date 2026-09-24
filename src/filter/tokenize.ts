/**
 * 中英分词、实词集与 5-gram 相似度助手。
 *
 * 【RED 桩】本文件先落签名与类型，函数体一律抛 "not implemented"：
 * 让 tokenize.test.ts 能加载并在断言处失败（而非模块加载崩溃），
 * GREEN 提交再填实实现。
 *
 * 依据：01-RESEARCH.md「通用：分词与实词集」「Code Examples: 5-gram shingle 与两种相似度」。
 */

/** Unicode script 切段：Han / 假名 / 谚文各成连续段，其余按连续字母数字段。 */
export const SCRIPT_PATTERN: RegExp =
  /\p{Script=Han}+|[\p{Script=Hiragana}]+|[\p{Script=Katakana}]+|[\p{Script=Hangul}]+|[\p{L}\p{N}]+/gu;

/** 停用词表（RED 桩占位）。 */
export const STOPWORDS: ReadonlySet<string> = new Set<string>();

export function tokenize(_text: string): string[] {
  throw new Error('tokenize: not implemented (RED stub)');
}

export function contentTerms(..._texts: string[]): Set<string> {
  throw new Error('contentTerms: not implemented (RED stub)');
}

export function shingles(_tokens: string[], _n?: number): Set<string> {
  throw new Error('shingles: not implemented (RED stub)');
}

export function jaccard(_a: ReadonlySet<string>, _b: ReadonlySet<string>): number {
  throw new Error('jaccard: not implemented (RED stub)');
}

export function containment(_a: ReadonlySet<string>, _b: ReadonlySet<string>): number {
  throw new Error('containment: not implemented (RED stub)');
}
