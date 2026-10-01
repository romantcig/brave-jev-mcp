/**
 * GitHub 平台界面文字局部清洗（filter-rules-9）：在送入 Jev 前，对确定的 GitHub
 * 平台界面行做**行级剥离**——片段正文保持原文，幸存行保持 Brave 原序。清洗后的
 * 文本同时用于 Jev 判断与最终实际返回（管道内同一份片段文本）。
 *
 * 范围（GITHUB_CLEANUP_PLAN 首批五条，较离线实验版收窄）：
 * 1. `repo_nav`——仓库首页独立行 `Repository files navigation`（去 Markdown 标题
 *    标记后精确等于）；
 * 2. `copy_branch_button`——PR 页行尾按钮后缀 ` Copy head branch name to clipboard`，
 *    要求行内含当前仓库限定的分支引用 `owner/repo:分支`（冒号后必须有分支名），
 *    只剥后缀、分支文本完整保留；
 * 3. `search_block`——仓库首页同一连续界面块（允许空行）中出现 `Saved searches`、
 *    `Search code, repositories, users, issues, pull requests...`、`Provide feedback`
 *    三个独立标记时仅删这三个标记行；实质正文（或代码/引用行）打断即不成块；
 * 4. `tag_compare`——Release tag 页 `Choose a tag to compare` 与紧随（允许空行）的
 *    `No results found` 成对出现时仅删这两行；单独出现一律保留；
 * 5. `reactions_unavailable`——Issue / PR / Discussion 详情页独立行精确等于
 *    `Reactions are currently unavailable`。
 *
 * 明确不做（计划的暂缓清单）：`Uh oh!`、`owner / **repo** Public` 面包屑、注册邀请
 * 后缀、`Awesome Jev Awesome` 重复尾词消除——这些规则一律不实现。
 *
 * 保护（GITHUB_CLEANUP_PLAN 第 4 点；filter-rules-9 返修补全）：围栏代码（反引号/
 * 波浪线，开闭长度匹配；未闭合保护到末尾）、缩进代码与跨行内联代码跨度复用
 * prefilter 的 `codeRegionFlags`；引用行与引用段落的懒续行由本模块叠加——引用行
 * 后不带 `>` 的非空行（ATX 标题等明确新块除外）仍属引用内容。保护行既不作为命中
 * 行，也作为连续块 / 成对扫描的**打断**（代码或引用内出现的标记不能触发外部删除）。
 *
 * 幂等（filter-rules-9 返修）：判定全部基于当次输入快照、一次性应用；应用后在新
 * 文本上重新判定，若仍有命中——即本轮删除会让原本不连续的标记接壤成新块（审查
 * R2 的同规则嵌套与跨规则接壤）——则**整轮保守放弃**、原样返回，绝不循环清洗到
 * 固定点（那会扩大已授权的结构匹配范围）。由此保证 `clean(clean(x)) === clean(x)`。
 *
 * 纯函数约束：不读环境变量、不联网、不改入参；未命中时原样返回传入文本（同一
 * 引用）；命中时仅删除命中行与按钮后缀，不做全文 trim、空白折叠、重排或改写，
 * 不额外清理空行。
 *
 * 依据：GITHUB_CLEANUP_PLAN.md（五条首批规则、收窄边界与保护要求）、
 * notes 私有实验产物（2026-09-30..10-02 三天 68 份现场样本的离线回放）。
 */

import { codeRegionFlags } from './prefilter.js';
import type { GitHubCleanupAction, GitHubCleanupResult } from './types.js';

/** 规则 1 的独立行文本（去 Markdown 标题标记后精确比较的目标）。 */
const REPO_NAV_LINE = 'Repository files navigation';

/** 规则 2 的行尾按钮后缀：剥离时连同前导空格一起剥，前面的分支文本逐字保留。 */
const COPY_BUTTON_SUFFIX = ' Copy head branch name to clipboard';

/** 规则 3 的三个界面标记（去 Markdown 标题标记后精确比较的目标全集）。 */
const SEARCH_BLOCK_LINES: readonly string[] = [
  'Saved searches',
  'Search code, repositories, users, issues, pull requests...',
  'Provide feedback',
];

/** 规则 4 的成对提示行。 */
const TAG_COMPARE_PROMPT = 'Choose a tag to compare';
const TAG_COMPARE_EMPTY = 'No results found';

