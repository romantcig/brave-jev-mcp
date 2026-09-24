/**
 * 管道步 2：URL 规范化与同页来源归并。
 *
 * 规范 URL **只当合并键**：输出的 `generic[].url` 与 `sources` 键永远是 Brave 原串，
 * 模型引用的链接不被改写。规范化只做笔记列出的几类：小写 host、去 `www.` / `amp.`
 * 前缀、`http`→`https`（键里不带 scheme）、去 fragment、去尾斜杠、去 AMP 标记、
 * 去跟踪参数、其余查询参数按键排序；path 大小写、`index.html`、内容参数一律不动。
 *
 * 依据：notes/local-rules-design.md §2、01-RESEARCH.md「规则 2（步 2）」。
 */

import type { SourceDropReason } from './types.js';

/** 跟踪参数前缀；键小写后比对。可增补，出处 notes/local-rules-design.md §2。 */
export const TRACKING_PARAM_PREFIXES: readonly string[] = ['utm_'];

/** 跟踪参数；键一律小写存放。可增补，出处同上。 */
export const TRACKING_PARAMS: ReadonlySet<string> = new Set([
  'fbclid',
  'gclid',
  'dclid',
  'msclkid',
  'yclid',
  'twclid',
  'igshid',
  'mc_cid',
  'mc_eid',
  '_ga',
  '_gl',
  'ref',
  'ref_src',
  'source',
  'si',
]);

/** AMP 参数；键一律小写存放。`amp` 取任何值（含无值）都算，`outputType` 看取值。可增补。 */
export const AMP_PARAMS: ReadonlySet<string> = new Set(['amp', 'outputtype']);

/** `outputType` 表示 AMP 版的取值；值小写后比对。 */
export const AMP_OUTPUT_TYPE_VALUES: ReadonlySet<string> = new Set(['amp']);

/** 只有 http(s) 才有可比的"同一页"；其余 scheme 与解析失败的串不参与归并。 */
const WEB_PROTOCOLS: ReadonlySet<string> = new Set(['http:', 'https:']);

/**
 * @returns 键小写后命中跟踪参数表或 `utm_` 前缀时为真
 * @example isTrackingParam('UTM_Source') === true
 * @example isTrackingParam('id') === false
 */
export function isTrackingParam(key: string): boolean {
  const lower = key.toLowerCase();
  return (
    TRACKING_PARAMS.has(lower) || TRACKING_PARAM_PREFIXES.some((prefix) => lower.startsWith(prefix))
  );
}

/**
 * @returns `amp` 取任何值都为真；`outputType` 只在值小写等于 `amp` 时为真
 * @example isAmpParam('amp', '') === true
 * @example isAmpParam('outputType', 'print') === false
 */
export function isAmpParam(key: string, value: string): boolean {
  const lower = key.toLowerCase();
  if (!AMP_PARAMS.has(lower)) return false;
  return lower === 'amp' || AMP_OUTPUT_TYPE_VALUES.has(value.toLowerCase());
}

/** 查询串的键值只为比对而解码；解码失败就用原文比对。 */
const decodeComponent = (text: string): string => {
  try {
    return decodeURIComponent(text.replace(/\+/g, ' '));
  } catch {
    return text;
  }
};

/**
 * 滤掉跟踪与 AMP 参数，其余按键排序（同键保持原相对顺序）。
 * 输出用每一对的原文，不重新编码——`q=a%20b` 不会变成 `q=a+b`。
 */
const canonicalQuery = (search: string): string =>
  search
    .slice(1)
    .split('&')
    .filter((pair) => pair !== '')
    .map((pair) => {
      const eq = pair.indexOf('=');
      return {
        pair,
        key: decodeComponent(eq === -1 ? pair : pair.slice(0, eq)),
        value: eq === -1 ? '' : decodeComponent(pair.slice(eq + 1)),
      };
    })
    .filter(({ key, value }) => !isTrackingParam(key) && !isAmpParam(key, value))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map(({ pair }) => pair)
    .join('&');

/** 去 AMP 路径段（`/amp/…`、`…/amp`）、尾斜杠与 `.amp` 后缀；裸路径保持 `/`。 */
const canonicalPath = (pathname: string): string => {
  const path = pathname
    .replace(/\/amp(?=\/|$)/g, '')
    .replace(/\/+$/, '')
    .replace(/\.amp$/, '');
  return path === '' ? '/' : path;
};

