/**
 * 管道步 3：片段预筛谓词（样板行剥离、标题重复行、引用块、短且无实词、页内逐字
 * 重复）。
 *
 * 全部是无副作用纯函数：不读 `process.env`、不写文件、不改入参，同一输入重复
 * 调用返回深相等结果，可安全并发。实词集与前缀表由调用方（pipeline.ts）预算
 * 一次传入，谓词自身无状态——形态照 src/protocols/rebinding.ts 的 is* 谓词。
 *
 * 依据：notes/local-rules-design.md §3、01-RESEARCH.md「规则 3（步 3）」、
 * Assumptions A9（行级剥离）、A10（200 字符阈值）、A11（包含度）；
 * 标题重复行 / 引用块来自 2026-10-01 真实样本的四类漏网（第二十轮，
 * notes/filter-experiments/round-20-local-leak-rules.md）；乱码碎词原型经
 * GPT-6 审核证实误删真实代码与品牌名短句（F1），整条撤下未接入。
 */

import { CJK_SEGMENT, jaccard, tokenize } from './tokenize.js';
import { normalizeTitleForCompare } from './jsonld.js';

/** "短"阈值：长度判定统一用 String.length（UTF-16 码元）。 */
export const SHORT_SNIPPET_MAX = 200;

/** 样板短行阈值（英文条目）：行归一化后不超过该长度才允许前缀命中——Share/分享/广告
 * 这类词常出现在正文句首，长行必须放过。 */
export const BOILERPLATE_SHORT_LINE_MAX = 40;

/** 样板短行阈值（中文条目）：中文正文句没有空格分隔，40 码元能装下一整句，阈值远小于英文。 */
export const BOILERPLATE_SHORT_LINE_MAX_CJK = 12;

/** 页内逐字重复判定的 shingle 窗口宽度。 */
export const SHINGLE_N = 5;

/** Jaccard 严格大于该值才算重复（恰为 0.8 不删）。 */
export const NEAR_DUP_JACCARD = 0.8;

/** 候选被幸存者覆盖的 shingle 比例达到该值即算重复（恰为 0.8 删）。 */
export const NEAR_DUP_COVERAGE = 0.8;

/** 参与重复判定的最小 shingle 集合规模；更短的片段不做重复判定（保守留）。 */
export const MIN_SHINGLES = 8;

/**
 * 行归一化：去掉前导 `#`/`*`/`-` 标记（含其间空白）后 trim。
 * @returns 归一化后的行文本；不压缩行中空白、不改大小写
 * @example normalizeLine('## Frequently Asked Questions (FAQ)') === 'Frequently Asked Questions (FAQ)'
 * @example normalizeLine('   *Share') === 'Share'
 */
