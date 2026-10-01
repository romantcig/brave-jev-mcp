import type { BraveLlmContextGenericItem, FilteredResponse } from './types.js';

/** 展示层只去结构重复；日期沿用 Brave 的 age 语义，不改称发布日期。 */
type CompactResponse<T extends FilteredResponse> = Omit<T, 'grounding' | 'sources'> & {
  grounding: Omit<FilteredResponse['grounding'], 'generic'> & {
    generic: Array<BraveLlmContextGenericItem & { age?: unknown }>;
  };
  /** 仅存无法从正文条目恢复的元数据；通常省略整个来源表。 */
  sources?: FilteredResponse['sources'];
};

/**
 * 在过滤完成后精简工具载荷：把 age 移到对应正文旁，去掉重复标题及 URL 可推导的
 * hostname。不同标题、非标准 hostname、未知元数据与未匹配来源保留在稀疏来源表。
 * 不修改输入、正文、顺序或 map/poi；额外根字段（如参数调整）原样保留。
 */
export function compactResponse<T extends FilteredResponse>(result: T): CompactResponse<T> {
  const { grounding, sources, ...rest } = result;
  const generic = grounding.generic.map((item) => {
    const meta = Object.hasOwn(sources, item.url) ? sources[item.url] : undefined;
    return meta && Object.hasOwn(meta, 'age') ? { ...item, age: meta.age } : item;
  });

  const remaining = Object.entries(sources).flatMap(([url, meta]) => {
    const items = grounding.generic.filter((item) => item.url === url);
    if (items.length === 0) return [[url, meta] as const];

    const extra = { ...meta };
    delete extra.age;
    if (items.every((item) => item.title === extra.title)) delete extra.title;
    try {
      if (extra.hostname === new URL(url).hostname) delete extra.hostname;
    } catch {
      // 异常 URL 不推导域名；保留元数据，避免展示精简影响搜索返回。
    }
    return Object.keys(extra).length > 0 ? [[url, extra] as const] : [];
  });

  return {
    ...rest,
    grounding: { ...grounding, generic },
    ...(remaining.length > 0 ? { sources: Object.fromEntries(remaining) } : {}),
  };
}
