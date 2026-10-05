/** 真实日志完整回放：严格核对新题目请求、事实保留、噪声删除及候选身份。 */
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
    if (recording) {
      // 严格检查请求与录制契约，任何模型、题干、来源错位均直接抛错使测试失败，无 catch-and-skip
      assertRecording(recording, request);
    }
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

it('完整 MiniMax 上下文：三个不同发布片段保持正文、原始身份与组合映射', () => {
  const fixture = loadFixture('minimax-time');
  const config = parseFilterConfigObject({ ...fixture.config, mode: 'on' });
  const candidates = collectJevCandidatesDetailed(fixture.data, fixture.request, config);

  assert.equal(candidates.length, 10);
  assert.equal(candidates[0].url, 'https://www.aibase.com/news/31365');
  assert.equal(candidates[0].snippets.length, 9);
  assert.equal(
    candidates[1].url,
    'https://www.reddit.com/r/MiniMax_AI/comments/1v73a0r/m31_has_strong_potential_to_be_the_most/'
  );
  assert.equal(candidates[1].snippets.length, 5);

  // 推特来源的三个不同片段均进入候选，保持原始身份与顺序。
  const source = candidates[3];
  assert.equal(source.url, 'https://x.com/MiniMaxAgent/status/2104079819881517400');
  assert.equal(source.snippets.length, 3);

  // 校验片段身份、完整正文及发布事实，防止只保留账号前缀。
  const announcementSnippet = source.snippets[1];
  assert.equal(announcementSnippet.key, '1');
  assert.deepEqual(
    source.snippets.map((snip) => snip.key),
    ['0', '1', '2'],
    '三个不同片段均保留原始身份'
  );
  assert.equal(
    announcementSnippet.text,
    fixture.data.grounding.generic[3].snippets[1],
    '发布片段须完整保留夹具中的原始正文'
  );
  assert.ok(
    announcementSnippet.text.includes('M3.1-Flash-Preview, debuts today on MiniMax Code.'),
    '发布片段须保留模型名称及发布事实'
  );

  // 验证生成请求的来源与题键
  const { state, questions, entries } = buildContextRequest(
    candidates,
    fixture.request.params.query,
    fixture.request.intent,
    fixture.request.retrievalTime
  );
  const request = buildRequest(state, questions, config.jev.model);
  assert.equal(request.state.sources[3].snippets.length, 3);
  assert.deepEqual(entries[3].snippet_keys, ['0', '1', '2']);
  assert.deepEqual(entries[3].snippet_groups, [
    { key: 'group0', start: 0, size: 3, letters: ['A', 'B', 'C'] },
  ]);
  assert.deepEqual(
    Object.keys(request.questions).filter((key) => key.startsWith('s3__')),
    ['s3__filler', 's3__group0']
  );
  const recording = loadRecording('minimax-time');
  assertRecording(recording, request);
});

it('请求正文改变时直接抛错拒绝，确保回放防线有效', () => {
  const recording = loadRecording('jev-questions');
  const changed = structuredClone(recording.request);
  changed.state.sources[0].snippets[0] += ' changed';
  assert.throws(
    () => assertRecording(recording, changed),
    /模型请求已变化，须用当前请求重新录制夹具/
  );
});