/** 去一个前导标签，但剩下的部分至少还要带一个点——`amp.dev` 不会被削成 `dev`。 */
const stripLeadingLabel = (host: string, label: string): string => {
  const prefix = `${label}.`;
  if (!host.startsWith(prefix)) return host;
  const rest = host.slice(prefix.length);
  return rest.includes('.') ? rest : host;
};

/** 归并用的键；解析失败或非 http(s) 时为 `null`，这类来源永不与别人合并。 */
const mergeKey = (raw: string): string | null => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (!WEB_PROTOCOLS.has(url.protocol)) return null;

  // http→https：`:443` 随之成为默认端口而消失，非默认端口保留
  url.protocol = 'https:';
  const host = stripLeadingLabel(stripLeadingLabel(url.hostname.toLowerCase(), 'www'), 'amp');
  const port = url.port === '' ? '' : `:${url.port}`;
  const query = canonicalQuery(url.search);

  return `${host}${port}${canonicalPath(url.pathname)}${query === '' ? '' : `?${query}`}`;
};

/**
 * 规范化 URL，只作合并键与统计表的 `canonical_url`，不写回输出。
 * @returns 不带 scheme 的 `host[:port]path[?query]`；解析失败或非 http(s) 时返回原串
 * @example canonicalizeUrl('HTTPS://WWW.Example.com:443/a/b/?utm_source=t&id=5#x') === 'example.com/a/b?id=5'
 * @example canonicalizeUrl('https://amp.x.com/amp/post.amp?amp=1') === 'x.com/post'
 * @example canonicalizeUrl('https://example.com/a/') === 'example.com/a'
 * @example canonicalizeUrl('https://example.com:8080/a') === 'example.com:8080/a'
 * @example canonicalizeUrl('not a url') === 'not a url'
 */
export function canonicalizeUrl(raw: string): string {
  return mergeKey(raw) ?? raw;
}

/** 步 2 需要的最小片段形状；`mergedFrom` 是并入片段原属来源的 Brave 索引。 */
export type MergeableSnippet = {
  text: string;
  kept: boolean;
  mergedFrom?: number;
};

/** 步 2 需要的最小来源形状；管道工作表的来源在结构上满足它。 */
export type MergeableSource<S extends MergeableSnippet> = {
  index: number;
  url: string;
  snippets: S[];
  verdict: 'keep' | 'drop';
  reason?: SourceDropReason;
};

/**
 * 按规范键归并同页来源，原地修改工作表，不重排。
 * - 按 Brave 序遍历在留来源；首见某键的来源持有它，后续同键来源的在留片段按序追加
 *   到首见来源末尾，并带上 `mergedFrom`
 * - 与首见来源在留片段 `trim` 后逐字相等的不追加，留在被并入来源名下随它丢弃
 *   （不算页内重复，不计 `dup_removed`）；已被前面步骤移除的片段同样留在原处
 * - 被并入的来源 `verdict: 'drop'`、`reason: 'merged'`，`url` 字段不动
 * @returns 被并入的来源条数，即本次的 `url_merged`
 */
export function mergeByCanonicalUrl<S extends MergeableSnippet>(
  table: MergeableSource<S>[]
): number {
  const owners = new Map<string, { source: MergeableSource<S>; texts: Set<string> }>();
  let merged = 0;

  for (const source of table) {
    if (source.verdict !== 'keep') continue;
    const key = mergeKey(source.url);
    if (key === null) continue;

    const owner = owners.get(key);
    if (owner === undefined) {
      const texts = source.snippets
        .filter((snippet) => snippet.kept)
        .map((snippet) => snippet.text.trim());
      owners.set(key, { source, texts: new Set(texts) });
      continue;
    }

    const leftovers: S[] = [];
    for (const snippet of source.snippets) {
      const text = snippet.text.trim();
      if (!snippet.kept || owner.texts.has(text)) {
        leftovers.push(snippet);
        continue;
      }
      owner.texts.add(text);
      owner.source.snippets.push({ ...snippet, mergedFrom: source.index });
    }

    source.snippets = leftovers;
    source.verdict = 'drop';
    source.reason = 'merged';
    merged += 1;
  }

  return merged;
}
