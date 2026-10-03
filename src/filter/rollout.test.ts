/** 日常规则上线回归：栏目屏蔽在 Jev 之前生效，其他路径与模式一致性不受影响。 */
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { filterLlmContext } from './pipeline.js';
import { parseFilterConfigObject } from './config.js';
import { parseBlocklist } from './blocklist.js';
import { DEFAULT_JEV_MODEL } from './jev/questions.js';
import type { ClassifyDeps, JevAnswer } from './types.js';

it('栏目规则只删除指定路径，跳过其 Jev 请求，保留同站文档且 test/on 一致', async () => {
  const flash = 'https://farm.example/news/flash/hyperion';
  const docs = 'https://farm.example/docs/hyperion';
  const data = {
    grounding: {
      generic: [
        {
          url: flash,
          title: 'Hyperion API news',
          snippets: [
            'Hyperion API launched a typed routing endpoint for application developers using cloud tools.',
          ],
        },
        {
          url: docs,
          title: 'Hyperion API documentation',
          snippets: [
            'Hyperion API requires a request identifier for every write operation and retains each identifier for 24 hours.',
          ],
        },
      ],
      map: [],
    },
    sources: {
      [flash]: { title: 'Hyperion API news' },
      [docs]: { title: 'Hyperion API documentation' },
    },
  };
  const config = {
    ...parseFilterConfigObject({ mode: 'test' }),
    blocklist: parseBlocklist('https://farm.example/news/flash/'),
  };
  const called: string[] = [];
  const classify: ClassifyDeps['classify'] = async ({ state, questions }) => {
    // 全量共享请求：进入 Jev 的来源 URL 全部记录——栏目来源被本地规则删掉就
    // 不该出现在这里（先于 Jev 生效的证明）
    for (const source of state.sources) called.push(source.url);
    const answers: Record<string, JevAnswer> = {};
    for (const [key, q] of Object.entries(questions))
      answers[key] =
        q.type === 'score' ? { kind: 'score', score: 2 } : { kind: 'noul', probability: 0 };
    return { status: 'answered', answers, model: DEFAULT_JEV_MODEL, input_tokens: 100 };
  };
  const request = {
    params: { query: 'Hyperion API' },
    intent: 'Find Hyperion API request requirements.',
  };
  const a = await filterLlmContext(data, request, config, { classify });
  const b = await filterLlmContext(data, request, { ...config, mode: 'on' }, { classify });
  // 两次运行各一次共享请求，且只有同站文档进入 Jev（栏目来源未进入）
  assert.deepEqual(called, [docs, docs]);
  assert.deepEqual(a.result, b.result);
  assert.deepEqual(a.stats.sources, b.stats.sources);
  assert.deepEqual(
    a.result.grounding.generic.map((s) => s.url),
    [docs]
  );
  assert.equal(a.stats.local.blocklist_hits, 1);
  assert.equal(a.stats.sources.find((s) => s.url === flash)?.reason, 'blocklist');
});
