/**
 * 管道步 3：片段预筛谓词（样板行剥离、短且无实词、页内逐字重复）。
 *
 * 【RED 桩】本文件先落签名与常量，函数体一律抛 "not implemented"：
 * 让 prefilter.test.ts 能加载并在断言处失败（而非模块加载崩溃），
 * GREEN 提交再填实实现。
 *
 * 谓词接收调用方预算好的集合（实词集、前缀表），自身无状态、可安全并发——
 * 形态照 src/protocols/rebinding.ts 的 is* 谓词。
 * 依据：notes/local-rules-design.md §3、01-RESEARCH.md「规则 3（步 3）」、Assumptions A9-A11。
 */

export const SHORT_SNIPPET_MAX = 0;

export const SHINGLE_N = 0;

export const NEAR_DUP_JACCARD = 0;

export const NEAR_DUP_CONTAINMENT = 0;

export const MIN_SHINGLES = 0;

export function normalizeLine(_line: string): string {
  throw new Error('normalizeLine: not implemented (RED stub)');
}

export function matchesPrefix(_normalizedLine: string, _prefixes: readonly string[]): boolean {
  throw new Error('matchesPrefix: not implemented (RED stub)');
}

export function isTitleOnly(_text: string, _sourceTitle: string): boolean {
  throw new Error('isTitleOnly: not implemented (RED stub)');
}

export function stripBoilerplateLines(
  _text: string,
  _prefixes: readonly string[],
  _sourceTitle: string
): { text: string; emptied: boolean } {
  throw new Error('stripBoilerplateLines: not implemented (RED stub)');
}

export function isShortWithoutTerms(
  _text: string,
  _terms: ReadonlySet<string>,
  _maxLength: number = SHORT_SNIPPET_MAX
): boolean {
  throw new Error('isShortWithoutTerms: not implemented (RED stub)');
}

export function isNearDuplicate(
  _candidateShingles: ReadonlySet<string>,
  _survivorShingles: ReadonlySet<string>
): boolean {
  throw new Error('isNearDuplicate: not implemented (RED stub)');
}
