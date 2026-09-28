/**
 * 逐请求 JSONL 日志写入器（D-09/D-11/D-13/D-14）。
 *
 * 形状：`createLogWriter` 是工厂——库不持模块级可变状态（stats.ts 不变式），
 * 进程级状态（串行 promise 链）住工厂闭包；适配行持惰性单例，每请求调一次。
 *
 * **两种记录形状（Phase 4 审核脚本必须都兼容）：**
 * - 成功请求（`write`）：信封字段在前、`FilterStats` 整体展开在后——
 *   `{ ts, backend, model_config, model_reported, thresholds, mode, request, … }`；
 * - 错误请求（`writeError`，Brave 报错 / zod 校验失败，无 stats 主体）——
 *   `{ ts, backend, model_config, thresholds, mode, request: { query, intent }, error: { stage, message } }`。
 *   `stage`：请求抛错或非 2xx 记 `'brave'`，响应 zod 校验失败记 `'schema'`。
 *
 * 信封字段（D-11）：`ts` 带时区偏移的本地 ISO（`toISOString()` 是 UTC 不满足）；
 * `backend` 常量 `'typesafe'`；`model_config` 是配置钉的模型 ID；`model_reported`
 * 是 Jev 实际回报的模型 ID（per_source answered 行去重，常态单元素）；`thresholds`
 * 是 THRESHOLD_SPECS 投影的十一项 snake_case 快照（绝不手写键名——影子期改阈值后
 * 旧记录仍可复现裁决）。`mode` 已在 stats 里，成功记录的信封不重复。
 *
 * 红线（LOG-03/D-12）：绝不写片段正文——只存 URL、标题、指纹、概率、分数、计数
 * 与标记；FilterStats 类型不含正文即证明，信封也不得加任何片段字段。
 *
 * 写入（D-13，Windows 多进程实测口径，03-RESEARCH 六问 2）：
 * - 文件按**本地**日期滚动 `YYYY-MM-DD.jsonl`（必须用本地 getter，UTC 系列差时区）；
 * - 目录不存在时先 `mkdirSync(recursive)` 兜自愈；
 * - **每条记录一次 `appendFileSync` 整行追加**——绝不多次 append 拼一条；
 * - 进程内 promise 链串行（成功与错误记录共用同一条链），同进程多请求不乱序；
 *   跨进程不交错由 OS append 语义保证。
 *
 * 失败（D-14）：整体 try/catch fail-open——stderr 恰一行 `[jev-filter]` 告警，
 * 搜索返回不受影响；**绝不写 stdout**（stdout 是 stdio 协议通道，Pitfall 4）。
 * 不设保留天数、不自动清理日志（D-15，影子期审核要用）。
 *
 * 依据：03-RESEARCH.md 六问 2 / 六问 6、config.ts 的 `[jev-filter]` 告警先例。
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { THRESHOLD_SPECS } from './config.js';
import type { FilterConfig, FilterStats } from './types.js';

/** 错误请求记录的 stage：Brave 请求层失败 / 响应 schema 校验失败。 */
export type LogErrorStage = 'brave' | 'schema';

/** 日志写入器：成功请求与错误请求两种落账入口，共用同一条串行写入链。 */
export type LogWriter = {
  /** 成功请求：信封 + FilterStats 整体展开（D-09）。 */
  write(stats: FilterStats): void;
  /** 错误请求（无 stats 主体）：信封 + request + error 标记。 */
  writeError(entry: { stage: LogErrorStage; message: string; query: string; intent: string }): void;
};

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

/** 十一项阈值快照：THRESHOLD_SPECS 投影（snake_case 键），绝不手写键名（D-11）。 */
const thresholdSnapshot = (config: FilterConfig): Record<string, number> =>
  Object.fromEntries(THRESHOLD_SPECS.map((spec) => [spec.key, config.thresholds[spec.configKey]]));

/** 错误消息截断（03-RESEARCH Open Question 3 落定口径 200 字符）。 */
const truncateMessage = (message: string): string =>
  message.length > 200 ? message.slice(0, 200) : message;

/**
 * 创建一个 JSONL 日志写入器：`write` 落成功请求（信封 + stats 展开），`writeError`
 * 落错误请求（信封 + request + error）。两种记录都整行追加到 `config.logDir` 下的
 * 按天文件，共用同一条串行链；写入失败 fail-open（stderr 一行，不抛）。
 * @param config 过滤配置（取 logDir、钉版模型与生效阈值；适配行持单例）
 */
export function createLogWriter(config: FilterConfig): LogWriter {
  // 串行链：同进程多请求按调用序落盘；同步 append 在 then 回调里执行，
  // 失败在链内消化，绝不向外抛（fail-open）
  let chain: Promise<void> = Promise.resolve();
  const enqueue = (build: () => Record<string, unknown>): void => {
    chain = chain
      .then(() => {
        const record = build();
        const file = join(config.logDir, logFileName());
        mkdirSync(config.logDir, { recursive: true });
        appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');
      })
      .catch((error: unknown) => {
        const reason = error instanceof Error ? error.message : String(error);
        console.error(
          `[jev-filter] Unable to write log record to '${config.logDir}': ${reason}; search result is unaffected.`
        );
      });
  };

  // Jev 实际回报的模型 ID：per_source answered 行去重（常态单元素，A4 落定）；
  // model 是可选字段，显式收窄成 string 再入集
  const modelReported = (stats: FilterStats): string[] => {
    const models: string[] = [];
    for (const row of stats.jev?.per_source ?? []) {
      if (row.status === 'answered' && row.model !== undefined) models.push(row.model);
    }
    return [...new Set(models)];
  };

  return {
    write(stats: FilterStats): void {
      enqueue(() => ({
        ts: localIsoWithOffset(),
        backend: 'typesafe',
        model_config: config.jev.model,
        model_reported: modelReported(stats),
        thresholds: thresholdSnapshot(config),
        ...stats,
      }));
    },
    writeError(entry: {
      stage: LogErrorStage;
      message: string;
      query: string;
      intent: string;
    }): void {
      enqueue(() => ({
        ts: localIsoWithOffset(),
        backend: 'typesafe',
        model_config: config.jev.model,
        thresholds: thresholdSnapshot(config),
        mode: config.mode,
        request: { query: entry.query, intent: entry.intent },
        error: { stage: entry.stage, message: truncateMessage(entry.message) },
      }));
    },
  };
}
