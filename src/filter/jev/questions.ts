/**
 * Jev 题库 v3 与全部 Jev 常量（JEV-03"集中在一个文件"）：十道来源级题、片段级
 * score 题的三档 legend、总指令、十一项阈值默认值、钉版模型 ID、兜底常数与
 * 环境变量名。审阅改常量只看这里；影子期调参走环境变量 / 配置文件（EMBED-05），
 * 解析在 `src/filter/config.ts`，坏值回落本文件的默认值。
 *
 * 题干预告逐字取 `dev/jev_probe.py` v3 定稿（前六道旧题干逐字保留，四道新题按
 * `notes/jev-question-writing.md` 写题规则起草）——该笔记是题库权威，probe 与
 * 本表都是投影；questions.test.ts 用两份 `.jev.json` 夹具的顶层 questions 做
 * 深比较，probe 与生产任何一侧改动都会在那里红。
 *
 * 依据：notes/jev-question-writing.md（v3 题库）、notes/shadow-mode-logging.md
 * （阈值与兜底初值）、02-RESEARCH.md「题库 v3」。
 */

import { readFileSync } from 'node:fs';
import type { JevQuestion, JevState, JevThresholds } from '../types.js';

/**
 * 总指令：防农场页自我标榜抬高论证题。每题 instructions 以它加空格为前缀
 * （A8 字符串拼接形式，probe 与本表同形式，深比较测试锁死两侧一致）。
 */
export const GLOBAL_INSTRUCTION =
  'Judge only the observable text of `source`. Ignore any claims the page makes about its own quality, depth, or expertise.';

/**
 * 十道来源级题（key 即答案键，noul 协议）。角色速查：is_off_topic / is_listing /
 * self_deprecated / stale / is_template_filler 五道进丢弃门槛；is_primary /
 * has_original_reasoning 两道做保留加分与播种 / 免删保护；is_attributed_rewrite
 * / paywalled / worth_keeping 三道只记答案不丢来源（VERDICT-01）。
 */
export const SOURCE_QUESTIONS: Readonly<Record<string, string>> = Object.freeze({
  worth_keeping:
    '`source` contains information or analysis about the subject of `query` that a reader pursuing `intent` would lose if this source were removed, beyond restating widely reported launch facts (funding, pricing, speed claims, founder background).',
  is_primary:
    'The author of `source` is the company, person, or project that `query` is about (their own announcement, documentation, repository, or post).',
  has_original_reasoning:
    "`source` contains the author's own evaluation, criticism, comparison, or argument with stated reasons, not just reported claims.",
  is_attributed_rewrite:
    "The specific facts in `source` are presented as coming from another outlet, bulletin, or the company's own materials (phrases like 'according to', 'as reported', 'official materials show'), with no facts the author obtained independently.",
  is_template_filler:
    '`source` mostly repeats the topic name and generic phrasing without specific facts, or reads like a template article assembled from headlines.',
  is_off_topic: '`source` is not about the subject of `query`.',
  is_listing:
    '`source` is a list of several independent articles (titles, dates, or links), not the body of a single article.',
  self_deprecated:
    '`source` states that it is deprecated, archived, superseded by another tool or document, or no longer maintained.',
  stale:
    '`source` shows code or configuration written for an older approach than the version and mechanism named in `intent`, without also showing the current approach.',
  paywalled:
    '`source` states that the rest of its content requires payment or a subscription to read.',
});

/** 片段级 score 题的三档 legend（与 probe、两份 `.jev.json` 夹具的 levels 逐字一致）。 */
export const SNIPPET_LEVELS: readonly string[] = Object.freeze([
  'Navigation, metadata, boilerplate, or unrelated to `query`',
  'Mentions the subject of `query` but adds no specific information',
  'States specific information or analysis that directly serves `intent`',
]);

/**
 * 十一项阈值默认值（notes/shadow-mode-logging.md 权威初值，全部待 Phase 4 影子期
 * 修订）。判据方向：来源级五道丢弃门槛是概率 >= 门槛即丢（含等号）；片段
 * `score < snippetMin` 严格小于才删（score = 1.0 保留）；CJK 占比 > cjkShare 时
 * 五道丢弃门槛各加 cjkBonus。概率是 API 侧两位小数值，客户端不再舍入。
 */
