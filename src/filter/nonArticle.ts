/**
 * 非文章页与来源级规则：步 4 feed / 黑名单、步 8 空来源 / 一句话来源、付费墙截断。
 *
 * 全部是无副作用纯函数：不读 `process.env`、不写文件、不改入参，同一输入重复
 * 调用返回深相等结果，可安全并发（RULES-04/concurrency）。坏 URL 一律按"判不出
 * → 不判"处理，方向保守（T-01-03-02）。
 *
 * 依据：notes/non-article-pages.md「处理」表、01-RESEARCH.md「规则 4」「规则 7」「规则 8」。
 */

import { normalizeLine } from './prefilter.js';
import { tokenize } from './tokenize.js';

/** feed 判定的 token：hostname 与 pathname 按 `/ . - _` 切出的任一 token 等于其一即判 feed。可增补。 */
export const FEED_TOKENS: ReadonlySet<string> = new Set(['rss', 'feed', 'feeds', 'atom']);

/** 路径末段以这些后缀结尾即判 feed。可增补。 */
export const FEED_PATH_SUFFIXES: readonly string[] = ['.xml', '.rss', '.atom'];

/**
 * feed URL 判定：token 匹配而非子串——子串会误杀 `feedback`、`newsfeed-article`、
 * `grassroots`（RESEARCH Pitfall 8 / Assumption A12）。判定顺序：`feeds.` 前缀 →
 * host/path token → 路径末段后缀 → `feed` 查询参数；解析失败一律不判（保守留）。
 * @returns 判定为 feed 时为真
 * @example isFeedUrl('https://feeds.example.com/rss.xml') === true
 * @example isFeedUrl('https://example.com/x?feed=rss2') === true
 * @example isFeedUrl('https://example.com/feedback-form') === false
 * @example isFeedUrl('https://example.com/newsfeed-article') === false
 * @example isFeedUrl('https://example.com/grassroots') === false
 * @example isFeedUrl('not a url') === false
 */
export function isFeedUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }

  const hostname = url.hostname.toLowerCase();
  if (hostname.startsWith('feeds.')) return true;

  const tokens = [...hostname.split(/[/.-_]/), ...url.pathname.toLowerCase().split(/[/.-_]/)];
  if (tokens.some((token) => FEED_TOKENS.has(token))) return true;

  const lastSegment = url.pathname.split('/').filter(Boolean).pop();
  if (
    lastSegment !== undefined &&
    FEED_PATH_SUFFIXES.some((suffix) => lastSegment.toLowerCase().endsWith(suffix))
  ) {
    return true;
  }

  return url.searchParams.has('feed');
}

/**
 * 黑名单匹配：在**规范 host**（小写、去 `www.`，由调用方归一化）上比对——条目
 * 命中其自身与任意子域（结构性农场常按语言分子域，Assumption A13）。
 * @returns host 是某条目或其子域时为真
 * @example isBlocklisted('farm.example', new Set(['farm.example'])) === true
 * @example isBlocklisted('sub.farm.example', new Set(['farm.example'])) === true
 * @example isBlocklisted('notfarm.example', new Set(['farm.example'])) === false
 */
export function isBlocklisted(canonicalHost: string, blocklist: ReadonlySet<string>): boolean {
  if (blocklist.has(canonicalHost)) return true;
  for (const entry of blocklist) {
    if (canonicalHost.endsWith(`.${entry}`)) return true;
  }
  return false;
}

/** 最小片段形状：调用方（pipeline 工作表）预算好的幸存片段。 */
type SurvivingSnippet = {
  text: string;
};

/**
 * 空来源判定：幸存片段数为 0。来源在 `sources` 元数据里缺条目不影响本判定，
 * 全程不抛异常（RULES-05/empty）。
 * @returns 幸存片段为空数组时为真
 * @example isEmptySource([]) === true
 */
export function isEmptySource(survivingSnippets: readonly SurvivingSnippet[]): boolean {
  return survivingSnippets.length === 0;
}

/**
 * 一句话来源判定：恰好一条幸存片段、长度 < maxLength、且与 **query 实词集**（不含
 * intent——步 3 已用并集过滤过，用并集本条永不生效，Assumption A17）无交集。
 * `queryTerms` 为空集时恒为假（保守留）。
 * @returns 判定为"一句话来源"时为真（调用方按 `empty` 丢来源）
 * @example isOneLiner([{ text: 'the current version' }], contentTerms('foo bar')) === true
 * @example isOneLiner([{ text: 'foo explained' }], contentTerms('foo bar')) === false
 * @example isOneLiner([{ text: 'a' }, { text: 'b' }], contentTerms('foo')) === false
 */
export function isOneLiner(
  survivingSnippets: readonly SurvivingSnippet[],
  queryTerms: ReadonlySet<string>,
  maxLength: number = 200
): boolean {
  if (queryTerms.size === 0) return false;
  if (survivingSnippets.length !== 1) return false;

  const [snippet] = survivingSnippets;
  if (snippet.text.length >= maxLength) return false;

  const tokens = new Set(tokenize(snippet.text));
  for (const term of queryTerms) {
    if (tokens.has(term)) return false;
  }
  return true;
}

/**
 * 付费墙截断：按行扫描，找第一行（normalizeLine 后、忽略大小写）以任一标记开头的行，
 * 保留其之前的文本并 `trimEnd()`。标记只在行首匹配——句中出现（例如一篇讨论付费墙
 * 的文章）不截断，避免误伤（Assumption A15）。只做片段级，不据此判整页。
 * @returns `truncated` 为真时 `text` 是截断后文本（可能为空串，调用方按 `paywall_empty` 删）
 * @example truncateAtPaywall('Para.\nSubscribe to continue reading\nx', markers) → { text: 'Para.', truncated: true }
 * @example truncateAtPaywall('No marker here', markers) → { text: 'No marker here', truncated: false }
 */
export function truncateAtPaywall(
  text: string,
  markers: readonly string[]
): { text: string; truncated: boolean } {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = normalizeLine(lines[i]).toLowerCase();
    const hit = markers.some((marker) => line.startsWith(normalizeLine(marker).toLowerCase()));
    if (!hit) continue;

    return { text: lines.slice(0, i).join('\n').trimEnd(), truncated: true };
  }
  return { text, truncated: false };
}
