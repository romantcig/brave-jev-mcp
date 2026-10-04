/** stdio 离线传输桩：原文与完整当前请求来自日志夹具，禁止回退到网络。 */
import assert from 'node:assert/strict';
import { loadFixture, loadRecording, assertRecording } from '../test-support/log-fixtures.mjs';

const fixture = loadFixture(process.env.SMOKE_FIXTURE);
const recording = loadRecording(fixture.id);
const anchor = fixture.request.retrievalTime;
assert.ok(anchor, 'stdio 夹具必须保存实际检索时间');
const NativeDate = Date;
const timestamp = NativeDate.parse(anchor);
// 固定宿主取时；页面日期和请求检索时间仍来自原始记录。
globalThis.Date = class extends NativeDate {
  constructor(...args) {
    super(...(args.length ? args : [timestamp]));
  }
  static now() {
    return timestamp;
  }
};

globalThis.fetch = async (input, init) => {
  try {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin === 'https://api.search.brave.com' && url.pathname === '/res/v1/llm/context') {
      assert.equal(url.searchParams.get('q'), fixture.request.params.query);
      console.error('[smoke-brave] 日志原文回放');
      return Response.json(fixture.data);
    }
    assert.notEqual(process.env.SMOKE_MODE, 'off', 'off 不得请求 Jev');
    assert.equal(url.href, process.env.SMOKE_JEV_ENDPOINT);
    assert.equal(init?.method, 'POST');
    assertRecording(recording, JSON.parse(String(init?.body)));
    console.error('[smoke-jev] 当前完整请求匹配');
    return Response.json(recording.body, { status: recording.status });
  } catch (error) {
    console.error('[smoke-stub-failed]', error instanceof Error ? error.message : String(error));
    throw error;
  }
};
