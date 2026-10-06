/**
 * 清理 dev.to 文章的 JSON 目录提纲片段；须在通用 JSON-LD 转换前读取原始结构。
 * 仅识别已知字段组合、密集短行及同页正文中的对应章节，不把 text 字段视为重复证明。
 */

import { normalizeTitleForCompare, parseJsonFragment } from './jsonld.js';
import { codeRegionFlags } from './prefilter.js';
import type { DevToCleanupResult } from './types.js';

/** 提纲至少八个非空短行，每行至多 100 码元；长段落不属于此规则。 */
const OUTLINE_MIN_LINES = 8;
const OUTLINE_MAX_LINE_CHARS = 100;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** 只接受文章的两段路径，排除个人页、标签页与设置等保留路由。 */
const isDevToArticle = (url: string): boolean => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.hostname !== 'dev.to' && parsed.hostname !== 'www.dev.to') return false;
  return /^\/(?!t\/|tags\/|settings\/|search\/)[\w-]+\/[\w-]+\/?$/.test(parsed.pathname);
};

/** 站点标题后缀不属于文章标题；其余文字必须与来源标题一致。 */
const matchesHeadline = (value: unknown, sourceTitle: string): boolean =>
  value === undefined ||
  (typeof value === 'string' &&
    normalizeTitleForCompare(value) ===
      normalizeTitleForCompare(sourceTitle.replace(/ - DEV Community$/i, '')));

/** 仅收集带后续正文的二至六级章节标题；代码、引用和纯标题片段不提供匹配依据。 */
const bodySectionHeadings = (snippets: readonly string[]): Set<string> => {
  const headings = new Set<string>();
  for (const snippet of snippets) {
    const lines = snippet.split(/\r?\n/);
    const code = codeRegionFlags(lines);
    let heading: string | undefined;
    for (const [index, line] of lines.entries()) {
      if (code[index] || line.trim() === '') continue;
      if (/^ {0,3}#{1,6}[ \t]+/.test(line)) {
        heading = /^ {0,3}#{2,6}[ \t]+/.test(line) ? normalizeTitleForCompare(line) : undefined;
      } else if (heading !== undefined && !/^ {0,3}>/.test(line)) {
        headings.add(heading);
        heading = undefined;
      }
    }
  }
  return headings;
};

/**
 * 返回清洗文本与整片动作；其他片段来自同一来源的原始快照，顺序不参与判断。
 * 对象只允许提纲、同名标题与作者字段；问答、额外正文和未知字段不在本规则内。
 */
export function cleanDevToBoilerplate(
  text: string,
  url: string,
  sourceTitle: string,
  otherSnippets: readonly string[]
): DevToCleanupResult {
  const unchanged: DevToCleanupResult = { text, actions: [] };
  if (!isDevToArticle(url)) return unchanged;
  const node = parseJsonFragment(text);
  if (!isRecord(node)) return unchanged;
  const entity = node.mainEntity;
  if (
    !isRecord(entity) ||
    !Object.keys(node).every((key) => ['mainEntity', 'headline', 'author'].includes(key)) ||
    !Object.keys(entity).every((key) => ['text', 'headline', 'author'].includes(key)) ||
    !matchesHeadline(node.headline, sourceTitle) ||
    !matchesHeadline(entity.headline, sourceTitle) ||
    typeof entity.text !== 'string'
  ) {
    return unchanged;
  }

  const lines = entity.text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (
    lines.length < OUTLINE_MIN_LINES ||
    lines.some((line) => line.length > OUTLINE_MAX_LINE_CHARS || /<[^>]+>|```|~~~/.test(line))
  ) {
    return unchanged;
  }

  const headings = bodySectionHeadings(otherSnippets);
  const matched = new Set(lines.map(normalizeTitleForCompare).filter((line) => headings.has(line)));
  // 至少两个不同章节已带正文返回，才能把目录提纲作为站点样板清理。
  if (matched.size < 2) return unchanged;
  return { text: '', actions: [{ rule: 'article_outline' }] };
}
