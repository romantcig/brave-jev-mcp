import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_JEV_MODEL, DEFAULT_THRESHOLDS } from './jev/questions.js';
import { filterLlmContext } from './pipeline.js';
import type { BraveLlmContextResponse, FilterConfig } from './types.js';
import {
  canonicalizeUrl,
  isAmpParam,
  isTrackingParam,
  mergeByCanonicalUrl,
  type MergeableSnippet,
  type MergeableSource,
} from './url.js';

describe('canonicalizeUrl', () => {
  it('canonicalizes the combined example from the plan', () => {
    assert.equal(
      canonicalizeUrl('HTTPS://WWW.Example.com:443/a/b/?utm_source=t&id=5#x'),
      'example.com/a/b?id=5'
    );
  });

  it('lowercases the host and strips a leading www.', () => {
    assert.equal(canonicalizeUrl('https://WWW.Example.COM/a'), 'example.com/a');
  });

  it('keeps path case, so /a/b and /A/B stay different pages', () => {
    assert.equal(canonicalizeUrl('https://example.com/A/B'), 'example.com/A/B');
    assert.notEqual(
      canonicalizeUrl('https://example.com/a/b'),
      canonicalizeUrl('https://example.com/A/B')
    );
  });

  it('treats http and https as the same page', () => {
    assert.equal(canonicalizeUrl('http://example.com/a'), canonicalizeUrl('https://example.com/a'));
  });

  it('drops default ports and keeps non-default ones', () => {
    assert.equal(canonicalizeUrl('https://example.com:443/a'), 'example.com/a');
    assert.equal(canonicalizeUrl('http://example.com:80/a'), 'example.com/a');
    assert.equal(canonicalizeUrl('https://example.com:8080/a'), 'example.com:8080/a');
  });

  it('converts IDN hosts to punycode', () => {
    assert.equal(canonicalizeUrl('https://例子.测试/a'), 'xn--fsqu00a.xn--0zwm56d/a');
  });

  it('keeps the bare root path, equal with or without the slash', () => {
    assert.equal(canonicalizeUrl('https://example.com'), 'example.com/');
    assert.equal(canonicalizeUrl('https://example.com/'), 'example.com/');
  });

  it('strips trailing slashes from non-root paths', () => {
    assert.equal(canonicalizeUrl('https://example.com/a/'), 'example.com/a');
    assert.equal(canonicalizeUrl('https://example.com/a//'), 'example.com/a');
  });

  it('drops the fragment', () => {
    assert.equal(canonicalizeUrl('https://example.com/a#section-2'), 'example.com/a');
  });

  it('strips /amp path segments', () => {
    assert.equal(canonicalizeUrl('https://example.com/amp/post'), 'example.com/post');
    assert.equal(canonicalizeUrl('https://example.com/post/amp'), 'example.com/post');
    assert.equal(canonicalizeUrl('https://example.com/post/amp/'), 'example.com/post');
    assert.equal(canonicalizeUrl('https://example.com/amp'), 'example.com/');
  });

  it('strips a leading amp. host label', () => {
    assert.equal(canonicalizeUrl('https://amp.example.com/post'), 'example.com/post');
    assert.equal(canonicalizeUrl('https://www.amp.example.com/post'), 'example.com/post');
  });

  it('never strips a host down to a bare TLD', () => {
    // amp.dev 本身就是站点，去掉 `amp.` 只剩 `dev` 不是页面
    assert.equal(canonicalizeUrl('https://amp.dev/documentation'), 'amp.dev/documentation');
  });

  it('strips a trailing .amp suffix', () => {
    assert.equal(canonicalizeUrl('https://example.com/post.amp'), 'example.com/post');
    assert.equal(canonicalizeUrl('https://example.com/post.amp/'), 'example.com/post');
  });

  it('drops amp query parameters with or without a value, and outputType=amp', () => {
    assert.equal(canonicalizeUrl('https://example.com/post?amp=1'), 'example.com/post');
    assert.equal(canonicalizeUrl('https://example.com/post?amp'), 'example.com/post');
    assert.equal(canonicalizeUrl('https://example.com/post?outputType=amp'), 'example.com/post');
    // outputType 取别的值时是内容参数
    assert.equal(
      canonicalizeUrl('https://example.com/post?outputType=print'),
      'example.com/post?outputType=print'
    );
  });

  it('treats every AMP form as the same page', () => {
    const plain = canonicalizeUrl('https://x.com/post');
    for (const amp of [
      'https://x.com/amp/post',
      'https://amp.x.com/post',
      'https://x.com/post.amp',
      'https://x.com/post?amp=1',
      'https://x.com/post?amp',
    ]) {
      assert.equal(canonicalizeUrl(amp), plain, amp);
    }
  });

  it('drops tracking parameters case-insensitively', () => {
    assert.equal(
      canonicalizeUrl(
        'https://example.com/a?utm_source=x&UTM_Medium=y&fbclid=1&gclid=2&ref=hn&source=rss&si=abc&_ga=3'
      ),
      'example.com/a'
    );
  });

  it('keeps content parameters sorted by key without re-encoding them', () => {
    assert.equal(canonicalizeUrl('https://example.com/s?page=2&id=5'), 'example.com/s?id=5&page=2');
    assert.equal(canonicalizeUrl('https://example.com/s?q=a%20b'), 'example.com/s?q=a%20b');
    // 同名参数保持原相对顺序（排序稳定）
    assert.equal(
      canonicalizeUrl('https://example.com/s?tag=b&id=1&tag=a'),
      'example.com/s?id=1&tag=b&tag=a'
    );
  });

  it('leaves lookalike paths untouched', () => {
    assert.equal(canonicalizeUrl('https://example.com/feedback'), 'example.com/feedback');
    assert.equal(canonicalizeUrl('https://example.com/ampersand'), 'example.com/ampersand');
    assert.equal(
      canonicalizeUrl('https://example.com/champ/amp-guide'),
      'example.com/champ/amp-guide'
    );
  });

  it('returns the input unchanged when it cannot be parsed, without throwing', () => {
    assert.equal(canonicalizeUrl(''), '');
    assert.equal(canonicalizeUrl('not a url'), 'not a url');
    assert.equal(canonicalizeUrl('://x'), '://x');
  });

  it('returns non-http(s) URLs unchanged', () => {
    assert.equal(canonicalizeUrl('mailto:someone@example.com'), 'mailto:someone@example.com');
    assert.equal(canonicalizeUrl('ftp://example.com/a/'), 'ftp://example.com/a/');
  });
});

