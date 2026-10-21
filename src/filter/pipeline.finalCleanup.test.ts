/** 最终清理集成：完整性门槛、幸存代表、统计和样本必须共用同一工作表。 */
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { parseFilterConfigObject } from './config.js';
import { filterLlmContext } from './pipeline.js';
import { createSampleWriter, type SampleRecord } from './sample.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BraveLlmContextResponse, ClassifyDeps, JevAnswer, JevQuestion } from './types.js';

const phrase =
  'The released compiler provides a stable programmatic interface starting with version 7.1.';
const makeData = (...snippets: string[][]): BraveLlmContextResponse => ({
  grounding: {
    generic: snippets.map((texts, i) => ({
      url: `https://example.test/${i}`,
      title: 'Example',
      snippets: texts,
    })),
  },
  sources: Object.fromEntries(
    snippets.map((_, i) => [`https://example.test/${i}`, { title: 'Example' }])
  ),
});
const request = { params: { query: 'compiler' }, intent: 'Find the stable compiler interface.' };
const config = parseFilterConfigObject({ mode: 'test' });
const keepAnswers = (questions: Record<string, JevQuestion>): Record<string, JevAnswer> =>
  Object.fromEntries(
    Object.entries(questions)
      .reverse()
      .map(([key, question]) => [
        key,
        question.type === 'noul'
          ? { kind: 'noul', probability: 0 }
          : {
              kind: 'choice',
              probabilities: Object.fromEntries(
                Object.keys(question.criteria).map((label) => [
                  label,
                  label === Object.keys(question.criteria).at(-1) ? 1 : 0,
                ])
              ),
            },
      ])
  );
const keepAll: ClassifyDeps['classify'] = async (req) => ({
  status: 'answered',
  model: config.jev.model,
  answers: keepAnswers(req.questions),
  input_tokens: 1,
  dispatch: req,
});

it('test/on 同链，末端删空来源、元数据、统计与样本实发映射一致', async () => {
  const data = makeData(
    [''],
    [phrase, phrase, phrase + ' More details.'],
    ['# Example\n**Key takeaways**']
  );
  const before = structuredClone(data);
  for (const mode of ['test', 'on'] as const) {
    const r = await filterLlmContext(data, request, { ...config, mode }, { classify: keepAll });
    assert.deepEqual(
      r.result.grounding.generic.map((s) => s.snippets),
      [[phrase + ' More details.']]
    );
    assert.deepEqual(Object.keys(r.result.sources), ['https://example.test/1']);
    assert.equal(r.stats.local.dup_removed, 2);
    assert.equal(r.stats.local.snippets_prefiltered, 2);
    assert.equal(r.stats.local.empty_dropped, 2);
    assert.equal(r.stats.output.n_sources, 1);
    assert.equal(r.stats.output.n_snippets, 1);
    assert.match(
      r.stats.output.status_line!,
      /dropped 2 of 3 sources: 2 empty; 2 snippets removed/
    );
    assert.deepEqual(r.jev_requests[0].source_ids, ['s1', 's2']);
    assert.deepEqual(Object.keys(r.jev_requests[0].state!.sources), ['s1', 's2']);
    assert.ok(
      r.jev_requests[0].questions!.s1__group0.instructions.includes('sources.s1.snippets[0]')
    );
    let sample: SampleRecord | undefined;
    const writer = createSampleWriter(
      { ...config, logDir: tmpdir() },
      {
        writeFile: (_path, body) => {
          sample = JSON.parse(body);
        },
        rename: () => {},
      }
    );
    assert.equal(
      writer.save({
        path: {
          absolute: join(tmpdir(), 'jev-final-cleanup-test.json'),
          relative: 'jev-final-cleanup-test.json',
          capturedAt: new Date(),
        },
        filterParams: request.params,
        requestId: 'final-cleanup',
        originalParams: request.params,
        braveParams: request.params,
        intent: request.intent,
        preFilter: data,
        payload: r.result,
        statusLine: r.stats.output.status_line!,
        stats: r.stats,
        jevDispatch: r.jev_dispatch,
        jevRequests: r.jev_requests,
      }).status,
      'saved'
    );
    assert.equal(sample!.format_version, 9);
    assert.deepEqual(JSON.parse(sample!.jev!.requests[0].state!), r.jev_requests[0].state);
    assert.ok(
      sample!
        .jev!.sent.filter((s) => s.src !== 's0')
        .every((s) => s.snippets.every((sn) => sn.in_state && sn.valid))
    );
    assert.deepEqual(sample!.outcome!.sources[1].snippets[0].final_cleanup, {
      rule: 'same_source_exact_coverage',
      snippet: '0',
      covered_by: '2',
    });
    assert.equal(sample!.jev!.sent.find((s) => s.src === 's1')!.snippets[0].reason, 'dup');
    assert.equal(sample!.outcome!.sources[2].snippets[0].reason, 'boilerplate');
  }
  assert.deepEqual(data, before);
});