export function normalizeLine(line: string): string {
  return line.replace(/^[#*\s-]+/, '').trim();
}

/**
 * 行首前缀匹配：**行与前缀两侧都用同一个 normalizeLine 归一化**再忽略大小写比对，
 * 末尾标点（样板行常带句点/冒号）参与比较前剥掉。命中两条路：
 * 1. 归一化后**整行相等**——独立样板行（`Share`、`Advertisement`）；
 * 2. **短行前缀**：行不超过短行阈值（中文条目 12、英文 40）且以条目开头，英文条目
 *    还要求条目末尾落在词边界——`Share` 不得吞掉 `Shares` / `SharePoint`。
 * 两侧同法归一化是必需的——前缀表里有 `## Frequently Asked Questions` 这种自带
 * 标记的条目，若只归一化行那一侧，它永远不命中。不用无界正则（ReDoS，T-01-03-01）。
 * @returns 行按上述两条路之一命中任一前缀时为真
 * @example matchesPrefix('## Frequently Asked Questions (FAQ)', ['## Frequently Asked Questions']) === true
 * @example matchesPrefix('Read our READ MORE section', ['READ MORE']) === false
 * @example matchesPrefix('Shares of Nvidia fell 5%...', ['Share']) === false（长行放过）
 */
export function matchesPrefix(normalizedLine: string, prefixes: readonly string[]): boolean {
  const line = stripTrailingPunctuation(normalizeLine(normalizedLine).toLowerCase());
  return prefixes.some((prefix) => {
    const entry = stripTrailingPunctuation(normalizeLine(prefix).toLowerCase());
    if (line === entry) return true;

    const max = CJK_SEGMENT.test(entry)
      ? BOILERPLATE_SHORT_LINE_MAX_CJK
      : BOILERPLATE_SHORT_LINE_MAX;
    if (line.length > max || !line.startsWith(entry)) return false;
    // 中文没有词边界概念，短行前缀即命中；英文要求条目后是非字母数字
    if (CJK_SEGMENT.test(entry)) return true;
    const next = line[entry.length];
    return next === undefined || !/[a-z0-9]/.test(next);
  });
}

/** 剥掉行末的标点、符号与空白：样板行、付费墙标记行常带句点或冒号收尾。 */
export const stripTrailingPunctuation = (line: string): string =>
  line.replace(/[\p{P}\p{S}\s]+$/u, '');

/**
 * 来源标题比较用的归一化（`normalizeTitleForCompare`）：直接复用 jsonld.ts 的实现，
 * 两处语义不得漂移（01-03 SUMMARY 曾写"复用"却落成了复制，审查问题 12）。
 */

/**
 * 剥离后是否只剩来源标题（归一化后相等）。
 * @returns 文本与标题归一化后相等时为真（两者都为空串也算相等）
 * @example isTitleOnly('# Sanity Studio upgrade planner Skill', 'Sanity Studio upgrade planner Skill') === true
 * @example isTitleOnly('Body text', 'Title') === false
 */
export function isTitleOnly(text: string, sourceTitle: string): boolean {
  return normalizeTitleForCompare(text) === normalizeTitleForCompare(sourceTitle);
}

/**
 * 标题重复行判定的署名容忍上限（码元）：Brave 的 title 字段常带
 * " By Investing.com" 这类署名/站点后缀，片段内的重复行没有——title 以该行为
 * 开头且多出部分不超过该值即算同一标题行。2026-10-01 投资站样本实测必要。
 */
export const TITLE_RESIDUAL_MAX = 40;

/** 标题重复行判定的行下限（码元）：过短的行（导航词、栏目标签）不参与前缀式判定。 */
export const TITLE_LINE_MIN = 20;

/**
 * 行首缩进的列数：空格记 1 列，Tab 按 CommonMark tab stop 展开到下一个 4 列倍数
 * ——单个 Tab 即达 4 列，"2 空格 + Tab"也是 4 列。按**字符数**判断（`\s{4,}`）会把
 * 这些缩进误放行（审查 R1）。
 */
const indentColumns = (line: string): number => {
  let columns = 0;
  for (let at = 0; at < line.length; at += 1) {
    const char = line[at];
    if (char === ' ') columns += 1;
    else if (char === '\t') columns += 4 - (columns % 4);
    else break;
  }
  return columns;
};

/**
 * 统一代码区域识别（第二十轮复审 R2；filter-rules-9 增强）：逐行标记是否处于代码
 * 区域，标题重复行、引用块两个新增剥离与步 3 的 GitHub 界面清洗共用同一份结果。
 * 三层状态机：
 * - 围栏：记录**开栏字符与长度**，闭栏必须同字符、长度不小于开栏且无尾随文字
 *   （CommonMark 规则）——外层四反引号包内层三反引号的 Markdown 示例里，内层围栏
 *   （含其"闭栏"）都是示例内容，不会提前闭合。未闭合保护到末尾。
 * - 缩进代码：按 `indentColumns` ≥ 4 列判定（宁多保护、无误删方向）。
 * - 内联代码跨度：行内反引号 run 的开闭跟踪——开启行、跨行内部行与闭合行整体
 *   受保护（删任何一行都会拆散跨度，审查 R1）；同一行内自洽开闭的不标记，保持
 *   既有判定面。围栏与缩进代码内的反引号是代码内容，不参与跨度状态；围栏是块级
 *   结构，进入时清掉段落内未闭合的跨度。
 * 引用行与引用懒续行由 githubCleanup.ts 叠加，不在此放宽（不能为复用而削弱保护）。
 * @returns 与行数组等长的标记：true = 该行处于代码区域，不参与删除判定
 */
export const codeRegionFlags = (lines: readonly string[]): boolean[] => {
  const flags: boolean[] = [];
  let fenced = false;
  let fenceChar = '';
  let fenceLen = 0;
  /** 未闭合内联代码跨度等待的闭合反引号串长度；0 = 无。 */
  let spanClose = 0;
  for (const line of lines) {
    if (fenced) {
      flags.push(true);
      const closing = /^(\s*)(`{3,}|~{3,})\s*$/.exec(line);
      if (closing !== null && closing[2][0] === fenceChar && closing[2].length >= fenceLen) {
        fenced = false;
      }
      continue;
    }
    const opening = /^(\s*)(`{3,}|~{3,})/.exec(line);
    if (opening !== null) {
      fenced = true;
      fenceChar = opening[2][0];
      fenceLen = opening[2].length;
      flags.push(true);
      spanClose = 0;
      continue;
    }
    if (indentColumns(line) >= 4) {
      flags.push(true);
      continue;
    }
    const insideSpanAtStart = spanClose > 0;
    for (let at = 0; at < line.length; ) {
      // 跨度外的反斜杠转义按对消费：奇数个转义下一反引号，偶数个不影响开栏。
      // 跨度内反斜杠是代码字面量，不能阻止等长反引号闭合。
      if (spanClose === 0 && line[at] === '\\') {
        at += 2;
        continue;
      }
      if (line[at] !== '`') {
        at += 1;
        continue;
      }
      const start = at;
      while (line[at] === '`') at += 1;
      const run = at - start;
      // 等长反引号串闭合 code span；不等长的 run 在跨度内是内容。
      if (spanClose === 0) spanClose = run;
      else if (run === spanClose) spanClose = 0;
    }
    flags.push(insideSpanAtStart || spanClose > 0);
  }
  return flags;
};

/**
 * 标题重复行判定：行归一化后与来源标题**相等**，或 title 以该行开头且署名残差
 * 以明确的署名/分隔记号起头（by/via/from 或 `-–—|·`）、残差不超过
 * `TITLE_RESIDUAL_MAX`、短于行本身、行本身达到 `TITLE_LINE_MIN`。残差记号校验是
 * 必须的——长度条件证明不了"同一标题"，只会把真实副标题（`: 10 outlets compared`）
 * 误当署名（GPT-6 审核 F2）。只做 title→行 单向前缀（"行 = title + 后缀"的
 * extended 口径零删除收益、误吞风险不为零，不上）。
 * @returns 行是来源标题的重复（含署名容忍）时为真
 * @example isTitleRepeatLine('# Cloudflare launches CA', 'Cloudflare launches CA') === true
 * @example isTitleRepeatLine('Cloudflare launches CA', 'Cloudflare launches CA By Investing.com') === true
 * @example isTitleRepeatLine('reddit API shut down', 'Reddit API Shut Down in 2026: What Still Works') === false（残差比行长）
 * @example isTitleRepeatLine('Cloudflare launches CA', 'Cloudflare launches CA: 10 outlets compared') === false（残差无署名记号）
 * @example isTitleRepeatLine('Cloudflare launches CA', 'Other title') === false
 */
export function isTitleRepeatLine(line: string, titleNorm: string): boolean {
  const normalized = normalizeTitleForCompare(line);
  if (normalized === '' || titleNorm === '') return false;
  if (normalized === titleNorm) return true;
  if (!titleNorm.startsWith(normalized)) return false;
  const residual = titleNorm.slice(normalized.length);
  return (
    /^\s*(?:by|via|from)\b|^\s*[-–—|·]/.test(residual) &&
    residual.length <= TITLE_RESIDUAL_MAX &&
    residual.length < normalized.length &&
    normalized.length >= TITLE_LINE_MIN
  );
}

/**
 * 标题重复行剥离：**只在命中行出现 ≥2 次时剥掉首次之后的所有命中行**——同一片段
 * 内重复出现本身是机械堆叠的证明，但首次出现可能是正文结构（H1 导语、围栏外的
 * 标题行），剥重复、留首次（GPT-6 审核 F2：mezha 夹具的 H1 + 列表重复形态实测）。
 * 唯一命中一律不动："非第一行"证明不了重复，可能是面包屑后的正文 H1 或代码区域
 * 内与来源标题同名的命令。代码区域行（`codeRegionFlags`）不参与判定。
 * @returns 行与代码标记同步过滤后的结果，未命中时保留全部行
 */
const stripTitleRepeatLines = (
  lines: readonly string[],
  codeFlags: readonly boolean[],
  titleNorm: string
): { lines: string[]; codeFlags: boolean[] } => {
  const hits: number[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!codeFlags[index] && isTitleRepeatLine(lines[index], titleNorm)) hits.push(index);
  }
  if (hits.length < 2) return { lines: [...lines], codeFlags: [...codeFlags] };
  const repeats = new Set(hits.slice(1));
  const outLines: string[] = [];
  const outFlags: boolean[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!repeats.has(index)) {
      outLines.push(lines[index]);
      outFlags.push(codeFlags[index]);
    }
  }
  return { lines: outLines, codeFlags: outFlags };
};

/** 引用块标题行（归一化、去行尾标点、小写后的精确全集）：见 stripReferenceBlock。 */
const REFERENCE_HEADINGS: readonly string[] = [
  'sources',
  'source',
  'references',
  'reference',
  'sources & references',
  'sources and references',
  'further reading',
  'external links',
];

/** 引用条目签名——原行以列表符起头；间隔号 `·` 与 accessed/行尾年份二者取其一。 */
const REFERENCE_ITEM_BULLET = /^\s*[-*•]\s+/;
const REFERENCE_ITEM_ACCESSED = /\baccessed\s+\w+\s+\d{4}/i;
const REFERENCE_ITEM_YEAR_END = /(19|20)\d{2}\s*$/u;
const REFERENCE_MIDDOT = '·';

/**
 * 内容信号（第二十轮复审 R1）：英文句读与分号 + 中文句读/逗号顿号。条目任一段含
 * 即视为带内容说明——"没有英文句号"证明不了无信息量，无句号的事实摘要与中文
 * 摘要在真实网页里正常存在。
 */
const REFERENCE_CONTENT_MARK = /[.!?;；。！？，、]/;

/** 来源标签段上限（码元）：只约束首段之后的标签，不能据此推断首段没有事实摘要。 */
export const REFERENCE_LABEL_MAX = 20;

/** 无句末标点也可能表达事实：条件、否定、依赖关系及常见陈述词一律保留。
 * 检查每一段，尤其是摘要和标题共用的首段。此保护是保守启发式，不是完整语义分类。 */
const REFERENCE_FACT_EN =
  /\b(?:must|shall|should|can|cannot|could|will|would|may|might|not|never|only|unless|until|before|after|requires?|needs?|depends?|dependent|remains?|is|are|was|were|has|have)\b/i;
const REFERENCE_FACT_ZH = /需要|必须|依赖|取决于|尚未|仍|只有|才能|不(?:会|能|得)|并非/;

/** 同级或更高的 Markdown 标题界定引用小节的结束，下级小节仍属当前块。 */
const REFERENCE_SECTION = /^ {0,3}(#{1,6})(?:[\t ]+|$)/;

/**
 * 引用条目解析（第二十轮复审 R1 收紧）：列表符 + 间隔号 + "Accessed 月 年"或行尾
 * 年份尾注之外，按间隔号分段后**除首段外的所有段必须是 ≤`REFERENCE_LABEL_MAX`
 * 的来源标签**（my-ssl 形态 `·Official·`）。任何段含内容标点、条件或事实关系均
 * 保留；其余仅视为书目候选，不声称格式足以证明没有摘要，误判继续随样本观察。
 * @returns 书目候选本体文本；不满足签名或命中内容保护时为 null
 */
const referenceItemBody = (line: string): string | null => {
  if (!REFERENCE_ITEM_BULLET.test(line)) return null;
  if (!line.includes(REFERENCE_MIDDOT)) return null;
  if (!REFERENCE_ITEM_ACCESSED.test(line) && !REFERENCE_ITEM_YEAR_END.test(line.trimEnd())) {
    return null;
  }
  const body = line
    .replace(REFERENCE_ITEM_BULLET, '')
    .replace(REFERENCE_ITEM_ACCESSED, '')
    .replace(REFERENCE_ITEM_YEAR_END, '');
  const segments = body
    .split(REFERENCE_MIDDOT)
    .map((segment) => segment.trim())
    .filter((segment) => segment !== '');
  if (segments.length < 2) return null;
  for (const segment of segments) {
    if (
      REFERENCE_CONTENT_MARK.test(segment) ||
      REFERENCE_FACT_EN.test(segment) ||
      REFERENCE_FACT_ZH.test(segment)
    ) {
      return null;
    }
  }
  return segments.slice(1).every((segment) => segment.length <= REFERENCE_LABEL_MAX)
    ? body.trim()
    : null;
};

/**
 * 引用块剥离（第二十轮复审 R1/R2）：`Sources & References` 一类标题行 + 其后
 * （允许空行）的整个小节，先扫描到同级/更高标题或片段结束再决定删除。条目不足
 * 2 条、或块内出现说明段、摘要、下级小节或代码时，整块保留，不删除合格前缀。
 * 代码区域内的标题不启动判定。只剥第一个合格块，幸存行保持原序。
 * @returns 剥离后的行数组（未命中原样返回同引用）
 */
const stripReferenceBlock = (lines: readonly string[], codeFlags: readonly boolean[]): string[] => {
  for (let heading = 0; heading < lines.length; heading += 1) {
    if (codeFlags[heading]) continue;
    const normalized = stripTrailingPunctuation(normalizeLine(lines[heading]).toLowerCase());
    if (!REFERENCE_HEADINGS.includes(normalized)) continue;

    let cursor = heading + 1;
    let lastItem = -1;
    let items = 0;
    let allReferences = true;
    const headingLevel = (REFERENCE_SECTION.exec(lines[heading])?.[1] ?? '######').length;
    while (cursor < lines.length) {
      const line = lines[cursor];
      if (line.trim() === '') {
        cursor += 1;
        continue;
      }
      const nextHeading = codeFlags[cursor] ? null : REFERENCE_SECTION.exec(line);
      if (nextHeading !== null && nextHeading[1].length <= headingLevel) break;

      if (!codeFlags[cursor] && referenceItemBody(line) !== null) {
        items += 1;
        lastItem = cursor;
      } else {
        allReferences = false;
      }
      cursor += 1;
    }
    if (allReferences && items >= 2) {
      return [...lines.slice(0, heading), ...lines.slice(lastItem + 1)];
    }
    // 不从被保护块的下级小节里重新捞取可删前缀；下次只检查新的独立小节。
    heading = cursor - 1;
  }
  return [...lines];
};

/**
 * 样板行剥离：删掉命中前缀的行后重新拼接并 `trim()`。前缀行剥离之后依次做
 * **标题重复行剥离**（来源 title 已在输出元数据里，片段内的机械重复只添噪声）
 * 与**引用块剥离**（纯书目占位符列表），三者的 emptied 语义一致——剥空或只剩
 * 来源标题都算整片删（原因 `boilerplate`）。标题与引用共用同一份代码区域标记
 * （`codeRegionFlags`，在前缀剥离后的行上计算）；子步顺序固定，不重排。
 * @returns 剥离后的文本；`emptied` 为真表示剥空或只剩来源标题——两种情形都整片删
 *   （原因 `boilerplate`），其余情形保留剥离后的文本（动作 `boilerplate_stripped`）
 * @example stripBoilerplateLines('Share\n\n正文', ['Share'], 'T') → { text: '正文', emptied: false }
 * @example stripBoilerplateLines('Share\n\n# T', ['Share'], 'T') → { text: '# T', emptied: true }
 */
export function stripBoilerplateLines(
  text: string,
  prefixes: readonly string[],
  sourceTitle: string
): { text: string; emptied: boolean } {
  const titleNorm = normalizeTitleForCompare(sourceTitle);
  const lines = text.split(/\r?\n/).filter((line) => !matchesPrefix(line, prefixes));
  const codeFlags = codeRegionFlags(lines);
  const titleStripped = stripTitleRepeatLines(lines, codeFlags, titleNorm);
  const stripped = stripReferenceBlock(titleStripped.lines, titleStripped.codeFlags)
    .join('\n')
    .trim();

  return { text: stripped, emptied: stripped === '' || isTitleOnly(stripped, sourceTitle) };
}

/**
 * 短且无实词：长度 < maxLength 且实词集里没有任何词出现在片段 token 中，两条
 * **同时满足**才删。实词集为空时恒为假（保守留）；空串按长度 0 处理（真）。
 * @returns 判定为"短且无实词"时为真
 * @example isShortWithoutTerms('On this page', terms) === true（12 字符、无实词）
 * @example isShortWithoutTerms('x'.repeat(200), terms) === false（达到阈值不删）
 * @example isShortWithoutTerms('short', new Set()) === false
 */
export function isShortWithoutTerms(
  text: string,
  terms: ReadonlySet<string>,
  maxLength: number = SHORT_SNIPPET_MAX
): boolean {
  if (terms.size === 0) return false;
  if (text.length >= maxLength) return false;

  const tokens = new Set(tokenize(text));
  for (const term of terms) {
    if (tokens.has(term)) return false;
  }
  return true;
}

/**
 * 页内逐字重复：与已幸存片段的 5-gram 集合比，`jaccard > 0.8` **或**候选自身 ≥80% 的
 * shingle 落在幸存者里即重复（任一侧 shingle 少于 8 个不判——RESEARCH 实测真实重复
 * 表现为包含关系，纯 Jaccard 抓不到，见 Assumption A11）。覆盖方向必须是"候选被覆盖"：
 * 原 containment（交/min）口径下候选是幸存者超集时包含度恒为 1，信息更全的后一条被
 * 误删（审查问题 4）；覆盖率口径下超集候选（导语 + 扩展段）保留，子集候选（同文被
 * 抽两次、后者更短）仍删。
 * @returns 判定为近重复时为真（保留先出现者由调用方保证：按原序只与已幸存者比）
 * @example isNearDuplicate(sameShingles, sameShingles) === true
 * @example isNearDuplicate(sevenShingles, anything) === false（不足 MIN_SHINGLES 不判）
 */
export function isNearDuplicate(
  candidateShingles: ReadonlySet<string>,
  survivorShingles: ReadonlySet<string>
): boolean {
  if (survivorShingles.size < MIN_SHINGLES || candidateShingles.size < MIN_SHINGLES) {
    return false;
  }
  let covered = 0;
  for (const shingle of candidateShingles) {
    if (survivorShingles.has(shingle)) covered += 1;
  }
  return (
    jaccard(candidateShingles, survivorShingles) > NEAR_DUP_JACCARD ||
    covered / candidateShingles.size >= NEAR_DUP_COVERAGE
  );
}