describe('isTrackingParam', () => {
  it('matches the utm_ prefix and the listed keys, case-insensitively', () => {
    for (const key of [
      'utm_source',
      'UTM_CAMPAIGN',
      'fbclid',
      'msclkid',
      'mc_eid',
      '_gl',
      'ref_src',
    ]) {
      assert.equal(isTrackingParam(key), true, key);
    }
  });

  it('does not match content parameters', () => {
    for (const key of ['id', 'page', 'q', 'utm', 'reference', 'sid']) {
      assert.equal(isTrackingParam(key), false, key);
    }
  });
});

describe('isAmpParam', () => {
  it('matches amp with any value and outputType only when its value is amp', () => {
    assert.equal(isAmpParam('amp', ''), true);
    assert.equal(isAmpParam('AMP', '1'), true);
    assert.equal(isAmpParam('outputType', 'AMP'), true);
    assert.equal(isAmpParam('outputType', 'print'), false);
    assert.equal(isAmpParam('ampere', '1'), false);
  });
});

type TestSnippet = MergeableSnippet & { index: number; reason?: string };

/** 合成工作表里的一个来源：片段按给定顺序、全部保留。 */
const source = (index: number, url: string, texts: string[]): MergeableSource<TestSnippet> => ({
  index,
  url,
  snippets: texts.map((text, snippetIndex) => ({ index: snippetIndex, text, kept: true })),
  verdict: 'keep',
});

describe('mergeByCanonicalUrl', () => {
  it('appends a later same-page source to the first one and marks it merged', () => {
    const table = [
      source(0, 'https://example.com/a', ['First.', 'Shared.']),
      source(1, 'http://www.example.com/a/?utm_source=t#x', ['  Shared.  ', 'Extra.']),
    ];

    assert.equal(mergeByCanonicalUrl(table), 1);

    assert.deepEqual(
      table[0].snippets.map((snippet) => [snippet.text, snippet.mergedFrom]),
      [
        ['First.', undefined],
        ['Shared.', undefined],
        ['Extra.', 1],
      ]
    );
    assert.equal(table[1].verdict, 'drop');
    assert.equal(table[1].reason, 'merged');
    // trim 后逐字相等的片段留在被并入来源名下，随它一起丢，不进首见来源
    assert.deepEqual(
      table[1].snippets.map((snippet) => snippet.text),
      ['  Shared.  ']
    );
  });

  it('keeps Brave URLs untouched and never reorders sources', () => {
    const urls = ['https://example.com/a', 'https://other.example/b', 'https://example.com/a/'];
    const table = urls.map((url, index) => source(index, url, [`Snippet ${index}.`]));

    mergeByCanonicalUrl(table);

    assert.deepEqual(
      table.map((entry) => [entry.index, entry.url, entry.verdict]),
      [
        [0, urls[0], 'keep'],
        [1, urls[1], 'keep'],
        [2, urls[2], 'drop'],
      ]
    );
  });

  it('merges every later duplicate into the first-seen source in Brave order', () => {
    const table = [
      source(0, 'https://example.com/a', ['A.']),
      source(1, 'https://amp.example.com/a', ['B.', 'A.']),
      source(2, 'https://example.com/amp/a', ['B.', 'C.']),
    ];

    assert.equal(mergeByCanonicalUrl(table), 2);
    assert.deepEqual(
      table[0].snippets.map((snippet) => snippet.text),
      ['A.', 'B.', 'C.']
    );
    assert.deepEqual(
      table.map((entry) => entry.verdict),
      ['keep', 'drop', 'drop']
    );
  });

  it('leaves already-removed snippets with the merged source', () => {
    const table = [
      source(0, 'https://example.com/a', ['A.']),
      source(1, 'https://example.com/a#top', ['{"author": "x"}', 'B.']),
    ];
    table[1].snippets[0] = { ...table[1].snippets[0], kept: false, reason: 'jsonld_meta' };

    mergeByCanonicalUrl(table);

    assert.deepEqual(
      table[0].snippets.map((snippet) => snippet.text),
      ['A.', 'B.']
    );
    assert.deepEqual(
      table[1].snippets.map((snippet) => snippet.reason),
      ['jsonld_meta']
    );
  });

  it('never merges URLs that fail to parse, even identical ones', () => {
    const table = [source(0, 'not a url', ['A.']), source(1, 'not a url', ['B.'])];

    assert.equal(mergeByCanonicalUrl(table), 0);
    assert.deepEqual(
      table.map((entry) => entry.verdict),
      ['keep', 'keep']
    );
  });

  it('skips sources that are already dropped', () => {
    const table = [
      source(0, 'https://example.com/a', ['A.']),
      source(1, 'https://example.com/a/', ['B.']),
    ];
    table[0].verdict = 'drop';

    assert.equal(mergeByCanonicalUrl(table), 0);
    assert.equal(table[1].verdict, 'keep');
  });

  it('does nothing for a single source or an empty table', () => {
    assert.equal(mergeByCanonicalUrl([source(0, 'https://example.com/a', ['A.'])]), 0);
    assert.equal(mergeByCanonicalUrl([]), 0);
  });
});

