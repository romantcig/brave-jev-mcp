/**
 * 非文章规则：feed / 黑名单、空来源 / 一句话来源、付费墙截断。
 * 纯函数，不修改输入；无法解析 URL 时保守不判。
 */

import { normalizeLine, stripTrailingPunctuation } from './prefilter.js';
import { tokenize } from './tokenize.js';

/** feed 判定的路径末段名：末段（去掉扩展名之前）恰为其一即判 feed。可增补。 */
export const FEED_SEGMENT_NAMES: ReadonlySet<string> = new Set(['feed', 'feeds', 'rss', 'atom']);

/** 路径末段以这些后缀结尾即判 feed。可增补。 */
export const FEED_PATH_SUFFIXES: readonly string[] = ['.xml', '.rss', '.atom'];

/**
 * 依次检查 feeds. 主机前缀、路径末段后缀、末段 feed 词和 feed 查询参数。
 * 不对主机名或整条路径任意分词，避免将 rss-parser 等项目名误判为 feed。
 * 解析失败返回 false。
 */
export function isFeedUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }

  if (url.hostname.toLowerCase().startsWith('feeds.')) return true;

  const lastSegment = url.pathname.split('/').filter(Boolean).pop();
  if (lastSegment !== undefined) {
    const segment = lastSegment.toLowerCase();
    if (FEED_PATH_SUFFIXES.some((suffix) => segment.endsWith(suffix))) return true;
    if (FEED_SEGMENT_NAMES.has(segment)) return true;
  }

  return url.searchParams.has('feed');
}

/**
 * 主机规则匹配规范 host 及其子域；URL 规则要求精确主机。
 * URL 路径末尾斜杠表示栏目范围，否则精确匹配路径。
 */
export function isBlocklisted(
  canonicalHost: string,
  blocklist: ReadonlySet<string>,
  rawUrl?: string
): boolean {
  if (blocklist.has(canonicalHost)) return true;
  for (const entry of blocklist) {
    if (/^https?:\/\//i.test(entry)) {
      if (!rawUrl) continue;
      try {
        const rule = new URL(entry);
        const candidate = new URL(rawUrl);
        if (!['http:', 'https:'].includes(candidate.protocol)) continue;
        const ruleHost = rule.hostname.toLowerCase().replace(/^www\./, '');
        const candidateHost = candidate.hostname.toLowerCase().replace(/^www\./, '');
        // URL 规则只命中精确主机，不自动扩展到所有子域；协议不影响同一页面身份。
        if (ruleHost !== canonicalHost || candidateHost !== canonicalHost) continue;
        if (rule.username || rule.password || rule.search || rule.hash || rule.port) continue;
        if (
          candidate.pathname === rule.pathname ||
          (rule.pathname.endsWith('/') && candidate.pathname.startsWith(rule.pathname))
        )
          return true;
      } catch {
        // 不可解析的 URL 不匹配。
      }
      continue;
    }
    if (canonicalHost.endsWith(`.${entry}`)) return true;
  }
  return false;
}

/** 最小片段形状：调用方（pipeline 工作表）预算好的幸存片段。 */
type SurvivingSnippet = {
  text: string;
};

/** 仅按幸存片段数判空，不依赖 sources 元数据。 */
export function isEmptySource(survivingSnippets: readonly SurvivingSnippet[]): boolean {
  return survivingSnippets.length === 0;
}

/**
 * 恰好一条片段、长度 < maxLength 且不含 query 实词时判为一句话来源。
 * 本规则只使用 query；intent 的匹配由 Jev 评分处理。queryTerms 为空时保守保留。
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
 * 按归一后的整行匹配付费墙标记，截断该行及其后内容。
 * 不能用 startsWith，否则 “Premium content pays the bills.” 等正文会误触发。
 * 只处理当前片段；截断后可为空，由调用方记为 paywall_empty。
 */
export function truncateAtPaywall(
  text: string,
  markers: readonly string[]
): { text: string; truncated: boolean } {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = stripTrailingPunctuation(normalizeLine(lines[i]).toLowerCase());
    const hit = markers.some((marker) => {
      const entry = stripTrailingPunctuation(normalizeLine(marker).toLowerCase());
      return line === entry;
    });
    if (!hit) continue;

    return { text: lines.slice(0, i).join('\n').trimEnd(), truncated: true };
  }
  return { text, truncated: false };
}