/** 规则 5 的独立行文本（trim 后精确比较，不去标题标记——样本只有裸行证据）。 */
const REACTIONS_UNAVAILABLE = 'Reactions are currently unavailable';

/**
 * 规则 1/3/4 用的行归一化：只剥 CommonMark ATX 标题标记（最多 3 空格缩进、
 * 1–6 个 `#` 后必须跟空格/制表符——`#tag` 不是标题）再 trim。**不复用**
 * `normalizeLine`：它把 `*` / `-` 列表符也当标记剥掉，会把列表行误纳入精确
 * 等于的命中面，超出计划"去除 Markdown 标题标记"的授权范围。
 */
const stripAtxHeading = (line: string): string => line.replace(/^ {0,3}#{1,6}[ \t]+/, '').trim();

/**
 * 引用区域标记（引用行 + 引用段落的懒续行）：引用行（`>` 起头）之后的非空行即使
 * 不带 `>` 也可能仍是同一段引用的懒续行（CommonMark lazy continuation）——审查 R1
 * 实证 issue 页 "> GitHub displays this message:" 的下一行被误删为
 * reactions_unavailable。空行结束引用段落；ATX 标题行是明确的新块开始，不视为续行；
 * 围栏/缩进代码行（`codeFlags`）不改变开放状态，其自身已由代码保护覆盖。列表项、
 * HTML 块等其余可能打断段落的形态按续行保守保护——多留可接受，不追求完整解析。
 * @returns 与行数组等长的标记：true = 引用行或引用续行，不参与删除判定
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

/**
 * 解析来源 URL 得到本模块支持的 GitHub 页面类别；不支持的一律 `null`（片段原样
 * 返回）。hostname 精确等于 `github.com` / `www.github.com`（不用字符串包含，
 * `github.com.evil.com` 之类不命中）；查询参数与 fragment 不参与判定；容忍尾
 * 斜杠；路径段含空段、owner/repo 缺失或未知页面路径（Topics、tree/blob、
 * `releases/latest` 等）都返回 `null`。
 */
type GitHubCleanPage = {
  kind: 'repo_root' | 'pull' | 'issue_thread' | 'discussion' | 'release_tag';
  owner: string;
  repo: string;
};

/**
 * GitHub 全局命名空间一级路径：`/topics/redlib` 这类页面与 `/owner/repo` 同为两段
 * 形态，仅凭段数无法区分，按保留名排除（GitHub 保留用户名不可注册，仓库不会误
 * 伤——黑名单漏项的最坏后果只是对全局页应用仓库规则，五条规则在那些页面没有
 * 独立界面行证据，实际命中≈0）。
 */
const GITHUB_GLOBAL_NAMESPACES: readonly string[] = [
  'topics',
  'search',
  'collections',
  'sponsors',
  'settings',
  'marketplace',
  'explore',
  'trending',
  'features',
  'pricing',
  'security',
  'customer-stories',
  'about',
  'orgs',
  'notifications',
  'events',
  'apps',
  'codespaces',
  'education',
  'enterprise',
];

const parseGitHubPage = (url: string): GitHubCleanPage | null => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  if (host !== 'github.com' && host !== 'www.github.com') return null;

  const segments = parsed.pathname.split('/');
  segments.shift(); // pathname 恒以 / 开头，去掉切分出的空首段
  while (segments.length > 0 && segments[segments.length - 1] === '') segments.pop();
  if (segments.length < 2 || segments.some((segment) => segment === '')) return null;

  const owner = segments[0];
  const repo = segments[1];
  const third = segments[2];
  // Issue / PR / Discussion 详情页要求纯数字编号（列表页、milestone 等不命中）
  const numberedThread = segments.length === 4 && third !== undefined && /^\d+$/.test(segments[3]);
  if (segments.length === 2) {
    return GITHUB_GLOBAL_NAMESPACES.includes(owner.toLowerCase())
      ? null
      : { kind: 'repo_root', owner, repo };
  }
  if (numberedThread && third === 'pull') return { kind: 'pull', owner, repo };
  if (numberedThread && third === 'issues') return { kind: 'issue_thread', owner, repo };
  if (numberedThread && third === 'discussions') return { kind: 'discussion', owner, repo };
  if (segments.length >= 5 && third === 'releases' && segments[3] === 'tag' && segments[4] !== '') {
    return { kind: 'release_tag', owner, repo };
  }
  return null;
};

