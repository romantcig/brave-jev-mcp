/** 少量真实日志回放：当前模型回答与关键事实核对，不展开逐字段快照。 */
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { parseFilterConfigObject } from './config.js';
import { collectJevCandidatesDetailed, filterLlmContext } from './pipeline.js';
import { buildContextRequest } from './jev/context.js';
import { buildRequest, createJevClassifier } from './jev/client.js';
import {
  assertFixtureOutput,
  assertRecording,
  fixtureNames,
  loadFixture,
  loadRecording,
} from '../../test-support/log-fixtures.mjs';

for (const name of fixtureNames()) {
  const fixture = loadFixture(name);
  it(`日志回放：${fixture.purpose}`, async (t) => {
    const config = parseFilterConfigObject({ ...fixture.config, mode: 'on' });
    const candidates = collectJevCandidatesDetailed(fixture.data, fixture.request, config);
    const { state, questions } = buildContextRequest(
      candidates,
      fixture.request.params.query,
      fixture.request.intent,
      fixture.request.retrievalTime
    );
    const request = buildRequest(state, questions, config.jev.model);
    const recording = candidates.length ? loadRecording(name) : undefined;
    if (recording) assertRecording(recording, request);
    let calls = 0;
    t.mock.method(
      globalThis,
      'fetch',
      async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
        calls += 1;
        assert.ok(recording, '空结果不得请求模型');
        assertRecording(recording, JSON.parse(String(init?.body)));
        return Response.json(recording.body, { status: recording.status });
      }
    );
    const { result, stats } = await filterLlmContext(
      fixture.data,
      fixture.request,
      config,
      createJevClassifier(config.jev, { TYPESAFE_API_KEY: 'fixture-replay' })
    );
    assert.equal(calls, recording ? 1 : 0);
    assert.equal(stats.jev?.status, 'ok');
    assertFixtureOutput(fixture, result);
  });
}

it('正文变化时在进入管道前拒绝旧回答', () => {
  const recording = loadRecording('jev-questions');
  const changed = structuredClone(recording.request);
  changed.state.sources[0].snippets[0] += ' changed';
  assert.throws(() => assertRecording(recording, changed), /重新录制/);
});