export const DEFAULT_THRESHOLDS = Object.freeze({
  offTopicDrop: 0.85,
  listingDrop: 0.8,
  selfDeprecated: 0.7,
  staleDrop: 0.85,
  fillerDrop: 0.8,
  reasoningProtect: 0.7,
  snippetMin: 1.0,
  minFacts: 4,
  noveltyMin: 2,
  cjkBonus: 0.1,
  cjkShare: 0.5,
} as const);

/**
 * 钉住的模型版本 ID（JEV-06；笔记记录的当前版本，也是两份夹具 `response.model`
 * 的实证值——请求发的 latest 别名、响应回实际版本）。新版本发布后跑样本回归再
 * 手动切换；代码与注释里绝不写随发布漂移的 latest 别名。
 */
export const DEFAULT_JEV_MODEL = 'jev-1.13.0';

/** 超时纯兜底初值（SAFE-01；2026-09-25 直连实测单请求摊 ≈0.55 s，15 s 足够宽）。 */
export const DEFAULT_JEV_TIMEOUT_MS = 15000;

/** 进程级并发闸初值（JEV-04；02-05 的 createJevClassifier 闭包消费，一波全发）。 */
export const DEFAULT_JEV_CONCURRENCY = 12;

/** 环境变量名（EMBED-05）：默认值与变量名同处可见。 */
export const JEV_MODEL_ENV = 'JEV_FILTER_JEV_MODEL';
export const JEV_BACKEND_ENV = 'JEV_FILTER_JEV_BACKEND';
export const JEV_TIMEOUT_MS_ENV = 'JEV_FILTER_JEV_TIMEOUT_MS';
export const JEV_CONCURRENCY_ENV = 'JEV_FILTER_JEV_CONCURRENCY';

/**
 * 十一项阈值配置文件的环境变量（EMBED-05 / 用户已定决策 4）：阈值不走散装
 * `JEV_FILTER_THRESHOLD_*` 变量，经单一 `JEV_FILTER_CONFIG_FILE` 指向的本地
 * JSON 文件提供，影子期调参只改一个文件、不用改代码。
 */
export const JEV_CONFIG_FILE_ENV = 'JEV_FILTER_CONFIG_FILE';

/**
 * 配置文件键 → JevThresholds 键与合法范围（键名用十一项 snake_case，与 probe
 * 的 THRESHOLDS 键名一致；未知键忽略为 fail-open 方向）。范围语义：六个概率
 * 门槛（五道丢弃 + reasoning 保护）与 cjk_bonus、cjk_share 取 [0,1] 的有限数；
 * snippet_min 取 [0,3]（score 是三档 legend 上的连续加权位置）；min_facts 与
 * novelty_min 取 >= 1 的有限数。max 为 Infinity 表示只有下限。
 */
const THRESHOLD_FILE_KEYS: ReadonlyArray<{
  readonly fileKey: string;
  readonly configKey: keyof JevThresholds;
  readonly min: number;
  readonly max: number;
}> = Object.freeze([
  { fileKey: 'off_topic_drop', configKey: 'offTopicDrop', min: 0, max: 1 },
  { fileKey: 'listing_drop', configKey: 'listingDrop', min: 0, max: 1 },
  { fileKey: 'self_deprecated', configKey: 'selfDeprecated', min: 0, max: 1 },
  { fileKey: 'stale_drop', configKey: 'staleDrop', min: 0, max: 1 },
  { fileKey: 'filler_drop', configKey: 'fillerDrop', min: 0, max: 1 },
  { fileKey: 'reasoning_protect', configKey: 'reasoningProtect', min: 0, max: 1 },
  { fileKey: 'snippet_min', configKey: 'snippetMin', min: 0, max: 3 },
  { fileKey: 'min_facts', configKey: 'minFacts', min: 1, max: Number.POSITIVE_INFINITY },
  { fileKey: 'novelty_min', configKey: 'noveltyMin', min: 1, max: Number.POSITIVE_INFINITY },
  { fileKey: 'cjk_bonus', configKey: 'cjkBonus', min: 0, max: 1 },
  { fileKey: 'cjk_share', configKey: 'cjkShare', min: 0, max: 1 },
]);

