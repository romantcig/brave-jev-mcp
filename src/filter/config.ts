/**
 * 单个 JSON 文件的过滤配置解析与加载。
 * 纯解析入口逐项校验，加载入口读取配置；坏值回落默认并向 stderr 告警。
 * 宿主持有初始化后的配置，改文件需重启对应 MCP；stdout 留给协议通信。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  DEFAULT_JEV_CONCURRENCY,
  DEFAULT_JEV_MODEL,
  DEFAULT_JEV_TIMEOUT_MS,
  DEFAULT_THRESHOLDS,
} from './jev/questions.js';
import type { FilterConfig, FilterMode, JevThresholds } from './types.js';

/** 配置路径覆盖；未设时使用主目录下的默认文件。 */
export const JEV_CONFIG_FILE_ENV = 'JEV_FILTER_CONFIG_FILE';

export const DEFAULT_CONFIG_FILE = '~/.brave-jev/config.json';

/** 合法模式仅 off/test/on；其他值告警并回退 on。 */
const MODES: ReadonlySet<string> = new Set<FilterMode>(['off', 'test', 'on']);

const isFilterMode = (value: string): value is FilterMode => MODES.has(value);

/** 默认 JSONL 目录，~ 展开为本机主目录。 */
export const DEFAULT_LOG_DIR = '~/.brave-jev/logs';

/**
 * `timeout_ms` 的运行时上限：`AbortSignal.timeout()` 只接受 32 位有符号整数毫秒，
 * 超界时 Node 会把 2^31 截成 1ms 或对 2^32 直接抛 ERR_OUT_OF_RANGE。
 */
export const JEV_TIMEOUT_MAX_MS = 2147483647;

/** 坏值告警出口；缺省写 stderr（stdout 是 stdio 协议通道）。 */
export type ConfigWarn = (line: string) => void;

const defaultWarn: ConfigWarn = (line) => console.error(line);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** 坏值摘要：JSON 文本，超长截断（键值可能是任意 JSON 值）。 */
const describeValue = (value: unknown): string => {
  const text = JSON.stringify(value);
  if (text === undefined) return String(value);
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
};

/** 坏值告警行：`[jev-filter] config: ignoring <键路径>=<值摘要>; using default <默认值>`。 */
const ignored = (keyPath: string, value: unknown, fallback: unknown): string =>
  `[jev-filter] config: ignoring ${keyPath}=${describeValue(value)}; using default ${describeValue(fallback)}`;

/** 组级告警行（嵌套对象不是对象时整组回落）。 */
const groupFallback = (keyPath: string, value: unknown): string =>
  `[jev-filter] config: ${keyPath}=${describeValue(value)} is not an object; using that group's defaults.`;

/** 有限数且落在 [min, max]；`integer` 为真时还要求整数。 */
const inRange = (value: unknown, min: number, max: number, integer = false): value is number =>
  typeof value === 'number' &&
  Number.isFinite(value) &&
  value >= min &&
  value <= max &&
  (!integer || Number.isInteger(value));

/** 正整数；`timeout_ms` 传给 `AbortSignal.timeout()`，并发名额都只要求有意义。 */
const isPositiveInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0;

/** 路径值 trim 后非空才接受；只展开 ~、~/ 和 ~\ 前缀，~foo 原样保留。 */
const optionalPath = (file: Record<string, unknown>, key: string): string | undefined => {
  const value = file[key];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : expandHome(trimmed);
};

/** 展开开头的 `~` 为本机 home（`~/x` 与 `~\x` 都认）。 */
const expandHome = (path: string): string => {
  if (path === '~') return homedir();
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2));
  return path;
};

/** 顶层规范成 Record：非对象一律当空表（调用方已按需报过一行告警）。 */
const configFileRecord = (raw: unknown): Record<string, unknown> => (isRecord(raw) ? raw : {});

/**
 * 配置键、内部阈值键与合法范围的统一映射，日志和样本快照复用此表。
 * 全部阈值都是 [0,1] 内的概率。
 */
export const THRESHOLD_SPECS: ReadonlyArray<{
  readonly key: string;
  readonly configKey: keyof JevThresholds;
  readonly min: number;
  readonly max: number;
  readonly integer?: boolean;
}> = Object.freeze([
  { key: 'filler_drop', configKey: 'fillerDrop', min: 0, max: 1 },
  { key: 'group_keep_min', configKey: 'groupKeepMin', min: 0, max: 1 },
  { key: 'single_keep_min', configKey: 'singleKeepMin', min: 0, max: 1 },
]);

/**
 * 解析已读取的配置对象，不读文件或环境。缺项取默认，坏值逐项回落并告警，未知键忽略。
 * 嵌套组形状错误时整组回落；字符串数字不当作数值。warn 可注入，默认写 stderr。
 */
