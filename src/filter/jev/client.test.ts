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
import { buildRequest } from './client.js';
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
