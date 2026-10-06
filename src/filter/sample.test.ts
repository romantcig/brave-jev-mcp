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
import { createLogWriter } from './logging.js';
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

/** 全保留的 choice 分布：概率 1 全给最长字母标签（none 为 0）。 */
const allKeepDistribution = (criteria: Record<string, null>): Record<string, number> => {
  const full = Object.keys(criteria)
    .filter((label) => label !== 'none')
    .reduce((best, label) => (label.length > best.length ? label : best), '');
  return Object.fromEntries(Object.keys(criteria).map((label) => [label, label === full ? 1 : 0]));
};

const keepAllClassify: ClassifyDeps['classify'] = async ({ questions }) => ({
  status: 'answered',
  model: DEFAULT_JEV_MODEL,
  answers: Object.fromEntries(
    Object.entries(questions).map(([key, question]) => [
      key,
      question.type === 'choice'
        ? { kind: 'choice', probabilities: allKeepDistribution(question.criteria) }
        : { kind: 'noul', probability: 0 },
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
              (question as { type: string; criteria?: Record<string, null> }).type === 'choice'
                ? {
                    type: 'choice',
                    probabilities: allKeepDistribution(
                      (question as { criteria: Record<string, null> }).criteria
                    ),
                  }
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

    assert.equal(sample.format_version, 8);
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
    assert.equal(savedRequest.answers?.s0__group0?.kind, 'choice');
    assert.deepEqual(
      sample.final_return,
      JSON.parse(JSON.stringify({ payload, status_line: statusLine }))
    );
    assert.match(String(sample.question_set_id), /^[0-9a-f]{12}$/);
    assert.equal(sample.filter_rules_version, FILTER_RULES_VERSION);
    // 只读运行规则快照：与配置阈值分开记录，不是可写配置组。
    assert.deepEqual(sample.config_snapshot.decision_rules, { near_threshold_max_gap: 0.02 });
    assert.deepEqual(sample.config_snapshot.thresholds, {
      filler_drop: DEFAULT_THRESHOLDS.fillerDrop,
      group_keep_min: DEFAULT_THRESHOLDS.groupKeepMin,
      single_keep_min: DEFAULT_THRESHOLDS.singleKeepMin,
    });
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

  it('逐片审计区分页面删除、坏组保留与独立裁决，重复 URL 按来源身份配对', async () => {
    const config = configOf(join(root, 'group-audit'));
    const data: BraveLlmContextResponse = {
      grounding: {
        generic: [4, 4, 7, 1].map((count, source) => ({
          url: 'https://same.example/article',
          title: `Evidence ${source}`,
          snippets: Array.from(
            { length: count },
            (_, position) => `${articleBody} Source ${source}, evidence ${position}.`
          ),
        })),
        map: [],
      },
      sources: {},
    };
    const threeNone = { none: 1, A: 0, B: 0, AB: 0, C: 0, AC: 0, BC: 0, ABC: 0 };
    const rawAnswers = {
      s0__filler: { type: 'noul', noul: 0.8 },
      s0__group0: {
        type: 'choice',
        choice: 'ABC',
        probabilities: { ...threeNone, none: 0, ABC: 1 },
      },
      s0__group3: { type: 'choice', choice: 'A', probabilities: { none: 0, A: 1 } },
      // s1 页面题缺答，仍然独立应用有效片段答案。
      s1__group0: { type: 'choice', choice: 'none', probabilities: threeNone },
      s1__group3: { type: 'choice', choice: 'A', probabilities: { A: 1 } },
      s2__filler: { type: 'noul', noul: 0.1 },
      s2__group0: { type: 'choice', probabilities: [1, 0] },
      s2__group3: { type: 'choice', choice: 'none', probabilities: threeNone },
      s2__group6: { type: 'choice', choice: 'none', probabilities: { none: 0.5, A: 0.5 } },
      s3__filler: { type: 'noul', noul: 0.1 },
      s3__group0: { type: 'choice', choice: 'none', probabilities: { none: 1, A: 0 } },
    };
    const { restore } = stubFetch(() => ({
      status: 200,
      text: async () =>
        JSON.stringify({
          model: DEFAULT_JEV_MODEL,
          answers: rawAnswers,
          usage: { input_tokens: 123 },
        }),
    }));
    let filtered: FilterResult;
    try {
      filtered = await filterLlmContext(
        data,
        { params: { query: QUERY }, intent: INTENT },
        config,
        createJevClassifier(config.jev, { TYPESAFE_API_KEY: 'stub-key' })
      );
    } finally {
      restore();
    }
    const writer = createSampleWriter(config);
    const requestId = '99999999-2222-3333-4444-555555555555';
    const path = writer.allocatePath(requestId);
    assert.deepEqual(
      writer.save({
        requestId,
        path,
        originalParams: { query: QUERY },
        braveParams: { query: QUERY },
        filterParams: { query: QUERY },
        intent: INTENT,
        preFilter: data,
        stats: filtered.stats,
        jevDispatch: filtered.jev_dispatch,
        jevRequests: filtered.jev_requests,
        payload: filtered.result,
        statusLine: filtered.stats.output.status_line ?? null,
      }),
      { status: 'saved' }
    );
    const sample = JSON.parse(readFileSync(path.absolute, 'utf8')) as SampleRecord;
    const jev = sample.jev!;
    assert.equal(jev.n_requests, 1);
    assert.equal(jev.input_tokens, 123);
    assert.deepEqual(jev.requests[0].answers?.s0__group0, {
      kind: 'choice',
      choice: 'ABC',
      probabilities: rawAnswers.s0__group0.probabilities,
    });
    assert.deepEqual(
      jev.sent[0].snippets.map((snippet) => [
        snippet.valid,
        snippet.applied,
        snippet.verdict,
        snippet.reason,
      ]),
      Array.from({ length: 4 }, () => [true, false, 'drop', 'filler'])
    );
    assert.equal(jev.sent[1].source_verdict_valid, false);
    assert.deepEqual(
      jev.sent[1].snippets.map((snippet) => [snippet.valid, snippet.applied, snippet.verdict]),
      [
        [true, true, 'drop'],
        [true, true, 'drop'],
        [true, true, 'drop'],
        [false, false, 'keep'],
      ]
    );
    assert.equal(jev.sent[1].snippets[3].invalid_reason, 'labels');
    assert.deepEqual(
      jev.sent[2].snippets.map((snippet) => snippet.verdict),
      ['keep', 'keep', 'keep', 'drop', 'drop', 'drop', 'drop']
    );
    assert.equal(jev.sent[2].snippets[0].invalid_reason, 'missing');
    assert.equal(jev.sent[2].snippets[6].keep_probability, 0.5);
    assert.equal(jev.sent[2].snippets[6].threshold, 0.5);
    // 0.5 恰达单片保留线：临界裁决删除，样本如实记录 gap 0，原概率与门槛不变。
    assert.equal(jev.sent[2].snippets[6].near_threshold_gap, 0);
    // 片段裁决删空来源时，不能把已经应用的概率误记成未应用。
    assert.deepEqual(
      jev.sent[3].snippets.map((snippet) => [
        snippet.valid,
        snippet.applied,
        snippet.verdict,
        snippet.reason,
      ]),
      [[true, true, 'drop', 'empty']]
    );
    assert.deepEqual(
      jev.sent[2].snippets.map((snippet) => [
        snippet.question,
        snippet.letter,
        snippet.question_sent,
      ]),
      [
        ['s2__group0', 'A', true],
        ['s2__group0', 'B', true],
        ['s2__group0', 'C', true],
        ['s2__group3', 'A', true],
        ['s2__group3', 'B', true],
        ['s2__group3', 'C', true],
        ['s2__group6', 'A', true],
      ]
    );
  });

  it('临界裁决落盘：页面先删、片段删空和坏组保留与 JSONL 一致', async () => {
    const config = configOf(join(root, 'near-threshold-audit'));
    const data: BraveLlmContextResponse = {
      grounding: {
        generic: [0, 1, 2, 3].map((source) => ({
          url: 'https://same.example/article',
          title: `Evidence ${source}`,
          snippets: [`${articleBody} Source ${source}.`],
        })),
        map: [],
      },
      sources: {},
    };
    const rawAnswers = {
      s0__filler: { type: 'noul', noul: 0.78 },
      s0__group0: { type: 'choice', probabilities: { none: 0.5, A: 0.5 } },
      s1__filler: { type: 'noul', noul: 0 },
      s1__group0: { type: 'choice', probabilities: { none: 0.5, A: 0.5 } },
      s2__filler: { type: 'noul', noul: 0 },
      s2__group0: { type: 'choice', probabilities: { none: 0.48, A: 0.52 } },
      s3__filler: { type: 'noul', noul: 0 },
      // 单项概率落在临界带内，但组合概率和无效，不能参与临界裁决。
      s3__group0: { type: 'choice', probabilities: { none: 0.6, A: 0.5 } },
    };
    const { captured, restore } = stubFetch(() => ({
      status: 200,
      text: async () =>
        JSON.stringify({
          model: DEFAULT_JEV_MODEL,
          answers: rawAnswers,
          usage: { input_tokens: 123 },
        }),
    }));
    let filtered: FilterResult;
    try {
      filtered = await filterLlmContext(
        data,
        { params: { query: QUERY }, intent: INTENT },
        config,
        createJevClassifier(config.jev, { TYPESAFE_API_KEY: 'stub-key' })
      );
    } finally {
      restore();
    }
    assert.equal(captured.length, 1);
    const writer = createSampleWriter(config);
    const requestId = '77777777-2222-3333-4444-555555555555';
    const path = writer.allocatePath(requestId);
    assert.equal(
      writer.save({
        requestId,
        path,
        originalParams: { query: QUERY },
        braveParams: { query: QUERY },
        filterParams: { query: QUERY },
        intent: INTENT,
        preFilter: data,
        stats: filtered.stats,
        jevDispatch: filtered.jev_dispatch,
        jevRequests: filtered.jev_requests,
        payload: filtered.result,
        statusLine: filtered.stats.output.status_line ?? null,
      }).status,
      'saved'
    );
    createLogWriter(config).write(filtered.stats, { requestId });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const sample = JSON.parse(readFileSync(path.absolute, 'utf8')) as SampleRecord;
    const logFile = readdirSync(config.logDir).find((file) => file.endsWith('.jsonl'))!;
    const log = JSON.parse(readFileSync(join(config.logDir, logFile), 'utf8'));
    const jev = sample.jev!;
    assert.deepEqual(JSON.parse(jev.requests[0].state!), captured[0].state);
    assert.deepEqual(jev.requests[0].questions, captured[0].questions);
    for (const [key, raw] of Object.entries(rawAnswers)) {
      if ('probabilities' in raw) {
        assert.deepEqual(jev.requests[0].answers?.[key], {
          kind: 'choice',
          probabilities: raw.probabilities,
        });
      } else {
        assert.deepEqual(jev.requests[0].answers?.[key], { kind: 'noul', probability: raw.noul });
      }
    }
    assert.equal(jev.per_source[0].near_threshold_gap, 0.02);
    assert.equal(jev.per_source[0].answers?.filler, 0.78);
    assert.deepEqual(
      jev.sent.map((source) => {
        const sn = source.snippets[0];
        return [sn.keep_probability, sn.threshold, sn.applied, sn.near_threshold_gap, sn.reason];
      }),
      [
        [0.5, 0.5, false, undefined, 'filler'],
        [0.5, 0.5, true, 0, 'empty'],
        [0.52, 0.5, true, 0.02, 'empty'],
        [null, 0.5, false, undefined, undefined],
      ]
    );
    assert.equal(jev.sent[3].snippets[0].invalid_reason, 'sum');
    assert.equal(jev.n_requests, 1);
    assert.equal(jev.input_tokens, 123);
    assert.deepEqual(log.jev.per_source, jev.per_source);
    assert.deepEqual(log.sources, sample.outcome!.sources);
    assert.deepEqual(log.decision_rules, sample.config_snapshot.decision_rules);
    assert.equal(log.filter_rules_version, sample.filter_rules_version);
    assert.equal(log.filter_rules_version, FILTER_RULES_VERSION);
    assert.equal(JSON.stringify(filtered.result).includes('near_threshold'), false);
    assert.deepEqual(filtered.result.grounding.generic, [data.grounding.generic[3]]);
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