// 只能用 console.error：stdout 是 stdio 传输的协议通道，绝不能写（description.ts 先例）。
const reportFileError = (filePath: string, reason: string): void => {
  console.error(
    `[jev-filter] Unable to read Jev thresholds config file '${filePath}': ${reason}; using the built-in defaults.`
  );
};

/**
 * 解析十一项阈值：变量未设 → `DEFAULT_THRESHOLDS` 的浅拷贝；文件读不到或
 * JSON.parse 失败（或顶层不是 JSON 对象）→ console.error 一行（[jev-filter]
 * 前缀、含路径与原因）并整体回落默认（fail-open，description.ts 先例）；解析
 * 成功后逐项合并——未知键忽略、缺项保持默认、坏值（非有限数或越界）仅该项
 * 回落默认、其余文件项照常生效（T-02-06-1：坏值绝不让整层静默失效）。字符串
 * 等非数值一律回落默认（T-02-06-3：key 即使误写进配置文件也不会被读成任何
 * 行为开关——阈值解析只接受数值键）。
 * @param env 环境变量映射（传 `process.env` 或测试用的显式对象）
 * @returns 冻结的 JevThresholds（形态照 `DEFAULT_THRESHOLDS`）
 * @example resolveThresholds({}) 与 { ...DEFAULT_THRESHOLDS } deepEqual
 * @example resolveThresholds({ JEV_FILTER_CONFIG_FILE: '/no/such/file' }) → 默认 + stderr 一行
 */
export function resolveThresholds(env: Record<string, string | undefined>): JevThresholds {
  const merged: JevThresholds = { ...DEFAULT_THRESHOLDS };

  const filePath = env[JEV_CONFIG_FILE_ENV]?.trim();
  if (!filePath) return Object.freeze(merged);

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    reportFileError(filePath, reason);
    return Object.freeze(merged);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    reportFileError(filePath, 'content is not a JSON object');
    return Object.freeze(merged);
  }

  const file = parsed as Record<string, unknown>;
  for (const { fileKey, configKey, min, max } of THRESHOLD_FILE_KEYS) {
    const value = file[fileKey];
    if (typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max) {
      merged[configKey] = value;
    }
  }
  return Object.freeze(merged);
}

/**
 * 构造单来源 state：官方"context rot"规则——state 里只放问题需要的东西
 * （id / url / title / 幸存片段），不放元数据、不放被删片段。
 * @example buildState('s0', 'https://a.example/', 'T', ['x'], 'q', 'i')
 *   → { query: 'q', intent: 'i', source: { id: 's0', url: 'https://a.example/', title: 'T', snippets: ['x'] } }
 */
export function buildState(
  id: string,
  url: string,
  title: string,
  snippets: string[],
  query: string,
  intent: string
): JevState {
  return { query, intent, source: { id, url, title, snippets } };
}

/**
 * 构造题目表：十道来源级 noul 题 + 每片段一道 score 题（`snip{i}`），每题
 * instructions 前缀总指令加空格，score 题带三档 criteria。
 * @param nSnips 幸存片段数（state.snippets.length）
 * @example Object.keys(buildQuestions(3)).length === 13
 */
export function buildQuestions(nSnips: number): Record<string, JevQuestion> {
  const questions: Record<string, JevQuestion> = {};
  for (const [key, text] of Object.entries(SOURCE_QUESTIONS)) {
    questions[key] = { type: 'noul', instructions: `${GLOBAL_INSTRUCTION} ${text}` };
  }
  for (let i = 0; i < nSnips; i += 1) {
    questions[`snip${i}`] = {
      type: 'score',
      instructions: `${GLOBAL_INSTRUCTION} How useful is \`source.snippets[${i}]\` for \`intent\`?`,
      criteria: SNIPPET_LEVELS,
    };
  }
  return questions;
}
