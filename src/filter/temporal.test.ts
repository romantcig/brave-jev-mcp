/** 时间题回归：预筛后身份对齐、只删目标片段、异常与缺答保留。正文为合成数据。 */
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { filterLlmContext } from './pipeline.js';
import { parseFilterConfigObject } from './config.js';
import type { ClassifyDeps, JevAnswer } from './types.js';

const url = 'https://example.test/hyperion';
const dated = 'Hyperion benchmark measured in January 2024: response time was 80 milliseconds.';
const stable =
  'Hyperion publishes its active instance list as machine-readable JSON for automatic discovery.';
const data = {
  grounding: { generic: [{ url, title: 'Hyperion overview', snippets: ['Share', stable, dated] }] },
  sources: { [url]: { title: 'Hyperion overview' } },
};
const config = parseFilterConfigObject({ mode: 'test' });
const request = {
  params: { query: 'Hyperion' },
  intent: 'Understand Hyperion availability in 2026.',
};

function classifyWith(
  value: number | undefined,
  omitDispatchQuestion = false
): ClassifyDeps['classify'] {
  return async ({ state, questions }) => {
    assert.deepEqual(state.source.snippets, [stable, dated]);
    assert.deepEqual(
      Object.keys(questions).filter((key) => key.startsWith('time_')),
      ['time_snip1']
    );
    const answers: Record<string, JevAnswer> = Object.fromEntries(
      Object.entries(questions)
        .filter(([key]) => !key.startsWith('time_'))
        .map(([key, q]) => [
          key,
          q.type === 'score' ? { kind: 'score', score: 2 } : { kind: 'noul', probability: 0 },
        ])
    );
    // 未提问的额外回答不得影响不含年份的正文。
    answers.time_snip0 = { kind: 'noul', probability: 1 };
    if (value !== undefined) answers.time_snip1 = { kind: 'noul', probability: value };
    const sent = { ...questions };
    if (omitDispatchQuestion) delete sent.time_snip1;
    return {
      status: 'answered',
      model: 'jev-1.13.0',
      input_tokens: 20,
      answers,
      dispatch: { state, questions: sent },
    };
  };
}

it('预筛后时间回答按身份对齐，只删除旧测量片段，test/on 一致', async () => {
  const deps = { classify: classifyWith(0.9) };
  const a = await filterLlmContext(data, request, config, deps);
  const b = await filterLlmContext(data, request, { ...config, mode: 'on' }, deps);
  assert.deepEqual(a.result, b.result);
  assert.deepEqual(a.stats.sources, b.stats.sources);
  assert.deepEqual(a.result.grounding.generic[0].snippets, [stable]);
  assert.equal(a.stats.sources[0].snippets[2].reason, 'time_mismatch');
  assert.equal(a.stats.sources[0].verdict, 'keep');
  assert.equal(a.stats.jev?.per_source[0].answers?.time_snip1, 0.9);
  assert.equal(a.stats.jev?.per_source[0].answers?.time_snip0, undefined);
});

it('时间题缺答、非法、低于门槛或未实发时保留正文', async () => {
  for (const value of [undefined, NaN, Infinity, -1, 1.1, 0.84, 0.05]) {
    const a = await filterLlmContext(data, request, config, { classify: classifyWith(value) });
    assert.deepEqual(a.result.grounding.generic[0].snippets, [stable, dated]);
  }
  const a = await filterLlmContext(data, request, config, { classify: classifyWith(0.99, true) });
  assert.deepEqual(a.result.grounding.generic[0].snippets, [stable, dated]);
});

it('Jev 失败时不使用时间判定删除片段', async () => {
  const a = await filterLlmContext(data, request, config, {
    classify: async () => ({ status: 'failed', kind: 'network' }),
  });
  assert.deepEqual(a.result.grounding.generic[0].snippets, [stable, dated]);
});
