/**
 * 过滤层配置解析：单个 JSON 配置文件 → FilterConfig（EMBED-05）。
 *
 * 环境变量只剩两类：Jev key（`TYPESAFE_API_KEY`，见 jev/client.ts）
 * 与指向配置文件的 `JEV_FILTER_CONFIG_FILE`。其余设置全部进文件，**启动时读一次**
 * （适配行持惰性单例）；改配置要重启 MCP。
 *
 * 两层结构（用户已定决策 4 的落地）：
 * - `parseFilterConfigObject(raw, warn?)`：纯函数，入参是已解析的 JSON 值，不碰文件
 *   ——测试主力。坏值逐项回落默认并各报 stderr 一行（`config: ignoring …`）。
 * - `loadFilterConfig(env)`：读 `JEV_FILTER_CONFIG_FILE` 指向的文件与它指定的黑名单
 *   文件（与内置黑名单求并集），再调前者。文件读不到 / JSON 坏 / 顶层不是对象 →
 *   stderr 一行、整体回落默认。
 *
 * 坏值一律回落默认值而不是抛错：过滤层永远不能让服务器启动失败（EMBED-02）。
 * 只能用 console.error——stdout 是 stdio 传输的协议通道（description.ts 先例）。
 *
 * 依据：PLAN.md §5「配置载体」、notes/test-mode-logging.md、02-RESEARCH.md
 * 「环境变量清单」、02-FIX-PLAN 批 B。
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_BLOCKLIST, parseBlocklist } from './blocklist.js';
import {
  DEFAULT_JEV_CONCURRENCY,
  DEFAULT_JEV_MODEL,
  DEFAULT_JEV_TIMEOUT_MS,
  DEFAULT_THRESHOLDS,
} from './jev/questions.js';
import type { FilterConfig, FilterMode, JevThresholds } from './types.js';

/** 指向配置文件的唯一配置类环境变量；未设 → 全部默认（mode off）。 */
export const JEV_CONFIG_FILE_ENV = 'JEV_FILTER_CONFIG_FILE';

/**
 * 合法模式三值集合（04-CONTEXT 模式与兼容节）；旧配置值 'shadow' 作 test 的别名
 * 映射为 'test' 并发一次迁移诊断，其余集合外的值（含未设）一律回落 'off'。
 * 别名绝不能落成 off——别名回落会静默改变过滤强度（T-04-01-1）。
 */
const MODES: ReadonlySet<string> = new Set<FilterMode>(['off', 'test', 'on']);

/** 旧别名到新值的映射（配置键 mode 不变；'shadow' 语义重定义为实际应用裁决的 test）。 */
const LEGACY_MODE_ALIASES: ReadonlyMap<string, FilterMode> = new Map([['shadow', 'test']]);

/** 旧别名 shadow 的迁移诊断行（04-CONTEXT：stderr 一次诊断 + 交接说明要求显式改配置）。 */
const SHADOW_ALIAS_MIGRATION =
  `[jev-filter] config: mode 'shadow' is a legacy alias for 'test'; ` +
  `update the config file to mode 'test'.`;

const isFilterMode = (value: string): value is FilterMode => MODES.has(value);

/** `timeout_ms` 的合法区间（整数）：保证 `AbortSignal.timeout()` 永不因参数抛 RangeError。 */
export const JEV_TIMEOUT_MIN_MS = 1000;
export const JEV_TIMEOUT_MAX_MS = 60000;

/** `concurrency` 的合法区间（整数）。 */
export const JEV_CONCURRENCY_MIN = 1;
export const JEV_CONCURRENCY_MAX = 64;

/**
 * `snippet_min` 的上限：score 的真实取值上限是 2.0，配成 > 2 会删光全部片段。
 * （02-06 的旧口径 [0,3] 是错的方向——02-FIX 批 B 收窄。）
 */
export const SNIPPET_MIN_MAX = 2;

/** JSONL 日志目录默认值（Phase 3 消费；本批只解析不使用）。`~` 展开为本机 home。 */
export const DEFAULT_LOG_DIR = '~/.brave-jev/logs';

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

