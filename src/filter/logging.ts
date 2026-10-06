/**
 * 逐请求 JSONL 日志：记录统计与样本指针，不写片段正文。
 * 成功和错误记录共用串行写入链，按本地日期滚动，每条记录整行追加一次。
 * 写入失败只向 stderr 告警，不影响搜索或 stdio 协议；不自动清理日志。
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { THRESHOLD_SPECS } from './config.js';
import { DECISION_RULES_SNAPSHOT } from './jev/threshold.js';
import { FILTER_RULES_VERSION } from './version.js';
import type { FilterConfig, FilterStats } from './types.js';

/** 错误请求记录的 stage：Brave 请求层失败 / 响应 schema 校验失败。 */
export type LogErrorStage = 'brave' | 'schema';

/** test 模式样本的相对路径与实际保存状态。 */
export type LogSamplePointer = { path: string; status: 'saved' | 'failed' };

/** write 的可选第二参数：request_id 与样本指针；缺省时记录不产生这两个键。 */
export type LogWriteMeta = { requestId: string; sample?: LogSamplePointer };

/** 日志写入器：成功请求与错误请求两种落账入口，共用同一条串行写入链。 */
export type LogWriter = {
  /**
   * 异步串行写入成功记录；入队后调用方不得再修改 stats 或其嵌套对象。
   * meta 缺省时不写 request_id 与 sample。
   */
  write(stats: FilterStats, meta?: LogWriteMeta): void;
  /**
   * 错误记录没有 stats 主体。sample 携带 saveError 的真实保存结果，
   * 用于区分未录制、保存失败和已保存；缺省时不产对应键。
   */
  writeError(entry: {
    stage: LogErrorStage;
    message: string;
    query: string;
    intent: string;
    requestId?: string;
    sample?: LogSamplePointer;
  }): void;
};

const pad2 = (value: number): string => String(value).padStart(2, '0');

/** 日志文件与样本目录共用的本地日期戳，避免使用 UTC 日期造成时区偏移。 */
export const localDateStamp = (now: Date): string =>
  `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;

/** 本地日期文件名 `YYYY-MM-DD.jsonl`：本地 getter（UTC 系列会差时区）。 */
const logFileName = (now: Date): string => `${localDateStamp(now)}.jsonl`;

/**
 * 带时区偏移的本地 ISO 时间戳。
 * ts 与文件名必须使用同一个 Date，避免跨午夜时分别落在两天。
 */
export const localIsoWithOffset = (now: Date): string => {
  const offsetMinutes = -now.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMinutes);
  return (
    `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}` +
    `T${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}.` +
    `${String(now.getMilliseconds()).padStart(3, '0')}` +
    `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`
  );
};

/** 将 stderr 告警中的换行与控制字符折成空格；日志正文仍由 JSON.stringify 转义。 */
export const oneLineStderr = (text: string): string =>
  text.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ');

/** 按 THRESHOLD_SPECS 生成 snake_case 阈值快照，供日志与样本共用。 */
export const thresholdSnapshot = (config: FilterConfig): Record<string, number> =>
  Object.fromEntries(THRESHOLD_SPECS.map((spec) => [spec.key, config.thresholds[spec.configKey]]));

/** 日志与错误样本共用的错误摘要，最多 200 字符。 */
export const truncateMessage = (message: string): string =>
  message.length > 200 ? message.slice(0, 200) : message;

/** 创建日志写入器；成功和错误记录按调用顺序写入 config.logDir 的每日文件。 */
export function createLogWriter(config: FilterConfig): LogWriter {
  // 串行链内部消化写入失败，避免影响后续记录与搜索。
  let chain: Promise<void> = Promise.resolve();
  const enqueue = (build: (now: Date) => Record<string, unknown>): void => {
    chain = chain
      .then(() => {
        // 时间戳与文件名共用一次取时，避免跨午夜不一致。
        const now = new Date();
        const record = build(now);
        const file = join(config.logDir, logFileName(now));
        mkdirSync(config.logDir, { recursive: true });
        appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');
      })
      .catch((error: unknown) => {
        const reason = error instanceof Error ? error.message : String(error);
        // 路径与错误详情单行化，保持 stderr 每次告警一行。
        console.error(
          `[jev-filter] Unable to write log record to '${oneLineStderr(config.logDir)}': ${oneLineStderr(reason)}; search result is unaffected.`
        );
      });
  };

  // 从成功响应中提取并去重实际模型 ID。
  const modelReported = (stats: FilterStats): string[] => {
    const models: string[] = [];
    for (const row of stats.jev?.per_source ?? []) {
      if (row.status === 'answered' && row.model !== undefined) models.push(row.model);
    }
    return [...new Set(models)];
  };

  return {
    write(stats: FilterStats, meta?: LogWriteMeta): void {
      enqueue((now) => ({
        ts: localIsoWithOffset(now),
        backend: 'typesafe',
        model_config: config.jev.model,
        model_reported: modelReported(stats),
        thresholds: thresholdSnapshot(config),
        // 只读运行规则快照与规则版本：不依赖外部样本文件即可识别该记录的裁决语义。
        decision_rules: { ...DECISION_RULES_SNAPSHOT },
        filter_rules_version: FILTER_RULES_VERSION,
        // 缺省 meta 不产生关联键，兼容没有样本指针的记录。
        ...(meta !== undefined ? { request_id: meta.requestId } : {}),
        ...(meta?.sample !== undefined ? { sample: meta.sample } : {}),
        ...stats,
      }));
    },
    writeError(entry: {
      stage: LogErrorStage;
      message: string;
      query: string;
      intent: string;
      requestId?: string;
      sample?: LogSamplePointer;
    }): void {
      enqueue((now) => ({
        ts: localIsoWithOffset(now),
        backend: 'typesafe',
        model_config: config.jev.model,
        thresholds: thresholdSnapshot(config),
        decision_rules: { ...DECISION_RULES_SNAPSHOT },
        filter_rules_version: FILTER_RULES_VERSION,
        mode: config.mode,
        // 与错误样本使用相同的 request_id。
        ...(entry.requestId !== undefined ? { request_id: entry.requestId } : {}),
        // 指针记录实际保存结果。
        ...(entry.sample !== undefined ? { sample: entry.sample } : {}),
        request: { query: entry.query, intent: entry.intent },
        error: { stage: entry.stage, message: truncateMessage(entry.message) },
      }));
    },
  };
}
