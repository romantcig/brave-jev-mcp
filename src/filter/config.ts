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

import { DEFAULT_BLOCKLIST } from './blocklist.js';
import {
  DEFAULT_JEV_CONCURRENCY,
  DEFAULT_JEV_MODEL,
  DEFAULT_JEV_TIMEOUT_MS,
  DEFAULT_THRESHOLDS,
  JEV_BACKEND_ENV,
  JEV_CONCURRENCY_ENV,
  JEV_MODEL_ENV,
  JEV_TIMEOUT_MS_ENV,
} from './jev/questions.js';
import type { FilterConfig, FilterMode, JevThresholds } from './types.js';

/** 合法模式集合；集合外的值（含未设）一律回落 'off'。 */
const MODES: ReadonlySet<string> = new Set<FilterMode>(['off', 'shadow', 'on']);

const isFilterMode = (value: string): value is FilterMode => MODES.has(value);

/** 合法 Jev 后端集合；单后端策略（JEV-01）下唯一成员是 'typesafe'。 */
const BACKENDS: ReadonlySet<string> = new Set(['typesafe']);

/**
 * 解析全部过滤层环境变量：模式、超量倍数、Jev 组（模型 / 后端 / 超时 / 并发闸）。
 * 黑名单固定为 `DEFAULT_BLOCKLIST`（仓库外黑名单文件合并留给 EMBED-05 的
 * `JEV_FILTER_BLOCKLIST_FILE`，02-06 落地）；thresholds 直接取
 * `DEFAULT_THRESHOLDS`（配置文件覆盖解析在 02-06）。
 * @param env 环境变量映射（传 `process.env` 或测试用的显式对象）
 * @returns 模式（坏值回落 off）、超量倍数（<1 或非数回落 1）、黑名单、
 *   十一项阈值默认值与 Jev 组——model 空串回落 `jev-1.13.0`（钉版，JEV-06）、
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

  const thresholds: JevThresholds = { ...DEFAULT_THRESHOLDS };

  return {
    mode,
    overfetchFactor,
    blocklist: DEFAULT_BLOCKLIST,
    thresholds,
    jev: { model, backend, timeoutMs, concurrency },
  };
}
