/**
 * 样本写入器测试：验证正常保存回读、失败请求证据保留与写入异常容错。
 */

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { DEFAULT_JEV_MODEL, DEFAULT_THRESHOLDS } from './jev/questions.js';
import { createJevClassifier } from './jev/client.js';
import { filterLlmContext } from './pipeline.js';
import { createSampleWriter, type SampleRecord } from './sample.js';
import { FILTER_RULES_VERSION } from './version.js';
import type {
  BraveLlmContextResponse,
  ClassifyDeps,
  FilterConfig,
  FilterResult,
  JevState,
} from './types.js';

const INTENT = 'What Brave Search is and how it differs from other engines';
const QUERY = 'brave browser';

const configOf = (logDir: string): FilterConfig => ({
  mode: 'test',
  thresholds: { ...DEFAULT_THRESHOLDS },
  jev: {
    model: DEFAULT_JEV_MODEL,
    timeoutMs: 15000,
    concurrency: 12,
  },
  logDir,
});

const keepAllClassify: ClassifyDeps['classify'] = async ({ questions }) => ({
  status: 'answered',
  model: DEFAULT_JEV_MODEL,
  answers: Object.fromEntries(
    Object.entries(questions).map(([key, question]) => [
      key,
      question.type === 'score' ? { kind: 'score', score: 2 } : { kind: 'noul', probability: 0 },
    ])
  ),
  input_tokens: 42,
});

const articleBody =
  'Brave search deeply analyzes the rendering pipeline of version 2.1 with specific benchmarks ' +
  'and profiling data that no other outlet covered in the same detail. The author reverse ' +
  'engineered the scheduler and documented every queue transition with timings.';

const richResponse: BraveLlmContextResponse = {
  grounding: {
    generic: [
      {
        url: 'https://a.example/post',
        title: 'A Post',
        snippets: [articleBody],
      },
    ],
    map: [],
  },
  sources: {
    'https://a.example/post': { title: 'A Post', hostname: 'a.example', age: [] },
  },
};

type CapturedRequest = { model: string; state: JevState; questions: Record<string, unknown> };

const stubFetch = (
  respond: (body: CapturedRequest) => { status: number; text: () => Promise<string> }
): { captured: CapturedRequest[]; restore: () => void } => {
  const captured: CapturedRequest[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
    const body = JSON.parse(String(init?.body)) as CapturedRequest;
    captured.push(body);
    return respond(body);
  }) as typeof fetch;
  return { captured, restore: () => (globalThis.fetch = original) };
};

