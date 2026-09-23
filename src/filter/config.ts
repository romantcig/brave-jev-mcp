/**
 * 过滤层配置解析：环境变量 → FilterConfig。
 *
 * 纯函数：入参是 env 对象而不是 `process.env`，调用方（适配行或库入口）在
 * 调用时传 `process.env`。这样既避开导入顺序问题（`src/server.ts` 先求值工具
 * 模块，`dotenv.config()` 在其后才跑），也让测试传显式对象即可隔离。
 *
 * 坏值一律回落默认值而不是抛错：过滤层永远不能让服务器启动失败（EMBED-02）。
 * 依据：01-RESEARCH.md「模式处理」一节、notes/shadow-mode-logging.md。
 */

import type { FilterConfig, FilterMode } from './types.js';

/** 合法模式集合；集合外的值（含未设）一律回落 'off'。 */
const MODES: ReadonlySet<string> = new Set<FilterMode>(['off', 'shadow', 'on']);

const isFilterMode = (value: string): value is FilterMode => MODES.has(value);

/**
 * 解析 `JEV_FILTER_MODE` 与 `JEV_FILTER_OVERFETCH_FACTOR`。
 * @param env 环境变量映射（传 `process.env` 或测试用的显式对象）
 * @returns 模式（去空白、忽略大小写；坏值回落 off）与超量倍数（有限且 >= 1 才用，否则 1）
 * @example parseFilterConfig({}).mode === 'off'
 * @example parseFilterConfig({ JEV_FILTER_MODE: ' ON ' }).mode === 'on'
 * @example parseFilterConfig({ JEV_FILTER_MODE: 'banana' }).mode === 'off'
 * @example parseFilterConfig({ JEV_FILTER_OVERFETCH_FACTOR: '0.5' }).overfetchFactor === 1
 */
export function parseFilterConfig(env: Record<string, string | undefined>): FilterConfig {
  const rawMode = (env.JEV_FILTER_MODE ?? '').trim().toLowerCase();
  const mode: FilterMode = isFilterMode(rawMode) ? rawMode : 'off';

  const factor = Number.parseFloat(env.JEV_FILTER_OVERFETCH_FACTOR ?? '');
  const overfetchFactor = Number.isFinite(factor) && factor >= 1 ? factor : 1;

  return { mode, overfetchFactor };
}