export function parseFilterConfigObject(
  raw: unknown,
  warn: ConfigWarn = defaultWarn
): FilterConfig {
  if (raw !== undefined && raw !== null && !isRecord(raw)) {
    warn(`[jev-filter] config: top level is not a JSON object; using all defaults.`);
  }
  const file = configFileRecord(raw);

  // 归一模式：合法值照常使用，其他任何值告警并回退 on；宿主初始化后复用配置。
  let mode: FilterMode = 'on';
  if (Object.hasOwn(file, 'mode')) {
    const value = file.mode;
    const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
    if (isFilterMode(text)) mode = text;
    else warn(ignored('mode', value, 'on'));
  }

  // jev 组：model / timeout_ms / concurrency
  let jevRecord: Record<string, unknown> = {};
  if (Object.hasOwn(file, 'jev')) {
    if (isRecord(file.jev)) jevRecord = file.jev;
    else warn(groupFallback('jev', file.jev));
  }

  let model = DEFAULT_JEV_MODEL;
  if (Object.hasOwn(jevRecord, 'model')) {
    const value = jevRecord.model;
    const trimmed = typeof value === 'string' ? value.trim() : '';
    if (trimmed !== '') model = trimmed;
    else warn(ignored('jev.model', value, DEFAULT_JEV_MODEL));
  }

  let timeoutMs = DEFAULT_JEV_TIMEOUT_MS;
  if (Object.hasOwn(jevRecord, 'timeout_ms')) {
    const value = jevRecord.timeout_ms;
    if (isPositiveInteger(value) && value <= JEV_TIMEOUT_MAX_MS) timeoutMs = value;
    else warn(ignored('jev.timeout_ms', value, DEFAULT_JEV_TIMEOUT_MS));
  }

  let concurrency = DEFAULT_JEV_CONCURRENCY;
  if (Object.hasOwn(jevRecord, 'concurrency')) {
    const value = jevRecord.concurrency;
    if (isPositiveInteger(value)) concurrency = value;
    else warn(ignored('jev.concurrency', value, DEFAULT_JEV_CONCURRENCY));
  }

  // thresholds 组：逐键校验，坏值只回落该项
  let thresholdRecord: Record<string, unknown> = {};
  if (Object.hasOwn(file, 'thresholds')) {
    if (isRecord(file.thresholds)) thresholdRecord = file.thresholds;
    else warn(groupFallback('thresholds', file.thresholds));
  }
  const thresholds: JevThresholds = { ...DEFAULT_THRESHOLDS };
  for (const spec of THRESHOLD_SPECS) {
    if (!Object.hasOwn(thresholdRecord, spec.key)) continue;
    const value = thresholdRecord[spec.key];
    if (inRange(value, spec.min, spec.max, spec.integer === true)) {
      thresholds[spec.configKey] = value;
    } else {
      warn(ignored(`thresholds.${spec.key}`, value, DEFAULT_THRESHOLDS[spec.configKey]));
    }
  }

  // 文件路径：非空字符串；坏值回落"不设"
  let toolDescriptionFile: string | undefined;
  if (Object.hasOwn(file, 'tool_description_file')) {
    const value = file.tool_description_file;
    toolDescriptionFile = optionalPath(file, 'tool_description_file');
    if (toolDescriptionFile === undefined) warn(ignored('tool_description_file', value, null));
  }

  // log_dir：非空字符串，开头 `~` 展开为本机 home
  let logDir = expandHome(DEFAULT_LOG_DIR);
  if (Object.hasOwn(file, 'log_dir')) {
    const value = file.log_dir;
    const trimmed = typeof value === 'string' ? value.trim() : '';
    if (trimmed !== '') logDir = expandHome(trimmed);
    else warn(ignored('log_dir', value, expandHome(DEFAULT_LOG_DIR)));
  }

  return {
    mode,
    thresholds: Object.freeze(thresholds),
    jev: { model, timeoutMs, concurrency },
    logDir,
    ...(toolDescriptionFile !== undefined ? { toolDescriptionFile } : {}),
  };
}

/**
 * 加载指定配置文件；未指定时自动创建并读取默认文件。
 * 只以独占方式创建缺失的默认文件，已有配置不覆盖；自定义路径不自动创建。
 * homeDir 供测试隔离文件系统，生产默认使用系统主目录。
 */
export function loadFilterConfig(
  env: Record<string, string | undefined>,
  homeDir = homedir()
): FilterConfig {
  const configuredPath = env[JEV_CONFIG_FILE_ENV]?.trim();
  const filePath = configuredPath
    ? expandHome(configuredPath)
    : join(homeDir, '.brave-jev', 'config.json');

  let raw: unknown;
  try {
    if (!configuredPath) {
      mkdirSync(dirname(filePath), { recursive: true });
      try {
        writeFileSync(filePath, JSON.stringify({ mode: 'on' }, null, 2) + '\n', {
          encoding: 'utf8',
          flag: 'wx',
        });
      } catch (error) {
        // 多个 MCP 进程可同时启动；已存在的文件交给后续读取。
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
    // 容忍编辑器写入的 UTF-8 BOM，避免合法 JSON 因编码标记失效。
    raw = JSON.parse(readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
    if (raw === null) {
      console.error('[jev-filter] config: top level is not a JSON object; using all defaults.');
      raw = undefined;
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(
      `[jev-filter] Unable to create or read config file '${filePath}': ${reason}; using the built-in defaults (mode on).`
    );
    raw = undefined;
  }

  return parseFilterConfigObject(raw);
}