describe('createSampleWriter', () => {
  const root = mkdtempSync(join(tmpdir(), 'jev-sample-test-'));

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('正常保存：分配路径与实际落盘一致，可读回原文、请求、回答、输出与版本信息', async () => {
    const logDir = join(root, 'normal-save', 'logs');
    const config = configOf(logDir);
    const { captured, restore } = stubFetch((body) => ({
      status: 200,
      text: async () =>
        JSON.stringify({
          model: DEFAULT_JEV_MODEL,
          answers: Object.fromEntries(
            Object.entries(body.questions).map(([key, question]) => [
              key,
              (question as { type: string }).type === 'score'
                ? { type: 'score', score: 2 }
                : { type: 'noul', noul: 0 },
            ])
          ),
          usage: { input_tokens: 42 },
        }),
    }));
    let filtered: FilterResult;
    try {
      filtered = await filterLlmContext(
        richResponse,
        { params: { query: QUERY }, intent: INTENT },
        config,
        createJevClassifier(config.jev, { TYPESAFE_API_KEY: 'stub-key' })
      );
    } finally {
      restore();
    }
    const { result: payload, stats, jev_dispatch, jev_requests } = filtered;
    stats.brave.latency_ms = 12;
    const statusLine = stats.output.status_line ?? null;
    const writer = createSampleWriter(config);
    const requestId = '11111111-2222-3333-4444-555555555555';
    const path = writer.allocatePath(requestId);

    const outcome = writer.save({
      requestId,
      path,
      originalParams: { query: QUERY, count: 3 },
      braveParams: { query: QUERY, maximum_number_of_urls: 10 },
      filterParams: { query: QUERY },
      intent: INTENT,
      preFilter: richResponse,
      stats,
      jevDispatch: jev_dispatch,
      jevRequests: jev_requests,
      payload,
      statusLine,
    });
    assert.deepEqual(outcome, { status: 'saved' });

    assert.equal(existsSync(path.absolute), true);
    const raw = readFileSync(path.absolute, 'utf8');
    const sample = JSON.parse(raw) as SampleRecord;

    assert.equal(sample.format_version, 7);
    assert.equal(sample.request_id, requestId);
    assert.equal(sample.mode, 'test');
    assert.deepEqual(sample.request, {
      params: { query: QUERY, count: 3 },
      brave_params: { query: QUERY, maximum_number_of_urls: 10 },
      intent: INTENT,
    });
    assert.deepEqual(sample.pre_filter, richResponse);
    assert.equal(captured.length, 1);
    const savedRequest = sample.jev?.requests[0];
    assert.ok(savedRequest?.state);
    assert.deepEqual(JSON.parse(savedRequest.state), captured[0].state);
    assert.deepEqual(savedRequest.questions, captured[0].questions);
    assert.deepEqual(savedRequest.answers, jev_requests[0].answers);
    assert.equal(savedRequest.answered, true);
    assert.equal(savedRequest.answers?.s0__snip0?.kind, 'score');
    assert.deepEqual(
      sample.final_return,
      JSON.parse(JSON.stringify({ payload, status_line: statusLine }))
    );
    assert.match(String(sample.question_set_id), /^[0-9a-f]{12}$/);
    assert.equal(sample.filter_rules_version, FILTER_RULES_VERSION);
  });

  it('失败请求：如实保留已有实发证据（HTTP 422），不伪造成功', async () => {
    const logDir = join(root, 'http-failed', 'logs');
    const config = configOf(logDir);
    const { captured, restore } = stubFetch(() => ({
      status: 422,
      text: () => Promise.resolve('invalid request'),
    }));
    let failed: FilterResult;
    try {
      failed = await filterLlmContext(
        richResponse,
        { params: { query: QUERY }, intent: INTENT },
        config,
        {
          classify: createJevClassifier(config.jev, { TYPESAFE_API_KEY: 'stub-key' }).classify,
        }
      );
    } finally {
      restore();
    }
    assert.equal(captured.length, 1);
    const lastRequest = captured[0]!;

    const writer = createSampleWriter(config);
    const requestId = '44444444-2222-3333-4444-555555555555';
    const path = writer.allocatePath(requestId);
    const outcome = writer.save({
      requestId,
      path,
      originalParams: { query: QUERY },
      braveParams: { query: QUERY },
      filterParams: { query: QUERY },
      intent: INTENT,
      preFilter: richResponse,
      stats: failed.stats,
      jevDispatch: failed.jev_dispatch,
      jevRequests: failed.jev_requests,
      payload: { output: failed.stats.output },
      statusLine: failed.stats.output.status_line ?? null,
    });
    assert.deepEqual(outcome, { status: 'saved' });

    const sample = JSON.parse(readFileSync(path.absolute, 'utf8')) as SampleRecord;
    assert.ok(sample.jev);
    assert.equal(sample.jev.requests.length, 1);
    const request = sample.jev.requests[0]!;
    assert.equal(request.dispatched, true);
    assert.equal(request.answered, false);
    assert.equal(request.fail_kind, 'validation');
    assert.equal(request.input_tokens, null);
    assert.equal(request.usage_complete, false);
    assert.ok(request.state);
    assert.deepEqual(JSON.parse(request.state), lastRequest.state);
    assert.deepEqual(request.questions, lastRequest.questions);
  });

  it('写入失败：目标目录不可写时返回 failed，不抛异常，不留下样本文件', async () => {
    const blockedPath = join(root, 'blocked-file');
    writeFileSync(blockedPath, 'not a directory', 'utf8');
    const config = configOf(blockedPath);
    const { stats, jev_dispatch, jev_requests } = await filterLlmContext(
      richResponse,
      { params: { query: QUERY }, intent: INTENT },
      config,
      { classify: keepAllClassify }
    );
    const writer = createSampleWriter(config);
    const requestId = '88888888-2222-3333-4444-555555555555';
    const path = writer.allocatePath(requestId);

    const originalError = console.error;
    console.error = () => {};
    let outcome: { status: string };
    try {
      outcome = writer.save({
        requestId,
        path,
        originalParams: { query: QUERY },
        braveParams: { query: QUERY },
        filterParams: { query: QUERY },
        intent: INTENT,
        preFilter: richResponse,
        stats,
        jevDispatch: jev_dispatch,
        jevRequests: jev_requests,
        payload: {},
        statusLine: null,
      });
    } finally {
      console.error = originalError;
    }
    assert.deepEqual(outcome, { status: 'failed' });
    assert.equal(existsSync(path.absolute), false);
  });

  it('写入中断：中途写盘抛错时返回 failed，不留下半截或可误读的损坏样本', async () => {
    const logDir = join(root, 'half-file', 'logs');
    const config = configOf(logDir);
    const { stats, jev_dispatch, jev_requests } = await filterLlmContext(
      richResponse,
      { params: { query: QUERY }, intent: INTENT },
      config,
      { classify: keepAllClassify }
    );
    const writer = createSampleWriter(config, {
      writeFile: (tmpPath, data) => {
        writeFileSync(tmpPath, data.slice(0, 20), 'utf8');
        throw new Error('injected mid-write failure');
      },
    });
    const requestId = 'aaaaaaa2-2222-3333-4444-555555555555';
    const path = writer.allocatePath(requestId);

    const originalError = console.error;
    console.error = () => {};
    let outcome: { status: string };
    try {
      outcome = writer.save({
        requestId,
        path,
        originalParams: { query: QUERY },
        braveParams: { query: QUERY },
        filterParams: { query: QUERY },
        intent: INTENT,
        preFilter: richResponse,
        stats,
        jevDispatch: jev_dispatch,
        jevRequests: jev_requests,
        payload: {},
        statusLine: null,
      });
    } finally {
      console.error = originalError;
    }
    assert.deepEqual(outcome, { status: 'failed' });
    assert.equal(existsSync(path.absolute), false);
    const dateDir = join(logDir, 'samples', path.relative.split('/')[1]!);
    assert.deepEqual(readdirSync(dateDir), []);
  });
});
