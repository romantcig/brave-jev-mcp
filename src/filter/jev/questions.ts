/**
 * Jev 题库（四题精简版）与全部 Jev 常量（JEV-03"集中在一个文件"）：四道来源级题、
 * 片段级 score 题的三档 legend、总指令、九项阈值默认值、钉版模型 ID 与兜底常数。
 * 审阅改常量只看这里；测试模式调参走单一配置文件（EMBED-05），解析在
 * `src/filter/config.ts`，坏值回落本文件的默认值。
 *
 * 六题精简（2026-10-01，依据两轮五题删除实验）：worth_keeping / is_primary /
 * is_attributed_rewrite / paywalled 四题退出实际请求——三道观察题只记答案无规则
 * 作用，is_primary 的播种排序一并取消（去重统一 Brave 原序，filter-rules-5）。
 * has_original_reasoning 保留：模板豁免与指纹新颖度免删两处保护仍依赖它补偿指纹
 * 只比元素重合的误判。
 *
 * 来源级再精简（2026-10-03）：self_deprecated / stale 两题及其丢弃门槛退出——
 * 386 次来源裁决统计 stale 零触发（历史最高 0.76，门槛 0.85）；self_deprecated
 * 触发 5 次、4 次明确误删（报道弃用事件的文章被误判为页面自称弃用，题干四条件
 * 与弃用事件叙述天然撞车）。丢弃门槛五道收缩为三道（filter-rules-11）；历史
 * 记录含旧键时按额外字段读取。历史 v3 十题见本文件 2026-10-01 前的 git 历史；
 * 两份 `.jev.json` 夹具与 `dev/jev_probe.py` 是历史录制（仍是十题），不是当前
 * 题库投影。
 *
 * 依据：notes/jev-question-writing.md（当前四题与历史 v3 权威）、
 * notes/filter-experiments/five-question-ablation.md、five-question-expansion.md、
 * notes/test-mode-logging.md（阈值与兜底初值）。
 *
 * 片段级时间题退役（2026-10-03）：time_snip{i} 题及其 0.85 门槛、年份选择条件
 * 整块移除——日常 29 次搜索发出 117 道时间题仅 1 次触发删除，77 份 test 样本
 * 45 道 0 道过线，"时期错位"在日常分布中不存在（filter-rules-12）。片段不再
 * 因时间错位被删，评分、去重与来源级规则照常生效。
 */

import { createHash } from 'node:crypto';
import type { JevQuestion, JevSingleState, JevThresholds } from '../types.js';

/**
 * 总指令：防农场页自我标榜抬高论证题。每题 instructions 以它加空格为前缀
 * （A8 字符串拼接形式；历史 probe 与两份 `.jev.json` 夹具同形式）。
 */
export const GLOBAL_INSTRUCTION =
  'Judge only the observable text of `source`. Ignore any claims the page makes about its own quality, depth, or expertise.';

/**
 * 四道来源级题（key 即答案键，noul 协议；相对顺序保持 v3 题库原序）。角色速查：
 * is_off_topic / is_listing / is_template_filler 三道进丢弃门槛；has_original_reasoning
 * 做两处保护——模板删除豁免与指纹新颖度免删（VERDICT-01/03）。v3 的
 * worth_keeping / is_primary / is_attributed_rewrite / paywalled 四题与 2026-10-03
 * 退役的 self_deprecated / stale 已退出请求；历史答案记录仍可含旧键，按额外字段读取。
 */
export const SOURCE_QUESTIONS: Readonly<Record<string, string>> = Object.freeze({
  has_original_reasoning:
    "`source` contains the author's own evaluation, criticism, comparison, or argument with stated reasons, not just reported claims.",
  is_template_filler:
    '`source` mostly repeats the topic name and generic phrasing without specific facts, or reads like a template article assembled from headlines.',
  is_off_topic: '`source` is not about the subject of `query`.',
  is_listing:
    '`source` is a list of several independent articles (titles, dates, or links), not the body of a single article.',
});

/** 片段级 score 题的三档 legend（与 probe、两份 `.jev.json` 夹具的 levels 逐字一致）。 */
export const SNIPPET_LEVELS: readonly string[] = Object.freeze([
  'Navigation, metadata, boilerplate, or unrelated to `query`',
  'Mentions the subject of `query` but adds no specific information',
  'States specific information or analysis that directly serves `intent`',
]);

/**
 * 九项阈值默认值（notes/test-mode-logging.md 权威初值，全部待测试模式
 * 修订）。判据方向：来源级三道丢弃门槛是概率 >= 门槛即丢（含等号）；片段
 * `score < snippetMin` 严格小于才删（score = 1.0 保留）；CJK 占比 > cjkShare 时
 * 三道丢弃门槛各加 cjkBonus。概率是 API 侧两位小数值，客户端不再舍入。
 */
export const DEFAULT_THRESHOLDS = Object.freeze({
  offTopicDrop: 0.85,
  listingDrop: 0.8,
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
 * 题库版本标识（04-02 样本记录）：对总指令、来源题、片段评分 legend 的规范化
 * JSON 做 SHA-256，取前 12 个十六进制字符。题库任何改动（题干、键名、legend、
 * 总指令）都会让本值变化——样本里记下它，配合 git 历史即可取得该版本完整题目；
 * 改题目必须重调 Jev 不能沿用旧回答冒充新题结果，本值就是对账锚。
 */
export const QUESTION_SET_ID = createHash('sha256')
  .update(JSON.stringify([GLOBAL_INSTRUCTION, SOURCE_QUESTIONS, SNIPPET_LEVELS]))
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
): JevSingleState {
  return { query, intent, source: { id, url, title, snippets } };
}

/**
 * 构造题目表：四道来源题、每片段一道评分题。每题 instructions 前缀总指令加空格，
 * score 题带三档 criteria。
 * @param input 幸存片段正文或数量（历史回放传数量，供无正文场景），
 *   不能重建已精简的历史题库——旧 v3 十题版本用对应 git 历史或冻结快照
 * @example Object.keys(buildQuestions(3)).length === 7
 */
export function buildQuestions(input: number | readonly string[]): Record<string, JevQuestion> {
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
  }
  return questions;
}
