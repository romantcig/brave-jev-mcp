/**
 * 管道步 1：JSON-LD 片段分流。
 *
 * Brave 会把页面里的 schema.org 结构化数据原样当片段返回。能抽出正文（文章正文、
 * FAQ 问答、HowTo 步骤、问答页答案）就换成正文段；全是元数据就整片删；拿不准
 * （有表外键但抽不出正文，如表格 / 代码块 JSON）就原样保留。
 *
 * 安全约束：判定只用 `JSON.parse`，键访问一律 `Object.hasOwn` + 固定键名，
 * 解析结果不 spread、不写回任何对象（`__proto__` 键只当普通键参与判断）。
 *
 * 依据：notes/local-rules-design.md §1、01-RESEARCH.md「规则 1（步 1）」与 Assumptions A8。
 */

/** 纯元数据键：笔记 §1 的删除键，加夹具实测补充的键（A8）。可增补。 */
export const METADATA_KEYS: ReadonlySet<string> = new Set([
  'author',
  'publisher',
  'editor',
  'sameAs',
  'citation',
  'keywords',
  'articleSection',
  'inLanguage',
  'isAccessibleForFree',
  'datePublished',
  'dateModified',
  'wordCount',
  'timeRequired',
  'interactionStatistic',
  'image',
  'url',
  '@context',
  '@type',
  'name',
  'item',
  'mainEntityOfPage',
  'breadcrumb',
  'itemListElement',
  // A8：夹具里实际出现、笔记未列的元数据键
  'dateCreated',
  'answerCount',
  'duration',
  'genre',
  'offers',
  'partOfSeries',
  'productionCompany',
]);

/** `description` 只有长于这个字符数才算正文（笔记 §1）。 */
const DESCRIPTION_MIN_CHARS = 200;

/** 步 1 对单个片段的结局。`not_json` 是普通文本，不进 JSON-LD 分支、不计数。 */
export type JsonFragmentVerdict =
  | { action: 'converted'; parts: string[] }
  | { action: 'dropped_meta' }
  | { action: 'kept_raw' }
  | { action: 'not_json' };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** 只读自有属性；原型链上的同名键一律视为不存在。 */
const own = (node: Record<string, unknown>, key: string): unknown =>
  Object.hasOwn(node, key) ? node[key] : undefined;

/** 单个对象与对象数组都按数组处理（schema.org 两种写法都常见）。 */
const asList = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : value === undefined ? [] : [value];

const nonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim() !== '';

