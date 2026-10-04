/**
 * 客户端解析、传输与管道回放测试，全部使用本地回答或 fetch 桩。
 * 录制按候选 ID 配对，响应解析复用生产实现；历史回答只验证规则行为。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseFilterConfigObject } from '../config.js';
import { filterLlmContext } from '../pipeline.js';
import type {
  BraveLlmContextResponse,
  ClassifyDeps,
  FilterConfig,
  FilterRequest,
  JevQuestion,
  JevState,
} from '../types.js';
import { buildRequest, createJevClassifier, hasJevKey, JEVI_ENDPOINT } from './client.js';
import { parseJevResponse } from './client.js';
import { DEFAULT_JEV_MODEL, SOURCE_QUESTIONS } from './questions.js';
import { buildContextRequest } from './context.js';

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

// ---------------------------------------------------------------------------
// 全量共享请求辅助（all-only）：全部 classify 桩统一使用 sources[] 形状
// ---------------------------------------------------------------------------

/** 构造最小全量 state：n 个来源各 m 条片段，日期恒在（无元数据为 null）。 */
const makeAllState = (sourceCount = 1, snippetsPerSource = 1): JevState => ({
  query: 'q',
  intent: 'i',
  sources: Array.from({ length: sourceCount }, (_, index) => ({
    id: `s${index}`,
    url: `https://s${index}.example/`,
    title: `Title ${index}`,
    snippets: Array.from({ length: snippetsPerSource }, (_, i) => `snippet ${i} text`),
    brave_page_date: null,
  })),
});

/** 与 state 配套的最小题目表：每来源四道来源级题 + snip0..snip{m-1}（命名空间键）。 */
const makeQuestions = (state: JevState, snippetsPerSource = 1): Record<string, JevQuestion> =>
  Object.fromEntries(
    state.sources.flatMap((source) => [
      ...Object.keys(SOURCE_QUESTIONS).map(
        (key) =>
          [`${source.id}__${key}`, { type: 'noul', instructions: 'x' } as JevQuestion] as const
      ),
      ...Array.from(
        { length: snippetsPerSource },
        (_, i) =>
          [`${source.id}__snip${i}`, { type: 'score', instructions: 'x' } as JevQuestion] as const
      ),
    ])
  );

const sharedState = makeAllState(1, 1);
const sharedQuestions = makeQuestions(sharedState, 1);
const sharedRequest = { state: sharedState, questions: sharedQuestions };

/**
 * 固定回答注入（all-only 合成桩）：把逐来源录制答案按 `${id}__${localKey}` 命名空间注入
 * 全量共享请求（只回答实发题集里存在的键），合成单个 200 响应走生产同一条
 * parseJevResponse 路径。没有 fetch，不带 dispatch，计零实发；合成用量为 0、
 * usage_complete=false，旧 single 录制用量不作为当前共享请求的用量。
 */
