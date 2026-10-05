/** 每次调用新建统计对象，隔离请求间状态；统计不存片段正文。 */

import type {
  BraveLlmContextResponse,
  FilterMode,
  FilterStats,
  JevStats,
  LocalStats,
  SourceStats,
} from './types.js';

/**
 * Brave 文档给的缺省上限：模型未传 `maximum_number_of_*` 时按它们理解预算。
 * 统计表的 request 摘要使用这一份。
 */
export const BRAVE_DEFAULT_MAX_URLS = 20;
export const BRAVE_DEFAULT_MAX_TOKENS = 8192;

/**
 * 本地计数器的零值。冻结成常量，供夹具测试用 `{ ...zeroLocal, ...expected }` 合并；
 * 库内部只做浅拷贝后再递增，不会改到这份常量。
 */
export const zeroLocal: Readonly<LocalStats> = Object.freeze({
  jsonld_converted: 0,
  jsonld_dropped: 0,
  jsonld_kept_raw: 0,
  snippets_prefiltered: 0,
  dup_removed: 0,
  empty_dropped: 0,
  github_cleanup_actions: 0,
  x_cleanup_actions: 0,
  devto_cleanup_actions: 0,
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
 * 按 Brave 原序建立来源和片段统计，初始均为保留。
 * 输出规模初始为 0，由管道结束时填入；jev 初始为 null。
 */
export function createFilterStats(
  mode: FilterMode,
  request: FilterStats['request'],
  data: BraveLlmContextResponse
): FilterStats {
  const items = genericItems(data);

  let braveSnippets = 0;
  let braveChars = 0;

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
      return { index: snippetIndex, kept: true, chars };
    });

    return {
      index,
      url,
      title,
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
    },
    local: { ...zeroLocal },
    sources,
    jev: null,
    output: { n_sources: 0, n_snippets: 0, chars: 0 },
  };
}

export type SummarizeSnippetRow = {
  text: string;
  kept: boolean;
};

export type SummarizeSourceRow = {
  snippets: SummarizeSnippetRow[];
  verdict: 'keep' | 'drop';
};

/**
 * 输出规模只统计幸存内容；chars 使用 String.length。
 */
export function summarizeOutput(table: SummarizeSourceRow[]): {
  n_sources: number;
  n_snippets: number;
  chars: number;
} {
  let nSources = 0;
  let nSnippets = 0;
  let chars = 0;

  for (const source of table) {
    if (source.verdict !== 'keep') continue;
    nSources += 1;
    for (const snippet of source.snippets) {
      if (!snippet.kept) continue;
      nSnippets += 1;
      chars += snippet.text.length;
    }
  }

  return { n_sources: nSources, n_snippets: nSnippets, chars };
}
