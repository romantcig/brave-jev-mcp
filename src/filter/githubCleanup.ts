/**
 * GitHub 局部清洗：仓库导航、PR 分支复制按钮及 Uh oh!、Release 成对比较提示，
 * 以及仓库首页独立 Topics 标签卡片和已有简介的完整包含回声。
 * search_block / reactions_unavailable 已退役；Conversation 保留。
 *
 * 在 Jev 前处理，幸存正文与行尾逐字保留；代码、引用及懒续行受保护。
 * 全部判定基于输入快照。删除产生新匹配时整轮保守放弃，保证幂等，不递归扩删。
 * earlierSnippets 仅由宿主提供同来源、当前本地步骤已保留的前序片段；
 * 简介只压缩空白后做完整包含，不降低全局 shingle 门槛，不推断语义相似。
 */

import { codeRegionFlags } from './prefilter.js';
import type { GitHubCleanupAction, GitHubCleanupResult } from './types.js';

/** 规则 1 的独立行文本（去 Markdown 标题标记后精确比较的目标）。 */
const REPO_NAV_LINE = 'Repository files navigation';

/** 规则 2 的行尾按钮后缀：剥离时连同前导空格一起剥，前面的分支文本逐字保留。 */
const COPY_BUTTON_SUFFIX = ' Copy head branch name to clipboard';

/** 规则 4 的成对提示行。 */
const TAG_COMPARE_PROMPT = 'Choose a tag to compare';
const TAG_COMPARE_EMPTY = 'No results found';

/**
 * 界面文字使用的行归一化：只剥 CommonMark ATX 标题标记（最多 3 空格缩进、
 * 1–6 个 `#` 后必须跟空格/制表符——`#tag` 不是标题）再 trim。**不复用**
 * `normalizeLine`：它把 `*` / `-` 列表符也当标记剥掉，会把列表行误纳入精确
 * 等于的命中面，超出计划"去除 Markdown 标题标记"的授权范围。
 */
const stripAtxHeading = (line: string): string => line.replace(/^ {0,3}#{1,6}[ \t]+/, '').trim();

/**
 * 引用区域标记（引用行 + 引用段落的懒续行）：引用行（`>` 起头）之后的非空行即使
 * 不带 `>` 也可能仍是同一段引用的懒续行（CommonMark lazy continuation）——审查 R1
 * 引用内的界面文字不得当作页面控件。空行结束引用段落；ATX 标题开始新块；
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
  kind: 'repo_root' | 'pull' | 'release';
  owner: string;
  repo: string;
};

/**
 * GitHub 全局命名空间一级路径：`/topics/redlib` 这类页面与 `/owner/repo` 同为两段
 * 形态，仅凭段数无法区分，按保留名排除（GitHub 保留用户名不可注册，仓库不会误
 * 伤——黑名单漏项的最坏后果只是对全局页应用仓库规则，局部规则在那些页面没有
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
  if (segments.length === 3 && third === 'releases') return { kind: 'release', owner, repo };
  if (segments.length >= 5 && third === 'releases' && segments[3] === 'tag' && segments[4] !== '') {
    return { kind: 'release', owner, repo };
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
 * 当前规则的纯判定：输入片段文本与页面类别，输出删除/剥后缀计划与逐动作清单。
 * 所有规则都在**同一份输入快照**上判定——规则之间不互相"腾位置"，判定的连续块 /
 * 成对 / 保护结果全部相对该快照，与最终删什么无关。
 */
const judgeCleanup = (
  text: string,
  page: GitHubCleanPage,
  earlierSnippets: readonly string[]
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

  // PR 页面精确界面词：只剥离独立行，不删除后面的提交说明或流程图。
  if (page.kind === 'pull') {
    for (let index = 0; index < contents.length; index += 1) {
      if (!guarded[index] && normalized[index] === 'Uh oh!') {
        deleteLine[index] = true;
        actions.push({ rule: 'pr_uh_oh', line: index + 1 });
      }
    }
  }

  // —— 规则 4：版本比较成对提示（Release 列表与 tag 详情页）——
  if (page.kind === 'release') {
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

  if (page.kind === 'repo_root' && !guarded.some(Boolean)) {
    const nonempty = contents
      .map((text, index) => ({ text, index }))
      .filter(({ text }) => text.trim() !== '');
    const heading = (at: number, value: string): boolean => {
      const row = nonempty[at];
      return (
        row !== undefined && /^ {0,3}#{1,6}[ 	]+/.test(row.text) && normalized[row.index] === value
      );
    };
    // 只接受完整独立卡片；标签是 GitHub slug，不把自然语言段落按短文本删掉。
    const topics =
      nonempty.length === 3 &&
      heading(0, 'About') &&
      heading(1, 'Topics') &&
      /^[a-z0-9][a-z0-9-]*(?:[ 	]+[a-z0-9][a-z0-9-]*){2,}$/.test(nonempty[2].text.trim());
    let aboutEcho = false;
    const aboutAt = nonempty.findIndex((_, index) => heading(index, 'About'));
    if (
      aboutAt >= 0 &&
      nonempty.length === aboutAt + 2 &&
      nonempty
        .slice(0, aboutAt)
        .every((_, index) => heading(index, 'License') || heading(index, 'Configuration'))
    ) {
      const body = nonempty[aboutAt + 1].text.trim();
      // 链接、代码、表格和列表不属于单行简介；不剥数字、标点、否定或限定条件。
      if (body.length >= 20 && !/^[#>*~-]|[`~\[\]|]|https?:\/\//.test(body)) {
        const needle = body.replace(/\s+/g, ' ');
        aboutEcho = earlierSnippets.some((previous) => {
          const haystack = previous.replace(/\s+/g, ' ').trim();
          let at = haystack.indexOf(needle);
          while (at >= 0) {
            // 防止把名称或单词的子串当成整句覆盖。
            const before = haystack[at - 1] ?? '';
            const after = haystack[at + needle.length] ?? '';
            if (!/[\p{L}\p{N}_]/u.test(before) && !/[\p{L}\p{N}_]/u.test(after)) return true;
            at = haystack.indexOf(needle, at + 1);
          }
          return false;
        });
      }
    }
    if (topics || aboutEcho) {
      deleteLine.fill(true);
      for (const { index } of nonempty)
        actions.push({ rule: topics ? 'repo_topics' : 'about_echo', line: index + 1 });
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
export function cleanGitHubBoilerplate(
  text: string,
  url: string,
  earlierSnippets: readonly string[] = []
): GitHubCleanupResult {
  const page = parseGitHubPage(url);
  if (page === null || text === '') return { text, actions: [] };

  const plan = judgeCleanup(text, page, earlierSnippets);
  if (plan.actions.length === 0) return { text, actions: plan.actions };

  const cleaned = applyCleanup(plan);
  const verify = judgeCleanup(cleaned, page, earlierSnippets);
  if (verify.actions.length > 0) return { text, actions: [] };

  return { text: cleaned, actions: plan.actions };
}
