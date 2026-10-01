/** 中断保护回归：全部使用临时目录与本地响应桩，不调用网络。 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { claimLiveRun, LIVE_RUN_MARKER } from './full-context-run-lock.mjs';

const root = mkdtempSync(join(process.env.FULL_CONTEXT_TEST_TMP_DIR ?? tmpdir(), 'run-lock-'));
const manifest = { logical_requests: 2, max_http_attempts: 6 };
const helper = new URL('./full-context-run-lock.mjs', import.meta.url).href;
const script = new URL('./full-context-smoke.mjs', import.meta.url).href;
const dir = () => mkdtempSync(join(root, 'case-'));

for (const name of [
  'http-1.json',
  'other.record.json',
  'case.live.result.json',
  'live-summary.json',
]) {
  test(`拒绝只有 ${name} 的旧目录，并保留原文件`, () => {
    const path = dir();
    const original = '{"old_evidence":true}\n';
    writeFileSync(join(path, name), original);
    assert.throws(() => claimLiveRun(path, manifest), /已有真实调用或未完成证据/);
    assert.equal(readFileSync(join(path, name), 'utf8'), original);
  });
}

test('开始后即使没有任何结果，也不能再次认领目录', () => {
  const path = dir();
  claimLiveRun(path, manifest);
  const marker = readFileSync(join(path, LIVE_RUN_MARKER), 'utf8');
  assert.deepEqual(JSON.parse(marker).manifest, manifest);
  assert.throws(() => claimLiveRun(path, manifest), /已有真实调用或未完成证据/);
  assert.equal(readFileSync(join(path, LIVE_RUN_MARKER), 'utf8'), marker);
});

test('两个并行进程只能有一个认领成功', async () => {
  const path = dir();
  const code = `import {claimLiveRun} from ${JSON.stringify(helper)}; claimLiveRun(${JSON.stringify(path)}, {});`;
  const run = () =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '--eval', code], {
        stdio: 'ignore',
        windowsHide: true,
      });
      child.on('error', reject);
      child.on('exit', (status) => resolve(status));
    });
  const statuses = await Promise.all([run(), run()]);
  assert.deepEqual(statuses.sort(), [0, 1]);
});

test('完整 live 入口遇到中断 HTTP 证据时零调用退出', () => {
  const path = dir();
  const cases = ['first', 'second'].map((id) => ({
    id,
    origin: '合成断点保护测试',
    data: {
      grounding: {
        generic: ['alpha', 'beta'].map((site) => ({
          url: `https://${site}.example/${id}`,
          title: `Orion ${site}`,
          snippets: [
            `Orion ${site} documents durable storage and recovery mechanisms in 2026, with explicit retry limits and operational restrictions.`,
          ],
        })),
      },
      sources: {},
    },
    request: {
      params: { query: 'Orion recovery 2026' },
      intent: 'Explain Orion recovery mechanisms and limitations in 2026.',
    },
    config: {},
  }));
  writeFileSync(join(path, 'cases.json'), JSON.stringify(cases));
  const original = '{"prior_dispatch":true}\n';
  writeFileSync(join(path, 'http-1.json'), original);
  const probe = join(path, 'probe.mjs');
  writeFileSync(
    probe,
    `
    import assert from 'node:assert/strict';
    process.env.TYPESAFE_API_KEY = 'local-test';
    process.argv = ['node', 'full-context-smoke.mjs', ${JSON.stringify(path)}, '--live'];
    let calls = 0;
    globalThis.fetch = async () => { calls++; throw new Error('禁止联网'); };
    await assert.rejects(import(${JSON.stringify(script)}), /已有真实调用或未完成证据/);
    assert.equal(calls, 0);
  `
  );
  const result = spawnSync(process.execPath, [probe], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(path, 'http-1.json'), 'utf8'), original);
});