const replayClassifier =
  (recording: JevRecording): ClassifyDeps['classify'] =>
  async ({ state, questions }) => {
    const answers: Record<string, unknown> = {};
    for (const source of state.sources) {
      const entry = recording.results[source.id];
      if (!entry || entry.http !== 200) return { status: 'failed', kind: 'network' };
      for (const [localKey, value] of Object.entries(entry.response.answers)) {
        const globalKey = `${source.id}__${localKey}`;
        if (questions[globalKey] !== undefined) answers[globalKey] = value;
      }
    }
    const parsed = parseJevResponse(
      200,
      JSON.stringify({ model: 'jev-1.13.0', answers, usage: { input_tokens: 0 } })
    );
    return parsed.ok
      ? {
          status: 'answered',
          model: parsed.model,
          answers: parsed.answers,
          input_tokens: parsed.input_tokens,
          usage_complete: false,
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
    // 题目模板细节由 questions.test.ts 锁定；这里验证请求体组装与钉版
    const { state, questions } = buildContextRequest(
      [
        {
          id: 's0',
          url: 'https://a.example/',
          title: 'Title',
          snippets: [
            { key: '0', text: 'one' },
            { key: '1', text: 'two' },
          ],
          bravePageDate: null,
        },
      ],
      'q',
      'i'
    );
    const request = buildRequest(state, questions, DEFAULT_JEV_MODEL);

    assert.equal(request.model, 'jev-1.13.0');
    assert.equal(request.state, state);
    assert.equal(request.questions, questions);
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

// 响应解析边界：畸形顶层返回失败，未知键忽略。

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

  it('isolates a noul answer that lacks its numeric value without failing the response', () => {
    // 逐题隔离（all-only 唯一语义）：坏的单题不拖垮同一响应里其他来源的有效答案
    const body = JSON.stringify({
      model: 'jev-1.13.0',
      answers: {
        s0__is_off_topic: { type: 'noul' },
        s1__is_listing: { type: 'noul', noul: 0.3 },
      },
      usage: { input_tokens: 5 },
    });

    const parsed = parseJevResponse(200, body);
    assert.ok(parsed.ok);
    assert.deepEqual(Object.keys(parsed.answers), ['s1__is_listing']);
    assert.deepEqual(parsed.answers['s1__is_listing'], { kind: 'noul', probability: 0.3 });
  });

  it('isolates a score answer that lacks its score without failing the response', () => {
    const body = JSON.stringify({
      model: 'jev-1.13.0',
      answers: {
        s0__snip0: { type: 'score', confidence: 0.5 },
        s0__snip1: { type: 'score', score: 1.5 },
      },
      usage: { input_tokens: 5 },
    });

    const parsed = parseJevResponse(200, body);
    assert.ok(parsed.ok);
    assert.deepEqual(Object.keys(parsed.answers), ['s0__snip1']);
    assert.deepEqual(parsed.answers['s0__snip1'], { kind: 'score', score: 1.5 });
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

  it('returns kind http with the status for a 413 — no local too_large branch (all-only §3.3)', () => {
    assert.deepEqual(parseJevResponse(413, '{"error":{"message":"payload too large"}}'), {
      ok: false,
      kind: 'http',
      status: 413,
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
  // 录制与期望的 intent 必须一致，否则不能用于此回放。
  assert.equal(recording.intent, expected.intent, `${name} recording intent mismatch`);

  const data = loadBraveFixture(`${name}.json`);
  const config: FilterConfig = { ...parseFilterConfigObject({}), mode: 'on' };
  const request = {
    params: { ...expected.request, query: expected.query },
    intent: expected.intent,
  };
  // 顶层 await：管道一次跑完，describe 闭包共享（node:test 等模块求值完成后开跑）
  const replay = replayClassifier(recording);
  let classifyCalls = 0;
  const { result, stats, jev_requests } = await filterLlmContext(data, request, config, {
    classify: async (input) => {
      classifyCalls += 1;
      return replay(input);
    },
  });
  const jev = stats.jev;
  assert.ok(jev, 'on mode with classify must populate stats.jev');
  const inputUrls = data.grounding.generic.map((item) => item.url);
  const outputUrls = result.grounding.generic.map((item) => item.url);

  describe(`end-to-end replay · ${name}`, () => {
    it('一次共享回答注入覆盖全部候选，零实发且不伪造载荷', () => {
      assert.equal(jev.status, 'ok');
      assert.equal(classifyCalls, 1);
      assert.equal(jev.n_requests, 0);
      assert.equal(jev.n_http_attempts, 0);
      assert.equal(jev_requests.length, 1);
      assert.equal(jev_requests[0].answered, true);
      assert.equal(jev_requests[0].dispatched, false);
      assert.equal(jev_requests[0].state, null);
      assert.equal(jev_requests[0].questions, null);
      assert.equal(jev.per_source.length, Object.keys(recording.results).length);
      for (const row of jev.per_source) {
        assert.equal(row.status, 'answered', `${row.src} must be answered`);
        assert.equal(row.model, 'jev-1.13.0');
        assert.equal(row.request_id, 'j1');
        // 请求级维度不逐来源复制：耗时在请求记录上（§6.1）
        assert.equal(row.latency_ms, undefined);
      }
      assert.equal(typeof jev.requests[0]?.latency_ms, 'number');
    });

    it('合成回答计零用量，不把旧逐来源用量合计成共享请求用量', () => {
      assert.equal(jev.input_tokens, 0);
      assert.equal(jev_requests[0].input_tokens, 0);
      assert.equal(jev_requests[0].usage_complete, false);
    });

    it('records the current source-level probabilities per source exactly as recorded', () => {
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

// 空输入即使注入分类器也应零请求。

describe('empty response with classify injected (VERDICT-06)', () => {
  it('returns empty output and makes zero requests without fabricating sources', async () => {
    const recording = defaultRecording;
    const config: FilterConfig = { ...parseFilterConfigObject({}), mode: 'on' };
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

// fetch 桩验证真实客户端传输，测试后恢复全局 fetch。

/** 客户端测试配置。 */
const jevConfig = {
  model: DEFAULT_JEV_MODEL,
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
  it('accepts only the official TYPESAFE_API_KEY with a non-blank value', () => {
    assert.equal(hasJevKey({}), false);
    assert.equal(hasJevKey({ TYPESAFE_API_KEY: '' }), false);
    assert.equal(hasJevKey({ TYPESAFE_API_KEY: '   ' }), false);
    assert.equal(hasJevKey({ TYPESAFE_API_KEY: 'k' }), true);
    // 其余名字（含大小写变体）一律不识别——当前识别的 key 只有 TYPESAFE_API_KEY；
    // 普通对象大小写敏感，与 Linux / macOS 环境一致
    assert.equal(hasJevKey({ jev_API_KEY: 'k' }), false);
    assert.equal(hasJevKey({ JEV_API_KEY: 'k' }), false);
  });
});

describe('createJevClassifier', () => {
  const state = makeAllState(1, 2);

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
      const classifier = createJevClassifier(jevConfig, { TYPESAFE_API_KEY: 'official-key' });
      const questions = makeQuestions(state, 2);
      const outcome = await classifier.classify({ state, questions });

      assert.ok(outcome.status === 'answered', JSON.stringify(outcome));
      assert.equal(outcome.model, 'jev-1.13.0');
      assert.equal(outcome.input_tokens, entry.response.usage.input_tokens);
      assert.equal(outcome.answers['worth_keeping']?.kind, 'noul');

      assert.equal(capturedUrl, JEVI_ENDPOINT);
      assert.equal(capturedInit?.method, 'POST');
      const headers = capturedInit?.headers as Record<string, string>;
      assert.equal(headers['Authorization'], 'Bearer official-key');
      assert.equal(headers['Content-Type'], 'application/json');
      assert.ok(capturedInit?.signal instanceof AbortSignal, 'must pass an abort signal');
      const body = JSON.parse(String(capturedInit?.body)) as {
        model: string;
        state: unknown;
        questions: Record<string, unknown>;
      };
      assert.equal(body.model, DEFAULT_JEV_MODEL);
      assert.deepEqual(body.state, state);
      assert.equal(Object.keys(body.questions).length, 6);
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
      const classifier = createJevClassifier(jevConfig, { TYPESAFE_API_KEY: 'k' });
      const outcome = await classifier.classify(sharedRequest);

      // 401 也是已派发请求，失败结果应保留输入载荷。
      assert.deepEqual(outcome, {
        status: 'failed',
        kind: 'auth',
        detail: '401 unauthorized',
        dispatch: sharedRequest,
        http_attempts: 1,
        usage_complete: false,
        http_status: 401,
      });
      assert.equal(fetchCount, 1);
    } finally {
      globalThis.fetch = saved;
    }
  });

  it('maps an AbortError throw to timeout without retrying', async () => {
    let fetchCount = 0;
    const saved = globalThis.fetch;
    globalThis.fetch = (async () => {
      fetchCount += 1;
      throw new DOMException('This operation was aborted', 'AbortError');
    }) as typeof fetch;

    try {
      // 超时立即返回；注入空 sleep 避免真实等待。
      const classifier = createJevClassifier(
        jevConfig,
        { TYPESAFE_API_KEY: 'k' },
        {
          sleep: async () => {},
        }
      );
      const outcome = await classifier.classify(sharedRequest);

      // 超时仍保留已派发的输入证据。
      assert.deepEqual(outcome, {
        status: 'failed',
        kind: 'timeout',
        detail: 'This operation was aborted',
        dispatch: sharedRequest,
        http_attempts: 1,
        usage_complete: false,
      });
      assert.equal(fetchCount, 1, 'a timeout must not be retried');
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
      // 持续网络异常应耗尽重试次数，空 sleep 避免真实退避。
      const classifier = createJevClassifier(
        jevConfig,
        { TYPESAFE_API_KEY: 'k' },
        {
          sleep: async () => {},
        }
      );
      const outcome = await classifier.classify(sharedRequest);

      assert.deepEqual(outcome, {
        status: 'failed',
        kind: 'network',
        detail: 'fetch failed',
        dispatch: sharedRequest,
        http_attempts: 3,
        usage_complete: false,
      });
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
      // 恒 429 → 耗尽重试；注入 no-op sleep 不真等
      const classifier = createJevClassifier(
        jevConfig,
        { TYPESAFE_API_KEY: key },
        {
          sleep: async () => {},
        }
      );
      const outcome = await classifier.classify(sharedRequest);

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
      const classifier = createJevClassifier(jevConfig, { TYPESAFE_API_KEY: 'k' });
      const request = sharedRequest;

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

// 重试策略与等待时长；用 hooks 注入时间、睡眠和随机数，避免真实等待。

describe('createJevClassifier retry (SAFE-03)', () => {
  const request = sharedRequest;

  /** 桩：按脚本逐次返回（脚本耗尽后重复末项）；计次。 */
  const scriptedFetch = (responses: Array<() => Response | Promise<Response>>): typeof fetch => {
    let call = 0;
    return (async () => {
      const step = responses[Math.min(call, responses.length - 1)];
      call += 1;
      return await step();
    }) as typeof fetch;
  };

  /** 恒定状态码的桩 + 计次。 */
  const statusFetch = (status: number, body = 'error', headers?: Record<string, string>) => {
    const counter = { calls: 0 };
    const fetchImpl = (async () => {
      counter.calls += 1;
      return new Response(body, { status, headers });
    }) as typeof fetch;
    return { fetchImpl, counter };
  };

  /** 收集退避时长的 hooks（random 固定）。 */
  const sleepRecorder = (random = 0) => {
    const sleeps: number[] = [];
    return {
      sleeps,
      hooks: {
        sleep: async (ms: number) => {
          sleeps.push(ms);
        },
        random: () => random,
      },
    };
  };

  const instantHooks = { sleep: async () => {}, random: () => 0 };

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
      const classifier = createJevClassifier(jevConfig, { TYPESAFE_API_KEY: 'k' }, instantHooks);
      const outcome = await classifier.classify(request);

      assert.ok(outcome.status === 'answered', JSON.stringify(outcome));
      assert.equal(fetchCount, 3);
    } finally {
      globalThis.fetch = saved;
    }
  });

  it('exhausts three attempts against persistent 429 and fails with rate_limited', async () => {
    const saved = globalThis.fetch;
    const { fetchImpl, counter } = statusFetch(429, 'rate limited');
    globalThis.fetch = fetchImpl;

    try {
      const classifier = createJevClassifier(jevConfig, { TYPESAFE_API_KEY: 'k' }, instantHooks);
      const outcome = await classifier.classify(request);

      assert.ok(outcome.status === 'failed', JSON.stringify(outcome));
      assert.equal(outcome.kind, 'rate_limited');
      assert.equal(counter.calls, 3);
    } finally {
      globalThis.fetch = saved;
    }
  });

  it('treats 529 like 429: retries three attempts then fails with rate_limited', async () => {
    const saved = globalThis.fetch;
    const { fetchImpl, counter } = statusFetch(529, 'overloaded');
    globalThis.fetch = fetchImpl;

    try {
      const classifier = createJevClassifier(jevConfig, { TYPESAFE_API_KEY: 'k' }, instantHooks);
      const outcome = await classifier.classify(request);

      assert.ok(outcome.status === 'failed', JSON.stringify(outcome));
      assert.equal(outcome.kind, 'rate_limited');
      assert.equal(counter.calls, 3);
    } finally {
      globalThis.fetch = saved;
    }
  });

  it('retries 408 and other 5xx (500, 503) to the full three attempts', async () => {
    const saved = globalThis.fetch;
    try {
      for (const status of [408, 500, 503]) {
        const { fetchImpl, counter } = statusFetch(status, 'transient');
        globalThis.fetch = fetchImpl;
        const classifier = createJevClassifier(jevConfig, { TYPESAFE_API_KEY: 'k' }, instantHooks);
        const outcome = await classifier.classify(request);
        assert.ok(outcome.status === 'failed', `${status} ${JSON.stringify(outcome)}`);
        assert.equal(outcome.kind, status === 408 ? 'timeout' : 'network', `${status} kind`);
        assert.equal(counter.calls, 3, `${status} must be retried three times`);
      }
    } finally {
      globalThis.fetch = saved;
    }
  });

  it('does not retry 403 (auth) and does not count it toward the breaker', async () => {
    const saved = globalThis.fetch;
    const { fetchImpl, counter } = statusFetch(403, 'forbidden');
    globalThis.fetch = fetchImpl;

    try {
      const classifier = createJevClassifier(jevConfig, { TYPESAFE_API_KEY: 'k' }, instantHooks);
      const outcome = await classifier.classify(request);

      // 派发后失败仍保留输入证据。
      assert.deepEqual(outcome, {
        status: 'failed',
        kind: 'auth',
        detail: '403 forbidden',
        dispatch: request,
        http_attempts: 1,
        usage_complete: false,
        http_status: 403,
      });
      assert.equal(counter.calls, 1);
    } finally {
      globalThis.fetch = saved;
    }
  });

  it('does not retry 404 (validation) either', async () => {
    const saved = globalThis.fetch;
    const { fetchImpl, counter } = statusFetch(404, 'not found');
    globalThis.fetch = fetchImpl;

    try {
      const classifier = createJevClassifier(jevConfig, { TYPESAFE_API_KEY: 'k' }, instantHooks);
      const outcome = await classifier.classify(request);

      assert.deepEqual(outcome, {
        status: 'failed',
        kind: 'validation',
        detail: '404 not found',
        dispatch: request,
        http_attempts: 1,
        usage_complete: false,
        http_status: 404,
      });
      assert.equal(counter.calls, 1);
    } finally {
      globalThis.fetch = saved;
    }
  });

  it('never retries 422 — a validation failure would just 422 again (Pitfall 7)', async () => {
    const saved = globalThis.fetch;
    const { fetchImpl, counter } = statusFetch(422, 'state too large');
    globalThis.fetch = fetchImpl;

    try {
      const classifier = createJevClassifier(jevConfig, { TYPESAFE_API_KEY: 'k' }, instantHooks);
      const outcome = await classifier.classify(request);

      // HTTP 拒绝仍是已发送请求，样本必须保留其载荷。
      assert.deepEqual(outcome, {
        status: 'failed',
        kind: 'validation',
        detail: '422 state too large',
        dispatch: request,
        http_attempts: 1,
        usage_complete: false,
        http_status: 422,
      });
      assert.equal(counter.calls, 1);
    } finally {
      globalThis.fetch = saved;
    }
  });

  it('never retries 413 either — validation, not a local oversize branch (all-only §3.3)', async () => {
    const saved = globalThis.fetch;
    const { fetchImpl, counter } = statusFetch(413, 'payload too large');
    globalThis.fetch = fetchImpl;

    try {
      const classifier = createJevClassifier(jevConfig, { TYPESAFE_API_KEY: 'k' }, instantHooks);
      const outcome = await classifier.classify(request);

      assert.deepEqual(outcome, {
        status: 'failed',
        kind: 'validation',
        detail: '413 payload too large',
        dispatch: request,
        http_attempts: 1,
        usage_complete: false,
        http_status: 413,
      });
      assert.equal(counter.calls, 1);
    } finally {
      globalThis.fetch = saved;
    }
  });

  it('sends a synthetic request over the old 32K/64K detection range whole — no trimming, no question drops, no splitting (all-only §6)', async () => {
    const saved = globalThis.fetch;
    // 80k 个 CJK 字符按旧估算仅正文就达 72k token，超过两条旧限额；
    // 现在必须一次完整原样发出。这里只验证测试输入，不恢复生产预算检测。
    const bigState: JevState = {
      query: 'q',
      intent: 'i',
      sources: [
        {
          id: 's0',
          url: 'https://s0.example/',
          title: 'Title',
          snippets: ['中'.repeat(80_000)],
          brave_page_date: null,
        },
      ],
    };
    assert.ok(JSON.stringify(bigState).length > 80_000, '仅 state 已超过 80_000 字符');
    const bigQuestions = makeQuestions(bigState, 1);
    let capturedBody: string | undefined;
    let calls = 0;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls += 1;
      capturedBody = String(init?.body);
      return new Response(
        JSON.stringify({
          model: 'jev-1.13.0',
          answers: { s0__has_original_reasoning: { type: 'noul', noul: 0.1 } },
          usage: { input_tokens: 7 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }) as typeof fetch;

    try {
      const classifier = createJevClassifier(jevConfig, { TYPESAFE_API_KEY: 'k' }, instantHooks);
      const outcome = await classifier.classify({ state: bigState, questions: bigQuestions });
      assert.ok(outcome.status === 'answered', JSON.stringify(outcome));
      assert.deepEqual(outcome.answers.s0__has_original_reasoning, {
        kind: 'noul',
        probability: 0.1,
      });

      const sent = JSON.parse(String(capturedBody)) as { state: JevState; questions: unknown };
      assert.deepEqual(sent.state, bigState, '正文不得被删改');
      assert.deepEqual(sent.questions, bigQuestions, '题目不得被删减或改写');
      assert.equal(calls, 1, '不得拆成多次请求');
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
      const classifier = createJevClassifier(jevConfig, { TYPESAFE_API_KEY: 'k' }, instantHooks);
      const outcome = await classifier.classify(request);

      assert.ok(outcome.status === 'answered', JSON.stringify(outcome));
      assert.equal(fetchCount, 3);
    } finally {
      globalThis.fetch = saved;
    }
  });

  it('backs off exactly 500ms then 1000ms when random returns 0', async () => {
    const saved = globalThis.fetch;
    globalThis.fetch = scriptedFetch([() => new Response('rate limited', { status: 429 })]);
    const { sleeps, hooks } = sleepRecorder(0);

    try {
      const classifier = createJevClassifier(jevConfig, { TYPESAFE_API_KEY: 'k' }, hooks);
      const outcome = await classifier.classify(request);

      assert.ok(outcome.status === 'failed', JSON.stringify(outcome));
      assert.deepEqual(sleeps, [500, 1000]);
    } finally {
      globalThis.fetch = saved;
    }
  });

  it('shaves at most 25% off each backoff when random returns 1', async () => {
    const saved = globalThis.fetch;
    globalThis.fetch = scriptedFetch([() => new Response('rate limited', { status: 429 })]);
    const { sleeps, hooks } = sleepRecorder(1);

    try {
      const classifier = createJevClassifier(jevConfig, { TYPESAFE_API_KEY: 'k' }, hooks);
      const outcome = await classifier.classify(request);

      assert.ok(outcome.status === 'failed', JSON.stringify(outcome));
      assert.deepEqual(sleeps, [375, 750]);
    } finally {
      globalThis.fetch = saved;
    }
  });

  it('honours retry-after-ms over the ordinary backoff', async () => {
    const saved = globalThis.fetch;
    globalThis.fetch = scriptedFetch([
      () => new Response('rate limited', { status: 429, headers: { 'retry-after-ms': '1200' } }),
      () => okResponseOf(defaultRecording.results['s0']),
    ]);
    const { sleeps, hooks } = sleepRecorder(0);

    try {
      const classifier = createJevClassifier(jevConfig, { TYPESAFE_API_KEY: 'k' }, hooks);
      const outcome = await classifier.classify(request);

      assert.ok(outcome.status === 'answered', JSON.stringify(outcome));
      assert.deepEqual(sleeps, [1200]);
    } finally {
      globalThis.fetch = saved;
    }
  });

  it('reads retry-after as seconds when retry-after-ms is absent', async () => {
    const saved = globalThis.fetch;
    globalThis.fetch = scriptedFetch([
      () => new Response('rate limited', { status: 429, headers: { 'retry-after': '3' } }),
      () => okResponseOf(defaultRecording.results['s0']),
    ]);
    const { sleeps, hooks } = sleepRecorder(0);

    try {
      const classifier = createJevClassifier(jevConfig, { TYPESAFE_API_KEY: 'k' }, hooks);
      const outcome = await classifier.classify(request);

      assert.ok(outcome.status === 'answered', JSON.stringify(outcome));
      assert.deepEqual(sleeps, [3000]);
    } finally {
      globalThis.fetch = saved;
    }
  });

  it('gives up after one fetch when retry-after exceeds the 5s cap', async () => {
    const saved = globalThis.fetch;
    const { fetchImpl, counter } = statusFetch(429, 'rate limited', { 'retry-after': '10' });
    globalThis.fetch = fetchImpl;
    const { sleeps, hooks } = sleepRecorder(0);

    try {
      const classifier = createJevClassifier(jevConfig, { TYPESAFE_API_KEY: 'k' }, hooks);
      const outcome = await classifier.classify(request);

      assert.ok(outcome.status === 'failed', JSON.stringify(outcome));
      assert.equal(outcome.kind, 'rate_limited');
      assert.equal(counter.calls, 1, 'a long retry-after must not be retried');
      assert.deepEqual(sleeps, []);
    } finally {
      globalThis.fetch = saved;
    }
  });

  it('converts an HTTP-date retry-after into a wait using hooks.now', async () => {
    const saved = globalThis.fetch;
    const now = 1_800_000_000_000;
    const date = new Date(now + 3000).toUTCString();
    globalThis.fetch = scriptedFetch([
      () => new Response('rate limited', { status: 429, headers: { 'retry-after': date } }),
      () => okResponseOf(defaultRecording.results['s0']),
    ]);
    const { sleeps, hooks } = sleepRecorder(0);

    try {
      const classifier = createJevClassifier(
        jevConfig,
        { TYPESAFE_API_KEY: 'k' },
        { ...hooks, now: () => now }
      );
      const outcome = await classifier.classify(request);

      assert.ok(outcome.status === 'answered', JSON.stringify(outcome));
      assert.deepEqual(sleeps, [3000]);
    } finally {
      globalThis.fetch = saved;
    }
  });

  it('falls back to the ordinary backoff when retry-after is garbage', async () => {
    const saved = globalThis.fetch;
    globalThis.fetch = scriptedFetch([
      () => new Response('rate limited', { status: 429, headers: { 'retry-after': 'soon-ish' } }),
      () => okResponseOf(defaultRecording.results['s0']),
    ]);
    const { sleeps, hooks } = sleepRecorder(0);

    try {
      const classifier = createJevClassifier(jevConfig, { TYPESAFE_API_KEY: 'k' }, hooks);
      const outcome = await classifier.classify(request);

      assert.ok(outcome.status === 'answered', JSON.stringify(outcome));
      assert.deepEqual(sleeps, [500]);
    } finally {
      globalThis.fetch = saved;
    }
  });

  it('retries a body-read disconnect (TypeError) and succeeds on the next attempt', async () => {
    let fetchCount = 0;
    const saved = globalThis.fetch;
    globalThis.fetch = scriptedFetch([
      () => {
        fetchCount += 1;
        // 响应头已到、读正文时连接断开
        return {
          status: 200,
          headers: new Headers(),
          text: async () => {
            throw new TypeError('terminated');
          },
        } as unknown as Response;
      },
      () => {
        fetchCount += 1;
        return okResponseOf(defaultRecording.results['s0']);
      },
    ]);
    const { hooks } = sleepRecorder(0);

    try {
      const classifier = createJevClassifier(jevConfig, { TYPESAFE_API_KEY: 'k' }, hooks);
      const outcome = await classifier.classify(request);

      assert.ok(outcome.status === 'answered', JSON.stringify(outcome));
      assert.equal(fetchCount, 2);
    } finally {
      globalThis.fetch = saved;
    }
  });

  it('treats a body-read timeout as timeout without retrying and counts it toward the breaker', async () => {
    const saved = globalThis.fetch;
    let fetchCount = 0;
    globalThis.fetch = (async () => {
      fetchCount += 1;
      return {
        status: 200,
        headers: new Headers(),
        text: async () => {
          throw new DOMException('The operation was aborted', 'TimeoutError');
        },
      } as unknown as Response;
    }) as typeof fetch;
    const { hooks } = sleepRecorder(0);

    try {
      const classifier = createJevClassifier(jevConfig, { TYPESAFE_API_KEY: 'k' }, hooks);
      const first = await classifier.classify(request);
      assert.ok(first.status === 'failed', JSON.stringify(first));
      assert.equal(first.kind, 'timeout');
      assert.equal(fetchCount, 1, 'a body-read timeout must not be retried');

      // 同一实例再连续两次超时 → 三次连续瞬态失败 → 熔断打开
      await classifier.classify(request);
      await classifier.classify(request);
      const fourth = await classifier.classify(request);
      assert.ok(fourth.status === 'failed', JSON.stringify(fourth));
      assert.equal(fourth.kind, 'breaker_open', 'body-read timeouts must count toward the breaker');
    } finally {
      globalThis.fetch = saved;
    }
  });

  it('retries reuse the exact same body: retrieval time and page dates unchanged (§3.1)', async () => {
    // 同一搜索的重试属于同一逻辑请求：复用完全相同的 body（state、题目、检索时间）
    const state: JevState = {
      query: 'q',
      intent: 'i',
      sources: [
        {
          id: 's0',
          url: 'https://a.example/',
          title: 'Title',
          snippets: ['one'],
          brave_page_date: '2026-09-16',
        },
      ],
      retrieval_time: '2026-10-03T23:59:59.900+08:00',
    };
    const seen: Array<{ state: JevState; questions: Record<string, JevQuestion> }> = [];
    const saved = globalThis.fetch;
    globalThis.fetch = (async (_input, init) => {
      seen.push(JSON.parse(String(init?.body)));
      return seen.length === 1
        ? new Response('retry', { status: 503 })
        : okResponseOf(defaultRecording.results['s0']);
    }) as typeof fetch;

    try {
      const classifier = createJevClassifier(
        jevConfig,
        { TYPESAFE_API_KEY: 'k' },
        { sleep: async () => {}, random: () => 0 }
      );
      const outcome = await classifier.classify({ state, questions: sharedQuestions });

      assert.ok(outcome.status === 'answered', JSON.stringify(outcome));
      assert.equal(seen.length, 2);
      assert.deepEqual(seen[0], seen[1], 'retries must reuse the identical request body');
      assert.equal(seen[0]?.state.retrieval_time, '2026-10-03T23:59:59.900+08:00');
      assert.equal(seen[0]?.state.sources[0]?.brave_page_date, '2026-09-16');
    } finally {
      globalThis.fetch = saved;
    }
  });
});

// 熔断阈值、窗口、成功清零与失败分类；已在途请求不应被取消。

describe('createJevClassifier breaker (SAFE-02)', () => {
  const request = sharedRequest;

  it('opens after three consecutive transient failures and short-circuits with zero fetches', async () => {
    let fetchCount = 0;
    const saved = globalThis.fetch;
    globalThis.fetch = (async () => {
      fetchCount += 1;
      return new Response('rate limited', { status: 429 });
    }) as typeof fetch;

    try {
      const classifier = createJevClassifier(
        jevConfig,
        { TYPESAFE_API_KEY: 'k' },
        { sleep: async () => {}, now: () => 1000000 }
      );

      for (let i = 0; i < 3; i += 1) {
        const outcome = await classifier.classify(request);
        assert.ok(outcome.status === 'failed', JSON.stringify(outcome));
        assert.equal(outcome.kind, 'rate_limited');
      }
      assert.equal(fetchCount, 9, 'each failure exhausts three attempts');

      const fourth = await classifier.classify(request);
      assert.ok(fourth.status === 'failed', JSON.stringify(fourth));
      assert.equal(fourth.kind, 'breaker_open');
      assert.equal(fetchCount, 9, 'breaker_open must short-circuit with zero fetches');
    } finally {
      globalThis.fetch = saved;
    }
  });

  it('resets the consecutive-failure count on any answered outcome', async () => {
    // classify 序列 f, f, ok, f, f, ok → fetch 序：429×3 | 429×3 | 200 | 429×3 | 429×3 | 200
    let fetchCount = 0;
    const okAt = new Set([7, 14]);
    const saved = globalThis.fetch;
    globalThis.fetch = (async () => {
      fetchCount += 1;
      if (okAt.has(fetchCount)) return okResponseOf(defaultRecording.results['s0']);
      return new Response('rate limited', { status: 429 });
    }) as typeof fetch;

    try {
      const classifier = createJevClassifier(
        jevConfig,
        { TYPESAFE_API_KEY: 'k' },
        { sleep: async () => {}, now: () => 1000000 }
      );

      const kinds: string[] = [];
      for (let i = 0; i < 6; i += 1) {
        const outcome = await classifier.classify(request);
        kinds.push(outcome.status === 'answered' ? 'answered' : outcome.kind);
      }

      assert.deepEqual(kinds, [
        'rate_limited',
        'rate_limited',
        'answered',
        'rate_limited',
        'rate_limited',
        'answered',
      ]);
      assert.equal(fetchCount, 14, 'no breaker_open short-circuit anywhere in the sequence');
    } finally {
      globalThis.fetch = saved;
    }
  });

  it('closes the breaker after 60s without half-open probing and restarts the count at zero', async () => {
    let clock = 1000000;
    let fetchCount = 0;
    const okAt = new Set([10, 17]);
    const saved = globalThis.fetch;
    globalThis.fetch = (async () => {
      fetchCount += 1;
      if (okAt.has(fetchCount)) return okResponseOf(defaultRecording.results['s0']);
      return new Response('rate limited', { status: 429 });
    }) as typeof fetch;

    try {
      const classifier = createJevClassifier(
        jevConfig,
        { TYPESAFE_API_KEY: 'k' },
        { sleep: async () => {}, now: () => clock }
      );

      // 3 次失败 → 熔断
      for (let i = 0; i < 3; i += 1) {
        const outcome = await classifier.classify(request);
        assert.ok(outcome.status === 'failed' && outcome.kind === 'rate_limited');
      }
      assert.equal(fetchCount, 9);

      // 熔断期短路
      const during = await classifier.classify(request);
      assert.ok(during.status === 'failed' && during.kind === 'breaker_open');
      assert.equal(fetchCount, 9);

      // 推进 61s → 到期直接闭合（无半开探测），恢复正常路径
      clock += 61000;
      const after = await classifier.classify(request);
      assert.ok(after.status === 'answered', JSON.stringify(after));
      assert.equal(fetchCount, 10);

      // 计数从 0 起：再连续 2 次失败不熔断，第 8 次仍正常发 fetch
      for (let i = 0; i < 2; i += 1) {
        const outcome = await classifier.classify(request);
        assert.ok(outcome.status === 'failed' && outcome.kind === 'rate_limited');
      }
      const eighth = await classifier.classify(request);
      assert.ok(eighth.status === 'answered', JSON.stringify(eighth));
      assert.equal(fetchCount, 17);
    } finally {
      globalThis.fetch = saved;
    }
  });

  it('leaves in-flight requests alone when the breaker opens', async () => {
    let clock = 1000000;
    let fetchCount = 0;
    let held: ((response: Response) => void) | undefined;
    const saved = globalThis.fetch;
    globalThis.fetch = (async () => {
      fetchCount += 1;
      if (fetchCount === 4) {
        // c2 的第一次 fetch 挂起，等熔断开后由测试释放
        return await new Promise<Response>((resolve) => {
          held = resolve;
        });
      }
      return new Response('rate limited', { status: 429 });
    }) as typeof fetch;

    try {
      const classifier = createJevClassifier(
        jevConfig,
        { TYPESAFE_API_KEY: 'k' },
        { sleep: async () => {}, now: () => clock }
      );

      // c1 快速失败（fetch 1-3，连续失败 1）
      const c1 = await classifier.classify(request);
      assert.ok(c1.status === 'failed' && c1.kind === 'rate_limited');

      // c2 在途（第一次 fetch 挂起）
      const c2Promise = classifier.classify(request);
      await waitFor(() => held !== undefined);
      assert.equal(fetchCount, 4);

      // c3、c4 快速失败（fetch 5-10）→ 连续 3 → 熔断开
      await classifier.classify(request);
      await classifier.classify(request);
      assert.equal(fetchCount, 10);

      // 释放 c2 的挂起 fetch：它继续自己的重试直到耗尽——不被取消、不短路
      held!(new Response('rate limited', { status: 429 }));
      const c2 = await c2Promise;
      assert.ok(c2.status === 'failed' && c2.kind === 'rate_limited');
      assert.equal(fetchCount, 12, 'in-flight request must finish its own retries');

      // 熔断后的新调用短路
      const c5 = await classifier.classify(request);
      assert.ok(c5.status === 'failed' && c5.kind === 'breaker_open');
      assert.equal(fetchCount, 12);
    } finally {
      globalThis.fetch = saved;
    }
  });

  it('does not count deterministic failures (auth) toward the breaker', async () => {
    let fetchCount = 0;
    const saved = globalThis.fetch;
    globalThis.fetch = (async () => {
      fetchCount += 1;
      return new Response('unauthorized', { status: 401 });
    }) as typeof fetch;

    try {
      const classifier = createJevClassifier(
        jevConfig,
        { TYPESAFE_API_KEY: 'k' },
        { sleep: async () => {}, now: () => 1000000 }
      );

      for (let i = 0; i < 3; i += 1) {
        const outcome = await classifier.classify(request);
        assert.ok(outcome.status === 'failed' && outcome.kind === 'auth');
      }

      // auth 是确定性请求问题：不计连续失败，第 4 次仍发 fetch
      const fourth = await classifier.classify(request);
      assert.ok(fourth.status === 'failed' && fourth.kind === 'auth');
      assert.equal(fetchCount, 4);
    } finally {
      globalThis.fetch = saved;
    }
  });
});

// 排队后的熔断复查、名额交接与归还、配置超时的传递。

describe('createJevClassifier concurrency and breaker re-check (02-FIX batch C/E)', () => {
  const request = sharedRequest;

  it('re-checks the breaker after the queue so parked requests do not fire (C3)', async () => {
    // concurrency 1。先制造 2 次连续瞬态失败（离阈值 3 差一步），再让一个请求挂住
    // 占住名额、两个排进闸；挂住的请求耗尽重试时把熔断打开——排队者醒来后必须复查
    // 熔断，不再发 fetch
    let fetchCount = 0;
    let releaseHeld: ((response: Response) => void) | undefined;
    const saved = globalThis.fetch;
    globalThis.fetch = (async () => {
      fetchCount += 1;
      if (fetchCount === 7) {
        // A 的首次 fetch 挂住，等测试释放
        return await new Promise<Response>((resolve) => {
          releaseHeld = resolve;
        });
      }
      return new Response('rate limited', { status: 429 });
    }) as typeof fetch;

    try {
      const classifier = createJevClassifier(
        { ...jevConfig, concurrency: 1 },
        { TYPESAFE_API_KEY: 'k' },
        { sleep: async () => {}, random: () => 0, now: () => 1000000 }
      );

      // 两次失败（各 3 次尝试，fetch 1-6）→ 连续失败计数 2
      for (let i = 0; i < 2; i += 1) {
        const outcome = await classifier.classify(request);
        assert.ok(outcome.status === 'failed' && outcome.kind === 'rate_limited');
      }
      assert.equal(fetchCount, 6);

      // A 占住唯一名额并挂住；B、C 在闸上排队
      const held = classifier.classify(request);
      await waitFor(() => releaseHeld !== undefined && fetchCount === 7);
      const queuedB = classifier.classify(request);
      const queuedC = classifier.classify(request);
      await new Promise((resolve) => setTimeout(resolve, 20));

      // 释放 A：它继续自己的重试直到耗尽（fetch 8、9），第 3 次连续失败 → 熔断打开
      releaseHeld!(new Response('rate limited', { status: 429 }));
      const heldOutcome = await held;
      assert.ok(heldOutcome.status === 'failed' && heldOutcome.kind === 'rate_limited');
      assert.equal(fetchCount, 9);

      const [b, c] = await Promise.all([queuedB, queuedC]);
      for (const [name, outcome] of [
        ['B', b],
        ['C', c],
      ] as const) {
        assert.ok(outcome.status === 'failed', `${name} ${JSON.stringify(outcome)}`);
        assert.equal(
          (outcome as { kind: string }).kind,
          'breaker_open',
          `${name} must re-check the breaker after waking`
        );
      }
      assert.equal(
        fetchCount,
        9,
        'parked requests must not fire any fetch after the breaker opened'
      );
    } finally {
      globalThis.fetch = saved;
    }
  });

  it('hands the slot to the head waiter instead of reopening a gap (C4)', async () => {
    // 并发上限为 1，等待者接棒期间的新请求不能抢到同一名额。
    // A 释放前还要读取正文和解析，微任务窗口不固定，因此让 C 延迟不同微任务数进入。
    // 每轮新建分类器，所有时序的在途峰值都应保持为 1。
    const saved = globalThis.fetch;
    try {
      for (let k = 0; k < 30; k += 1) {
        let inflight = 0;
        let peak = 0;
        const pending: Array<() => void> = [];
        globalThis.fetch = (async () => {
          inflight += 1;
          peak = Math.max(peak, inflight);
          await new Promise<void>((resolve) => pending.push(resolve));
          inflight -= 1;
          return okResponseOf(defaultRecording.results['s0']);
        }) as typeof fetch;

        const classifier = createJevClassifier(
          { ...jevConfig, concurrency: 1 },
          { TYPESAFE_API_KEY: 'k' },
          { random: () => 0 }
        );

        const promises: Array<Promise<{ status: string }>> = [];
        promises.push(classifier.classify(request)); // A 立即在途
        await waitFor(() => pending.length === 1);
        promises.push(classifier.classify(request)); // B 排队
        await new Promise((resolve) => setTimeout(resolve, 5));

        // 放行 A，C 延迟 k 个微任务后进闸
        pending.shift()!();
        let delayed: Promise<void> = Promise.resolve();
        for (let i = 0; i < k; i += 1) delayed = delayed.then(() => {});
        promises.push(delayed.then(() => classifier.classify(request)));

        // 依次放行 B 与 C
        for (let i = 0; i < 2; i += 1) {
          await waitFor(() => pending.length > 0);
          pending.shift()!();
        }

        const outcomes = await Promise.all(promises);
        for (const outcome of outcomes) {
          assert.equal(outcome.status, 'answered', JSON.stringify(outcome));
        }
        assert.equal(peak, 1, `k=${k}: peak in-flight fetches must be exactly 1, saw ${peak}`);
      }
    } finally {
      globalThis.fetch = saved;
    }
  });

  it('returns the slot on every failure path so the next request still runs (E1)', async () => {
    // concurrency 1：三种失败（fetch 恒抛 / 恒 500 / 恒 401）各发一次请求，之后第
    // 四个正常请求必须还能完成——失败路径漏还名额会让它永远排队（超时保护：挂住即失败）
    let behavior: 'throw' | '500' | '401' | 'ok' = 'throw';
    const saved = globalThis.fetch;
    globalThis.fetch = (async () => {
      if (behavior === 'throw') throw new Error('fetch failed');
      if (behavior === '500') return new Response('boom', { status: 500 });
      if (behavior === '401') return new Response('unauthorized', { status: 401 });
      return okResponseOf(defaultRecording.results['s0']);
    }) as typeof fetch;

    try {
      const classifier = createJevClassifier(
        { ...jevConfig, concurrency: 1 },
        { TYPESAFE_API_KEY: 'k' },
        { sleep: async () => {}, random: () => 0, now: () => 1000000 }
      );

      for (const [kind, expected] of [
        ['throw', 'network'],
        ['500', 'network'],
        ['401', 'auth'],
      ] as const) {
        behavior = kind;
        const outcome = await classifier.classify(request);
        assert.ok(outcome.status === 'failed', `${kind} ${JSON.stringify(outcome)}`);
        assert.equal((outcome as { kind: string }).kind, expected, kind);
      }

      behavior = 'ok';
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error('the fourth request hung: the slot was never returned')),
          1500
        )
      );
      const fourth = await Promise.race([classifier.classify(request), timeout]);
      assert.equal(fourth.status, 'answered', JSON.stringify(fourth));
    } finally {
      globalThis.fetch = saved;
    }
  });

  it('uses the configured timeout instead of a hard-coded one (E2)', async () => {
    /** 假 fetch：遵守传入的 signal，abort 时以 signal.reason reject；delayMs null = 永不返回。 */
    const signalAwareFetch =
      (delayMs: number | null) => async (_input: RequestInfo | URL, init?: RequestInit) => {
        const signal = init?.signal;
        return await new Promise<Response>((resolve, reject) => {
          const timer =
            delayMs === null
              ? undefined
              : setTimeout(() => resolve(okResponseOf(defaultRecording.results['s0'])), delayMs);
          signal?.addEventListener('abort', () => {
            if (timer !== undefined) clearTimeout(timer);
            reject(signal.reason);
          });
        });
      };

    const saved = globalThis.fetch;
    try {
      // timeout 1000ms，fetch 50ms 后返回 → 必须成功（能抓住"写死更短超时"的实现）
      globalThis.fetch = signalAwareFetch(50) as typeof fetch;
      const fast = createJevClassifier(
        { ...jevConfig, timeoutMs: 1000 },
        { TYPESAFE_API_KEY: 'k' },
        { random: () => 0 }
      );
      const answered = await fast.classify(request);
      assert.equal(answered.status, 'answered', JSON.stringify(answered));

      // fetch 永不返回 → 必须按 timeout 失败，且不重试
      let fetchCount = 0;
      globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        fetchCount += 1;
        const signal = init?.signal;
        return await new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason));
        });
      }) as typeof fetch;
      const slow = createJevClassifier(
        { ...jevConfig, timeoutMs: 30 },
        { TYPESAFE_API_KEY: 'k' },
        { random: () => 0 }
      );
      const timedOut = await slow.classify(request);
      assert.ok(timedOut.status === 'failed', JSON.stringify(timedOut));
      assert.equal((timedOut as { kind: string }).kind, 'timeout');
      assert.equal(fetchCount, 1, 'a timeout must not be retried');
    } finally {
      globalThis.fetch = saved;
    }
  });
});

// ---------------------------------------------------------------------------
// 全量上下文分支：完整载荷原样透传（无本地输入尺寸处理）、进程级并发闸对
// 全量请求按同一名额计。
// ---------------------------------------------------------------------------

describe('createJevClassifier all-context branch (FULL_CONTEXT_ROLLOUT_PLAN T06/T08)', () => {
  const allState: JevState = {
    query: 'q',
    intent: 'i',
    sources: [
      {
        id: 's0',
        url: 'https://a.example/',
        title: 'A',
        snippets: ['one'],
        brave_page_date: null,
      },
      {
        id: 's1',
        url: 'https://b.example/',
        title: 'B',
        snippets: ['two'],
        brave_page_date: null,
      },
    ],
  };
  const smallQuestions: Record<string, JevQuestion> = {
    s0__is_off_topic: { type: 'noul', instructions: 'x' },
    s1__is_off_topic: { type: 'noul', instructions: 'x' },
  };

  it('sends the all-context payload unchanged when within budget', async () => {
    let fetchCount = 0;
    let capturedInit: RequestInit | undefined;
    const saved = globalThis.fetch;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      fetchCount += 1;
      capturedInit = init;
      return okResponseOf(defaultRecording.results['s0']);
    }) as typeof fetch;

    try {
      const classifier = createJevClassifier(jevConfig, { TYPESAFE_API_KEY: 'k' });
      const outcome = await classifier.classify({ state: allState, questions: smallQuestions });

      assert.ok(outcome.status === 'answered', JSON.stringify(outcome));
      // 完整载荷原样透传：无任何本地输入尺寸处理
      assert.equal(fetchCount, 1);
      const body = JSON.parse(String(capturedInit?.body)) as { state: unknown; questions: unknown };
      assert.deepEqual(body.state, allState);
      assert.deepEqual(body.questions, smallQuestions);
    } finally {
      globalThis.fetch = saved;
    }
  });

  it('admits one all-context request per concurrency slot and queues the rest (T08)', async () => {
    const responseBody = JSON.stringify(defaultRecording.results['s0'].response);
    let fetchCalls = 0;
    let inflight = 0;
    let peak = 0;
    const pending: Array<() => void> = [];
    const saved = globalThis.fetch;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
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
      const classifier = createJevClassifier(
        { ...jevConfig, concurrency: 1 },
        { TYPESAFE_API_KEY: 'k' }
      );
      const request = { state: allState, questions: smallQuestions };

      // 两个并发全量请求：并发 1 下必须串行——第一个占住名额，第二个在闸上排队
      const promises = [classifier.classify(request), classifier.classify(request)];
      await waitFor(() => fetchCalls >= 1);
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(fetchCalls, 1, 'only the first all request may enter fetch');
      assert.equal(pending.length, 1, 'the first fetch must still be held open');
      assert.equal(peak, 1);

      // 释放第一个：名额交接给排队的第二个，进第二个 fetch（用调用计数等待，
      // pending 里第一个 resolve 已被取走、不能再用长度计数）
      pending.shift()!();
      await waitFor(() => fetchCalls >= 2);
      assert.ok(peak <= 1, `peak ${peak} must stay at 1`);
      pending.shift()!();
      const outcomes = await Promise.all(promises);
      assert.ok(outcomes.every((outcome) => outcome.status === 'answered'));
      assert.equal(peak, 1);
    } finally {
      globalThis.fetch = saved;
    }
  });
});

describe('全量接入审查：真实解析与请求账目', () => {
  const config = parseFilterConfigObject({ mode: 'test' });
  const request = { params: { query: 'brave browser' }, intent: 'Brave browser engineering facts' };
  const data: BraveLlmContextResponse = {
    grounding: {
      generic: [
        {
          url: 'https://alpha.example/',
          title: 'Brave alpha',
          snippets: [
            'Brave browser uses an independent renderer process to isolate each browsing context.',
          ],
        },
        {
          url: 'https://beta.example/',
          title: 'Brave beta',
          snippets: [
            'Brave browser records a distinct connection error when this transport fails.',
          ],
        },
      ],
      map: [],
    },
    sources: {},
  };

  it('一个来源错型时其他来源仍完成裁决，真实 HTTP 用量只记一次', async () => {
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async (_url, init) => {
      calls += 1;
      const body = JSON.parse(String(init?.body));
      const answers: Record<string, unknown> = Object.fromEntries(
        Object.entries(body.questions).map(([key, value]) => [
          key,
          (value as JevQuestion).type === 'score'
            ? { type: 'score', score: key.startsWith('s0__') ? 'bad' : 0 }
            : { type: 'noul', noul: key.endsWith('has_reasoning') ? 0.9 : 0.1 },
        ])
      );
      answers.s0__is_off_topic = { type: 'noul', noul: 'bad' };
      return new Response(
        JSON.stringify({ model: DEFAULT_JEV_MODEL, answers, usage: { input_tokens: 1234 } })
      );
    };
    try {
      const result = await filterLlmContext(
        data,
        request,
        config,
        createJevClassifier(config.jev, { TYPESAFE_API_KEY: 'offline-test' })
      );
      assert.equal(calls, 1);
      assert.equal(result.stats.jev?.n_requests, 1);
      assert.equal(result.stats.jev?.input_tokens, 1234);
      const rows = result.stats.jev!.per_source;
      assert.equal(rows.find((row) => row.src === 's0')?.fail_kind, 'validation');
      assert.deepEqual(rows.find((row) => row.src === 's1')?.snippet_scores, [0]);
      assert.equal(rows.find((row) => row.src === 's1')?.verdict, 'keep');
      assert.deepEqual(
        result.result.grounding.generic.map((source) => source.url),
        ['https://alpha.example/']
      );
      assert.equal(result.jev_requests[0].usage_complete, true);
    } finally {
      globalThis.fetch = original;
    }
  });

  it('顶层答案坏掉仍保留已知用量及 HTTP 状态', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          model: DEFAULT_JEV_MODEL,
          answers: null,
          usage: { input_tokens: 1234 },
        })
      );
    try {
      const result = await filterLlmContext(
        data,
        request,
        config,
        createJevClassifier(config.jev, { TYPESAFE_API_KEY: 'offline-test' })
      );
      assert.equal(result.stats.jev?.input_tokens, 1234);
      assert.equal(result.jev_requests[0].input_tokens, 1234);
      assert.equal(result.jev_requests[0].usage_complete, true);
      assert.equal(result.jev_requests[0].http_status, 200);
      assert.equal(result.jev_requests[0].fail_kind, 'validation');
      assert.equal(result.jev_requests[0].answered, false);
      assert.ok(result.stats.jev?.per_source.every((row) => row.status === 'failed'));
    } finally {
      globalThis.fetch = original;
    }
  });

  it('重试分别累加已知用量；断连后成功仍标记用量不完整', async () => {
    const original = globalThis.fetch;
    try {
      for (const firstUsage of [undefined, 11]) {
        let calls = 0;
        globalThis.fetch = async () => {
          calls += 1;
          if (calls === 1) {
            if (firstUsage === undefined) throw new Error('offline network fixture');
            return new Response(JSON.stringify({ usage: { input_tokens: firstUsage } }), {
              status: 500,
            });
          }
          return new Response(
            JSON.stringify({ model: DEFAULT_JEV_MODEL, answers: {}, usage: { input_tokens: 17 } })
          );
        };
        const result = await filterLlmContext(
          data,
          request,
          config,
          createJevClassifier(
            config.jev,
            { TYPESAFE_API_KEY: 'offline-test' },
            { sleep: async () => {} }
          )
        );
        assert.equal(result.stats.jev?.n_requests, 1);
        assert.equal(result.stats.jev?.n_http_attempts, 2);
        assert.equal(result.stats.jev?.input_tokens, 17 + (firstUsage ?? 0));
        assert.equal(result.jev_requests[0].usage_complete, firstUsage !== undefined);
      }
    } finally {
      globalThis.fetch = original;
    }
  });

  it('依赖抛出网络异常不伪装成熔断，也不扇出重试', async () => {
    let calls = 0;
    const result = await filterLlmContext(data, request, config, {
      classify: async () => {
        calls += 1;
        throw new Error('offline injected failure');
      },
    });
    assert.equal(calls, 1);
    assert.ok(
      result.stats.jev?.per_source.every(
        (row) => row.status === 'failed' && row.fail_kind === 'network'
      )
    );
    assert.ok(result.jev_dispatch.every((row) => row.not_dispatched_reason !== 'breaker_open'));
  });

  it('answered without dispatch books zero requests and keeps the payload null (§3.3)', async () => {
    // 回答桩可 answered=true 而 dispatched=false：计零请求、载荷保持 null、
    // 缺少量用完整性信息时 usage_complete=false，不由 answered 自动推定
    const result = await filterLlmContext(data, request, config, {
      classify: async () => ({
        status: 'answered',
        model: DEFAULT_JEV_MODEL,
        answers: {},
        input_tokens: 5,
      }),
    });

    assert.equal(result.stats.jev?.n_requests, 0);
    assert.equal(result.stats.jev?.input_tokens, 5);
    assert.equal(result.jev_requests.length, 1);
    const record = result.jev_requests[0];
    assert.equal(record?.answered, true);
    assert.equal(record?.dispatched, false);
    assert.equal(record?.state, null);
    assert.equal(record?.questions, null);
    assert.equal(record?.input_tokens, 5);
    assert.equal(record?.usage_complete, false);
    // 来源行仍按 answered 投影（缺答保守处理），派发记录如实 dispatched=false
    assert.ok(result.stats.jev?.per_source.every((row) => row.status === 'answered'));
    assert.ok(result.jev_dispatch.every((row) => row.dispatched === false));
  });
});
