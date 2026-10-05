/**
 * 片段预筛阶段的样板行、标题重复行与引用块判定。
 * 纯函数，不修改输入；前缀表由调用方统一传入。
 */

import { normalizeTitleForCompare } from './jsonld.js';

/** 样板短行阈值（码元）：行归一化后不超过该长度才允许前缀命中——Share 这类词
 * 常出现在正文句首，长行必须放过。 */
export const BOILERPLATE_SHORT_LINE_MAX = 40;

/** 去掉行首 # / * / - 标记及其间空白，再 trim；不压缩内部空白或改变大小写。 */
export function normalizeLine(line: string): string {
  return line.replace(/^[#*\s-]+/, '').trim();
}

/**
 * 行与前缀使用相同归一化，忽略大小写并剥掉末尾标点。
 * 整行相等时匹配；短行也可按前缀匹配，要求词边界，避免 Share 吞掉 Shares。
 * 两侧都要归一化，因为前缀表自身可能带 Markdown 标记。
 */
export function matchesPrefix(normalizedLine: string, prefixes: readonly string[]): boolean {
  const line = stripTrailingPunctuation(normalizeLine(normalizedLine).toLowerCase());
  return prefixes.some((prefix) => {
    const entry = stripTrailingPunctuation(normalizeLine(prefix).toLowerCase());
    if (line === entry) return true;

    if (line.length > BOILERPLATE_SHORT_LINE_MAX || !line.startsWith(entry)) return false;
    const next = line[entry.length];
    return next === undefined || !/[a-z0-9]/.test(next);
  });
}

/** 剥掉行末的标点、符号与空白：样板行常带句点或冒号收尾。 */
export const stripTrailingPunctuation = (line: string): string =>
  line.replace(/[\p{P}\p{S}\s]+$/u, '');

/** 标题归一化复用 jsonld.ts，避免两处语义漂移。 */

/** 文本与标题归一化后相等即为纯标题；两者为空也算相等。 */
export function isTitleOnly(text: string, sourceTitle: string): boolean {
  return normalizeTitleForCompare(text) === normalizeTitleForCompare(sourceTitle);
}

/** 标题额外署名的最大码元长度，兼容 Brave title 中的站点后缀。 */
export const TITLE_RESIDUAL_MAX = 40;

/** 标题重复行判定的行下限（码元）：过短的行（导航词、栏目标签）不参与前缀式判定。 */
export const TITLE_LINE_MIN = 20;

/** 空格记一列，Tab 展开到下一个四列制表位；按字符数判断会漏掉单 Tab 缩进。 */
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
 * 逐行标记代码区域，供标题、引用和 GitHub 清洗共用。
 * 围栏闭合须同字符、长度不小于开栏且无尾随文字；未闭合时保护到末尾。
 * 缩进按列数判定，至少四列即保护。
 * 跨行内联代码的开启行、内部行和闭合行均保护，避免删除破坏跨度。
 * 围栏和缩进代码中的反引号不参与内联状态；进入围栏清除未闭合内联状态。
 * 同一行内闭合的内联代码不标记整行；引用与懒续行由 githubCleanup.ts 另行保护。
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
 * 归一后的行须等于来源标题，或是标题去掉短署名后的前缀。
 * 署名残差须有 by/via/from 或分隔记号，长度受限且短于行，行本身也须足够长。
 * 只按 title → 行的方向匹配，避免把带实质副标题的行误当作署名变体。
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
 * 同一片段至少两次命中标题时，仅删除首次之后的重复行。
 * 单次命中可能是正文 H1，应保留；代码区域不参与判定。
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

/** 中英文句读、分号、中文逗号或顿号表示条目可能含正文，不能只靠英文句号判断。 */
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
 * 书目候选要求列表符、间隔号和 Accessed 月年或行尾年份签名。
 * 首段后的所有分段必须是短来源标签；含内容标点、条件或事实关系时保留。
 * 匹配仅表示书目候选，仍需整块检查。
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
 * 从引用标题扫描完整小节，再决定是否删除。
 * 少于两条、或含说明段、摘要、下级小节、代码时整块保留，不删除合格前缀。
 * 代码中的标题不启动判断；只剥首个合格块。
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
 * 固定顺序：前缀行 → 标题重复行 → 引用块，最后重组文本。
 * 后两步共用前缀剥离后计算的代码标记；剥空或只剩来源标题时 emptied 为 true。
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
