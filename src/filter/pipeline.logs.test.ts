/** 真实日志回放与契约防线：未受影响材料严格回放，已知材料建立精准本地回归与重录拒绝断言。 */
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

// 1. 未受影响的常规夹具严格端到端回放，绝不吞没任何异常
const unaffectedFixtures = fixtureNames().filter((name) => name !== 'minimax-time');

for (const name of unaffectedFixtures) {
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

// 2. 已确认受页内去重影响的材料：明确标注端到端回放未完成，建立精确本地回归与拒绝复用断言
it('minimax-time 本地回归：页内严格全等去重恢复推特片段并生成新题目键（端到端回放待重新录制）', () => {
  const fixture = loadFixture('minimax-time');
  const config = parseFilterConfigObject({ ...fixture.config, mode: 'on' });
  const candidates = collectJevCandidatesDetailed(fixture.data, fixture.request, config);

  // 验证候选来源集合保持为 3 个
  assert.equal(candidates.length, 3);
  assert.equal(candidates[0].url, 'https://www.aibase.com/news/31365');
  assert.equal(candidates[0].snippets.length, 9);
  assert.equal(
    candidates[1].url,
    'https://www.reddit.com/r/MiniMax_AI/comments/1v73a0r/m31_has_strong_potential_to_be_the_most/'
  );
  assert.equal(candidates[1].snippets.length, 5);

  // 推特来源的三个不同片段均进入候选，保持原始身份与顺序。
  const s2 = candidates[2];
  assert.equal(s2.url, 'https://x.com/MiniMaxAgent/status/2104079819881517400');
  assert.equal(s2.snippets.length, 3);

  // 校验片段身份、完整正文及发布事实，防止只保留账号前缀。
  const restoredSnippet = s2.snippets[1];
  assert.equal(restoredSnippet.key, '1');
  assert.deepEqual(
    s2.snippets.map((snip) => snip.key),
    ['0', '1', '2'],
    '片段序号由旧录制的 [0, 2] 恢复为完整的 [0, 1, 2]'
  );
  assert.equal(
    restoredSnippet.text,
    fixture.data.grounding.generic[2].snippets[1],
    '恢复片段须完整保留夹具中的原始正文'
  );
  assert.ok(
    restoredSnippet.text.includes('M3.1-Flash-Preview, debuts today on MiniMax Code.'),
    '恢复片段须保留模型名称及发布事实'
  );

  // 验证生成请求的来源与题键
  const { state, questions } = buildContextRequest(
    candidates,
    fixture.request.params.query,
    fixture.request.intent,
    fixture.request.retrievalTime
  );
  const request = buildRequest(state, questions, config.jev.model);
  assert.equal(request.state.sources[2].snippets.length, 3);
  assert.ok('s2__snip0' in request.questions);
  assert.ok('s2__snip1' in request.questions);
  assert.ok('s2__snip2' in request.questions, '候选片段由 2 变 3，必须生成新增题键 s2__snip2');

  // 契约校验：旧录制缺少 s2__snip2，assertRecording 必须直接抛错拒绝，旧答案无法被不当复用
  const recording = loadRecording('minimax-time');
  assert.throws(
    () => assertRecording(recording, request),
    /模型请求已变化，须用当前请求重新录制夹具/,
    '请求改变时 assertRecording 必须直接抛错拒绝，端到端回放明确标注为待重新录制'
  );
});

// 3. 保护检查：未受影响材料请求改变时直接测试失败，绝不跳过
it('未受影响材料请求改变时直接抛错拒绝，确保回放防线有效', () => {
  const recording = loadRecording('jev-questions');
  const changed = structuredClone(recording.request);
  changed.state.sources[0].snippets[0] += ' changed';
  assert.throws(
    () => assertRecording(recording, changed),
    /模型请求已变化，须用当前请求重新录制夹具/
  );
});
