/**
 * 从最终统计生成单行英文摘要，供宿主作为第二个 text 块返回。
 * 来源按删除原因计数；片段只统计幸存来源内的删除，避免重复计算。
 * test/on 模式还提示保守保留但未完成 Jev 裁决的来源；无删除时不生成状态行。
 */

import type { FilterStats, SourceDropReason } from './types.js';

/** 兼容旧 stale 记录时，intent 回显的最大长度。 */
const INTENT_ECHO_MAX = 100;

/** 主数字的英文复数规则；原因词不变形，不用本助手。 */
const plural = (count: number, singular: string): string =>
  count === 1 ? singular : `${singular}s`;

/** 生成状态行；没有删除或未完成的 Jev 检查时返回 undefined。 */
export function buildStatusLine(stats: FilterStats): string | undefined {
  const dropped = stats.sources.filter((source) => source.verdict === 'drop');

  // 按原因首次出现的顺序聚合；兼容旧 stale 记录时逐来源回显 intent。
  const intentEcho = `"${truncateIntent(stats.request.intent)}"`;
  const reasonCounts = new Map<SourceDropReason, number>();
  type ListItem = { kind: 'count'; reason: SourceDropReason } | { kind: 'stale' };
  const list: ListItem[] = [];
  for (const source of dropped) {
    const reason: SourceDropReason = source.reason ?? 'empty';
    if (reason === 'stale') {
      // 仅用于历史样本的 stale 原因兼容。
      list.push({ kind: 'stale' });
      continue;
    }
    if (!reasonCounts.has(reason)) list.push({ kind: 'count', reason });
    reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
  }

  // 只统计幸存来源内的片段删除，被丢来源不重复计数。
  let removedSnippets = 0;
  for (const source of stats.sources) {
    if (source.verdict !== 'keep') continue;
    for (const snippet of source.snippets) {
      if (!snippet.kept) removedSnippets += 1;
    }
  }

  // 保留来源缺少回答、请求失败或来源裁决校验失败时，提示 Jev 未完成检查。
  // 收到可解析响应不等于取得有效裁决；off 模式不显示此提示。
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

  if (dropped.length === 0 && removedSnippets === 0 && unchecked === 0) {
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
  if (unchecked > 0) {
    parts.push(`${unchecked} ${plural(unchecked, 'source')} not checked by Jev (kept)`);
  }
  return `[filter] ${parts.join('; ')}`;
}

/**
 * 只转义展示文本，不改传给 Jev 和日志的原 intent。
 * 引号、反斜杠、控制字符和孤立代理码元显示为转义串，保持状态行单行。
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

/** 转义后截断 intent；若截断点劈开合法代理对则回退一位。 */
const truncateIntent = (intent: string): string => {
  const escaped = escapeForEcho(intent);
  if (escaped.length <= INTENT_ECHO_MAX) return escaped;
  let cut = escaped.slice(0, INTENT_ECHO_MAX);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return `${cut}…`;
};
