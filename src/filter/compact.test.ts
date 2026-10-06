import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { compactResponse } from './compact.js';
import type { FilteredResponse } from './types.js';

describe('工具返回元数据精简', () => {
  it('正文与顺序逐字保留，日期就近放置，重复来源表省略且输入不变', () => {
    const input: FilteredResponse = {
      grounding: {
        generic: [
          { url: 'https://a.example/post', title: '甲', snippets: ['事实一', '事实二'] },
          { url: 'https://b.example/', title: '乙', snippets: ['独立事实'] },
        ],
        map: [],
      },
      sources: {
        'https://a.example/post': { title: '甲', hostname: 'a.example', age: ['2026-10-02'] },
        'https://b.example/': { title: '乙', hostname: 'b.example' },
      },
    };
    const before = structuredClone(input);
    const output = compactResponse(input);
    assert.deepEqual(output, {
      grounding: {
        generic: [
          { ...input.grounding.generic[0], age: ['2026-10-02'] },
          input.grounding.generic[1],
        ],
        map: [],
      },
    });
    assert.deepEqual(input, before);
  });

  it('不同标题、非标准域名、未知字段及未匹配元数据仍可读，地图和参数调整透传', () => {
    const input = {
      grounding: {
        generic: [{ url: 'https://a.example/', title: '正文标题', snippets: ['正文'] }],
        map: [{ url: 'https://map.example/', title: '地图', snippets: ['地址'] }],
        poi: { url: 'https://poi.example/', title: '地点', snippets: ['营业时间'] },
      },
      sources: {
        'https://a.example/': {
          title: '另一标题',
          hostname: '显示站点名',
          age: ['2026-10-02'],
          language: 'zh',
        },
        'https://map.example/': { title: '地图', hostname: 'map.example', age: ['2026-10-01'] },
      },
      parameter_adjustments: { maximum_number_of_tokens: { requested: 500, applied: 1024 } },
    };
    const output = compactResponse(input);
    assert.deepEqual(output.sources, {
      'https://a.example/': { title: '另一标题', hostname: '显示站点名', language: 'zh' },
      'https://map.example/': input.sources['https://map.example/'],
    });
    assert.deepEqual(output.grounding.generic[0].age, ['2026-10-02']);
    assert.deepEqual(output.grounding.map, input.grounding.map);
    assert.deepEqual(output.grounding.poi, input.grounding.poi);
    assert.deepEqual(output.parameter_adjustments, input.parameter_adjustments);
  });

  it('元数据缺失时保留来源，空结果不伪造来源或日期', () => {
    const item = { url: 'https://a.example/', title: '甲', snippets: ['正文'] };
    assert.deepEqual(compactResponse({ grounding: { generic: [item], map: [] }, sources: {} }), {
      grounding: { generic: [item], map: [] },
    });
    assert.deepEqual(
      compactResponse({ grounding: { generic: [], map: [], poi: null }, sources: {} }),
      { grounding: { generic: [], map: [], poi: null } }
    );
  });
});
