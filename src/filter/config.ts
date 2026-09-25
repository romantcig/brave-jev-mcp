/**
 * 过滤层配置解析：环境变量 → FilterConfig。
 *
 * 纯函数：入参是 env 对象而不是 `process.env`，调用方（适配行或库入口）在
 * 调用时传 `process.env`。这样既避开导入顺序问题（`src/server.ts` 先求值工具
 * 模块，`dotenv.config()` 在其后才跑），也让测试传显式对象即可隔离。
 *
 * 坏值一律回落默认值而不是抛错：过滤层永远不能让服务器启动失败（EMBED-02）。
 * 依据：01-RESEARCH.md「模式处理」一节、notes/shadow-mode-logging.md、
 * 02-RESEARCH.md「环境变量清单」。
 */

import { readFileSync } from 'node:fs';
import { DEFAULT_BLOCKLIST, parseBlocklist } from './blocklist.js';
import {
  DEFAULT_JEV_CONCURRENCY,
  DEFAULT_JEV_MODEL,
  DEFAULT_JEV_TIMEOUT_MS,
  JEV_BACKEND_ENV,
  JEV_CONCURRENCY_ENV,
  JEV_MODEL_ENV,
  JEV_TIMEOUT_MS_ENV,
  resolveThresholds,
} from './jev/questions.js';
import type { FilterConfig, FilterMode } from './types.js';

/** 合法模式集合；集合外的值（含未设）一律回落 'off'。 */
const MODES: ReadonlySet<string> = new Set<FilterMode>(['off', 'shadow', 'on']);

const isFilterMode = (value: string): value is FilterMode => MODES.has(value);

/** 合法 Jev 后端集合；单后端策略（JEV-01）下唯一成员是 'typesafe'。 */
const BACKENDS: ReadonlySet<string> = new Set(['typesafe']);

/**
 * 仓库外黑名单文件的环境变量（EMBED-05）：文件内容与内置黑名单合并，影子期
 * 手工加农场站不用改代码（blocklist.ts 注释里留给 Phase 2 的位置在此兑现）。
 */
export const JEV_BLOCKLIST_FILE_ENV = 'JEV_FILTER_BLOCKLIST_FILE';

/**
 * 解析全部过滤层环境变量：模式、超量倍数、Jev 组（模型 / 后端 / 超时 / 并发闸）、
 * 十一项阈值与仓库外黑名单文件。阈值经 `JEV_FILTER_CONFIG_FILE` 指向的本地
 * JSON 配置文件提供（用户已定决策 4，解析见 questions.ts 的 `resolveThresholds`）；
 * 黑名单文件 `JEV_FILTER_BLOCKLIST_FILE` 与内置黑名单求并集，读不到时仅用内置
 * 黑名单 + stderr 一行（fail-open，description.ts 先例）。
 * @param env 环境变量映射（传 `process.env` 或测试用的显式对象）
 * @returns 模式（坏值回落 off）、超量倍数（<1 或非数回落 1）、黑名单（文件与
 *   内置的并集；文件缺失时仅内置）、十一项阈值（配置文件逐项覆盖，坏值逐项
 *   回落默认）与 Jev 组——model 空串回落 `jev-1.13.0`（钉版，JEV-06）、
 *   backend 集合外回落 `typesafe`、timeoutMs / concurrency 非有限数或 <1 回落
 *   15000 / 12
 * @example parseFilterConfig({}).mode === 'off'
 * @example parseFilterConfig({ JEV_FILTER_MODE: ' ON ' }).mode === 'on'
 * @example parseFilterConfig({ JEV_FILTER_MODE: 'banana' }).mode === 'off'
 * @example parseFilterConfig({ JEV_FILTER_OVERFETCH_FACTOR: '0.5' }).overfetchFactor === 1
 * @example parseFilterConfig({}).blocklist.size === 0
 * @example parseFilterConfig({ JEV_FILTER_JEV_MODEL: '  ' }).jev.model === 'jev-1.13.0'
 * @example parseFilterConfig({ JEV_FILTER_JEV_BACKEND: 'openrouter' }).jev.backend === 'typesafe'
 * @example parseFilterConfig({ JEV_FILTER_JEV_TIMEOUT_MS: 'abc' }).jev.timeoutMs === 15000
 * @example parseFilterConfig({ JEV_FILTER_JEV_CONCURRENCY: '0' }).jev.concurrency === 12
 */
export function parseFilterConfig(env: Record<string, string | undefined>): FilterConfig {
  const rawMode = (env.JEV_FILTER_MODE ?? '').trim().toLowerCase();
  const mode: FilterMode = isFilterMode(rawMode) ? rawMode : 'off';

  const factor = Number.parseFloat(env.JEV_FILTER_OVERFETCH_FACTOR ?? '');
  const overfetchFactor = Number.isFinite(factor) && factor >= 1 ? factor : 1;

  // Jev 组（02-02）：坏值一律回落默认（EMBED-05）。
  const model = (env[JEV_MODEL_ENV] ?? '').trim() || DEFAULT_JEV_MODEL;
  // 后端单选：'typesafe' 既是唯一合法值也是回落目标（JEV-01）。保留集合判定是
  // EMBED-05 的坏值回落口径——未来增加第二后端时扩展这里与 BACKENDS。
  const rawBackend = (env[JEV_BACKEND_ENV] ?? '').trim().toLowerCase();
  const backend: 'typesafe' = BACKENDS.has(rawBackend) ? 'typesafe' : 'typesafe';

  const timeout = Number.parseFloat(env[JEV_TIMEOUT_MS_ENV] ?? '');
  const timeoutMs = Number.isFinite(timeout) && timeout >= 1 ? timeout : DEFAULT_JEV_TIMEOUT_MS;

  const concurrencyValue = Number.parseFloat(env[JEV_CONCURRENCY_ENV] ?? '');
  const concurrency =
    Number.isFinite(concurrencyValue) && concurrencyValue >= 1
      ? concurrencyValue
      : DEFAULT_JEV_CONCURRENCY;

  // 阈值（02-06）：经单一配置文件提供，缺项/坏值逐项回落默认（resolveThresholds）。
  const thresholds = resolveThresholds(env);

  // 黑名单文件（02-06）：设了则读文件、与内置求并集为新 Set（每次调用新建，
  // 不改内置常量）；读不到 → stderr 一行 + 仅内置黑名单（fail-open）。
  const blocklistFilePath = env[JEV_BLOCKLIST_FILE_ENV]?.trim();
  let blocklist: ReadonlySet<string> = DEFAULT_BLOCKLIST;
  if (blocklistFilePath) {
    try {
      blocklist = new Set([
        ...DEFAULT_BLOCKLIST,
        ...parseBlocklist(readFileSync(blocklistFilePath, 'utf8')),
      ]);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.error(
        `[jev-filter] Unable to read blocklist file '${blocklistFilePath}': ${reason}; using the built-in blocklist only.`
      );
    }
  }

  return {
    mode,
    overfetchFactor,
    blocklist,
    thresholds,
    jev: { model, backend, timeoutMs, concurrency },
  };
}
