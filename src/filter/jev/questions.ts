/**
 * Jev 题库（六题精简版）与全部 Jev 常量（JEV-03"集中在一个文件"）：六道来源级题、
 * 片段级 score 题的三档 legend、总指令、十一项阈值默认值、钉版模型 ID 与兜底常数。
 * 审阅改常量只看这里；测试模式调参走单一配置文件（EMBED-05），解析在
 * `src/filter/config.ts`，坏值回落本文件的默认值。
 *
 * 六题精简（2026-10-01，依据两轮五题删除实验）：worth_keeping / is_primary /
 * is_attributed_rewrite / paywalled 四题退出实际请求——三道观察题只记答案无规则
 * 作用，is_primary 的播种排序一并取消（去重统一 Brave 原序，filter-rules-5）。
 * has_original_reasoning 保留：模板豁免与指纹新颖度免删两处保护仍依赖它补偿指纹
 * 只比元素重合的误判。历史 v3 十题见本文件 2026-10-01 前的 git 历史；两份
 * `.jev.json` 夹具与 `dev/jev_probe.py` 是历史录制（仍是十题），不是当前题库投影。
 *
 * 依据：notes/jev-question-writing.md（当前六题与历史 v3 权威）、
 * notes/filter-experiments/five-question-ablation.md、five-question-expansion.md、
 * notes/test-mode-logging.md（阈值与兜底初值）。
 */

import { createHash } from 'node:crypto';
import type { JevQuestion, JevState, JevThresholds } from '../types.js';

/**
 * 总指令：防农场页自我标榜抬高论证题。每题 instructions 以它加空格为前缀
 * （A8 字符串拼接形式；历史 probe 与两份 `.jev.json` 夹具同形式）。
 */
export const GLOBAL_INSTRUCTION =
  'Judge only the observable text of `source`. Ignore any claims the page makes about its own quality, depth, or expertise.';

/**
 * 六道来源级题（key 即答案键，noul 协议；相对顺序保持 v3 题库原序）。角色速查：
 * is_off_topic / is_listing / self_deprecated / stale / is_template_filler 五道进
 * 丢弃门槛；has_original_reasoning 做两处保护——模板删除豁免与指纹新颖度免删
 * （VERDICT-01/03）。v3 的 worth_keeping / is_primary / is_attributed_rewrite /
 * paywalled 四题已退出请求；历史答案记录仍可含旧键，按额外字段读取。
 */
export const SOURCE_QUESTIONS: Readonly<Record<string, string>> = Object.freeze({
  has_original_reasoning:
    "`source` contains the author's own evaluation, criticism, comparison, or argument with stated reasons, not just reported claims.",
  is_template_filler:
    '`source` mostly repeats the topic name and generic phrasing without specific facts, or reads like a template article assembled from headlines.',
  is_off_topic: '`source` is not about the subject of `query`.',
  is_listing:
    '`source` is a list of several independent articles (titles, dates, or links), not the body of a single article.',
  self_deprecated:
    '`source` states that it is deprecated, archived, superseded by another tool or document, or no longer maintained.',
  stale:
    '`source` shows code or configuration written for an older approach than the version and mechanism named in `intent`, without also showing the current approach.',
});

/** 片段级 score 题的三档 legend（与 probe、两份 `.jev.json` 夹具的 levels 逐字一致）。 */
export const SNIPPET_LEVELS: readonly string[] = Object.freeze([
  'Navigation, metadata, boilerplate, or unrelated to `query`',
  'Mentions the subject of `query` but adds no specific information',
  'States specific information or analysis that directly serves `intent`',
]);

/** 年份只用于决定是否提问，不能单凭年份删除正文。 */
export const EXPLICIT_YEAR_PATTERN = /\b(?:19|20)\d{2}\b/;
export const hasExplicitYear = (text: string): boolean => EXPLICIT_YEAR_PATTERN.test(text);

/** 时间判断只处理带年份的片段，不触发整页删除；与常规片段评分分开记账。 */
export const TEMPORAL_SNIPPET_DROP = 0.85;
export const TEMPORAL_SNIPPET_INSTRUCTION =
  'Use explicit event or measurement dates in the body first. A page date alone does not date all of its statements. If no event period can be established, do not assume a mismatch. Historical queries require historical evidence.';
export const temporalQuestionText = (index: number): string =>
  `${GLOBAL_INSTRUCTION} ${TEMPORAL_SNIPPET_INSTRUCTION} source.snippets[${index}] describes an event, reaction, or measurement from an earlier period than the one requested in intent.`;

/**
 * 十一项阈值默认值（notes/test-mode-logging.md 权威初值，全部待测试模式
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

/**
 * 题库版本标识（04-02 样本记录）：对总指令、来源题、片段评分 legend、年份选择条件
 * 和时间题模板的规范化 JSON 做 SHA-256，
 * 取前 12 个十六进制字符。题库任何改动（题干、键名、legend、总指令）都会让本值
 * 变化——样本里记下它，配合 git 历史即可取得该版本完整题目；改题目必须重调 Jev
 * 不能沿用旧回答冒充新题结果，本值就是对账锚。
 */
export const QUESTION_SET_ID = createHash('sha256')
  .update(
    JSON.stringify([
      GLOBAL_INSTRUCTION,
      SOURCE_QUESTIONS,
      SNIPPET_LEVELS,
      EXPLICIT_YEAR_PATTERN.source,
      temporalQuestionText(0),
    ])
  )
  .digest('hex')
  .slice(0, 12);

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
 * 构造题目表：六道来源题、每片段一道评分题；传正文时，带年份片段另有时间题。
 * 每题 instructions 前缀总指令加空格，score 题带三档 criteria。
 * @param input 幸存片段正文；传数量仅省略年份题分支（供无正文的历史回放），
 *   不能重建已精简的历史题库——旧 v3 十题版本用对应 git 历史或冻结快照
 * @example Object.keys(buildQuestions(3)).length === 9
 */
export function buildQuestions(input: number | readonly string[]): Record<string, JevQuestion> {
  // 数量形式供历史录制回放使用；生产传入正文，只为实际带年份的片段追加题目。
  const nSnips = typeof input === 'number' ? input : input.length;
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
    if (typeof input !== 'number' && hasExplicitYear(input[i])) {
      questions[`time_snip${i}`] = { type: 'noul', instructions: temporalQuestionText(i) };
    }
  }
  return questions;
}
