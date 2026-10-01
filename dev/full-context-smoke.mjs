/**
 * 全量接入的有限真实冒烟与严格离线回放。使用已构建 dist；正文及 HTTP 证据只写外部目录。
 * node dev/full-context-smoke.mjs <仓库外目录> --plan|--live|--offline
 * 目录预置 cases.json：[{ id, origin, data, request: {params,intent}, config }]。
 * 默认只规划；live 最多两次逻辑请求、六次 HTTP、60000 估算 token（含重试余量）。
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFilterConfigObject } from '../dist/filter/config.js';
import { collectJevCandidatesDetailed, filterLlmContext } from '../dist/filter/pipeline.js';
import { planAllRequest } from '../dist/filter/jev/context.js';
import { createJevClassifier, hasJevKey, JEVI_ENDPOINT } from '../dist/filter/jev/client.js';
import { QUESTION_SET_ID } from '../dist/filter/jev/questions.js';
import { CONTEXT_LAYOUT_ID, FILTER_RULES_VERSION } from '../dist/filter/version.js';
import { createSampleWriter } from '../dist/filter/sample.js';
import { claimLiveRun } from './full-context-run-lock.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
assert.ok(process.argv[2], '必须提供仓库外产物目录');
const root = resolve(process.argv[2]);
const rel = relative(repo, root);
assert.ok(rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel), '产物必须在仓库外');
const mode = process.argv[3] ?? '--plan';
assert.ok(['--plan', '--live', '--offline'].includes(mode));
mkdirSync(root, { recursive: true });
const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
const save = (name, value) =>
  writeFileSync(join(root, name), `${JSON.stringify(value, null, 2)}\n`);
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const files = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)]
  );
const runtimeHash = hash(
  files(join(repo, 'dist/filter'))
    .sort()
    .map((path) => [relative(repo, path), readFileSync(path, 'utf8')])
);
const cases = read(join(root, 'cases.json'));
assert.equal(cases.length, 2, '本轮固定两份材料，不自动扩展');
assert.equal(new Set(cases.map((item) => item.id)).size, cases.length);
const prepared = cases.map((item) => {
  assert.match(item.id, /^[a-z0-9-]+$/);
  const config = parseFilterConfigObject({
    ...item.config,
    mode: 'test',
    jev: { ...item.config?.jev, context_mode: 'all' },
    log_dir: join(root, 'samples'),
  });
  const candidates = collectJevCandidatesDetailed(item.data, item.request, config);
  assert.ok(candidates.length > 1, '本轮须覆盖多来源全量路径');
  const planned = planAllRequest(candidates, item.request.params.query, item.request.intent);
  assert.ok(planned.ok, '本轮不自动扩展为 single 网络请求');
  const { state, questions, estimates } = planned.plan;
  const payload = { state, questions };
  const identity = {
    runtime_hash: runtimeHash,
    rules: FILTER_RULES_VERSION,
    layout: CONTEXT_LAYOUT_ID,
    question_set: QUESTION_SET_ID,
    model: config.jev.model,
    payload,
  };
  return { item, config, payload, identity, key: hash(identity), estimates };
});
const plan = prepared.map((entry) => ({
  id: entry.item.id,
  origin: entry.item.origin,
  key: entry.key,
  state_sha256: hash(entry.payload.state),
  questions_sha256: hash(entry.payload.questions),
  model: entry.config.jev.model,
  sources: entry.payload.state.sources.length,
  questions: Object.keys(entry.payload.questions).length,
  temporal_questions: Object.keys(entry.payload.questions).filter((key) =>
    key.includes('__time_snip')
  ).length,
  estimates: entry.estimates,
  retry_upper_estimate: entry.estimates.total_limit_estimate * 3,
}));
const upperEstimate = plan.reduce((sum, entry) => sum + entry.retry_upper_estimate, 0);
assert.ok(upperEstimate <= 60000, '累计含重试估算超过本轮上限');
const manifest = {
  mode,
  runtime_hash: runtimeHash,
  rules: FILTER_RULES_VERSION,
  layout: CONTEXT_LAYOUT_ID,
  question_set: QUESTION_SET_ID,
  logical_requests: 2,
  max_http_attempts: 6,
  estimated_input_upper_bound: upperEstimate,
  plan,
};
console.log(JSON.stringify(manifest, null, 2));
if (mode === '--plan') {
  save('plan.json', manifest);
  process.exit(0);
}
if (mode === '--live') {
  assert.ok(hasJevKey(process.env), '缺少环境变量 TYPESAFE_API_KEY');
  // 首次派发之前永久认领目录；中断后也不能覆盖证据或从零重算调用预算。
  claimLiveRun(root, manifest);
}

let attempts = 0;
let chargedEstimate = 0;
let active;
const nativeFetch = globalThis.fetch;
const summary = { ...manifest, http_attempts: 0, known_input_tokens: 0, results: [] };
// 在 fetch 处记录真实请求正文和响应，不保存鉴权头、密钥或环境变量。
globalThis.fetch = async (url, init) => {
  assert.equal(mode, '--live', '离线模式禁止 HTTP');
  assert.equal(url, JEVI_ENDPOINT);
  assert.ok(active);
  const sent = JSON.parse(String(init?.body));
  assert.deepEqual(sent, { model: active.config.jev.model, ...active.payload });
  assert.ok(attempts < 6 && chargedEstimate + active.estimates.total_limit_estimate <= 60000);
  const attempt = ++attempts;
  chargedEstimate += active.estimates.total_limit_estimate;
  const evidence = { case_id: active.item.id, attempt, request: sent };
  save(`http-${attempt}.json`, evidence);
  try {
    const response = await nativeFetch(url, init);
    evidence.status = response.status;
    evidence.body = await response.clone().text();
    save(`http-${attempt}.json`, evidence);
    return response;
  } catch (error) {
    evidence.failure = error instanceof Error ? error.name : 'unknown';
    save(`http-${attempt}.json`, evidence);
    throw error;
  }
};

try {
  for (const entry of prepared) {
    active = entry;
    const { item, config } = entry;
    let outcome;
    let calls = 0;
    const client = createJevClassifier(config.jev, process.env);
    const classify = async (payload) => {
      assert.equal(++calls, 1, '一次 case 只允许一次全量逻辑请求');
      assert.deepEqual(payload, entry.payload);
      if (mode === '--live') {
        outcome = await client.classify(payload);
        save(`${item.id}.record.json`, { key: entry.key, identity: entry.identity, outcome });
      } else {
        const recorded = read(join(root, `${item.id}.record.json`));
        assert.equal(recorded.key, entry.key, '输入或构建改变，拒绝复用旧答案');
        assert.deepEqual(recorded.identity, entry.identity);
        outcome = recorded.outcome;
      }
      return structuredClone(outcome);
    };
    const filtered = await filterLlmContext(item.data, item.request, config, { classify });
    const writer = createSampleWriter(config);
    const requestId = randomUUID();
    const path = writer.allocatePath(requestId);
    const statusLine = `${filtered.stats.output.status_line ?? ''} sample: ${path.absolute}`;
    assert.equal(
      writer.save({
        requestId,
        path,
        originalParams: item.request.params,
        braveParams: item.request.params,
        filterParams: item.request.params,
        intent: item.request.intent,
        preFilter: item.data,
        stats: filtered.stats,
        jevDispatch: filtered.jev_dispatch,
        jevRequests: filtered.jev_requests,
        payload: filtered.result,
        statusLine,
      }).status,
      'saved'
    );
    const sample = read(path.absolute);
    assert.equal(sample.format_version, 4);
    assert.equal(sample.context_layout_id, CONTEXT_LAYOUT_ID);
    assert.deepEqual(sample.pre_filter, item.data);
    assert.deepEqual(sample.final_return, { payload: filtered.result, status_line: statusLine });
    assert.equal(sample.jev.requests.length, 1);
    const record = sample.jev.requests[0];
    assert.deepEqual(JSON.parse(record.state), entry.payload.state);
    assert.deepEqual(record.questions, entry.payload.questions);
    for (const source of sample.jev.sent) {
      const mapping = record.mapping.find((entry) => entry.source_id === source.src);
      assert.equal(source.request_id, record.request_id);
      assert.equal(source.array_index, mapping.array_index);
      assert.equal(entry.payload.state.sources[source.array_index].id, source.src);
      for (const snippet of source.snippets) {
        assert.equal(snippet.snippet, mapping.snippet_keys[snippet.position]);
        assert.equal(
          snippet.text,
          entry.payload.state.sources[source.array_index].snippets[snippet.position]
        );
        assert.equal(snippet.in_state, true);
        assert.equal(snippet.score_question_sent, true);
      }
    }
    // 同一次录制分别进入 test/on；回放依赖严格验证实际输入，不再请求 Jev。
    const replay = {
      classify: async (payload) => {
        assert.deepEqual(payload, entry.payload);
        return structuredClone(outcome);
      },
    };
    const on = await filterLlmContext(item.data, item.request, { ...config, mode: 'on' }, replay);
    assert.deepEqual(on.result, filtered.result);
    assert.deepEqual(on.stats.sources, filtered.stats.sources);
    assert.deepEqual(on.stats.local, filtered.stats.local);
    const result = {
      id: item.id,
      status: outcome.status,
      sample: path.absolute,
      n_requests: filtered.stats.jev.n_requests,
      http_attempts: outcome.http_attempts,
      input_tokens: outcome.input_tokens ?? null,
      usage_complete: outcome.usage_complete,
      test_on_equal: true,
      retained_sources: filtered.result.grounding.generic.length,
    };
    summary.results.push(result);
    summary.known_input_tokens += outcome.input_tokens ?? 0;
    save(`${item.id}.${mode.slice(2)}.result.json`, filtered);
    console.log(JSON.stringify(result));
    assert.equal(outcome.status, 'answered', '真实请求失败，已保存证据，停止本轮');
    assert.equal(outcome.model, config.jev.model);
    assert.equal(outcome.http_status, 200);
    assert.equal(filtered.stats.jev.n_requests, 1);
  }
} finally {
  globalThis.fetch = nativeFetch;
  summary.http_attempts = attempts;
  summary.dispatched_input_estimate = chargedEstimate;
  save(`${mode.slice(2)}-summary.json`, summary);
}
