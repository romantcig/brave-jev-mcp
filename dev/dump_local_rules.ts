/**
 * 运行本地步骤 1–4，stdout 输出一行 { query, intent, sources }，不调用 Jev。
 * 用法：node --import tsx dev/dump_local_rules.ts fixtures/<stem>.json
 * 请求参数来自对应 expected 文件；候选口径与生产管道共用。
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