/** 标题比较用的归一化：去首尾空白、去前导 `#`/`*`/`-`、压缩连续空白、小写。 */
export const normalizeTitleForCompare = (text: string): string =>
  text
    .trim()
    .replace(/^[#*-]+/, '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();

/** `headline` 与来源标题归一化后相同：算"并入标题"，既不成段也不阻止整片删。 */
const isTitleHeadline = (value: unknown, sourceTitle: string): boolean =>
  typeof value === 'string' &&
  normalizeTitleForCompare(value) === normalizeTitleForCompare(sourceTitle);

/**
 * 判定片段是不是 JSON：`trim()` 后首字符是 `{` 或 `[`，且 `JSON.parse` 成功、结果是
 * 对象或数组。
 * @returns 解析结果；空串、普通文本、畸形 JSON、标量 JSON 一律 `null`
 * @example parseJsonFragment(' {"a": 1} ') → { a: 1 }
 * @example parseJsonFragment('42') → null
 * @example parseJsonFragment('{not json') → null
 */
export function parseJsonFragment(text: string): unknown | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  return typeof parsed === 'object' && parsed !== null ? parsed : null;
}

/**
 * 从 schema.org 节点按固定顺序抽正文段，每项成为独立一段：`articleBody`；长于 200
 * 字符的 `description`；与来源标题不同的 `headline`；FAQ `mainEntity[]` 拼成
 * `Q: <name>\nA: <text>`（缺 `name` 只出 `A: <text>`）；HowTo `step[]` 的 `text` 或
 * `name`；问答页 `suggestedAnswer[].text`；顶层 `acceptedAnswer.text`。
 * 数组对每个元素递归同样处理；标量与非 schema.org 对象返回空数组。
 * @returns 正文段，顺序即抽取顺序
 */
export function extractBodyParts(node: unknown, sourceTitle: string): string[] {
  if (Array.isArray(node)) return node.flatMap((child) => extractBodyParts(child, sourceTitle));
  if (!isRecord(node)) return [];

  const parts: string[] = [];

  const body = own(node, 'articleBody');
  if (nonEmptyString(body)) parts.push(body);

  const description = own(node, 'description');
  if (typeof description === 'string' && description.length > DESCRIPTION_MIN_CHARS) {
    parts.push(description);
  }

  const headline = own(node, 'headline');
  if (nonEmptyString(headline) && !isTitleHeadline(headline, sourceTitle)) parts.push(headline);

  for (const entity of asList(own(node, 'mainEntity'))) {
    if (!isRecord(entity)) continue;
    const answer = own(entity, 'acceptedAnswer');
    const text = isRecord(answer) ? own(answer, 'text') : undefined;
    if (!nonEmptyString(text)) continue;
    const name = own(entity, 'name');
    parts.push(nonEmptyString(name) ? `Q: ${name}\nA: ${text}` : `A: ${text}`);
  }

  for (const step of asList(own(node, 'step'))) {
    if (!isRecord(step)) continue;
    const text = own(step, 'text');
    const name = own(step, 'name');
    if (nonEmptyString(text)) parts.push(text);
    else if (nonEmptyString(name)) parts.push(name);
  }

  for (const answer of asList(own(node, 'suggestedAnswer'))) {
    const text = isRecord(answer) ? own(answer, 'text') : undefined;
    if (nonEmptyString(text)) parts.push(text);
  }

  const accepted = own(node, 'acceptedAnswer');
  const acceptedText = isRecord(accepted) ? own(accepted, 'text') : undefined;
  if (nonEmptyString(acceptedText)) parts.push(acceptedText);

  return parts;
}

/**
 * 抽不出正文时判断是否"全是元数据"：对象的每个键都在元数据表里（等于来源标题的
 * `headline` 视为已并入标题）；数组要求每个元素都满足；空对象、空数组也算满足。
 * 标量元素（数字、字符串）不是元数据，按保守方向留下。
 */
const isMetadataOnly = (node: unknown, sourceTitle: string): boolean => {
  if (Array.isArray(node)) return node.every((child) => isMetadataOnly(child, sourceTitle));
  if (!isRecord(node)) return false;

  return Object.keys(node).every(
    (key) =>
      METADATA_KEYS.has(key) || (key === 'headline' && isTitleHeadline(node[key], sourceTitle))
  );
};

/**
 * 步 1 对单个片段的分流裁决。
 * - `not_json`：不是 JSON（含解析失败、标量、空白），当普通文本，不计任何 JSON-LD 计数
 * - `converted`：抽出 ≥ 1 段正文，整片换成这些段
 * - `dropped_meta`：抽不出正文且键全在元数据表里，整片删
 * - `kept_raw`：抽不出正文但有表外键，原样保留（保守）
 * @param text 片段原文
 * @param sourceTitle 来源标题，用于判断 `headline` 是否只是重复标题
 * @example splitJsonFragment('{"name": "Blog", "item": "https://x/blog"}', 'T') → { action: 'dropped_meta' }
 * @example splitJsonFragment('{"rows": [[1, 2]]}', 'T') → { action: 'kept_raw' }
 */
export function splitJsonFragment(text: string, sourceTitle: string): JsonFragmentVerdict {
  const parsed = parseJsonFragment(text);
  if (parsed === null) return { action: 'not_json' };

  const parts = extractBodyParts(parsed, sourceTitle);
  if (parts.length > 0) return { action: 'converted', parts };

  return isMetadataOnly(parsed, sourceTitle) ? { action: 'dropped_meta' } : { action: 'kept_raw' };
}
