/**
 * 页面日期选择与检索时间校验，不作过滤决策。
 * 只使用传入元数据，不倒推相对日期、不联网补齐、不以当前时间填补缺失。
 */

import type { SourceMetadata } from './types.js';

// Brave 也会返回不带时区的绝对页面时间；原样保留，不擅自指定页面所在时区。
const ISO_TIME =
  /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)?$/;

/** 纯日期字串的精确判定（`YYYY-MM-DD` 整串；与实验脚本同一正则）。 */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** Date.parse 会把 2 月 30 日滚入 3 月，因此先独立校验公历年月日。 */
const validCalendarDate = (value: string): boolean => {
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1];
};

const validIsoTime = (value: string, requireZone: boolean): boolean => {
  const match = ISO_TIME.exec(value);
  if (!match || match[0] !== value || !validCalendarDate(value) || (requireZone && !match[2]))
    return false;
  // 无时区页面时间仅借 UTC 验证格式，避免本机时区和夏令时影响验证结果。
  return Number.isFinite(Date.parse(match[2] ? value : `${value}Z`));
};

/**
 * 优先选 age 中首个合法绝对 ISO 时间，其次选合法纯日期，保留原字串。
 * 缺失、形状错误或无合法日期时返回 null。
 */
export const selectPageDate = (meta: SourceMetadata | undefined): string | null => {
  const age = meta?.age;
  if (!Array.isArray(age)) return null;
  const absolute = age.find(
    (entry): entry is string => typeof entry === 'string' && validIsoTime(entry, false)
  );
  if (absolute !== undefined) return absolute;
  const dateOnly = age.find(
    (entry): entry is string =>
      typeof entry === 'string' &&
      entry.length === 10 &&
      DATE_ONLY.test(entry) &&
      validCalendarDate(entry)
  );
  return dateOnly ?? null;
};

/**
 * 合法且带时区的 ISO 时间原样返回，否则返回 undefined，供调用方省略字段。
 * 回放必须显式携带原检索时间，不能取本次运行时间替代。
 */
export const normalizeRetrievalTime = (value: unknown): string | undefined => {
  return typeof value === 'string' && validIsoTime(value, true) ? value : undefined;
};
