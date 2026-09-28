/**
 * 逐请求 JSONL 日志写入器（D-09/D-13/D-14）。
 *
 * 形状：`createLogWriter` 是工厂——库不持模块级可变状态（stats.ts 不变式），
 * 进程级状态（串行 promise 链）住工厂闭包；适配行持惰性单例，每请求调一次。
 *
 * 记录形状（D-09/D-11）：信封字段在前、`FilterStats` 整体展开在后。信封本批先
 * 只放 `ts`（带时区偏移的本地 ISO，`toISOString()` 是 UTC 不满足 D-11）；
 * backend / model / thresholds 等其余信封字段随 Phase 3 计划补齐。
 *
 * 两种记录（Phase 4 审核脚本必须都兼容）：
 * - 成功请求：`{ ts, ...FilterStats }`（后续补齐信封后为 `{ ts, backend, …, ...FilterStats }`）；
 * - 错误请求（Brave 报错 / zod 校验失败，无 stats 主体）：
 *   `{ ts, backend, model_config, thresholds, mode, request: { query, intent }, error: { stage: 'brave' | 'schema', message } }`。
 *
 * 写入（D-13，Windows 多进程实测口径，03-RESEARCH 六问 2）：
 * - 文件按**本地**日期滚动 `YYYY-MM-DD.jsonl`（必须用本地 getter，UTC 系列差时区）；
 * - 目录不存在时先 `mkdirSync(recursive)` 兜自愈；
 * - **每条记录一次 `appendFileSync` 整行追加**——绝不多次 append 拼一条；
 * - 进程内 promise 链串行，同进程多请求不乱序；跨进程不交错由 OS append 语义保证。
 *
 * 失败（D-14）：整体 try/catch fail-open——stderr 恰一行 `[jev-filter]` 告警，
 * 搜索返回不受影响；**绝不写 stdout**（stdout 是 stdio 协议通道，Pitfall 4）。
 *
 * 依据：03-RESEARCH.md 六问 2 / 六问 6、config.ts 的 `[jev-filter]` 告警先例。
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { FilterStats } from './types.js';

const pad2 = (value: number): string => String(value).padStart(2, '0');

/** 本地日期文件名 `YYYY-MM-DD.jsonl`：本地 getter（UTC 系列会差时区）。 */
const logFileName = (): string => {
  const now = new Date();
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}.jsonl`;
};

/**
 * 带时区偏移的本地 ISO 时间戳 `YYYY-MM-DDTHH:mm:ss.sss±HH:MM`（D-11）。
 * 本地 get* 系列 + `getTimezoneOffset`（03-RESEARCH 六问 6.2 实测构造，
 * `Date.parse` 可回解析）。
 */
const localIsoWithOffset = (): string => {
  const now = new Date();
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

/**
 * 创建一个 JSONL 日志写入函数：每次调用构造一条记录（信封 + stats 展开）并
 * 整行追加到 `logDir` 下的按天文件。写入失败 fail-open（stderr 一行，不抛）。
 * @param logDir 日志目录（config.logDir，解析时已展开 `~`）
 */
export function createLogWriter(logDir: string): (stats: FilterStats) => void {
  // 串行链：同进程多请求按调用序落盘；同步 append 在 then 回调里执行，
  // 失败在链内消化，绝不向外抛（fail-open）
  let chain: Promise<void> = Promise.resolve();
  return (stats: FilterStats): void => {
    chain = chain
      .then(() => {
        const record = { ts: localIsoWithOffset(), ...stats };
        const file = join(logDir, logFileName());
        mkdirSync(logDir, { recursive: true });
        appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');
      })
      .catch((error: unknown) => {
        const reason = error instanceof Error ? error.message : String(error);
        console.error(
          `[jev-filter] Unable to write log record to '${logDir}': ${reason}; search result is unaffected.`
        );
      });
  };
}
