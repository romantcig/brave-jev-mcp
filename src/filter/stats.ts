/**
 * 统计对象的构造。
 *
 * `createFilterStats` 是工厂：每次调用新建对象，库不持有任何模块级可变状态，
 * 同一进程里交替使用不同配置的调用互不污染（EMBED-01/concurrency）。
 * 统计表只存索引、标记与字符数，绝不放片段正文（LOG-03）。
 *
 * 依据：01-RESEARCH.md「统计对象」一节。
 */

import { canonicalizeUrl } from './url.js';
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
 * 库内部只做浅拷贝后再递增，不会改到这份常量。
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
});

/** 防御性读取 `grounding.generic`：上游已过 zod，但库对畸形输入也不抛。 */
const genericItems = (
  data: BraveLlmContextResponse
): BraveLlmContextResponse['grounding']['generic'] =>
  Array.isArray(data?.grounding?.generic) ? data.grounding.generic : [];

/**
 * on/shadow 模式未注入 classify 时的 Jev 统计零值（no_key）：零请求、零记账、
 * per_source 空表——SAFE-01 语义前置（"未判定"与"判了但失败"从一开始就分开记）。
 * 每次调用新建对象，库不持模块级可变状态。
 */
export function createNoKeyJevStats(): JevStats {
  return {
    n_requests: 0,
    input_tokens: 0,
    latency_ms_total: 0,
    status: 'no_key',
    per_source: [],
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
 * 新建一份统计对象：记录 Brave 原始规模，并按 Brave 序为每个来源与片段建一行
 * （全部先标为保留，管道各步再翻标记）。`canonical_url` 是步 2 的归并键，只进统计，
 * 输出永远用原始 URL。
 * @param mode 本次调用的模式
 * @param request 已归一化的请求摘要（上限缺省已填 Brave 默认值）
 * @param data Brave 原始响应
 * @returns 新对象；`jev` 与 `shadow_diff` 为 null，`output` 全 0，由管道末尾填实
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
      canonical_url: canonicalizeUrl(url),
      ...(hostname !== undefined ? { hostname } : {}),
      verdict: 'keep' as const,
      snippets,
    };
  });

  return {
    mode,
    request: { ...request },
    brave: { n_sources: items.length, n_snippets: braveSnippets, chars: braveChars },
    local: { ...zeroLocal },
    sources,
    jev: null,
    output: { n_sources: 0, n_snippets: 0, chars: 0, est_tokens: 0 },
    shadow_diff: null,
  };
}
