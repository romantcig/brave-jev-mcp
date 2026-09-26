/**
 * 本地规则后候选集 dump（02-01）：对一份 Brave 夹具跑 `collectJevCandidates`
 * （本地规则层步 1–4 的幸存口径），stdout 只打印一行 JSON：
 * `{ query, intent, sources: JevCandidate[] }`。`dev/jev_probe.py` 以子进程调用
 * 本脚本，只对幸存来源发请求、对幸存片段录答案——录好的 `.jev.json` 因此与
 * 管道步 5 发送的 state 逐源逐片段对齐（02-RESEARCH A14 的解法）。
 *
 * 用法：node --import tsx dev/dump_local_rules.ts fixtures/<stem>.json
 *
 * query / intent / request 取自同 stem 的 `fixtures/expected/<stem>.off.json`
 * （Phase 1 期望文件，与两份 Jev 夹具的请求参数一致）；夹具本体用三形状加载器
 * 收窄（复制自 src/filter/pipeline.fixtures.test.ts 的 loadBraveFixture，不建
 * src/testUtils/ 新文件）。dev/ 不进 tsc / prettier 门禁；相对导入带 .js 后缀
 * （NodeNext ESM 直跑约定）。
 */
import { readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { parseFilterConfigObject } from '../src/filter/config.js';
import { collectJevCandidates } from '../src/filter/pipeline.js';
import type { BraveLlmContextResponse, FilterRequest } from '../src/filter/types.js';

const fxPath = process.argv[2];
if (!fxPath) {
  console.error('usage: node --import tsx dev/dump_local_rules.ts <fixture-relative-path>');
  process.exit(2);
}

const stem = basename(fxPath).replace(/\.json$/, '');
const expectedPath = join(dirname(fxPath), 'expected', `${stem}.off.json`);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** 三形状加载器（wrapped / bare / noise），与 src/filter/pipeline.fixtures.test.ts 同逻辑。 */
const loadBraveFixture = (raw: string): BraveLlmContextResponse => {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed === 'object' && parsed !== null && 'response' in parsed) {
    return (parsed as { response: BraveLlmContextResponse }).response;
  }
  if (Array.isArray((parsed as BraveLlmContextResponse)?.grounding?.generic)) {
    return parsed as BraveLlmContextResponse;
  }
  const noise = parsed as {
    generic: BraveLlmContextResponse['grounding']['generic'][number];
    source?: BraveLlmContextResponse['sources'];
  };
  return {
    grounding: { generic: [noise.generic], map: [] },
    sources: noise.source ?? {},
  };
};

const data = loadBraveFixture(readFileSync(fxPath, 'utf8'));

const expected: unknown = JSON.parse(readFileSync(expectedPath, 'utf8'));
if (!isRecord(expected)) throw new Error(`expected file is not an object: ${expectedPath}`);
const { query, intent, request } = expected as {
  query?: unknown;
  intent?: unknown;
  request?: unknown;
};
if (typeof query !== 'string' || typeof intent !== 'string' || !isRecord(request)) {
  throw new Error(`expected file missing string query / intent or object request: ${expectedPath}`);
}

const params: FilterRequest = { query, ...request };
const config = parseFilterConfigObject({});

console.log(
  JSON.stringify({
    query,
    intent,
    sources: collectJevCandidates(data, { params, intent }, config),
  })
);
