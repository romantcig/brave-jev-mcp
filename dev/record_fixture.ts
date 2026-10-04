/** 用当前请求重录一份夹具；默认只规划，实发证据写入指定的仓库外目录。 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadFixture } from '../test-support/log-fixtures.mjs';
import { parseFilterConfigObject } from '../src/filter/config.js';
import { collectJevCandidatesDetailed } from '../src/filter/pipeline.js';
import { buildContextRequest } from '../src/filter/jev/context.js';
import {
  buildRequest,
  createJevClassifier,
  hasJevKey,
  JEVI_ENDPOINT,
} from '../src/filter/jev/client.js';
import { QUESTION_SET_ID } from '../src/filter/jev/questions.js';
import { FILTER_RULES_VERSION } from '../src/filter/version.js';

const [name, evidenceArg, ...flags] = process.argv.slice(2);
assert.ok(name, '用法：node --import tsx dev/record_fixture.ts <名称> <仓库外证据目录> [--live]');
const fixture = loadFixture(name);
const config = parseFilterConfigObject({ ...fixture.config, mode: 'on' });
const candidates = collectJevCandidatesDetailed(fixture.data, fixture.request, config);
assert.ok(candidates.length, '空结果无需模型录制');
const { state, questions } = buildContextRequest(
  candidates,
  fixture.request.params.query,
  fixture.request.intent,
  fixture.request.retrievalTime
);
const request = buildRequest(state, questions, config.jev.model);
const key = createHash('sha256').update(JSON.stringify(request)).digest('hex');
const target = new URL(`../fixtures/log-derived/${name}.record.json`, import.meta.url);
if (existsSync(target)) {
  const recorded = JSON.parse(readFileSync(target, 'utf8'));
  if (recorded.request_sha256 === key && recorded.status === 200) {
    console.log(`${name}：已有相同请求的录制，零调用退出`);
    process.exit(0);
  }
}
console.log(
  JSON.stringify({
    name,
    sources: candidates.length,
    questions: Object.keys(questions).length,
    request_sha256: key,
  })
);
if (!flags.includes('--live')) process.exit(0);
assert.ok(hasJevKey(process.env), '缺少 TYPESAFE_API_KEY');
assert.ok(evidenceArg, '实发必须提供仓库外证据目录');
const evidenceDir = resolve(evidenceArg);
const repo = fileURLToPath(new URL('../', import.meta.url));
const rel = relative(repo, evidenceDir);
assert.ok(rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel), '证据目录必须在仓库外');
mkdirSync(evidenceDir, { recursive: true });

let attempts = 0;
let successful: { status: number; body: unknown } | undefined;
const nativeFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  assert.equal(String(url), JEVI_ENDPOINT);
  assert.deepEqual(JSON.parse(String(init?.body)), request);
  const evidence = resolve(evidenceDir, `${name}-${key.slice(0, 12)}-attempt-${++attempts}.json`);
  // 已存在的尝试不能被覆盖；中断后须使用新的证据目录。
  writeFileSync(evidence, JSON.stringify({ request }, null, 2), { flag: 'wx' });
  const response = await nativeFetch(url, init);
  const body = await response.clone().text();
  writeFileSync(evidence, JSON.stringify({ request, status: response.status, body }, null, 2));
  if (response.status === 200) successful = { status: response.status, body: JSON.parse(body) };
  return response;
};
try {
  const outcome = await createJevClassifier(config.jev, process.env).classify({ state, questions });
  assert.equal(outcome.status, 'answered', `录制未成功：${JSON.stringify(outcome)}`);
  assert.ok(successful);
  writeFileSync(
    target,
    JSON.stringify(
      {
        recorded_at: new Date().toISOString(),
        filter_rules_version: FILTER_RULES_VERSION,
        question_set_id: QUESTION_SET_ID,
        request_sha256: key,
        request,
        ...successful,
      },
      null,
      2
    ) + '\n'
  );
  console.log(`${name}：已保存当前真实回答，HTTP 尝试 ${attempts} 次`);
} finally {
  globalThis.fetch = nativeFetch;
}