/**
 * 判断 head（剥掉按钮后缀后的行内容）里是否含当前仓库限定的分支引用
 * `owner/repo:分支`。大小写不敏感比对（Brave 返回的 URL 与页面渲染文本大小写
 * 可能漂移）；引用的 owner 前一个字符不得是名称字符——`xowner/repo:`、
 * `sub/owner/repo:` 这类其它路径或仓库名的子串不命中；冒号后必须有非空白内容
 * 作分支名——`owner/repo:` 后直接接按钮后缀（残缺引用）不命中（审查非阻塞补充）。
 */
const containsRepoBranchRef = (head: string, owner: string, repo: string): boolean => {
  const needle = `${owner}/${repo}:`.toLowerCase();
  const lower = head.toLowerCase();
  let at = lower.indexOf(needle);
  while (at >= 0) {
    const prev = at === 0 ? '' : lower[at - 1];
    if (!/[A-Za-z0-9._/-]/.test(prev) && /\S/.test(head.slice(at + needle.length))) {
      return true;
    }
    at = lower.indexOf(needle, at + 1);
  }
  return false;
};

/**
 * 五条规则的纯判定：输入片段文本与页面类别，输出删除/剥后缀计划与逐动作清单。
 * 所有规则都在**同一份输入快照**上判定——规则之间不互相"腾位置"，判定的连续块 /
 * 成对 / 保护结果全部相对该快照，与最终删什么无关。
 */
const judgeCleanup = (
  text: string,
  page: GitHubCleanPage
): {
  lines: string[];
  contents: string[];
  deleteLine: boolean[];
  partialLine: Map<number, string>;
  actions: GitHubCleanupAction[];
} => {
  // 带行尾切分：每行保留原始行尾字节（含 \r\n），未命中的行逐字原样回到输出
  const lines = text.split(/(?<=\n)/);
  const contents = lines.map((line) => line.replace(/\r?\n$/, ''));
  const normalized = contents.map(stripAtxHeading);
  // 保护区域：围栏/缩进/跨行内联代码（复用步 3 的统一识别）+ 引用行及其懒续行
  // （本模块叠加）。识别上下文标记（块成员、配对伙伴）与命中行用同一份保护结果
  const codeFlags = codeRegionFlags(contents);
  const referenceFlags = referenceGuardFlags(contents, codeFlags);
  const guarded = contents.map((_, index) => codeFlags[index] || referenceFlags[index]);

  const deleteLine: boolean[] = new Array(lines.length).fill(false);
  /** 行内局部剥后缀：行号 → 剥后的行内容（行尾字节在应用时从 lines 取回）。 */
  const partialLine = new Map<number, string>();
  const actions: GitHubCleanupAction[] = [];

  // —— 规则 1：仓库导航行（repo_root）——
  if (page.kind === 'repo_root') {
    for (let index = 0; index < contents.length; index += 1) {
      if (!guarded[index] && normalized[index] === REPO_NAV_LINE) {
        deleteLine[index] = true;
        actions.push({ rule: 'repo_nav', line: index + 1 });
      }
    }
  }

  // —— 规则 2：分支复制按钮后缀（PR 详情页）——
  if (page.kind === 'pull') {
    for (let index = 0; index < contents.length; index += 1) {
      if (guarded[index] || !contents[index].endsWith(COPY_BUTTON_SUFFIX)) continue;
      const head = contents[index].slice(0, contents[index].length - COPY_BUTTON_SUFFIX.length);
      if (containsRepoBranchRef(head, page.owner, page.repo)) {
        partialLine.set(index, head);
        actions.push({ rule: 'copy_branch_button', line: index + 1, partial: true });
      }
    }
  }

  // —— 规则 3：搜索界面连续块（repo_root）——
  if (page.kind === 'repo_root') {
    const isMarker = (index: number): boolean =>
      !guarded[index] && SEARCH_BLOCK_LINES.includes(normalized[index]);
    let blockOpen = false;
    const seen = new Set<string>();
    const blockLines: number[] = [];
    // 块收口：三个标记在同一连续块内才删标记行。主循环保证连续性——标记行之间
    // 只可能隔着普通空行（非空非标记行与保护行都直接打断），无需回扫间隔行。
    const flush = (): void => {
      if (blockOpen && seen.size === SEARCH_BLOCK_LINES.length) {
        for (const index of blockLines) {
          deleteLine[index] = true;
          actions.push({ rule: 'search_block', line: index + 1 });
        }
      }
      blockOpen = false;
      seen.clear();
      blockLines.length = 0;
    };
    for (let index = 0; index < contents.length; index += 1) {
      if (isMarker(index)) {
        if (!blockOpen) blockOpen = true;
        seen.add(normalized[index]);
        blockLines.push(index);
      } else if (guarded[index] || contents[index].trim() !== '') {
        flush(); // 非标记行里，保护行或实质正文打断；普通空行不打断
      }
    }
    flush();
  }

  // —— 规则 4：版本比较成对提示（Release tag 详情页）——
  if (page.kind === 'release_tag') {
    for (let index = 0; index < contents.length; index += 1) {
      if (guarded[index] || normalized[index] !== TAG_COMPARE_PROMPT) continue;
      // 紧随（允许普通空行）的最近非空行必须恰是 `No results found`；保护行、
      // 其它正文一律视为不成对，两行都保留
      let partner = -1;
      for (let cursor = index + 1; cursor < contents.length; cursor += 1) {
        if (contents[cursor].trim() === '' && !guarded[cursor]) continue;
        partner = cursor;
        break;
      }
      if (partner < 0 || guarded[partner] || normalized[partner] !== TAG_COMPARE_EMPTY) continue;
      deleteLine[index] = true;
      deleteLine[partner] = true;
      actions.push({ rule: 'tag_compare', line: index + 1 });
      actions.push({ rule: 'tag_compare', line: partner + 1 });
    }
  }

  // —— 规则 5：反应按钮状态行（Issue / PR / Discussion 详情页）——
  if (page.kind === 'issue_thread' || page.kind === 'pull' || page.kind === 'discussion') {
    for (let index = 0; index < contents.length; index += 1) {
      if (!guarded[index] && contents[index].trim() === REACTIONS_UNAVAILABLE) {
        deleteLine[index] = true;
        actions.push({ rule: 'reactions_unavailable', line: index + 1 });
      }
    }
  }

  return { lines, contents, deleteLine, partialLine, actions };
};

