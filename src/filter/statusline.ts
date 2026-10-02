/**
 * 状态行生成（管道步 10）：从统计对象投影出一行英文摘要，追加在工具返回的
 * `content` 末尾作为第二个 text 块，同时写进 `stats.output.status_line`
 * （LOG-03 同源：适配行追加第二块时读的就是这个字段，绝不自创条件）。
 *
 * 口径（03-CONTEXT D-01..D-08）：
 * - 英文单行，形如 `[filter] dropped 4 of 12 sources: 2 rewrite, 1 stale, 1 blocklist; 17 snippets removed`；
 * - 来源按原因计数，原因词直接用 `SourceDropReason` 键原样、不变形（含 `budget`
 *   并入计数；`merged` 不算丢弃——归并是动作不是信息损失）；片段只给一个总数
 *   （幸存来源内被删片段，被丢来源的片段不重复计，与 dev/compare.ts 的
 *   `afterOf` 同式）；
 * - D-03：stale 丢弃不聚合，每个 stale 来源独立成项并回显 intent 原句
 *   `1 stale (vs intent: "…")`；超 100 字符截断加省略号。绝不用代码从 intent
 *   抽版本号（与"版本号正则不做"同精神，零误判）。（2026-10-03 注：stale 门槛题
 *   已退役，新运行不再产生该原因——本分支与 D-03 口径仅为历史样本记录保留）；
 * - D-05：付费墙截断 > 0 时单列一项（它是片段级动作不是来源级原因）；
 * - D-06：test 与 on 同口径统计"Jev 未判定"来源（mode !== 'off'，04-CONTEXT：test
 *   状态行不假装完成 Jev 检查）——最终 keep 且 per_source 缺行、该行
 *   status 非 answered、或 answered 但 fail_kind='validation'（回答已收到但未完成
 *   有效裁决，A-04）；> 0 时追加 `N source(s) not checked by Jev (kept)`，
 *   零丢弃也附（模型要知道结果是漏网的）；off 绝不出现这一段；
 * - 单复数：主数字用英文复数规则（1 source / 2 sources、1 snippet / N snippets），
 *   原因词保持键原样不变形；
 * - 附加条件（D-04，任一成立就附，全都没有返回 undefined）：有来源丢弃 /
 *   有片段删除 / 有付费墙截断 / test 或 on 模式有 Jev 未判定来源。
 *
 * 纯函数：不抛错（统计对象字段全部防御式读取）、不引任何 MCP 类型。
 *
 * 依据：03-CONTEXT.md D-01..D-08、03-RESEARCH.md 六问 5 / Code Examples。
 */

import type { FilterStats, SourceDropReason } from './types.js';

/** intent 回显截断长度（Claude's Discretion 落定：100 字符 + 省略号，D-03）。 */
const INTENT_ECHO_MAX = 100;

/** 主数字的英文复数规则；原因词不变形，不用本助手。 */
const plural = (count: number, singular: string): string =>
  count === 1 ? singular : `${singular}s`;

/**
 * 从最终统计对象生成状态行；无可报告内容时返回 undefined（不附第二块）。
 * @example 全部幸存且零删除 → undefined
 * @example 有来源丢弃 → `[filter] dropped 1 of 10 sources: 1 stale (vs intent: "…")`
 */
