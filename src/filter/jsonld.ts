/**
 * 步 1 JSON-LD 分流：能抽正文就拆成正文段，只有元数据就删除，无法确定则原样保留。
 * 仅用 JSON.parse 和自有固定键读取，不展开或写回解析对象。
 */

/** 可判为纯元数据的键集合。 */
export const METADATA_KEYS: ReadonlySet<string> = new Set([
  'author',
  'publisher',
  'keywords',
  'articleSection',
  'inLanguage',
  'isAccessibleForFree',
  'datePublished',
  'dateModified',
  'image',
  'url',
  '@context',
  '@type',
  'name',
  'item',
  'mainEntityOfPage',
  'breadcrumb',
  'itemListElement',
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

/** 仅尝试解析以 { 或 [ 开头的对象和数组；普通文本、标量及解析失败返回 null。 */
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
 * `Q: <name>\nA: <text>`（缺 `name` 只出 `A: <text>`）。
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
 * 按片段分流：非 JSON 当普通文本；可提取正文时替换；只有元数据时删除；
 * 有未知键但提不出正文时原样保留。
 */
export function splitJsonFragment(text: string, sourceTitle: string): JsonFragmentVerdict {
  const parsed = parseJsonFragment(text);
  if (parsed === null) return { action: 'not_json' };

  const parts = extractBodyParts(parsed, sourceTitle);
  if (parts.length > 0) return { action: 'converted', parts };

  return isMetadataOnly(parsed, sourceTitle) ? { action: 'dropped_meta' } : { action: 'kept_raw' };
}