it('Jev 删除的覆盖者不能用于去重，其余原文与输出顺序保持', async () => {
  const data = makeData([phrase, 'Independent useful detail.', phrase + ' More details.']);
  const r = await filterLlmContext(data, request, config, {
    classify: async (req) => {
      const answers = keepAnswers(req.questions);
      const q = req.questions.s0__group0;
      assert.equal(q.type, 'choice');
      answers.s0__group0 = {
        kind: 'choice',
        probabilities: Object.fromEntries(
          Object.keys(q.criteria).map((label) => [label, label === 'AB' ? 1 : 0])
        ),
      };
      return {
        status: 'answered',
        model: config.jev.model,
        answers,
        input_tokens: 0,
        dispatch: req,
      };
    },
  });
  assert.deepEqual(
    r.result.grounding.generic[0].snippets,
    data.grounding.generic[0].snippets.slice(0, 2)
  );
  assert.equal(r.stats.local.dup_removed, 0);
});

it('off、无分类器、失败、熔断以及页面或任意组合题缺答均不扩大本地删除', async () => {
  const data = makeData([phrase, phrase, 'Detail.', '# Example\nKey takeaways']);
  const runs: Array<{ mode?: 'off'; classify?: ClassifyDeps['classify'] }> = [
    { mode: 'off', classify: keepAll },
    {},
    { classify: async (req) => ({ status: 'failed', kind: 'network', dispatch: req }) },
    { classify: async () => ({ status: 'failed', kind: 'breaker_open', http_attempts: 0 }) },
    {
      classify: async () => {
        throw new Error('disconnect');
      },
    },
    ...['s0__filler', 's0__group0', 's0__group3'].map((key) => ({
      classify: (async (req) => {
        const answers = keepAnswers(req.questions);
        delete answers[key];
        return {
          status: 'answered',
          model: config.jev.model,
          answers,
          input_tokens: 0,
          dispatch: req,
        };
      }) as ClassifyDeps['classify'],
    })),
  ];
  for (const run of runs) {
    const r = await filterLlmContext(
      data,
      request,
      { ...config, mode: run.mode ?? 'test' },
      { classify: run.classify }
    );
    assert.deepEqual(r.result.grounding.generic, data.grounding.generic);
    assert.equal(r.stats.local.dup_removed, 0);
    assert.ok(r.stats.sources[0].snippets.every((sn) => sn.final_cleanup === undefined));
  }
});

it('完整有效来源独立清理，缺答邻源及相同 URL 的独立来源保守处理', async () => {
  const data = makeData([phrase, phrase], [phrase, phrase], [phrase]);
  data.grounding.generic[2].url = data.grounding.generic[0].url;
  const r = await filterLlmContext(data, request, config, {
    classify: async (req) => {
      const answers = keepAnswers(req.questions);
      delete answers.s1__group0;
      return {
        status: 'answered',
        model: config.jev.model,
        answers,
        input_tokens: 0,
        dispatch: req,
      };
    },
  });
  assert.deepEqual(
    r.result.grounding.generic.map((s) => s.snippets.length),
    [1, 2, 1]
  );
  assert.equal(r.stats.local.dup_removed, 1);
});
