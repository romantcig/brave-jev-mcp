/**
 * 从最终统计生成单行英文摘要，供宿主作为第二个 text 块返回。
 * 来源按删除原因计数；片段只统计幸存来源内的删除，避免重复计算。
 * test/on 模式在出现 Jev 故障或未完成检查时报告结构化 [error] 标记；全通过且无删除时不生成状态行。
 */

import type { FilterStats, JevFailKind, SourceDropReason } from './types.js';
import { DEFAULT_CONFIG_FILE, JEV_CONFIG_FILE_ENV } from './config.js';

/** 标准错误与工具返回共用配置指引，避免只给出无法操作的状态码。 */
export const JEV_KEY_SETUP_HINT =
  "Set TYPESAFE_API_KEY to your Jev API key in this MCP server's env configuration, then restart the MCP server. " +
  `To disable Jev, set "mode": "off" in the JSON file selected by ${JEV_CONFIG_FILE_ENV}, or ${DEFAULT_CONFIG_FILE} when unset, then restart the MCP server.`;

/** 状态行识别的失败类型：per_source 的 fail_kind 加上熔断与无密钥。 */
type StatusLineFailKind = JevFailKind | 'no_key' | 'circuit_breaker';

/** 主数字的英文复数规则；原因词不变形，不用本助手。 */
const plural = (count: number, singular: string): string =>
  count === 1 ? singular : `${singular}s`;

/** 生成状态行；没有删除或未完成的 Jev 检查时返回 undefined。 */
export function buildStatusLine(stats: FilterStats): string | undefined {
  const dropped = stats.sources.filter((source) => source.verdict === 'drop');

  // 按原因首次出现的顺序聚合。
  const reasonCounts = new Map<SourceDropReason, number>();
  for (const source of dropped) {
    const reason: SourceDropReason = source.reason ?? 'empty';
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

  // 保留来源缺少回答、请求失败或页面/组合题校验失败时，报告结构化 [error] 标记。
  // 收到可解析响应不等于取得有效裁决；off 模式不显示此提示。
  let unchecked = 0;
  const failKinds = new Set<StatusLineFailKind>();
  const failStatusMap = new Map<StatusLineFailKind, number>();

  if (stats.mode !== 'off') {
    if (stats.jev?.status === 'no_key') {
      failKinds.add('no_key');
    }
    if (stats.jev?.requests) {
      for (const req of stats.jev.requests) {
        if (req.fail_kind) {
          const kind: StatusLineFailKind =
            req.fail_kind === 'breaker_open' ? 'circuit_breaker' : req.fail_kind;
          failKinds.add(kind);
          if (req.http_status !== undefined && req.http_status !== 200) {
            failStatusMap.set(kind, req.http_status);
          }
        }
      }
    }
    const bySrc = new Map((stats.jev?.per_source ?? []).map((row) => [row.src, row]));
    for (const source of stats.sources) {
      if (source.verdict !== 'keep') continue;
      const row = bySrc.get(`s${source.index}`);
      const invalidGroups = Object.keys(row?.snippet_validation ?? {}).length > 0;
      if (
        row === undefined ||
        row.status !== 'answered' ||
        row.fail_kind === 'validation' ||
        invalidGroups
      ) {
        unchecked += 1;
        if (invalidGroups) failKinds.add('validation');
        if (row?.status === 'breaker_open') {
          failKinds.add('circuit_breaker');
        } else if (row?.fail_kind !== undefined) {
          failKinds.add(row.fail_kind);
        }
      }
    }
  }

  if (dropped.length === 0 && removedSnippets === 0 && unchecked === 0) {
    return undefined;
  }

  const parts: string[] = [];
  if (dropped.length > 0) {
    const reasonList = [...reasonCounts.entries()]
      .map(([reason, count]) => `${count} ${reason}`)
      .join(', ');
    parts.push(
      `dropped ${dropped.length} of ${stats.brave.n_sources} ${plural(stats.brave.n_sources, 'source')}: ${reasonList}`
    );
  }
  if (removedSnippets > 0) {
    parts.push(`${removedSnippets} ${plural(removedSnippets, 'snippet')} removed`);
  }

  if (unchecked > 0) {
    parts.push(formatFilterError(unchecked, failKinds, failStatusMap));
  }

  return `[filter] ${parts.join('; ')}`;
}

/** 格式化过滤失败报错信息为 [error] [内容] [报错数字] 格式。 */
function formatFilterError(
  unchecked: number,
  failKinds: Set<StatusLineFailKind>,
  failStatusMap: Map<StatusLineFailKind, number>
): string {
  const countDesc = `${unchecked} ${plural(unchecked, 'source')} unchecked`;
  if (failKinds.size === 0) {
    return `[error] [${countDesc}: filter check incomplete, raw sources kept] [500]`;
  }

  const PRIORITY: StatusLineFailKind[] = [
    'no_key',
    'auth',
    'circuit_breaker',
    'rate_limited',
    'timeout',
    'network',
    'validation',
  ];
  let primaryKind: StatusLineFailKind | undefined;
  for (const k of PRIORITY) {
    if (failKinds.has(k)) {
      primaryKind = k;
      break;
    }
  }
  if (!primaryKind) {
    primaryKind = Array.from(failKinds)[0];
  }

  let reason = 'upstream error';
  let defaultCode = 500;

  switch (primaryKind) {
    case 'rate_limited':
      reason = 'rate limited';
      defaultCode = 429;
      break;
    case 'timeout':
      reason = 'timeout';
      defaultCode = 408;
      break;
    case 'circuit_breaker':
      reason = 'circuit breaker open';
      defaultCode = 503;
      break;
    case 'no_key':
      reason = 'missing API key';
      defaultCode = 401;
      break;
    case 'auth':
      reason = 'unauthorized';
      defaultCode = 401;
      break;
    case 'validation':
      reason = 'payload rejected';
      defaultCode = 422;
      break;
    case 'network':
      reason = 'upstream error';
      defaultCode = 500;
      break;
    default:
      reason = 'upstream error';
      defaultCode = 500;
      break;
  }

  const code = failStatusMap.get(primaryKind) ?? defaultCode;
  const help = primaryKind === 'no_key' ? ` ${JEV_KEY_SETUP_HINT}` : '';
  return `[error] [${countDesc}: filter ${reason}, raw sources kept] [${code}]${help}`;
}
