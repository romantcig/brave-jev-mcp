/**
 * Jev 客户端纯函数与回放端到端（JEV-02/JEV-07/VERDICT-06/SAFE-01）。
 *
 * 回放口径（02-01）：两份重录 `.jev.json` 的 `results` 键（s0..s11）与管道
 * `collectJevCandidates` 的候选 id 同源——把录好的 results 变成 classify 依赖，
 * `filterLlmContext` 的"请求构造 → classify → 解析 → stats 记账"整条真实路径
 * 即可零网络复现。replayClassifier 内联在本文件（不建 src/testUtils/ 新文件），
 * 200 走生产同一条 `parseJevResponse` 路径。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseFilterConfig } from '../config.js';
import { filterLlmContext } from '../pipeline.js';
import type {
  BraveLlmContextResponse,
  ClassifyDeps,
  FilterConfig,
  FilterRequest,
} from '../types.js';
import { buildRequest, createJevClassifier, hasJevKey, JEVI_ENDPOINT } from './client.js';
import { parseJevResponse } from './client.js';
import { DEFAULT_JEV_MODEL, SOURCE_QUESTIONS, buildQuestions, buildState } from './questions.js';

const fixtureRoot = fileURLToPath(new URL('../../../fixtures/', import.meta.url));
const expectedRoot = join(fixtureRoot, 'expected');

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// ---------------------------------------------------------------------------
// 夹具装载与收窄（不 spread 解析结果，V5）
// ---------------------------------------------------------------------------

/** 录制夹具里单个来源的答案条目（只声明测试关心的字段）。 */
type RecordedAnswer = { type: string; noul?: number; score?: number };

type RecordedEntry = {
  url: string;
  http: number;
  response: {
    model: string;
    answers: Record<string, RecordedAnswer>;
    usage: { input_tokens: number };
  };
};

type JevRecording = {
  intent: string;
  results: Record<string, RecordedEntry>;
};

const loadJevRecording = (rel: string): JevRecording => {
  const parsed: unknown = JSON.parse(readFileSync(join(fixtureRoot, rel), 'utf8'));
  assert.ok(isRecord(parsed), `${rel} is not an object`);
  assert.ok(isRecord(parsed.results), `${rel} has no results table`);
  assert.equal(typeof parsed.intent, 'string', `${rel} has no intent`);
  return {
    intent: parsed.intent as string,
    results: parsed.results as Record<string, RecordedEntry>,
  };
};