describe('filterLlmContext step 2', () => {
  const offConfig: FilterConfig = {
    mode: 'off',
    overfetchFactor: 1,
    blocklist: new Set(),
    thresholds: { ...DEFAULT_THRESHOLDS },
    jev: { model: DEFAULT_JEV_MODEL, backend: 'typesafe', timeoutMs: 15000, concurrency: 12 },
  };
  const request = { params: { query: 'jev release' }, intent: 'What TypeSafe released' };

  const FIRST = 'https://example.com/jev';
  const OTHER = 'https://other.example/jev';
  const SAME_PAGE = 'http://www.example.com/jev/?utm_source=feed#top';

  // 合成样本：入库夹具里没有同页来源（RESEARCH 已遍历确认），正例只能内联
  const payload = (): BraveLlmContextResponse => ({
    grounding: {
      generic: [
        { url: FIRST, title: 'Jev', snippets: ['Jev launched.', 'Same Jev paragraph.'] },
        { url: OTHER, title: 'Other', snippets: ['Other Jev page.'] },
        {
          url: SAME_PAGE,
          title: 'Jev (tracked)',
          snippets: ['Same Jev paragraph.', 'Extra Jev detail.'],
        },
      ],
      map: [],
    },
    sources: {
      [FIRST]: { title: 'Jev', hostname: 'example.com' },
      [OTHER]: { title: 'Other', hostname: 'other.example' },
      [SAME_PAGE]: { title: 'Jev (tracked)', hostname: 'www.example.com' },
    },
  });

  it('outputs the merged source under its original Brave URL', async () => {
    const { result } = await filterLlmContext(payload(), request, offConfig);

    assert.deepEqual(
      result.grounding.generic.map((item) => item.url),
      [FIRST, OTHER]
    );
    assert.deepEqual(result.grounding.generic[0].snippets, [
      'Jev launched.',
      'Same Jev paragraph.',
      'Extra Jev detail.',
    ]);
    assert.deepEqual(Object.keys(result.sources), [FIRST, OTHER]);
    assert.deepEqual(result.sources[FIRST], { title: 'Jev', hostname: 'example.com' });
  });

  it('records the merge in stats without counting it as a duplicate', async () => {
    const { stats } = await filterLlmContext(payload(), request, offConfig);

    assert.equal(stats.local.url_merged, 1);
    assert.equal(stats.local.dup_removed, 0);
    assert.deepEqual(
      stats.sources.map((entry) => [entry.verdict, entry.reason, entry.canonical_url]),
      [
        ['keep', undefined, 'example.com/jev'],
        ['keep', undefined, 'other.example/jev'],
        ['drop', 'merged', 'example.com/jev'],
      ]
    );
    // 并入的片段带 merged_from，(来源, 片段) 与 Brave 原文的对照不丢
    assert.deepEqual(
      stats.sources[0].snippets.map((snippet) => [snippet.index, snippet.merged_from]),
      [
        [0, undefined],
        [1, undefined],
        [1, 2],
      ]
    );
    assert.deepEqual(
      stats.sources[2].snippets.map((snippet) => snippet.index),
      [0]
    );
  });
});
