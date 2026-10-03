/** 每次调用新建统计对象，隔离请求间状态；统计不存片段正文。 */

import { canonicalizeUrl } from './url.js';
import { estimateTokens } from './tokens.js';
import type {
  BraveLlmContextResponse,
  FilterMode,
  FilterStats,
  JevStats,
  LocalStats,
  SourceStats,
} from './types.js';

/**
 * 本地计数器的零值。冻结成常量，供夹具测试用 `{ ...zeroLocal, ...expected }` 合并；
 * 库内部只做浅拷贝后再递增，不会改到这份常量。`novelty` 数组在工厂里另行新建——
 * 浅拷贝载体不共享这份空数组引用（替换式写回也绝不会 mutate 它）。
 */
export const zeroLocal: Readonly<LocalStats> = Object.freeze({
  jsonld_converted: 0,
  jsonld_dropped: 0,
  jsonld_kept_raw: 0,
  url_merged: 0,
  snippets_prefiltered: 0,
  dup_removed: 0,
  paywall_truncated: 0,
  feed_hits: 0,
  blocklist_hits: 0,
  empty_dropped: 0,
  budget_dropped_sources: 0,
  budget_trimmed_snippets: 0,
  novelty_removed: 0,
  cross_source_dup_removed: 0,
  github_cleanup_actions: 0,
  novelty: [],
});

/** 防御性读取 `grounding.generic`：上游已过 zod，但库对畸形输入也不抛。 */
const genericItems = (
  data: BraveLlmContextResponse
): BraveLlmContextResponse['grounding']['generic'] =>
  Array.isArray(data?.grounding?.generic) ? data.grounding.generic : [];

/**
 * 缺少 classify 时的 no_key 统计：零请求、空来源表，区别于已请求但失败。
 * 每次调用返回独立对象。
 */
export function createNoKeyJevStats(): JevStats {
  return {
    n_requests: 0,
    input_tokens: 0,
    latency_ms_total: 0,
    status: 'no_key',
    per_source: [],
    n_http_attempts: 0,
    requests: [],
  };
}

/** 只在 `sources` 表里确有该 URL 且元数据是对象时返回它；避免读到原型链上的属性。 */
const metaOf = (
  data: BraveLlmContextResponse,
  url: string
): Record<string, unknown> | undefined => {
  const sources = data?.sources;
  if (!sources || typeof sources !== 'object' || !Object.hasOwn(sources, url)) return undefined;
  const meta = sources[url];
  return meta && typeof meta === 'object' && !Array.isArray(meta)
    ? (meta as Record<string, unknown>)
    : undefined;
};

/**
 * 按 Brave 原序建立来源和片段统计，初始均为保留；canonical_url 只作归并键。
 * 输出规模初始为 0，由管道结束时填入；jev 与兼容字段 shadow_diff 初始为 null。
 */
export function createFilterStats(
  mode: FilterMode,
  request: FilterStats['request'],
  data: BraveLlmContextResponse
): FilterStats {
  const items = genericItems(data);

  let braveSnippets = 0;
  let braveChars = 0;
  // 原始规模与输出规模共用 estimateTokens，先累加全部片段再向上取整。
  let braveTokenSum = 0;

  const sources: SourceStats[] = items.map((item, index) => {
    const url = typeof item?.url === 'string' ? item.url : '';
    const title = typeof item?.title === 'string' ? item.title : '';
    const texts = Array.isArray(item?.snippets) ? item.snippets : [];
    const meta = metaOf(data, url);
    const hostname = typeof meta?.hostname === 'string' ? meta.hostname : undefined;

    const snippets = texts.map((text, snippetIndex) => {
      // 长度判定统一用 String.length（UTF-16 码元），与后续预算估算同一尺度
      const chars = typeof text === 'string' ? text.length : 0;
      braveSnippets += 1;
      braveChars += chars;
      braveTokenSum += typeof text === 'string' ? estimateTokens(text) : 0;
      return { index: snippetIndex, kept: true, chars };
    });

    return {
      index,
      url,
      title,
      canonical_url: canonicalizeUrl(url),
      ...(hostname !== undefined ? { hostname } : {}),
      verdict: 'keep' as const,
      snippets,
    };
  });

  return {
    mode,
    request: { ...request },
    brave: {
      n_sources: items.length,
      n_snippets: braveSnippets,
      chars: braveChars,
      est_tokens: Math.ceil(braveTokenSum),
    },
    // novelty 另行新建：浅拷贝载体不共享 zeroLocal 的空数组引用（工厂每次调用
    // 新建对象的不变量；applyNovelty 的明细写回是替换式，双保险）
    local: { ...zeroLocal, novelty: [] },
    sources,
    jev: null,
    output: { n_sources: 0, n_snippets: 0, chars: 0, est_tokens: 0 },
    shadow_diff: null,
  };
}