/** 按 judgeCleanup 的计划应用删除与剥后缀，幸存行保持原序、行尾字节逐字保留。 */
const applyCleanup = (plan: ReturnType<typeof judgeCleanup>): string => {
  const out: string[] = [];
  for (let index = 0; index < plan.lines.length; index += 1) {
    if (plan.deleteLine[index]) continue;
    const partial = plan.partialLine.get(index);
    if (partial !== undefined) {
      out.push(partial + plan.lines[index].slice(plan.contents[index].length));
    } else {
      out.push(plan.lines[index]);
    }
  }
  return out.join('');
};

/**
 * GitHub 平台界面文字清洗主入口：输入片段原文与来源 URL，输出清洗后的文本与
 * 逐动作清单（每条动作含规则名与 1 起行号——行号相对进入本清洗时的片段文本，
 * 即步 3 付费墙截断之后；GitHub 页面与付费墙标记实际不重叠，动作不记正文，
 * 内容凭行号回 pre_filter 对齐）。非 GitHub、不支持页面或未命中时原样返回，
 * `actions` 为空表。
 *
 * 幂等保证（见文件头）：首判无命中原样返回；有命中则应用后在新文本上重判，
 * 重判仍有命中说明本轮删除制造了原本不成立的接壤块——整轮保守放弃、原样返回。
 */
export function cleanGitHubBoilerplate(text: string, url: string): GitHubCleanupResult {
  const page = parseGitHubPage(url);
  if (page === null || text === '') return { text, actions: [] };

  const plan = judgeCleanup(text, page);
  if (plan.actions.length === 0) return { text, actions: plan.actions };

  const cleaned = applyCleanup(plan);
  const verify = judgeCleanup(cleaned, page);
  if (verify.actions.length > 0) return { text, actions: [] };

  return { text: cleaned, actions: plan.actions };
}