export function buildStatusLine(stats: FilterStats): string | undefined {
  const dropped = stats.sources.filter(
    (source) => source.verdict === 'drop' && source.reason !== 'merged'
  );

  // 计数列表（D-02/D-03）：非 stale 原因按首次出现顺序聚合计数（Map 插入序）；
  // stale 逐源独立成项并回显 intent。渲染按列表序，聚合计数遍历后回填。
  // （stale 门槛题已退役（2026-10-03），新运行不再产生该原因——本分支仅为历史
  // 样本记录保留，行为零改动。）
  const intentEcho = `"${truncateIntent(stats.request.intent)}"`;
  const reasonCounts = new Map<SourceDropReason, number>();
  type ListItem = { kind: 'count'; reason: SourceDropReason } | { kind: 'stale' };
  const list: ListItem[] = [];
  for (const source of dropped) {
    const reason: SourceDropReason = source.reason ?? 'empty';
    if (reason === 'stale') {
      // 已退役原因：仅为消费历史样本记录保留（SourceDropReason 注释同源）
      list.push({ kind: 'stale' });
      continue;
    }
    if (!reasonCounts.has(reason)) list.push({ kind: 'count', reason });
    reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
  }

  // 幸存来源内被删片段总数（A2 口径；被丢来源的片段不重复计）
  let removedSnippets = 0;
  for (const source of stats.sources) {
    if (source.verdict !== 'keep') continue;
    for (const snippet of source.snippets) {
      if (!snippet.kept) removedSnippets += 1;
    }
  }

  // 付费墙是片段级动作不是来源级原因，单独计数（D-05）
  const paywallTruncated = stats.local.paywall_truncated;

  // Jev 未判定来源（D-06）：test 与 on 同口径（mode !== 'off'，04-CONTEXT——test
  // 状态行与 on 同规则，不假装完成 Jev 检查）——最终 keep 且 per_source 缺行
  // （如 no_key 零值对象、本地规则后未入候选）、该行 status 非 answered，或
  // answered 但 fail_kind='validation'（A-04：回答已收到但关键答案缺失/越界，
  // 防御式保留——"回答已收到"不等于"已完成有效裁决"）。
  let unchecked = 0;
  if (stats.mode !== 'off') {
    const bySrc = new Map((stats.jev?.per_source ?? []).map((row) => [row.src, row]));
    for (const source of stats.sources) {
      if (source.verdict !== 'keep') continue;
      const row = bySrc.get(`s${source.index}`);
      if (row === undefined || row.status !== 'answered' || row.fail_kind === 'validation') {
        unchecked += 1;
      }
    }
  }

  // D-04 附加条件：全都没有不附。
  if (dropped.length === 0 && removedSnippets === 0 && paywallTruncated === 0 && unchecked === 0) {
    return undefined;
  }

  const parts: string[] = [];
  if (dropped.length > 0) {
    const reasonList = list
      .map((item) =>
        item.kind === 'stale'
          ? `1 stale (vs intent: ${intentEcho})`
          : `${reasonCounts.get(item.reason)} ${item.reason}`
      )
      .join(', ');
    parts.push(
      `dropped ${dropped.length} of ${stats.brave.n_sources} ${plural(stats.brave.n_sources, 'source')}: ${reasonList}`
    );
  }
  if (removedSnippets > 0) {
    parts.push(`${removedSnippets} ${plural(removedSnippets, 'snippet')} removed`);
  }
  if (paywallTruncated > 0) {
    parts.push(`${paywallTruncated} ${plural(paywallTruncated, 'snippet')} paywall-truncated`);
  }
  if (unchecked > 0) {
    parts.push(`${unchecked} ${plural(unchecked, 'source')} not checked by Jev (kept)`);
  }
  return `[filter] ${parts.join('; ')}`;
}

/**
 * intent 回显的展示层转义（A-01/A-02）：状态行是单行英文摘要，模型传来的合法
 * intent 可能含跨行、控制字符与引号——原 intent 照旧送给 Jev 与日志（不拒绝
 * 搜索、不改写、不做语言识别），只在回显处：
 * - 反斜杠与直引号转义——包裹引号边界清楚，优先转义而不是删除；
 * - CR/LF/TAB 与其余 C0 控制、DEL、U+2028/U+2029 转成 `\n` 式可见转义，
 *   绝不原样透传跨行/控制字符；
 * - 孤立代理对转成 `\uXXXX`（原 intent 里就不放行）。
 * 普通字符逐字保留——无特殊字符的 intent 外观与旧实现完全一致。
 */
const escapeForEcho = (intent: string): string =>
  intent.replace(
    /[\u0000-\u001f\u007f\u2028\u2029"\\]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g,
    (char) => {
      switch (char) {
        case '"':
          return '\\"';
        case '\\':
          return '\\\\';
        case '\n':
          return '\\n';
        case '\r':
          return '\\r';
        case '\t':
          return '\\t';
        default:
          return `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`;
      }
    }
  );

/**
 * intent 回显：转义后超 100 字符截断加省略号（D-03）。码元截断若把合法代理对
 * （emoji 等）劈成孤立高代理，回退一位——截断不劈代理对；转义串本身不含孤立
 * 代理对，劈开只可能发生在截断处。不抽版本号、不做任何改写（D-03）。
 */
const truncateIntent = (intent: string): string => {
  const escaped = escapeForEcho(intent);
  if (escaped.length <= INTENT_ECHO_MAX) return escaped;
  let cut = escaped.slice(0, INTENT_ECHO_MAX);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return `${cut}…`;
};
