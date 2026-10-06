/**
 * 清理 X (Twitter) 页面中的界面文字，具体页面和动作由本模块判定。
 * 保留正文与行尾，保护代码与引用；全部规则基于同一输入快照。
 * 清洗后重判若产生新的命中则整轮放弃，避免非幂等或递归扩删。
 */

import { codeRegionFlags } from './prefilter.js';
import type { XCleanupAction, XCleanupResult } from './types.js';

/** 规则 2 的相关热搜推荐标题行。 */
const RELATED_TRENDING_HEADING = 'Related Trending Stories on X';

/** 规则 3 的成对侧边栏卡片首两行。 */
const AUTH_HEADING = 'Log in or sign up for X';
const RELEVANT_HEADING = 'Relevant people';

/** 只剥 CommonMark ATX 标题标记再 trim。 */
const stripAtxHeading = (line: string): string => line.replace(/^ {0,3}#{1,6}[ \t]+/, '').trim();

/**
 * 保护引用行及其非空懒续行；空行或 ATX 标题结束引用段落。
 */
const referenceGuardFlags = (
  contents: readonly string[],
  codeFlags: readonly boolean[]
): boolean[] => {
  const flags: boolean[] = [];
  let open = false;
  for (let index = 0; index < contents.length; index += 1) {
    const line = contents[index];
    if (/^ {0,3}>/.test(line)) {
      flags.push(true);
      open = true;
      continue;
    }
    if (line.trim() === '') {
      flags.push(false);
      open = false;
      continue;
    }
    if (codeFlags[index]) {
      flags.push(true);
      continue;
    }
    if (open && !/^ {0,3}#{1,6}[ \t]/.test(line)) {
      flags.push(true);
      continue;
    }
    flags.push(false);
    open = false;
  }
  return flags;
};

/** 解析来源 URL 得到本模块支持的 X 页面类别。 */
export type XCleanPage = {
  kind: 'status' | 'trending' | 'profile';
};

/** 排除与用户主页同为单段路径的 X 全局保留路径。 */
const X_GLOBAL_NAMESPACES: readonly string[] = [
  'home',
  'explore',
  'notifications',
  'messages',
  'settings',
  'i',
  'search',
  'login',
  'logout',
  'signup',
  'tos',
  'privacy',
];

export const parseXPage = (url: string): XCleanPage | null => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  if (
    host !== 'x.com' &&
    host !== 'www.x.com' &&
    host !== 'twitter.com' &&
    host !== 'www.twitter.com'
  ) {
    return null;
  }

  const segments = parsed.pathname.split('/');
  segments.shift();
  while (segments.length > 0 && segments[segments.length - 1] === '') segments.pop();
  if (segments.length === 0 || segments.some((segment) => segment === '')) return null;
  const validUser =
    /^[A-Za-z0-9_]{1,15}$/.test(segments[0]) &&
    !X_GLOBAL_NAMESPACES.includes(segments[0].toLowerCase());

  // 1. Trending 聚合页：/i/trending/<id>
  if (
    segments.length === 3 &&
    segments[0] === 'i' &&
    segments[1] === 'trending' &&
    /^\d+$/.test(segments[2])
  ) {
    return { kind: 'trending' };
  }

  // 2. Status 详情页：/<user>/status/<id>
  const statusShape =
    segments.length === 3 ||
    (segments.length === 5 &&
      /^(photo|video)$/.test(segments[3]) &&
      /^[1-9]\d*$/.test(segments[4]));
  if (validUser && statusShape && segments[1] === 'status' && /^\d+$/.test(segments[2])) {
    return { kind: 'status' };
  }

  // 3. Profile 页面：/<user>
  if (segments.length === 1 && validUser) {
    return { kind: 'profile' };
  }

  return null;
};

/**
 * 当前规则的纯判定：输入片段文本与页面类别，输出删行计划与逐动作清单。
 */
const judgeCleanup = (
  text: string
): {
  lines: string[];
  contents: string[];
  deleteLine: boolean[];
  actions: XCleanupAction[];
} => {
  const lines = text.split(/(?<=\n)/);
  const contents = lines.map((line) => line.replace(/\r?\n$/, ''));
  const normalized = contents.map(stripAtxHeading);
  const codeFlags = codeRegionFlags(contents);
  const referenceFlags = referenceGuardFlags(contents, codeFlags);
  const guarded = contents.map((_, index) => codeFlags[index] || referenceFlags[index]);

  const deleteLine: boolean[] = new Array(lines.length).fill(false);
  const actions: XCleanupAction[] = [];

  // —— 规则 1：相关热搜推荐标题行 (Related Trending Stories on X) ——
  for (let index = 0; index < contents.length; index += 1) {
    if (!guarded[index] && normalized[index] === RELATED_TRENDING_HEADING) {
      deleteLine[index] = true;
      actions.push({ rule: 'related_trending_heading', line: index + 1 });
    }
  }

  // —— 规则 2：独立展开按钮行；行内同名文字无法可靠区分正文，予以保留。 ——
  for (let index = 0; index < contents.length; index += 1) {
    if (guarded[index]) continue;
    if (normalized[index] === 'Show more') {
      deleteLine[index] = true;
      actions.push({ rule: 'show_more_button', line: index + 1 });
      continue;
    }
  }

  // —— 规则 3：登录拦截与推荐作者侧边栏卡片 (auth_sidebar_card) ——
  if (!guarded.some(Boolean)) {
    const nonempty = contents
      .map((rowText, index) => ({ rowText, index }))
      .filter(({ rowText }) => rowText.trim() !== '');

    const isHeading = (rowAt: number, target: string): boolean => {
      const row = nonempty[rowAt];
      return row !== undefined && normalized[row.index] === target;
    };

    if (nonempty.length >= 2 && isHeading(0, AUTH_HEADING) && isHeading(1, RELEVANT_HEADING)) {
      // 片段可能继续包含人物简介或帖子正文，只删除已确认的两个界面标题。
      for (const { index } of nonempty.slice(0, 2)) {
        deleteLine[index] = true;
        actions.push({ rule: 'auth_sidebar_card', line: index + 1 });
      }
    }
  }

  return { lines, contents, deleteLine, actions };
};

/** 按 judgeCleanup 的计划应用删行，幸存行保持原序、行尾字节逐字保留。 */
const applyCleanup = (plan: ReturnType<typeof judgeCleanup>): string => {
  const out: string[] = [];
  for (let index = 0; index < plan.lines.length; index += 1) {
    if (plan.deleteLine[index]) continue;
    out.push(plan.lines[index]);
  }
  return out.join('');
};

/**
 * 返回清洗文本与动作清单，行号从进入清洗时的片段首行按 1 起算。
 * 不支持或未命中时原样返回；应用后重判仍有命中时整轮放弃，保证幂等。
 */
export function cleanXBoilerplate(text: string, url: string): XCleanupResult {
  const page = parseXPage(url);
  if (page === null || text === '') return { text, actions: [] };

  const plan = judgeCleanup(text);
  if (plan.actions.length === 0) return { text, actions: plan.actions };

  const cleaned = applyCleanup(plan);
  const verify = judgeCleanup(cleaned);
  if (verify.actions.length > 0) return { text, actions: [] };

  return { text: cleaned, actions: plan.actions };
}
