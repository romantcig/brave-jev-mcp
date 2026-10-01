/** 真实冒烟目录只能开始一次；中断留下的标记和 HTTP 证据必须保留。 */
import assert from 'node:assert/strict';
import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const LIVE_RUN_MARKER = 'live-run.json';

/** 排他认领运行目录。标记不清除，后续采集必须换目录，旧目录仍可离线回放。 */
export function claimLiveRun(root, manifest) {
  const evidence = readdirSync(root).find(
    (name) =>
      name === LIVE_RUN_MARKER ||
      name === 'live-summary.json' ||
      /^http-.*\.json$/.test(name) ||
      name.endsWith('.record.json') ||
      name.endsWith('.live.result.json')
  );
  assert.equal(evidence, undefined, '目录已有真实调用或未完成证据，请使用新目录');
  // wx 同时挡住两个进程都通过上方检查的竞争；写入失败同样不得继续派发。
  writeFileSync(
    join(root, LIVE_RUN_MARKER),
    `${JSON.stringify({ started_at: new Date().toISOString(), pid: process.pid, manifest }, null, 2)}\n`,
    { encoding: 'utf8', flag: 'wx' }
  );
}
