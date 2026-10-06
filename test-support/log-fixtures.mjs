/** 日志夹具共用读取与核对；不加载个人日志，不调用网络。 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const root = new URL('../fixtures/log-derived/', import.meta.url);
export const fixtureNames = () =>
  readdirSync(root)
    .filter((name) => name.endsWith('.case.json'))
    .map((name) => name.slice(0, -10))
    .sort();

export function loadFixture(name) {
  assert.ok(fixtureNames().includes(name), `未知日志夹具：${name}`);
  const fixture = JSON.parse(readFileSync(new URL(`${name}.case.json`, root), 'utf8'));
  assert.equal(fixture.id, name);
  return fixture;
}

export function loadRecording(name) {
  return JSON.parse(readFileSync(new URL(`${name}.record.json`, root), 'utf8'));
}

/** 在调用过滤管道前核对请求；不能让失败保留机制掩盖错位的旧回答。 */
export function assertRecording(recording, request) {
  assert.deepEqual(request, recording.request, '模型请求已变化，须用当前请求重新录制夹具');
  for (const [key, question] of Object.entries(request.questions)) {
    if (question.type === 'choice')
      assert.deepEqual(
        Object.keys(question.criteria),
        Object.keys(recording.request.questions[key].criteria),
        '组合选项顺序必须与录制一致'
      );
  }
  assert.equal(recording.status, 200, '回放需要一次成功的真实录制');
  assert.equal(recording.body.model, request.model);
}

/** 只检查选样时独立核对的关键内容，以及幸存来源的原始顺序。 */
export function assertFixtureOutput(fixture, result) {
  const input = fixture.data.grounding.generic;
  const output = result.grounding.generic;
  let cursor = 0;
  for (const source of output) {
    const index = input.findIndex((item, i) => i >= cursor && item.url === source.url);
    assert.ok(index >= cursor, `${fixture.id}：输出出现新来源或改变 Brave 顺序`);
    cursor = index + 1;
  }
  if (input.length === 0) assert.deepEqual(output, []);
  for (const check of fixture.checks) {
    const url = input[check.source].url;
    const text = output.find((item) => item.url === url)?.snippets.join('\n') ?? '';
    for (const fact of check.keep ?? [])
      assert.ok(text.includes(fact), `${fixture.id}：丢失事实 ${fact}`);
    for (const noise of check.absent ?? [])
      assert.ok(!text.includes(noise), `${fixture.id}：仍含 ${noise}`);
  }
}