/** 三形状 Brave 夹具加载器（与 pipeline.fixtures.test.ts / dev/dump_local_rules.ts 同逻辑）。 */
const loadBraveFixture = (rel: string): BraveLlmContextResponse => {
  const parsed: unknown = JSON.parse(readFileSync(join(fixtureRoot, rel), 'utf8'));
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

/** 期望文件头三件套（query / intent / request 与录制口径一致）。 */
const loadExpectedHeader = (
  rel: string
): { query: string; intent: string; request: Omit<FilterRequest, 'query'> } => {
  const parsed: unknown = JSON.parse(readFileSync(join(expectedRoot, rel), 'utf8'));
  assert.ok(isRecord(parsed), `${rel} is not an object`);
  assert.equal(typeof parsed.query, 'string', `${rel} has no query`);
  assert.equal(typeof parsed.intent, 'string', `${rel} has no intent`);
  assert.ok(isRecord(parsed.request), `${rel} has no request`);
  return {
    query: parsed.query as string,
    intent: parsed.intent as string,
    request: parsed.request as Omit<FilterRequest, 'query'>,
  };
};

/** 回放传输：按 state.source.id 取录制条目，200 走生产同一条 parseJevResponse 路径。 */
const replayClassifier =
  (recording: JevRecording): ClassifyDeps['classify'] =>
  async ({ state }) => {
    const entry = recording.results[state.source.id];
    if (!entry || entry.http !== 200) return { status: 'failed', kind: 'network' };
    const parsed = parseJevResponse(entry.http, JSON.stringify(entry.response));
    return parsed.ok
      ? {
          status: 'answered',
          model: parsed.model,
          answers: parsed.answers,
          input_tokens: parsed.input_tokens,
        }
      : // 录制声称 200 但解析不过：响应形状坏，按校验失败记账（契约里无 'shape' kind）
        { status: 'failed', kind: 'validation' };
  };

const defaultRecording = loadJevRecording('jev_release_default.jev.json');
const strictRecording = loadJevRecording('jev_release_strict.jev.json');

// ---------------------------------------------------------------------------
// buildRequest：钉版与形状
// ---------------------------------------------------------------------------

describe('buildRequest', () => {
  it('pins the model id and carries state and questions by reference', () => {
    const state = buildState('s0', 'https://a.example/', 'Title', ['one', 'two'], 'q', 'i');
    const questions = buildQuestions(2);
    const request = buildRequest(state, questions, DEFAULT_JEV_MODEL);

    assert.equal(request.model, 'jev-1.13.0');
    assert.equal(request.state, state);
    assert.equal(request.questions, questions);
  });

  it('carries ten source-level questions plus one per snippet, each prefixed with the global instruction', () => {
    const request = buildRequest(
      buildState('s1', 'https://b.example/', 'T', ['a', 'b', 'c'], 'q', 'i'),
      buildQuestions(3),
      DEFAULT_JEV_MODEL
    );

    assert.equal(Object.keys(request.questions).length, 13);
    for (const question of Object.values(request.questions)) {
      assert.match(
        question.instructions,
        /^Judge only the observable text of `source`\./,
        'every question must start with the global instruction'
      );
    }
  });
});

// ---------------------------------------------------------------------------
// parseJevResponse：真实夹具条目 + ok:false 分支
// ---------------------------------------------------------------------------

describe('parseJevResponse', () => {
  it('narrows every recorded entry of both fixtures with the actual model id and input_tokens', () => {
    for (const [name, recording] of Object.entries({
      default: defaultRecording,
      strict: strictRecording,
    })) {
      for (const [key, entry] of Object.entries(recording.results)) {
        const parsed = parseJevResponse(entry.http, JSON.stringify(entry.response));
        assert.equal(parsed.ok, true, `${name} ${key} must parse`);
        if (parsed.ok) {
          assert.equal(parsed.model, 'jev-1.13.0', `${name} ${key} model`);
          assert.equal(
            parsed.input_tokens,
            entry.response.usage.input_tokens,
            `${name} ${key} tokens`
          );
          assert.equal(
            Object.keys(parsed.answers).length,
            Object.keys(entry.response.answers).length,
            `${name} ${key} answer keys`
          );
        }
      }
    }
  });

  it('reads noul probability and continuous score from a real entry', () => {
    const entry = defaultRecording.results['s0'];
    assert.ok(entry, 's0 missing from the default recording');
    const parsed = parseJevResponse(entry.http, JSON.stringify(entry.response));
    assert.ok(parsed.ok);

    const noul = entry.response.answers['worth_keeping'];
    assert.ok(noul, 'worth_keeping answer missing');
    assert.deepEqual(parsed.answers['worth_keeping'], { kind: 'noul', probability: noul.noul });

    const score = entry.response.answers['snip0'];
    assert.ok(score, 'snip0 answer missing');
    assert.deepEqual(parsed.answers['snip0'], { kind: 'score', score: score.score });
  });

  it('returns kind http for non-200 statuses without parsing the body', () => {
    assert.deepEqual(parseJevResponse(500, 'server error'), {
      ok: false,
      kind: 'http',
      status: 500,
    });
  });

  it('returns kind shape for a 200 body that is not the recorded shape', () => {
    assert.deepEqual(parseJevResponse(200, 'not json'), { ok: false, kind: 'shape' });
    const missingModel = JSON.stringify({ answers: {}, usage: { input_tokens: 1 } });
    assert.deepEqual(parseJevResponse(200, missingModel), { ok: false, kind: 'shape' });
  });
});

// ---------------------------------------------------------------------------
// 解析边界（T-02-02-1 白名单收窄的六个具名用例）：畸形/恶意形状一律 ok:false
// 而非 spread 或抛错；白名单外的键忽略不进结果。
// ---------------------------------------------------------------------------

describe('parseJevResponse boundaries', () => {
  it('ignores answer keys outside the protocol whitelist', () => {
    const body = JSON.stringify({
      model: 'jev-1.13.0',
      answers: {
        is_off_topic: { type: 'noul', noul: 0.2 },
        junk_typed: { type: 'wat' },
        junk_value: 'text',
      },
      usage: { input_tokens: 5 },
    });

    const parsed = parseJevResponse(200, body);
    assert.ok(parsed.ok);
    assert.deepEqual(Object.keys(parsed.answers), ['is_off_topic']);
    assert.deepEqual(parsed.answers['is_off_topic'], { kind: 'noul', probability: 0.2 });
  });

  it('returns kind shape when a noul answer lacks its numeric value', () => {
    const body = JSON.stringify({
      model: 'jev-1.13.0',
      answers: { is_off_topic: { type: 'noul' } },
      usage: { input_tokens: 5 },
    });

    assert.deepEqual(parseJevResponse(200, body), { ok: false, kind: 'shape' });
  });

  it('returns kind shape when a score answer lacks its score', () => {
    const body = JSON.stringify({
      model: 'jev-1.13.0',
      answers: { snip0: { type: 'score', confidence: 0.5 } },
      usage: { input_tokens: 5 },
    });

    assert.deepEqual(parseJevResponse(200, body), { ok: false, kind: 'shape' });
  });

  it('returns kind shape when the body is not JSON', () => {
    assert.deepEqual(parseJevResponse(200, '<html>gateway timeout</html>'), {
      ok: false,
      kind: 'shape',
    });
  });

  it('returns kind http with the status for a 422 validation failure', () => {
    assert.deepEqual(parseJevResponse(422, '{"error":{"message":"state too large"}}'), {
      ok: false,
      kind: 'http',
      status: 422,
    });
  });

  it('returns kind shape when input_tokens is missing (JEV-02 contract)', () => {
    const body = JSON.stringify({
      model: 'jev-1.13.0',
      answers: {},
      usage: { output_tokens: 3 },
    });

    assert.deepEqual(parseJevResponse(200, body), { ok: false, kind: 'shape' });
  });
});

// ---------------------------------------------------------------------------
// 端到端回放：on 模式 + 注入回放 classify，整条真实路径零网络
// ---------------------------------------------------------------------------

for (const [name, recording] of Object.entries({
  jev_release_default: defaultRecording,
  jev_release_strict: strictRecording,
})) {
  const expected = loadExpectedHeader(`${name}.off.json`);
  // 录制口径守卫（02-01 的 probe 校验镜像）：intent 不一致即错录，回放对齐不成立
  assert.equal(recording.intent, expected.intent, `${name} recording intent mismatch`);

  const data = loadBraveFixture(`${name}.json`);
  const config: FilterConfig = { ...parseFilterConfig({}), mode: 'on' };
  const request = {
    params: { ...expected.request, query: expected.query },
    intent: expected.intent,
  };
  // 顶层 await：管道一次跑完，describe 闭包共享（node:test 等模块求值完成后开跑）
  const { result, stats } = await filterLlmContext(data, request, config, {
    classify: replayClassifier(recording),
  });
  const jev = stats.jev;
  assert.ok(jev, 'on mode with classify must populate stats.jev');
  const inputUrls = data.grounding.generic.map((item) => item.url);
  const outputUrls = result.grounding.generic.map((item) => item.url);

  describe(`end-to-end replay · ${name}`, () => {
    it('answers every candidate with one counted request each', () => {
      assert.equal(jev.status, 'ok');
      assert.equal(jev.n_requests, Object.keys(recording.results).length);
      assert.equal(jev.per_source.length, Object.keys(recording.results).length);
      for (const row of jev.per_source) {
        assert.equal(row.status, 'answered', `${row.src} must be answered`);
        assert.equal(row.model, 'jev-1.13.0');
        assert.equal(typeof row.latency_ms, 'number');
      }
    });

    it('aggregates input_tokens as the sum of recorded usage', () => {
      const expectedSum = Object.values(recording.results).reduce(
        (sum, entry) => sum + entry.response.usage.input_tokens,
        0
      );
      assert.equal(jev.input_tokens, expectedSum);
    });

    it('records the ten source-level probabilities per source exactly as recorded', () => {
      for (const row of jev.per_source) {
        const entry = recording.results[row.src];
        assert.ok(entry, `recording missing ${row.src}`);
        for (const key of Object.keys(SOURCE_QUESTIONS)) {
          const recorded = entry.response.answers[key];
          assert.ok(recorded, `${row.src} missing answer ${key}`);
          assert.equal(row.answers?.[key], recorded.noul, `${row.src} ${key}`);
        }
      }
    });

    it('records snippet scores in snip0..snipN order aligned with the recorded state', () => {
      for (const row of jev.per_source) {
        const entry = recording.results[row.src];
        assert.ok(entry, `recording missing ${row.src}`);
        const snipKeys = Object.keys(entry.response.answers)
          .filter((key) => /^snip\d+$/.test(key))
          .sort((a, b) => Number(a.slice(4)) - Number(b.slice(4)));
        assert.equal(row.snippet_scores?.length, snipKeys.length, `${row.src} score count`);
        snipKeys.forEach((key, i) => {
          const recorded = entry.response.answers[key];
          assert.ok(recorded, `${row.src} missing answer ${key}`);
          assert.equal(row.snippet_scores?.[i], recorded.score, `${row.src} ${key}`);
        });
      }
    });

    it('keeps surviving sources as a subsequence of the Brave order', () => {
      let cursor = 0;
      for (const url of outputUrls) {
        const found = inputUrls.indexOf(url, cursor);
        assert.ok(found >= cursor, `output url ${url} breaks Brave order`);
        cursor = found + 1;
      }
    });
  });
}

// ---------------------------------------------------------------------------
// VERDICT-06：空输入 + classify 注入 → 空输出且零请求（不变式在 Jev 路径激活时成立）
// ---------------------------------------------------------------------------

describe('empty response with classify injected (VERDICT-06)', () => {
  it('returns empty output and makes zero requests without fabricating sources', async () => {
    const recording = defaultRecording;
    const config: FilterConfig = { ...parseFilterConfig({}), mode: 'on' };
    const { result, stats } = await filterLlmContext(
      { grounding: { generic: [], map: [] }, sources: {} },
      { params: { query: 'q' }, intent: 'i' },
      config,
      { classify: replayClassifier(recording) }
    );

    assert.deepEqual(result, { grounding: { generic: [], map: [] }, sources: {} });
    assert.equal(stats.jev?.n_requests, 0);
    assert.deepEqual(stats.jev?.per_source, []);
  });
});

// ---------------------------------------------------------------------------
// 传输兜底（02-05 Task 1）：globalThis.fetch 桩（装卸纪律照 mcpTestHarness 26-46）
// ——零网络验证请求形状、状态码映射、key 语义与进程级并发闸。
// ---------------------------------------------------------------------------

/** createJevClassifier 的入参 config（02-02 config 解析的同形状字面量）。 */
const jevConfig = {
  model: DEFAULT_JEV_MODEL,
  backend: 'typesafe' as const,
  timeoutMs: 15000,
  concurrency: 12,
};

/** 轮询直到条件成立（并发闸用例的挂起计数同步）；超时失败。 */
const waitFor = async (condition: () => boolean, timeoutMs = 2000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(condition(), 'waitFor condition not met before deadline');
};

/** 200 响应体：default 夹具 s0 的真实形状（含十来源级题答案与 snip0..N）。 */
const okResponseOf = (entry: { response: unknown }): Response =>
  new Response(JSON.stringify(entry.response), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

describe('hasJevKey', () => {
  it('accepts either probe-script variable name with a non-blank value (A9 order names)', () => {
    assert.equal(hasJevKey({}), false);
    assert.equal(hasJevKey({ jev_API_KEY: '' }), false);
    assert.equal(hasJevKey({ jev_API_KEY: '   ' }), false);
    assert.equal(hasJevKey({ TYPESAFE_API_KEY: '' }), false);
    assert.equal(hasJevKey({ jev_API_KEY: 'k' }), true);
    assert.equal(hasJevKey({ TYPESAFE_API_KEY: 'k' }), true);
    assert.equal(hasJevKey({ jev_API_KEY: undefined, TYPESAFE_API_KEY: 'k' }), true);
  });
});

describe('createJevClassifier', () => {
  const state = buildState('s0', 'https://a.example/', 'Title', ['one', 'two'], 'q', 'i');

  it('sends the pinned request shape to the single endpoint with the bearer header', async () => {
    const entry = defaultRecording.results['s0'];
    let capturedUrl = '';
    let capturedInit: RequestInit | undefined;
    const saved = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = String(input instanceof Request ? input.url : input);
      capturedInit = init;
      return okResponseOf(entry);
    }) as typeof fetch;

    try {
      const classifier = createJevClassifier(jevConfig, { jev_API_KEY: 'probe-order-key' });
      const questions = buildQuestions(2);
      const outcome = await classifier.classify({ state, questions });

      assert.ok(outcome.status === 'answered', JSON.stringify(outcome));
      assert.equal(outcome.model, 'jev-1.13.0');
      assert.equal(outcome.input_tokens, entry.response.usage.input_tokens);
      assert.equal(outcome.answers['worth_keeping']?.kind, 'noul');

      assert.equal(capturedUrl, JEVI_ENDPOINT);
      assert.equal(capturedInit?.method, 'POST');
      const headers = capturedInit?.headers as Record<string, string>;
      assert.equal(headers['Authorization'], 'Bearer probe-order-key');
      assert.equal(headers['Content-Type'], 'application/json');
      assert.ok(capturedInit?.signal instanceof AbortSignal, 'must pass an abort signal');
      const body = JSON.parse(String(capturedInit?.body)) as {
        model: string;
        state: unknown;
        questions: Record<string, unknown>;
      };
      assert.equal(body.model, DEFAULT_JEV_MODEL);
      assert.deepEqual(body.state, state);
      assert.equal(Object.keys(body.questions).length, 12);
    } finally {
      globalThis.fetch = saved;
    }
  });

  it('maps 401 to auth failure with exactly one fetch attempt', async () => {
    let fetchCount = 0;
    const saved = globalThis.fetch;
    globalThis.fetch = (async () => {
      fetchCount += 1;
      return new Response('unauthorized', { status: 401 });
    }) as typeof fetch;

    try {
      const classifier = createJevClassifier(jevConfig, { jev_API_KEY: 'k' });
      const outcome = await classifier.classify({
        state,
        questions: buildQuestions(0),
      });

      assert.deepEqual(outcome, { status: 'failed', kind: 'auth', detail: '401 unauthorized' });
      assert.equal(fetchCount, 1);
    } finally {
      globalThis.fetch = saved;
    }
  });

  it('maps an AbortError throw to timeout', async () => {
    const saved = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new DOMException('This operation was aborted', 'AbortError');
    }) as typeof fetch;

    try {
      const classifier = createJevClassifier(jevConfig, { jev_API_KEY: 'k' });
      const outcome = await classifier.classify({
        state,
        questions: buildQuestions(0),
      });

      assert.deepEqual(outcome, {
        status: 'failed',
        kind: 'timeout',
        detail: 'This operation was aborted',
      });
    } finally {
      globalThis.fetch = saved;
    }
  });

  it('maps a generic throw to network', async () => {
    const saved = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error('fetch failed');
    }) as typeof fetch;

    try {
      const classifier = createJevClassifier(jevConfig, { jev_API_KEY: 'k' });
      const outcome = await classifier.classify({
        state,
        questions: buildQuestions(0),
      });

      assert.deepEqual(outcome, { status: 'failed', kind: 'network', detail: 'fetch failed' });
    } finally {
      globalThis.fetch = saved;
    }
  });

  it('never leaks the key or auth header through failure details (T-02-05-1)', async () => {
    let capturedAuth = '';
    const saved = globalThis.fetch;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedAuth = (init?.headers as Record<string, string>)['Authorization'];
      return new Response('rate limited', { status: 429 });
    }) as typeof fetch;

    try {
      const key = 'sk-super-secret-test-key-42';
      const classifier = createJevClassifier(jevConfig, { jev_API_KEY: key });
      const outcome = await classifier.classify({
        state,
        questions: buildQuestions(0),
      });

      assert.ok(outcome.status === 'failed', JSON.stringify(outcome));
      assert.equal(outcome.kind, 'rate_limited');
      assert.ok(outcome.detail !== undefined, 'HTTP failure must carry a detail');
      // 头只在请求构造处拼接，值正确
      assert.equal(capturedAuth, `Bearer ${key}`);
      // detail 无 key 值、无鉴权头关键字
      assert.equal(outcome.detail.includes(key), false, `detail leaked key: ${outcome.detail}`);
      assert.match(outcome.detail, /^429 /);
      assert.equal(/bearer/i.test(outcome.detail), false);
      assert.equal(/authorization/i.test(outcome.detail), false);
    } finally {
      globalThis.fetch = saved;
    }
  });

  it('reads the key in probe-script order: jev_API_KEY first, then TYPESAFE_API_KEY', async () => {
    const authOf = async (env: Record<string, string | undefined>): Promise<string> => {
      let captured = '';
      const saved = globalThis.fetch;
      globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        captured = (init?.headers as Record<string, string>)['Authorization'];
        return okResponseOf(defaultRecording.results['s0']);
      }) as typeof fetch;
      try {
        const classifier = createJevClassifier(jevConfig, env);
        await classifier.classify({ state, questions: buildQuestions(0) });
        return captured;
      } finally {
        globalThis.fetch = saved;
      }
    };

    assert.equal(
      await authOf({ jev_API_KEY: 'primary', TYPESAFE_API_KEY: 'fallback' }),
      'Bearer primary'
    );
    assert.equal(await authOf({ TYPESAFE_API_KEY: 'fallback' }), 'Bearer fallback');
  });

  it('caps concurrent fetches at the configured limit and queues the rest (JEV-04)', async () => {
    const entry = defaultRecording.results['s0'];
    const responseBody = JSON.stringify(entry.response);
    let inflight = 0;
    let peak = 0;
    const pending: Array<() => void> = [];
    const saved = globalThis.fetch;
    globalThis.fetch = (async () => {
      inflight += 1;
      peak = Math.max(peak, inflight);
      await new Promise<void>((resolve) => pending.push(resolve));
      inflight -= 1;
      return new Response(responseBody, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    try {
      const classifier = createJevClassifier(jevConfig, { jev_API_KEY: 'k' });
      const questions = buildQuestions(1);
      const request = { state, questions };

      // 15 个并发提交：12 个立即进 fetch，3 个在闭包信号量上排队
      const promises = Array.from({ length: 15 }, () => classifier.classify(request));
      await waitFor(() => pending.length >= 12);
      assert.ok(peak <= 12, `peak ${peak} must not exceed the limit 12`);
      assert.equal(pending.length, 12, '12 admitted, 3 queued');

      // 释放首批：名额释放后排队的 3 个补发
      while (pending.length > 0) pending.shift()!();
      await waitFor(() => pending.length >= 3);
      assert.ok(peak <= 12, `peak ${peak} must still not exceed the limit 12`);

      while (pending.length > 0) pending.shift()!();
      const outcomes = await Promise.all(promises);
      assert.equal(outcomes.length, 15);
      for (const outcome of outcomes) {
        assert.equal(outcome.status, 'answered', JSON.stringify(outcome));
      }
      assert.ok(peak <= 12, `final peak ${peak} must not exceed the limit 12`);
      assert.ok(peak >= 1);
    } finally {
      globalThis.fetch = saved;
    }
  });
});

// ---------------------------------------------------------------------------
// 传输兜底·重试（02-05 Task 2，SAFE-03）：白名单只有 429 / 529 / fetch 网络异常
// （3 次尝试、退避 500ms 起倍率 2 封顶 4s）；401 / 422 绝不重试（Pitfall 7）。
// 时钟注入 hooks：sleep 记录时长做下限断言，不在测试里真等。
// ---------------------------------------------------------------------------

describe('createJevClassifier retry (SAFE-03)', () => {
  const state = buildState('s0', 'https://a.example/', 'Title', ['one'], 'q', 'i');
  const request = { state, questions: buildQuestions(1) };

  /** 桩：按脚本逐次返回（脚本耗尽后重复末项）；计次。 */
  const scriptedFetch = (responses: Array<() => Response | Promise<Response>>): typeof fetch => {
    let call = 0;
    return (async () => {
      const step = responses[Math.min(call, responses.length - 1)];
      call += 1;
      return await step();
    }) as typeof fetch;
  };

  it('retries 429 twice and answers on the third attempt', async () => {
    let fetchCount = 0;
    const saved = globalThis.fetch;
    globalThis.fetch = scriptedFetch([
      () => {
        fetchCount += 1;
        return new Response('rate limited', { status: 429 });
      },
      () => {
        fetchCount += 1;
        return new Response('rate limited', { status: 429 });
      },
      () => {
        fetchCount += 1;
        return okResponseOf(defaultRecording.results['s0']);
      },
    ]);

    try {
      const classifier = createJevClassifier(jevConfig, { jev_API_KEY: 'k' });
      const outcome = await classifier.classify(request);

      assert.ok(outcome.status === 'answered', JSON.stringify(outcome));
      assert.equal(fetchCount, 3);
    } finally {
      globalThis.fetch = saved;
    }
  });

  it('exhausts three attempts against persistent 429 and fails with rate_limited', async () => {
    let fetchCount = 0;
    const saved = globalThis.fetch;
    globalThis.fetch = scriptedFetch([
      () => {
        fetchCount += 1;
        return new Response('rate limited', { status: 429 });
      },
    ]);

    try {
      const classifier = createJevClassifier(jevConfig, { jev_API_KEY: 'k' });
      const outcome = await classifier.classify(request);

      assert.ok(outcome.status === 'failed', JSON.stringify(outcome));
      assert.equal(outcome.kind, 'rate_limited');
      assert.equal(fetchCount, 3);
    } finally {
      globalThis.fetch = saved;
    }
  });

  it('treats 529 like 429: retries three attempts then fails with rate_limited', async () => {
    let fetchCount = 0;
    const saved = globalThis.fetch;
    globalThis.fetch = scriptedFetch([
      () => {
        fetchCount += 1;
        return new Response('overloaded', { status: 529 });
      },
    ]);

    try {
      const classifier = createJevClassifier(jevConfig, { jev_API_KEY: 'k' });
      const outcome = await classifier.classify(request);

      assert.ok(outcome.status === 'failed', JSON.stringify(outcome));
      assert.equal(outcome.kind, 'rate_limited');
      assert.equal(fetchCount, 3);
    } finally {
      globalThis.fetch = saved;
    }
  });

  it('retries network throws and answers on the third attempt', async () => {
    let fetchCount = 0;
    const saved = globalThis.fetch;
    globalThis.fetch = scriptedFetch([
      () => {
        fetchCount += 1;
        throw new Error('fetch failed');
      },
      () => {
        fetchCount += 1;
        throw new Error('fetch failed');
      },
      () => {
        fetchCount += 1;
        return okResponseOf(defaultRecording.results['s0']);
      },
    ]);

    try {
      const classifier = createJevClassifier(jevConfig, { jev_API_KEY: 'k' });
      const outcome = await classifier.classify(request);

      assert.ok(outcome.status === 'answered', JSON.stringify(outcome));
      assert.equal(fetchCount, 3);
    } finally {
      globalThis.fetch = saved;
    }
  });

  it('never retries 422 — a validation failure would just 422 again (Pitfall 7)', async () => {
    let fetchCount = 0;
    const saved = globalThis.fetch;
    globalThis.fetch = scriptedFetch([
      () => {
        fetchCount += 1;
        return new Response('state too large', { status: 422 });
      },
    ]);

    try {
      const classifier = createJevClassifier(jevConfig, { jev_API_KEY: 'k' });
      const outcome = await classifier.classify(request);

      assert.deepEqual(outcome, {
        status: 'failed',
        kind: 'validation',
        detail: '422 state too large',
      });
      assert.equal(fetchCount, 1);
    } finally {
      globalThis.fetch = saved;
    }
  });

  it('backs off at least 500ms after the first failure and 1000ms after the second', async () => {
    const saved = globalThis.fetch;
    globalThis.fetch = scriptedFetch([
      () => new Response('rate limited', { status: 429 }),
    ]);
    const sleeps: number[] = [];

    try {
      const classifier = createJevClassifier(jevConfig, { jev_API_KEY: 'k' }, {
        sleep: async (ms: number) => {
          sleeps.push(ms);
        },
      });
      const outcome = await classifier.classify(request);

      assert.ok(outcome.status === 'failed', JSON.stringify(outcome));
      assert.equal(outcome.kind, 'rate_limited');
      assert.equal(sleeps.length, 2, `recorded sleeps: ${JSON.stringify(sleeps)}`);
      assert.ok(sleeps[0] >= 500, `first backoff ${sleeps[0]} must be >= 500ms`);
      assert.ok(sleeps[1] >= 1000, `second backoff ${sleeps[1]} must be >= 1000ms`);
    } finally {
      globalThis.fetch = saved;
    }
  });
});

// ---------------------------------------------------------------------------
// 传输兜底·超限阶梯（02-05 Task 2，JEV-05）：发送前 estimateTokens 加 15% 余量对
// 两条限额做保护；超限按砍尾片段 → 去片段级题 → 不问 Jev 阶梯降级，级别名记
// answered outcome 的 ladder。估算全部走 ../tokens.js 的 estimateTokens。
// ---------------------------------------------------------------------------

describe('createJevClassifier oversize ladder (JEV-05)', () => {
  it('cuts tail snippets and their snip questions when the 32k limit is exceeded (cut_tail)', async () => {
    // 尾片段 34000 个词 ≈ 34000 tokens：(estState + max estQ) × 1.15 远超 32000，
    // 砍掉尾部大片段后余下 4 个小片段满足限额
    const big = 'word '.repeat(34000);
    const bigState = buildState('s0', 'https://a.example/', 'Title', [
      'small one.',
      'small two.',
      'small three.',
      'small four.',
      big,
    ], 'q', 'i');
    let capturedBody:
      | { state: { source: { snippets: string[] } }; questions: Record<string, unknown> }
      | undefined;
    const saved = globalThis.fetch;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body));
      return okResponseOf(defaultRecording.results['s0']);
    }) as typeof fetch;

    try {
      const classifier = createJevClassifier(jevConfig, { jev_API_KEY: 'k' });
      const outcome = await classifier.classify({
        state: bigState,
        questions: buildQuestions(5),
      });

      assert.ok(outcome.status === 'answered', JSON.stringify(outcome));
      assert.equal(outcome.ladder, 'cut_tail');
      assert.ok(capturedBody, 'fetch must have been called');
      assert.equal(
        capturedBody.state.source.snippets.length,
        4,
        'the oversized tail snippet must be cut'
      );
      assert.equal(Object.hasOwn(capturedBody.questions, 'snip4'), false);
      assert.ok(Object.hasOwn(capturedBody.questions, 'snip3'));
      assert.ok(Object.hasOwn(capturedBody.questions, 'is_off_topic'));
      assert.deepEqual(bigState.source.snippets.length, 5, 'input state must not be mutated');
    } finally {
      globalThis.fetch = saved;
    }
  });

  it('drops all snippet questions when the 64k limit is exceeded (source_only_questions)', async () => {
    // 500 个小片段：单题很小（32k 不超），片段题总和 × 1.15 超 64000 → 去掉全部
    // snip 题（来源级十题保留、state 片段保留）
    const snippets = Array.from({ length: 500 }, (_, i) => `small snippet ${i}.`);
    const wideState = buildState('s0', 'https://a.example/', 'Title', snippets, 'q', 'i');
    let capturedBody:
      | { state: { source: { snippets: string[] } }; questions: Record<string, unknown> }
      | undefined;
    const saved = globalThis.fetch;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body));
      return okResponseOf(defaultRecording.results['s0']);
    }) as typeof fetch;

    try {
      const classifier = createJevClassifier(jevConfig, { jev_API_KEY: 'k' });
      const outcome = await classifier.classify({
        state: wideState,
        questions: buildQuestions(500),
      });

      assert.ok(outcome.status === 'answered', JSON.stringify(outcome));
      assert.equal(outcome.ladder, 'source_only_questions');
      assert.ok(capturedBody, 'fetch must have been called');
      assert.equal(
        Object.keys(capturedBody.questions).length,
        10,
        'only the ten source-level questions remain'
      );
      assert.equal(
        Object.hasOwn(capturedBody.questions, 'snip0'),
        false,
        'all snip questions must be dropped'
      );
      assert.equal(capturedBody.state.source.snippets.length, 500, 'state snippets are kept');
    } finally {
      globalThis.fetch = saved;
    }
  });

  it('skips the source entirely when even source-level questions exceed 32k (too_large)', async () => {
    // title 200000 个连续字母 ≈ 33334 tokens：砍光片段后 state 本身仍超 32k →
    // 不发请求，failed too_large
    const hugeTitle = 't'.repeat(200000);
    const hugeState = buildState('s0', 'https://a.example/', hugeTitle, ['x'], 'q', 'i');
    let fetchCount = 0;
    const saved = globalThis.fetch;
    globalThis.fetch = (async () => {
      fetchCount += 1;
      return okResponseOf(defaultRecording.results['s0']);
    }) as typeof fetch;

    try {
      const classifier = createJevClassifier(jevConfig, { jev_API_KEY: 'k' });
      const outcome = await classifier.classify({
        state: hugeState,
        questions: buildQuestions(1),
      });

      assert.ok(outcome.status === 'failed', JSON.stringify(outcome));
      assert.equal(outcome.kind, 'too_large');
      assert.ok(outcome.detail !== undefined);
      assert.equal(fetchCount, 0, 'an unshrinkable state must never hit the wire');
    } finally {
      globalThis.fetch = saved;
    }
  });
});
