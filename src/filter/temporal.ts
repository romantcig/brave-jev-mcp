/**
 * 时间上下文的纯数据帮助函数（TEMPORAL_CONTEXT_SCORING_ROLLOUT_PLAN §4）：
 * 页面日期选择与归并冲突消解、检索时间合法性归一。
 *
 * 职责边界：只做"从原 Brave 元数据选出页面日期字串"与"消解归并候选的日期冲突"
 * 两件纯计算，不做任何过滤决策——日期只是 Jev state 的输入字段，删除与否仍由
 * 片段评分与既有规则决定（不恢复年份门槛、不建"超过多少天就删"规则）。
 *
 * 取值口径（合法日期保留实验原字串，额外拒绝非法绝对日期）：
 * - 页面日期从该来源原 Brave 元数据 `age` 数组里选：优先合法绝对 ISO 时间，
 *   次选合法纯日期；保留原字串，不倒推
 *   `3 days ago`、不联网补齐、不把缺失改成零或今天。
 * - 归并候选（步 2 并入了多个原来源的片段）统一页级日期：全部贡献原来源的日期
 *   相同才保留，不同或部分未知一律 null——不把 A 的日期贴到 B 的事实上。
 * - 检索时间只认合法、带时区的 ISO 时间；不合法一律省略字段，绝不隐式读取系统
 *   时间把"回放的今天"冒充原检索时间。
 *
 * 库不变式：无模块级可变状态、纯函数、不引任何宿主类型（SourceMetadata 除外，
 * 它本就住在类型家 types.ts）。
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
 * 从一个来源的原 Brave 元数据 `age` 中选页面日期：优先首个绝对 ISO 时间元素，
 * 次选首个纯日期元素；找不到（或 `age` 缺失 / 非数组 / 无字符串元素）返回 null。
 * 保留原字串（`2026-10-01T13:00:00Z` 不截成日期），与冻结请求的取值逐字同源。
 * @example selectPageDate({ age: ['Wed', '2026-09-16', '1 week ago'] }) === '2026-09-16'
 * @example selectPageDate({ age: ['2026-10-01T13:00:00Z', '2026-10-01'] }) === '2026-10-01T13:00:00Z'
 * @example selectPageDate({ age: ['3 days ago'] }) === null
 * @example selectPageDate(undefined) === null
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
 * 消解一个归并候选的统一页级日期：全部贡献原来源的日期**完全一致**才保留该值
 * （全 null 也是一致，结果即 null）；不同或部分未知一律 null——日期只说明页面
 * 线索，不能把一个页面的日期贴到另一个页面的事实上。
 * @example mergePageDates(['2026-10-01']) === '2026-10-01'
 * @example mergePageDates(['2026-10-01', '2026-10-01']) === '2026-10-01'
 * @example mergePageDates(['2026-10-01', null]) === null
 * @example mergePageDates(['2026-10-01', '2026-10-02']) === null
 * @example mergePageDates([null, null]) === null
 */
export const mergePageDates = (dates: ReadonlyArray<string | null>): string | null => {
  const first = dates[0] ?? null;
  return dates.every((date) => date === first) ? first : null;
};

/**
 * 归一内部调用传入的检索时间：合法、带时区的 ISO 时间才原样返回，否则 undefined
 * （调用方省略 `retrieval_time` 字段）。绝不隐式取系统时间——回放必须显式携带
 * 日志原 `ts`，"本次运行的今天"不能冒充原检索时间。
 * @example normalizeRetrievalTime('2026-10-02T04:26:27.787+08:00') === '2026-10-02T04:26:27.787+08:00'
 * @example normalizeRetrievalTime('  ') === undefined
 * @example normalizeRetrievalTime('not a date') === undefined
 * @example normalizeRetrievalTime(undefined) === undefined
 */
export const normalizeRetrievalTime = (value: unknown): string | undefined => {
  return typeof value === 'string' && validIsoTime(value, true) ? value : undefined;
};