/**
 * 配置文件里的非空字符串路径（trim + 开头 `~` 展开为本机 home）；非字符串或空白 →
 * undefined。三个路径键（`blocklist_file` / `tool_description_file` / `log_dir`）
 * 共用同一展开口径：只认单独 `~` 或 `~/`、`~\` 开头，`~foo` 原样保留（审查 R8）。
 */
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
 * 十一项阈值在配置文件里的键 → JevThresholds 键与合法范围（键名用 snake_case，
 * 与 probe 的 THRESHOLDS 键名一致；未知键忽略为 fail-open 方向）。
 * 范围语义：六个概率门槛（五道丢弃 + reasoning 保护）与 cjk_bonus、cjk_share 取
 * [0,1] 的有限数；snippet_min 取 [0,2]（score 上限 2.0）；min_facts 与 novelty_min
 * 取 >= 1 的**整数**。max 为 Infinity 表示只有下限。
 *
 * logging.ts 的日志信封复用本表投影阈值快照（`key` 即日志键名）——绝不手写
 * 11 个键名，测试模式改阈值后旧记录仍可复现裁决（D-11）。
 */
export const THRESHOLD_SPECS: ReadonlyArray<{
  readonly key: string;
  readonly configKey: keyof JevThresholds;
  readonly min: number;
  readonly max: number;
  readonly integer?: boolean;
}> = Object.freeze([
  { key: 'off_topic_drop', configKey: 'offTopicDrop', min: 0, max: 1 },
  { key: 'listing_drop', configKey: 'listingDrop', min: 0, max: 1 },
  { key: 'self_deprecated', configKey: 'selfDeprecated', min: 0, max: 1 },
  { key: 'stale_drop', configKey: 'staleDrop', min: 0, max: 1 },
  { key: 'filler_drop', configKey: 'fillerDrop', min: 0, max: 1 },
  { key: 'reasoning_protect', configKey: 'reasoningProtect', min: 0, max: 1 },
  { key: 'snippet_min', configKey: 'snippetMin', min: 0, max: SNIPPET_MIN_MAX },
  { key: 'min_facts', configKey: 'minFacts', min: 1, max: Number.POSITIVE_INFINITY, integer: true },
  {
    key: 'novelty_min',
    configKey: 'noveltyMin',
    min: 1,
    max: Number.POSITIVE_INFINITY,
    integer: true,
  },
  { key: 'cjk_bonus', configKey: 'cjkBonus', min: 0, max: 1 },
  { key: 'cjk_share', configKey: 'cjkShare', min: 0, max: 1 },
]);

/**
 * 解析配置对象（纯函数，不碰文件、不读 process.env）：缺项取默认、坏值逐项回落
 * 默认并报一行 stderr、未知键忽略。嵌套组（`jev` / `thresholds`）不是对象时整组
 * 回落默认并报一行。
 *
 * 字符串形式的数字（如 `"15000"`）算坏值——JSON 里写数字就是数字。
 *
 * @param raw 已解析的 JSON 值（`JSON.parse` 的输出，或测试直接构造的对象）
 * @param warn 告警出口；缺省写 stderr
 * @returns 每项都合法的 FilterConfig（mode 缺省 off、黑名单为内置表、logDir 已展开 `~`）
 * @example parseFilterConfigObject({}).mode === 'off'
 * @example parseFilterConfigObject({ mode: ' ON ' }).mode === 'on'
 * @example parseFilterConfigObject({ mode: 'shadow' }).mode === 'test'（旧别名，另发一次迁移诊断）
 * @example parseFilterConfigObject({ mode: 'banana' }).mode === 'off'
 * @example parseFilterConfigObject({ overfetch_factor: 0.5 }).overfetchFactor === 1
 * @example parseFilterConfigObject({ jev: 5 }).jev.model === 'jev-1.13.0'
 * @example parseFilterConfigObject({ thresholds: { timeout_ms: 1 } }).thresholds deepEqual DEFAULT_THRESHOLDS
 * @example parseFilterConfigObject({ jev: { timeout_ms: 15000.5 } }).jev.timeoutMs === 15000
 * @example parseFilterConfigObject({ jev: { concurrency: 65 } }).jev.concurrency === 12
 * @example parseFilterConfigObject({ thresholds: { snippet_min: 2.01 } }).thresholds.snippetMin === 1.0
 */
export function parseFilterConfigObject(
  raw: unknown,
  warn: ConfigWarn = defaultWarn
): FilterConfig {
  if (raw !== undefined && raw !== null && !isRecord(raw)) {
    warn(`[jev-filter] config: top level is not a JSON object; using all defaults.`);
  }
  const file = configFileRecord(raw);

  // mode：字符串、trim、不分大小写；三值 off/test/on；旧别名 'shadow' → 'test'
  // 并发一次迁移诊断（每次 parseFilterConfigObject 调用至多一次——配置启动读一次，
  // 进程内天然一次）；其余集合外一律 off
  let mode: FilterMode = 'off';
  if (Object.hasOwn(file, 'mode')) {
    const value = file.mode;
    const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
    if (isFilterMode(text)) mode = text;
    else if (LEGACY_MODE_ALIASES.has(text)) {
      mode = LEGACY_MODE_ALIASES.get(text) as FilterMode;
      warn(SHADOW_ALIAS_MIGRATION);
    } else warn(ignored('mode', value, 'off'));
  }

  // overfetch_factor：有限数且 >= 1
  let overfetchFactor = 1;
  if (Object.hasOwn(file, 'overfetch_factor')) {
    const value = file.overfetch_factor;
    if (typeof value === 'number' && Number.isFinite(value) && value >= 1) {
      overfetchFactor = value;
    } else {
      warn(ignored('overfetch_factor', value, 1));
    }
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
    if (inRange(value, JEV_TIMEOUT_MIN_MS, JEV_TIMEOUT_MAX_MS, true)) timeoutMs = value;
    else warn(ignored('jev.timeout_ms', value, DEFAULT_JEV_TIMEOUT_MS));
  }

  let concurrency = DEFAULT_JEV_CONCURRENCY;
  if (Object.hasOwn(jevRecord, 'concurrency')) {
    const value = jevRecord.concurrency;
    if (inRange(value, JEV_CONCURRENCY_MIN, JEV_CONCURRENCY_MAX, true)) concurrency = value;
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
  if (Object.hasOwn(file, 'blocklist_file')) {
    const value = file.blocklist_file;
    if (optionalPath(file, 'blocklist_file') === undefined) {
      warn(ignored('blocklist_file', value, null));
    }
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
    overfetchFactor,
    blocklist: DEFAULT_BLOCKLIST,
    thresholds: Object.freeze(thresholds),
    jev: { model, timeoutMs, concurrency },
    logDir,
    ...(toolDescriptionFile !== undefined ? { toolDescriptionFile } : {}),
  };
}

/**
 * 读取配置文件并返回完整配置（EMBED-05）：`JEV_FILTER_CONFIG_FILE` 未设 → 全默认；
 * 文件读不到 / JSON 坏 / 顶层不是对象 → stderr 一行 + 全默认（fail-open）。
 * 配置里的 `blocklist_file` 指向的黑名单文件在此读取，与内置黑名单求并集；读不到
 * 时仅用内置黑名单 + stderr 一行（fail-open，description.ts 先例）。
 *
 * 适配行持惰性单例调用本函数——启动时读一次，之后复用；改配置要重启 MCP。
 *
 * @param env 环境变量映射（传 `process.env` 或测试用的显式对象）
 * @returns 完整 FilterConfig
 * @example loadFilterConfig({}).mode === 'off'
 * @example loadFilterConfig({ JEV_FILTER_CONFIG_FILE: '/no/such/file' }) → 默认 + stderr 一行
 */
export function loadFilterConfig(env: Record<string, string | undefined>): FilterConfig {
  const filePath = env[JEV_CONFIG_FILE_ENV]?.trim();

  let raw: unknown;
  if (filePath) {
    try {
      // 去掉开头的 UTF-8 BOM：PowerShell 5.1 的 `-Encoding UTF8` 写出的文件带 BOM，
      // 不去掉整份配置会被 JSON.parse 作废（审查 R4）
      raw = JSON.parse(readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
      if (raw === null) {
        // JSON 文本 `null` 解析成功但顶层不是对象——与数组/标量同待遇报一行，
        // 不能静默回落（审查 R3）；置 undefined 走"无配置"路径避免二次告警
        console.error('[jev-filter] config: top level is not a JSON object; using all defaults.');
        raw = undefined;
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.error(
        `[jev-filter] Unable to read config file '${filePath}': ${reason}; using the built-in defaults.`
      );
      raw = undefined;
    }
  }

  const config = parseFilterConfigObject(raw);

  // 黑名单文件（路径来自配置对象，口径与 parseFilterConfigObject 一致）：设了则读
  // 文件、与内置求并集为新 Set（每次调用新建，不改内置常量）。
  const blocklistPath = optionalPath(configFileRecord(raw), 'blocklist_file');
  if (blocklistPath) {
    try {
      const merged = new Set([
        ...DEFAULT_BLOCKLIST,
        ...parseBlocklist(readFileSync(blocklistPath, 'utf8')),
      ]);
      return { ...config, blocklist: merged };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.error(
        `[jev-filter] Unable to read blocklist file '${blocklistPath}': ${reason}; using the built-in blocklist only.`
      );
    }
  }

  return config;
}
