/**
 * 样本形状、身份对应与失败路径测试。
 * 真实管道配合回答桩验证映射；生产客户端配合 fetch 桩核对实发请求与落盘载荷。
 * 无派发证据时不得伪造输入；错误样本与保存失败应如实记录。
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import {
  DEFAULT_JEV_MODEL,
  DEFAULT_THRESHOLDS,
  GLOBAL_INSTRUCTION,
  QUESTION_SET_ID,
  SNIPPET_CRITERIA,
  SOURCE_QUESTIONS,
  snippetScoreInstructions,
} from './jev/questions.js';
import { createJevClassifier } from './jev/client.js';
import { filterLlmContext } from './pipeline.js';
import { createSampleWriter, type SampleRecord } from './sample.js';
import { createNoKeyJevStats, zeroLocal } from './stats.js';
import { FILTER_RULES_VERSION } from './version.js';
import type {
  BraveLlmContextResponse,
  ClassifyDeps,
  FilterConfig,
  FilterResult,
  FilterStats,
  JevDispatchRecord,
  JevRequestRecord,
  JevState,
} from './types.js';

const INTENT = 'What Brave Search is and how it differs from other engines';
const QUERY = 'brave browser';

/** test 配置，使用临时日志目录。 */
const configOf = (logDir: string, concurrency = 12): FilterConfig => ({
  mode: 'test',
  thresholds: { ...DEFAULT_THRESHOLDS },
  jev: {
    model: DEFAULT_JEV_MODEL,
    timeoutMs: 15000,
    concurrency,
  },
  logDir,
});

/**
 * 全保留合成 classify：按实际题表逐题给保留答案（noul 0.0 低于一切丢弃门槛、
 * score 2.0 满分），全局键原样回填——一次共享请求覆盖全部候选（当前题库四来源题 +
 * 每片段一道评分题，键为 `{sourceId}__{localKey}` 命名空间）。
 */
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

/**
 * 身份夹具：s0 带 JSON-LD（articleBody + FAQ → .part 拆分）；s1 与 s0 同主域
 * （www + utm 跟踪参数）→ 独立候选各自保留；s2 页内逐字重复被删；
 * s3 空白片段 → 阶段 6 整源丢弃。保留片段长于 200 字符且含 query 实词。
 */
const articleBody =
  'Brave search deeply analyzes the rendering pipeline of version 2.1 with specific benchmarks ' +
  'and profiling data that no other outlet covered in the same detail. The author reverse ' +
  'engineered the scheduler and documented every queue transition with timings.';

const mergedBody =
  'An independent follow-up from the mirrored copy of the brave search post with additional ' +
  'numbers about the rendering pipeline that the first entry did not include in its text. ' +
  'The measurements cover cold start and warm query paths with per-stage breakdowns.';

const uniqueBody =
  'B first unique snippet about brave browser privacy features and independent analysis worth ' +
  'keeping around for sure because it contains specific measurements and quotes.';

const richResponse: BraveLlmContextResponse = {
  grounding: {
    generic: [
      {
        url: 'https://a.example/post',
        title: 'A Post',
        snippets: [
          JSON.stringify({
            articleBody,
            mainEntity: [
              {
                name: 'What is brave search?',
                acceptedAnswer: {
                  text: 'Brave is a privacy-focused browser and search engine with an independent index.',
                },
              },
            ],
            author: 'Someone',
            datePublished: '2026-01-01',
          }),
        ],
      },
      {
        url: 'https://www.a.example/post?utm_source=x',
        title: 'A Post (www)',
        snippets: [mergedBody],
      },
      {
        url: 'https://b.example/',
        title: 'B Page',
        snippets: [uniqueBody, uniqueBody],
      },
      {
        url: 'https://c.example/',
        title: 'C Empty',
        snippets: ['   '],
      },
    ],
    map: [],
  },
  sources: {
    'https://a.example/post': { title: 'A Post', hostname: 'a.example', age: [] },
    'https://www.a.example/post?utm_source=x': { title: 'A Post (www)', hostname: 'a.example' },
    'https://b.example/': { title: 'B Page', hostname: 'b.example', age: [] },
    'https://c.example/': { title: 'C Empty', hostname: 'c.example', age: [] },
  },
};

/** 跑真实管道取生产口径的 FilterResult（stats + 派发与请求记录；步 10 状态行已写入）。 */
const runPipeline = async (config: FilterConfig): Promise<FilterResult> =>
  filterLlmContext(richResponse, { params: { query: QUERY }, intent: INTENT }, config, {
    classify: keepAllClassify,
  });

/** 零内容统计对象（目录自愈 / 原子形状用例不需要真实管道）。 */
const emptyStats = (mode: FilterStats['mode']): FilterStats => ({
  mode,
  request: { query: QUERY, intent: INTENT, max_urls: 20, max_tokens: 8192 },
  brave: { n_sources: 0, n_snippets: 0, chars: 0, est_tokens: 0 },
  local: { ...zeroLocal },
  sources: [],
  jev: null,
  output: { n_sources: 0, n_snippets: 0, chars: 0, est_tokens: 0 },
  shadow_diff: null,
});

/** fetch 桩的类型收窄辅助：捕获请求体并返回应答。 */
type CapturedRequest = { model: string; state: JevState; questions: Record<string, unknown> };

/**
 * 安装 fetch 桩：截获每次请求体（JSON parse 后入列），按 `respond` 产应答。
 * 返回卸载函数（finally 里恢复，避免污染其他测试）。
 */
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

/** 桩应答构造：对截获的题表逐题给答案（score 题 2 分、noul 题按 0.9/0 给出）。 */
const answeredText = (body: CapturedRequest): string => {
  const answers: Record<string, unknown> = {};
  for (const [key, question] of Object.entries(body.questions)) {
    const typed = question as { type?: string };
    answers[key] =
      typed.type === 'score' ? { type: 'score', score: 2 } : { type: 'noul', noul: 0.9 };
  }
  return JSON.stringify({ model: 'jev-1.13.0', answers, usage: { input_tokens: 20 } });
};

describe('QUESTION_SET_ID', () => {
  it('is 12 lowercase hex chars derived from the normalized question bank (recipe pinned)', () => {
    assert.match(QUESTION_SET_ID, /^[0-9a-f]{12}$/);
    // 独立核对哈希配方：总指令、来源题、完整评分模板 (0,0) 和 criteria。
    const expected = createHash('sha256')
      .update(
        JSON.stringify([
          GLOBAL_INSTRUCTION,
          SOURCE_QUESTIONS,
          snippetScoreInstructions(0, 0),
          SNIPPET_CRITERIA,
        ])
      )
      .digest('hex')
      .slice(0, 12);
    assert.equal(QUESTION_SET_ID, expected);
  });
});

describe('createSampleWriter', () => {
  const root = mkdtempSync(join(tmpdir(), 'jev-sample-test-'));

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  // 生产客户端接收异常但可解析的响应，核对实发、逐题有效性与实际裁决三种事实。
  // legacy-extra-answer：旧 v3 十题录制回放时响应多出当前题库外的旧键——验证解析
  // 层收下额外键、管道按当前四题收集（旧键不进 per_source.answers）、裁决不受影响。
  for (const scenario of [
    'complete',
    'missing-score',
    'wrong-score-type',
    'negative-score',
    'above-range',
    'nonfinite-score',
    'missing-source-answer',
    'legacy-extra-answer',
    'source-drop',
  ]) {
    it(`preserves answer evidence without inventing valid scores: ${scenario}`, async () => {
      const config = configOf(join(root, `answer-evidence-${scenario}`));
      const response: BraveLlmContextResponse = {
        grounding: {
          generic: [
            {
              url: 'https://a.example/article',
              title: 'Brave analysis',
              snippets: [articleBody, uniqueBody],
            },
          ],
          map: [],
        },
        sources: {},
      };
      const { captured, restore } = stubFetch((body) => {
        const answers: Record<string, { type: string; score?: number | string; noul?: number }> =
          {};
        for (const [key, question] of Object.entries(body.questions)) {
          answers[key] =
            (question as { type: string }).type === 'score'
              ? { type: 'score', score: key === 's0__snip0' ? 2 : 0.4 }
              : { type: 'noul', noul: key === 's0__has_original_reasoning' ? 0.9 : 0 };
        }
        if (scenario === 'missing-score') delete answers['s0__snip0'];
        if (scenario === 'wrong-score-type') answers['s0__snip0'] = { type: 'noul', noul: 0 };
        if (scenario === 'negative-score') answers['s0__snip0'].score = -1;
        if (scenario === 'above-range') answers['s0__snip0'].score = 3;
        if (scenario === 'nonfinite-score') answers['s0__snip0'].score = 'overflow';
        if (scenario === 'missing-source-answer') delete answers['s0__is_listing'];
        if (scenario === 'legacy-extra-answer')
          answers.worth_keeping = { type: 'noul', noul: 0.42 };
        if (scenario === 'source-drop') answers['s0__is_off_topic'].noul = 1;
        const text = JSON.stringify({
          model: DEFAULT_JEV_MODEL,
          answers,
          usage: { input_tokens: 20 },
        }).replace('"score":"overflow"', '"score":1e309');
        return { status: 200, text: () => Promise.resolve(text) };
      });
      let result: FilterResult;
      try {
        result = await filterLlmContext(
          response,
          { params: { query: QUERY }, intent: INTENT },
          config,
          createJevClassifier(config.jev, { TYPESAFE_API_KEY: 'stub-key' })
        );
      } finally {
        restore();
      }
      assert.equal(captured.length, 1);
      const writer = createSampleWriter(config);
      const path = writer.allocatePath(scenario);
      assert.equal(
        writer.save({
          requestId: scenario,
          path,
          originalParams: { query: QUERY },
          braveParams: { query: QUERY },
          filterParams: { query: QUERY },
          intent: INTENT,
          preFilter: response,
          stats: result.stats,
          jevDispatch: result.jev_dispatch,
          jevRequests: result.jev_requests,
          payload: result.result,
          statusLine: result.stats.output.status_line ?? null,
        }).status,
        'saved'
      );
      const sample = JSON.parse(readFileSync(path.absolute, 'utf8')) as SampleRecord;
      // v5：实发载荷在请求级（一次共享请求覆盖全部候选），来源行经 request_id 引用
      assert.equal(sample.jev!.requests.length, 1);
      const request = sample.jev!.requests[0]!;
      const sent = sample.jev!.sent[0]!;
      assert.equal(sent.request_id, request.request_id);
      // v5 请求级记录无模式切换字段（all-only：一次搜索至多一条共享请求）
      for (const retired of [
        'mode',
        'requested',
        'effective',
        'fallback_reason',
        'planned_estimates',
      ]) {
        assert.equal(
          Object.hasOwn(request, retired),
          false,
          `v5 request must not carry retired key '${retired}'`
        );
      }
      assert.deepEqual(request.source_ids, ['s0']);
      assert.equal(request.dispatched, true);
      assert.equal(request.answered, true);
      assert.equal(request.usage_complete, true);
      assert.equal(request.input_tokens, 20);
      assert.equal(request.model, DEFAULT_JEV_MODEL);
      assert.ok(typeof request.http_attempts === 'number' && request.http_attempts >= 1);
      assert.deepEqual(JSON.parse(request.state!), captured[0]!.state);
      assert.deepEqual(request.questions, captured[0]!.questions);
      assert.deepEqual(request.mapping, [
        {
          source_id: 's0',
          array_index: 0,
          snippet_keys: ['0', '1'],
          // 局部键 → 全局键（{sourceId}__{localKey}）；全局题键从截获请求推导
          question_keys: Object.fromEntries(
            Object.keys(captured[0]!.questions).map((key) => [
              key.startsWith('s0__') ? key.slice('s0__'.length) : key,
              key,
            ])
          ),
        },
      ]);
      assert.equal(sent.dispatched, true);
      assert.equal(sent.answered, true, '收到可解析响应与来源裁决有效性独立');
      assert.equal(sent.source_verdict_valid, scenario !== 'missing-source-answer');
      assert.ok(sent.snippets.every((snippet) => snippet.in_state && snippet.score_question_sent));
      const invalidFirst = [
        'missing-score',
        'wrong-score-type',
        'negative-score',
        'above-range',
        'nonfinite-score',
      ].includes(scenario);
      assert.deepEqual(
        sent.snippets.map((snippet) => snippet.scored),
        [!invalidFirst, true]
      );
      const firstScore =
        scenario === 'negative-score'
          ? -1
          : scenario === 'above-range'
            ? 3
            : invalidFirst
              ? null
              : 2;
      assert.deepEqual(
        sent.snippets.map((snippet) => snippet.score),
        [firstScore, 0.4]
      );
      const incomplete = ['missing-score', 'wrong-score-type'].includes(scenario);
      const droppedSource = scenario === 'source-drop';
      assert.deepEqual(
        sent.snippets.map((snippet) => snippet.score_applied),
        [!invalidFirst && !droppedSource, !incomplete && !droppedSource]
      );
      if (incomplete) {
        assert.equal(sample.jev!.per_source[0].snippet_scores, undefined);
        assert.equal(
          result.result.grounding.generic[0].snippets.length,
          2,
          '部分缺答仍跳过整组裁决，但样本保留后续评分而不将位置前移'
        );
      }
      if (scenario === 'missing-source-answer') {
        assert.equal(sample.jev!.per_source[0].fail_kind, 'validation');
      }
      if (scenario === 'legacy-extra-answer') {
        // 旧键回答被解析层收下、被当前题库的收集层忽略；四键齐全即有效裁决，
        // 不因响应里多了历史字段而误判 validation 或改变裁决
        assert.equal(sent.source_verdict_valid, true);
        const collected = sample.jev!.per_source[0].answers ?? {};
        assert.deepEqual(Object.keys(collected).sort(), [
          'has_original_reasoning',
          'is_listing',
          'is_off_topic',
          'is_template_filler',
        ]);
        // 旧键在请求级原始答案里如实保留（全局键），不进投影
        assert.equal(Object.hasOwn(request.answers ?? {}, 'worth_keeping'), true);
        assert.equal(Object.hasOwn(collected, 'worth_keeping'), false);
      }
    });
  }

  it('writes a pretty sample with stable field order, config snapshot and program ids', async () => {
    const logDir = join(root, 'shape', 'logs');
    const config = configOf(logDir);
    const { stats, jev_dispatch, jev_requests } = await runPipeline(config);
    stats.brave.latency_ms = 12;
    const payload = { grounding: { generic: [], map: [] }, output: stats.output };
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

    const raw = readFileSync(path.absolute, 'utf8');
    const sample = JSON.parse(raw) as Record<string, unknown>;
    // pretty 格式：两空格缩进 + 末尾换行（整份重序列化逐字一致即证明）
    assert.equal(raw, `${JSON.stringify(sample, null, 2)}\n`);

    // 核对字段完整性与稳定顺序。
    assert.deepEqual(Object.keys(sample), [
      'format_version',
      'request_id',
      'ts',
      'mode',
      'request',
      'pre_filter',
      'final_return',
      'outcome',
      'jev',
      'config_snapshot',
      'question_set_id',
      'context_layout_id',
      'filter_program_version',
      'filter_rules_version',
    ]);
    assert.equal(sample.format_version, 6);
    assert.equal(sample.request_id, requestId);
    assert.match(String(sample.ts), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/);
    assert.equal(sample.mode, 'test');
    assert.deepEqual(sample.request, {
      params: { query: QUERY, count: 3 },
      brave_params: { query: QUERY, maximum_number_of_urls: 10 },
      intent: INTENT,
    });
    // pre_filter 原样：全部四个来源（含后来被删的）按 Brave 原序
    const preFilter = sample.pre_filter as BraveLlmContextResponse;
    assert.deepEqual(
      preFilter.grounding.generic.map((item) => item.url),
      [
        'https://a.example/post',
        'https://www.a.example/post?utm_source=x',
        'https://b.example/',
        'https://c.example/',
      ]
    );
    // final_return 原样回放
    assert.deepEqual(sample.final_return, { payload, status_line: statusLine });

    // 配置快照只包含生效配置，Jev 组为模型、超时和并发。
    const snapshot = sample.config_snapshot as Record<string, unknown>;
    assert.deepEqual(Object.keys(snapshot), ['thresholds', 'jev', 'mode']);
    assert.deepEqual(snapshot.thresholds, {
      off_topic_drop: DEFAULT_THRESHOLDS.offTopicDrop,
      listing_drop: DEFAULT_THRESHOLDS.listingDrop,
      filler_drop: DEFAULT_THRESHOLDS.fillerDrop,
      reasoning_protect: DEFAULT_THRESHOLDS.reasoningProtect,
      snippet_min: DEFAULT_THRESHOLDS.snippetMin,
      min_facts: DEFAULT_THRESHOLDS.minFacts,
      novelty_min: DEFAULT_THRESHOLDS.noveltyMin,
      cjk_bonus: DEFAULT_THRESHOLDS.cjkBonus,
      cjk_share: DEFAULT_THRESHOLDS.cjkShare,
    });
    assert.deepEqual(Object.keys(snapshot.jev as Record<string, unknown>), [
      'model',
      'timeout_ms',
      'concurrency',
    ]);
    assert.deepEqual(snapshot.jev, {
      model: DEFAULT_JEV_MODEL,
      timeout_ms: 15000,
      concurrency: 12,
    });
    assert.equal(snapshot.mode, 'test');

    // 题库、包版本与规则版本分别核对。
    assert.match(String(sample.question_set_id), /^[0-9a-f]{12}$/);
    assert.equal(sample.filter_program_version, '2.1.4');
    assert.equal(sample.filter_rules_version, FILTER_RULES_VERSION);
  });

  it('carries stable snippet identities: JSON-LD split (.part), in-page dup and empty-source exclusion', async () => {
    const logDir = join(root, 'identity', 'logs');
    const config = configOf(logDir);
    const { stats, jev_dispatch, jev_requests } = await runPipeline(config);
    const writer = createSampleWriter(config);
    const requestId = '22222222-2222-3333-4444-555555555555';
    const path = writer.allocatePath(requestId);
    assert.deepEqual(
      writer.save({
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
        payload: { output: stats.output },
        statusLine: stats.output.status_line ?? null,
      }),
      { status: 'saved' }
    );

    const sample = JSON.parse(readFileSync(path.absolute, 'utf8')) as {
      jev: {
        status: string;
        n_requests: number;
        per_source: Array<{ src: string; status: string; snippet_scores?: number[] }>;
        requests: Array<{
          request_id: string;
          dispatched: boolean;
          state: string | null;
          questions: Record<string, unknown> | null;
        }>;
        sent: Array<{
          src: string;
          request_id?: string;
          dispatched: boolean;
          answered: boolean;
          snippets: Array<{
            snippet: string;
            position: number;
            in_state: boolean;
            score_question_sent: boolean;
            scored: boolean;
            text: string;
          }>;
        }>;
      };
      outcome: {
        sources: Array<{
          index: number;
          verdict: string;
          reason?: string;
          snippets: Array<{
            index: number;
            part?: number;
            kept: boolean;
            reason?: string;
          }>;
        }>;
      };
    };

    // 核对删除项的来源、片段身份和原因：空来源和页内重复应能分别定位。
    const outcomeByIndex = new Map(sample.outcome.sources.map((row) => [row.index, row]));
    assert.equal(outcomeByIndex.get(1)?.verdict, 'keep');
    assert.equal(outcomeByIndex.get(3)?.verdict, 'drop');
    assert.equal(outcomeByIndex.get(3)?.reason, 'empty');
    const bSnippets = outcomeByIndex.get(2)?.snippets ?? [];
    assert.equal(bSnippets[1]?.kept, false);
    assert.equal(bSnippets[1]?.reason, 'dup');

    // Jev 判断：s0, s1 与 s2 answered 且片段分数齐备（2, 1 与 1）
    assert.equal(sample.jev.status, 'ok');
    const perSource = new Map(sample.jev.per_source.map((row) => [row.src, row]));
    assert.equal(perSource.get('s0')?.status, 'answered');
    assert.deepEqual(perSource.get('s0')?.snippet_scores, [2, 2]);
    assert.equal(perSource.get('s1')?.status, 'answered');
    assert.deepEqual(perSource.get('s1')?.snippet_scores, [2]);
    assert.equal(perSource.get('s2')?.status, 'answered');
    assert.deepEqual(perSource.get('s2')?.snippet_scores, [2]);

    // 实发映射：全部 keep 来源已取得回答；s3 的片段在预筛已被删光（最终整源 drop），是
    // "无内容可发"的 skipped——不再从 jev 段隐身
    assert.deepEqual(
      sample.jev.sent.map((entry) => entry.src),
      ['s0', 's1', 's2', 's3']
    );
    // 注入面（合成 classify）无实发载荷：一次共享请求覆盖 s0, s1 与 s2，载荷为 null
    // ——v5 的 in_state / score_question_sent 按映射对实发载荷检查，无载荷即
    // false，绝不按 answered 冒充"已提交"；answered 无 dispatch 计零请求
    assert.equal(sample.jev.requests.length, 1);
    assert.equal(sample.jev.requests[0]!.state, null);
    assert.equal(sample.jev.requests[0]!.questions, null);
    assert.equal(sample.jev.n_requests, 0);
    const s0 = sample.jev.sent[0]!;
    assert.equal(s0.dispatched, false);
    assert.equal(s0.answered, true);
    assert.ok(s0.request_id, 'request_id links the source row to its request record');
    assert.equal(sample.jev.sent[1]!.request_id, s0.request_id, 's1 shares the same request');
    assert.equal(sample.jev.sent[2]!.request_id, s0.request_id, 's2 shares the same request');
    assert.deepEqual(
      s0.snippets.map((snippet) => [
        snippet.snippet,
        snippet.position,
        snippet.in_state,
        snippet.score_question_sent,
        snippet.scored,
      ]),
      [
        ['0.0', 0, false, false, true], // JSON-LD 拆分 part 0
        ['0.1', 1, false, false, true], // JSON-LD 拆分 part 1
      ]
    );
    assert.equal(s0.snippets[0]?.text, articleBody);

    const s1 = sample.jev.sent[1]!;
    assert.deepEqual(
      s1.snippets.map((snippet) => [
        snippet.snippet,
        snippet.position,
        snippet.in_state,
        snippet.score_question_sent,
        snippet.scored,
      ]),
      [['0', 0, false, false, true]]
    );
    assert.equal(s1.snippets[0]?.text, mergedBody);

    // s2：页内重复删掉第二片段，候选只有幸存第一片段
    const s2 = sample.jev.sent[2]!;
    assert.deepEqual(
      s2.snippets.map((snippet) => [snippet.snippet, snippet.in_state, snippet.scored]),
      [['0', false, true]]
    );
    assert.equal(s2.snippets[0]?.text, uniqueBody);
  });

  it('records the real dispatched payload deep-equal to the intercepted request when the full payload is sent (review R1)', async () => {
    // 使用长 CJK 片段核对完整载荷直接发送；样本必须与 fetch 截获请求深相等。
    // 删除正文、题目或拆分请求都应导致断言失败。
    const logDir = join(root, 'full-send', 'logs');
    const config = configOf(logDir);
    const giant = '資料'.repeat(16000);
    const response: BraveLlmContextResponse = {
      grounding: {
        generic: [
          {
            url: 'https://a.example/article',
            title: 'Brave analysis',
            snippets: [articleBody, giant],
          },
        ],
        map: [],
      },
      sources: { 'https://a.example/article': { title: 'Brave analysis' } },
    };
    const { captured, restore } = stubFetch((body) => ({
      status: 200,
      text: () => Promise.resolve(answeredText(body)),
    }));
    let dispatched: FilterResult;
    try {
      dispatched = await filterLlmContext(
        response,
        { params: { query: QUERY }, intent: INTENT },
        config,
        {
          classify: createJevClassifier(config.jev, { TYPESAFE_API_KEY: 'stub-key' }).classify,
        }
      );
    } finally {
      restore();
    }
    // 一次共享请求、一次 HTTP 尝试；实发 state 完整携带两段片段、snip 题齐全
    assert.equal(captured.length, 1);
    const lastRequest = captured[0]!;
    assert.deepEqual(
      lastRequest.state.sources.map((source) => source.snippets.length),
      [2]
    );
    assert.equal(lastRequest.state.sources[0]!.snippets[1], giant);
    // 题键为 {sourceId}__{localKey} 命名空间：两道评分题都随请求提交
    assert.deepEqual(
      Object.keys(lastRequest.questions)
        .filter((key) => /__snip\d+$/.test(key))
        .sort(),
      ['s0__snip0', 's0__snip1']
    );

    const writer = createSampleWriter(config);
    const requestId = '33333333-2222-3333-4444-555555555555';
    const path = writer.allocatePath(requestId);
    writer.save({
      requestId,
      path,
      originalParams: { query: QUERY },
      braveParams: { query: QUERY },
      filterParams: { query: QUERY },
      intent: INTENT,
      preFilter: response,
      stats: dispatched.stats,
      jevDispatch: dispatched.jev_dispatch,
      jevRequests: dispatched.jev_requests,
      payload: { output: dispatched.stats.output },
      statusLine: dispatched.stats.output.status_line ?? null,
    });

    const sample = JSON.parse(readFileSync(path.absolute, 'utf8')) as {
      jev: {
        n_requests: number;
        n_http_attempts: number;
        per_source: Array<{ src: string; status: string }>;
        requests: Array<{
          request_id: string;
          dispatched: boolean;
          state: string | null;
          questions: Record<string, unknown> | null;
        }>;
        sent: Array<{
          src: string;
          request_id?: string;
          dispatched: boolean;
          answered: boolean;
          snippets: Array<{
            snippet: string;
            in_state: boolean;
            score_question_sent: boolean;
            scored: boolean;
            text: string;
          }>;
        }>;
      };
    };
    // v5 无 ladder / sent_snippets 记账（整批一次请求，无逐源缩减动作）
    for (const row of sample.jev.per_source) {
      assert.equal(Object.hasOwn(row, 'ladder'), false);
      assert.equal(Object.hasOwn(row, 'sent_snippets'), false);
    }
    // 请求记录必须与 fetch 截获的完整 state 相等。
    assert.equal(sample.jev.requests.length, 1);
    const request = sample.jev.requests[0]!;
    assert.equal(request.dispatched, true);
    assert.ok(request.state, 'dispatched request must carry the input evidence');
    assert.deepEqual(JSON.parse(request.state), lastRequest.state);
    assert.deepEqual(request.questions, lastRequest.questions);
    assert.equal(sample.jev.n_requests, 1);
    assert.equal(sample.jev.n_http_attempts, 1);
    const s0 = sample.jev.sent[0]!;
    assert.equal(s0.request_id, request.request_id);
    assert.equal(s0.dispatched, true);
    // 状态三维拆分：两段都进实发 state、题都提交、都有有效评分——各字段独立表达
    assert.deepEqual(
      s0.snippets.map((snippet) => [
        snippet.snippet,
        snippet.in_state,
        snippet.score_question_sent,
        snippet.scored,
      ]),
      [
        ['0', true, true, true],
        ['1', true, true, true],
      ]
    );
    // 候选口径文本与实发文本一致（完整发送，无缩减）
    assert.equal(s0.snippets[0]?.text, articleBody);
    assert.equal(s0.snippets[1]?.text, giant);
  });

  it('keeps the input evidence of a dispatched-but-failed request (HTTP 422) without calling it unsent (review R1)', async () => {
    const logDir = join(root, 'http-failed', 'logs');
    const config = configOf(logDir);
    const response: BraveLlmContextResponse = {
      grounding: {
        generic: [
          { url: 'https://a.example/article', title: 'Brave analysis', snippets: [articleBody] },
        ],
        map: [],
      },
      sources: { 'https://a.example/article': { title: 'Brave analysis' } },
    };
    const { captured, restore } = stubFetch(() => ({
      status: 422,
      text: () => Promise.resolve('invalid request'),
    }));
    let failed: FilterResult;
    try {
      failed = await filterLlmContext(
        response,
        { params: { query: QUERY }, intent: INTENT },
        config,
        {
          classify: createJevClassifier(config.jev, { TYPESAFE_API_KEY: 'stub-key' }).classify,
        }
      );
    } finally {
      restore();
    }
    assert.equal(captured.length, 1, 'validation failures must not retry');
    const lastRequest = captured[0]!;
    const row = failed.stats.jev?.per_source[0];
    assert.equal(row?.status, 'failed');
    assert.equal(row?.fail_kind, 'validation');

    const writer = createSampleWriter(config);
    const requestId = '44444444-2222-3333-4444-555555555555';
    const path = writer.allocatePath(requestId);
    writer.save({
      requestId,
      path,
      originalParams: { query: QUERY },
      braveParams: { query: QUERY },
      filterParams: { query: QUERY },
      intent: INTENT,
      preFilter: response,
      stats: failed.stats,
      jevDispatch: failed.jev_dispatch,
      jevRequests: failed.jev_requests,
      payload: { output: failed.stats.output },
      statusLine: failed.stats.output.status_line ?? null,
    });

    const sample = JSON.parse(readFileSync(path.absolute, 'utf8')) as {
      jev: {
        requests: Array<{
          request_id: string;
          dispatched: boolean;
          answered: boolean;
          state: string | null;
          questions: Record<string, unknown> | null;
          input_tokens: number | null;
          usage_complete: boolean;
          fail_kind?: string;
        }>;
        sent: Array<{
          request_id?: string;
          dispatched: boolean;
          answered: boolean;
        }>;
      };
    };
    // 请求级：已派发但失败 ≠ 未发送——dispatched true、实发载荷保留、usage 未知不伪称
    assert.equal(sample.jev.requests.length, 1);
    const request = sample.jev.requests[0]!;
    assert.equal(request.dispatched, true);
    assert.equal(request.answered, false);
    assert.equal(request.fail_kind, 'validation');
    assert.equal(request.input_tokens, null);
    assert.equal(request.usage_complete, false);
    assert.ok(request.state, 'a dispatched request must keep its input evidence');
    assert.deepEqual(JSON.parse(request.state), lastRequest.state);
    assert.deepEqual(request.questions, lastRequest.questions);
    // 来源级：引用请求，answered 独立记 false
    const s0 = sample.jev.sent[0]!;
    assert.equal(s0.request_id, request.request_id);
    assert.equal(s0.dispatched, true);
    assert.equal(s0.answered, false);
  });

  it('keeps the dispatched-but-failed shared request with retry attempts in the sample (review R1)', async () => {
    // 生产客户端 + fetch 桩网络失败：一次共享请求重试 RETRY_ATTEMPTS(3) 次后放弃
    // ——请求级账目 n_requests=1、n_http_attempts=3，实发 state 保留作输入证据；
    // 覆盖的四个来源都按"未完成 Jev 判断"保守保留，不拆成逐来源请求。
    const logDir = join(root, 'network-retry', 'logs');
    const config = configOf(logDir);
    const sources = ['s0', 's1', 's2', 's3'].map((_, index) => ({
      url: `https://host${index}.example/post`,
      title: `Post ${index}`,
      snippets: [`${articleBody} variant ${index}`],
    }));
    const response: BraveLlmContextResponse = {
      grounding: { generic: sources, map: [] },
      sources: Object.fromEntries(sources.map((source) => [source.url, { title: source.title }])),
    };
    const { captured, restore } = stubFetch(() => {
      throw new Error('injected network failure');
    });
    let degraded: FilterResult;
    try {
      degraded = await filterLlmContext(
        response,
        { params: { query: QUERY }, intent: INTENT },
        config,
        {
          classify: createJevClassifier(
            config.jev,
            { TYPESAFE_API_KEY: 'stub-key' },
            { sleep: () => Promise.resolve() }
          ).classify,
        }
      );
    } finally {
      restore();
    }
    assert.equal(captured.length, 3, 'one shared request retries three times in total');
    assert.equal(degraded.stats.jev?.status, 'degraded');

    const writer = createSampleWriter(config);
    const requestId = '55555555-aaaa-3333-4444-555555555555';
    const path = writer.allocatePath(requestId);
    writer.save({
      requestId,
      path,
      originalParams: { query: QUERY },
      braveParams: { query: QUERY },
      filterParams: { query: QUERY },
      intent: INTENT,
      preFilter: response,
      stats: degraded.stats,
      jevDispatch: degraded.jev_dispatch,
      jevRequests: degraded.jev_requests,
      payload: { output: degraded.stats.output },
      statusLine: degraded.stats.output.status_line ?? null,
    });

    const sample = JSON.parse(readFileSync(path.absolute, 'utf8')) as {
      jev: {
        n_requests: number;
        n_http_attempts: number;
        per_source: Array<{ src: string; status: string; fail_kind?: string }>;
        requests: Array<{
          request_id: string;
          source_ids: string[];
          dispatched: boolean;
          answered: boolean;
          state: string | null;
          input_tokens: number | null;
          usage_complete: boolean;
          fail_kind?: string;
          http_attempts?: number;
        }>;
        sent: Array<{
          src: string;
          request_id?: string;
          dispatched: boolean;
          answered: boolean;
        }>;
      };
    };
    // 请求级账目：一次共享请求（4 来源）、已派发但失败——N 来源不冒充 N 次请求，
    // 重试次数如实记录、实发 state 保留、usage 未知不伪称
    assert.equal(sample.jev.requests.length, 1);
    assert.equal(sample.jev.n_requests, 1);
    assert.equal(sample.jev.n_http_attempts, 3);
    const request = sample.jev.requests[0]!;
    assert.deepEqual(request.source_ids, ['s0', 's1', 's2', 's3']);
    assert.equal(request.dispatched, true);
    assert.equal(request.answered, false);
    assert.ok(request.state, 'dispatched-but-failed keeps its input evidence');
    assert.equal(request.fail_kind, 'network');
    assert.equal(request.input_tokens, null);
    assert.equal(request.usage_complete, false);
    assert.equal(request.http_attempts, 3);
    // 来源级：四行都引用同一请求、都未完成检查
    assert.deepEqual(
      sample.jev.sent.map((entry) => [
        entry.src,
        entry.request_id,
        entry.dispatched,
        entry.answered,
      ]),
      [
        ['s0', request.request_id, true, false],
        ['s1', request.request_id, true, false],
        ['s2', request.request_id, true, false],
        ['s3', request.request_id, true, false],
      ]
    );
    for (const row of sample.jev.per_source) {
      assert.equal(row.status, 'failed');
      assert.equal(row.fail_kind, 'network');
    }
  });

  it('marks skipped sources (nothing to dispatch) distinctly from sent ones', async () => {
    // 第一来源正常片段 → 进入共享请求（生产客户端实发）；第二来源片段全空白 →
    // 本地规则删光 → skipped 占位（零 fetch、无请求记录）。
    const logDir = join(root, 'skip', 'logs');
    const config = configOf(logDir, 1);
    const response: BraveLlmContextResponse = {
      grounding: {
        generic: [
          { url: 'https://a.example/post', title: 'A Post', snippets: [articleBody] },
          { url: 'https://b.example/post', title: 'B Page', snippets: ['   '] },
        ],
        map: [],
      },
      sources: {
        'https://a.example/post': { title: 'A Post' },
        'https://b.example/post': { title: 'B Page' },
      },
    };
    const { captured, restore } = stubFetch((body) => ({
      status: 200,
      text: () => Promise.resolve(answeredText(body)),
    }));
    let result: FilterResult;
    try {
      result = await filterLlmContext(
        response,
        { params: { query: QUERY }, intent: INTENT },
        config,
        {
          classify: createJevClassifier(config.jev, { TYPESAFE_API_KEY: 'stub-key' }).classify,
        }
      );
    } finally {
      restore();
    }
    assert.equal(captured.length, 1, 'only the source with content enters the shared request');

    const writer = createSampleWriter(config);
    const requestId = '66666666-aaaa-3333-4444-555555555555';
    const path = writer.allocatePath(requestId);
    writer.save({
      requestId,
      path,
      originalParams: { query: QUERY },
      braveParams: { query: QUERY },
      filterParams: { query: QUERY },
      intent: INTENT,
      preFilter: response,
      stats: result.stats,
      jevDispatch: result.jev_dispatch,
      jevRequests: result.jev_requests,
      payload: { output: result.stats.output },
      statusLine: result.stats.output.status_line ?? null,
    });

    const sample = JSON.parse(readFileSync(path.absolute, 'utf8')) as {
      jev: {
        n_requests: number;
        requests: Array<{
          request_id: string;
          source_ids: string[];
          dispatched: boolean;
          state: string | null;
          questions: Record<string, unknown> | null;
        }>;
        sent: Array<{
          src: string;
          request_id?: string;
          dispatched: boolean;
          not_dispatched_reason?: string;
          snippets: Array<{ in_state: boolean; score_question_sent: boolean }>;
        }>;
      };
    };
    // 正常来源进共享请求计一；skipped 占位不构造请求
    assert.equal(sample.jev.n_requests, 1);
    assert.equal(sample.jev.requests.length, 1);
    const request = sample.jev.requests[0]!;
    assert.deepEqual(request.source_ids, ['s0']);
    assert.equal(request.dispatched, true);
    assert.ok(request.state, 'the dispatched shared request keeps its input evidence');
    const sent = new Map(sample.jev.sent.map((entry) => [entry.src, entry]));
    const s0 = sent.get('s0');
    assert.ok(s0, 's0 must appear in the dispatch map');
    assert.equal(s0.dispatched, true);
    assert.deepEqual(
      s0.snippets.map((snippet) => snippet.in_state),
      [true]
    );
    assert.deepEqual(
      s0.snippets.map((snippet) => snippet.score_question_sent),
      [true]
    );
    const s1 = sent.get('s1');
    assert.ok(s1, 'skipped sources appear with their own reason');
    assert.equal(s1.dispatched, false);
    assert.equal(s1.not_dispatched_reason, 'skipped');
    assert.equal(s1.request_id, undefined, 'skipped sources have no request record');
  });

  it('records the no_key jev body verbatim with an empty dispatch map', async () => {
    const logDir = join(root, 'no-key', 'logs');
    const config = configOf(logDir);
    const { stats, jev_dispatch } = await runPipeline(config);
    stats.jev = createNoKeyJevStats(); // no_key：零值对象，per_source 空

    const writer = createSampleWriter(config);
    const requestId = '77777777-2222-3333-4444-555555555555';
    const path = writer.allocatePath(requestId);
    writer.save({
      requestId,
      path,
      originalParams: { query: QUERY },
      braveParams: { query: QUERY },
      filterParams: { query: QUERY },
      intent: INTENT,
      preFilter: richResponse,
      stats,
      jevDispatch: jev_dispatch,
      jevRequests: [],
      payload: { output: stats.output },
      statusLine: stats.output.status_line ?? null,
    });

    const sample = JSON.parse(readFileSync(path.absolute, 'utf8')) as {
      jev: {
        status: string;
        n_requests: number;
        per_source: unknown[];
        sent: Array<{ src: string; dispatched: boolean; answered: boolean }>;
      };
    };
    // no_key 如实记账（不伪装成完成检查）；注入面 answered 的派发记录不冒充实发
    assert.equal(sample.jev.status, 'no_key');
    assert.equal(sample.jev.n_requests, 0);
    assert.deepEqual(sample.jev.per_source, []);
    assert.deepEqual(
      sample.jev.sent.map((entry) => [entry.src, entry.dispatched, entry.answered]),
      [
        ['s0', false, true],
        ['s1', false, true],
        ['s2', false, true],
        ['s3', false, false],
      ]
    );
  });

  it('fails open with exactly one stderr line when the log dir is unwritable, leaving no sample', async () => {
    const blockedPath = join(root, 'blocked-file');
    writeFileSync(blockedPath, 'not a directory', 'utf8'); // logDir 指向一个文件
    const config = configOf(blockedPath);
    const { stats, jev_dispatch, jev_requests } = await runPipeline(config);
    const writer = createSampleWriter(config);
    const requestId = '88888888-2222-3333-4444-555555555555';
    const path = writer.allocatePath(requestId);

    const errors: unknown[][] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args);
    };
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
    assert.equal(existsSync(path.absolute), false, 'no sample file may appear on failure');
    // stderr 恰一行、可定位（前缀 + 目标路径）
    assert.equal(errors.length, 1, `expected one stderr line, got ${errors.length}`);
    assert.ok(
      errors[0].some((arg) => String(arg).includes('[jev-filter]')),
      JSON.stringify(errors[0])
    );
    assert.ok(
      errors[0].some((arg) => String(arg).includes(path.absolute)),
      JSON.stringify(errors[0])
    );
  });

  it('heals a missing directory tree and lands the file at the allocated relative path', () => {
    const logDir = join(root, 'self-heal', 'fresh', 'nested', 'logs'); // 全都不存在
    const config = configOf(logDir);
    const writer = createSampleWriter(config);
    const requestId = '99999999-2222-3333-4444-555555555555';
    const path = writer.allocatePath(requestId);
    // 相对路径口径：samples/<本地日期>/<8位十六进制摘要>.json
    assert.match(path.relative, /^samples\/\d{4}-\d{2}-\d{2}\/[0-9a-f]{8}\.json$/);

    const outcome = writer.save({
      requestId,
      path,
      originalParams: {},
      braveParams: {},
      filterParams: { query: QUERY },
      intent: INTENT,
      preFilter: { grounding: { generic: [] }, sources: {} },
      stats: emptyStats('test'),
      jevDispatch: [],
      jevRequests: [],
      payload: {},
      statusLine: null,
    });
    assert.deepEqual(outcome, { status: 'saved' });
    assert.equal(existsSync(path.absolute), true);
    // 目录树被自愈创建：samples/ 下恰一个日期子目录
    const samplesDir = join(logDir, 'samples');
    const dateDirs = readdirSync(samplesDir);
    assert.equal(dateDirs.length, 1);
    assert.match(dateDirs[0]!, /^\d{4}-\d{2}-\d{2}$/);
  });

  it('leaves only the final file after the temp-file rename, never a leftover .tmp', () => {
    const logDir = join(root, 'atomic', 'logs');
    mkdirSync(logDir, { recursive: true });
    const config = configOf(logDir);
    const writer = createSampleWriter(config);
    const requestId = 'aaaaaaa1-2222-3333-4444-555555555555';
    const path = writer.allocatePath(requestId);

    const outcome = writer.save({
      requestId,
      path,
      originalParams: {},
      braveParams: {},
      filterParams: { query: QUERY },
      intent: INTENT,
      preFilter: { grounding: { generic: [] }, sources: {} },
      stats: emptyStats('test'),
      jevDispatch: [],
      jevRequests: [],
      payload: {},
      statusLine: null,
    });
    assert.deepEqual(outcome, { status: 'saved' });
    // 原子形状：目标目录里只有最终文件，无 .tmp 残留
    const dateDir = join(logDir, 'samples', path.relative.split('/')[1]!);
    assert.deepEqual(readdirSync(dateDir), [path.relative.split('/').at(-1)]);
  });

  it('leaves no parseable half record when the write fails midway (hooks injection)', async () => {
    const logDir = join(root, 'half-file', 'logs');
    const config = configOf(logDir);
    const { stats, jev_dispatch, jev_requests } = await runPipeline(config);
    const writer = createSampleWriter(config, {
      // 故障注入：临时文件写一半（不可能解析成完整 JSON）再抛——rename 永不发生
      writeFile: (tmpPath, data) => {
        writeFileSync(tmpPath, data.slice(0, 20), 'utf8');
        throw new Error('injected mid-write failure');
      },
    });
    const requestId = 'aaaaaaa2-2222-3333-4444-555555555555';
    const path = writer.allocatePath(requestId);

    const errors: unknown[][] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args);
    };
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
    // 防护断言：目录里既无最终 .json 也无半截 .tmp（fail 路径尽力清理）——
    // 绝无可误读为完整成功记录的半截 JSON 落盘
    const dateDir = join(logDir, 'samples', path.relative.split('/')[1]!);
    assert.ok(existsSync(dateDir), 'the date dir is created before the write');
    assert.deepEqual(readdirSync(dateDir), []);
    assert.equal(existsSync(path.absolute), false);
    // stderr 恰一行可定位
    assert.equal(errors.length, 1);
    assert.ok(
      errors[0].some((arg) => String(arg).includes(path.absolute)),
      JSON.stringify(errors[0])
    );
  });

  it('records breaker_open jev bodies verbatim without pretending completion', async () => {
    const logDir = join(root, 'breaker', 'logs');
    const config = configOf(logDir);
    const stats = emptyStats('test');
    stats.jev = {
      n_requests: 0,
      input_tokens: 0,
      latency_ms_total: 0,
      status: 'breaker_open',
      n_http_attempts: 0,
      requests: [],
      per_source: [
        { src: 's0', url: 'https://a.example/post', status: 'breaker_open', latency_ms: 0 },
        { src: 's2', url: 'https://b.example/', status: 'breaker_open', latency_ms: 0 },
      ],
    };
    // 手工派发与请求记录同形（生产管道形状：进程级熔断在前一次搜索达阈值后打开，
    // 本次搜索的共享请求进闸即被短路——零 fetch、未派发、载荷 null）
    const jevDispatch = [
      {
        src: 's0',
        url: 'https://a.example/post',
        title: 'A Post',
        request_id: 'j1',
        array_index: 0,
        dispatched: false,
        answered: false,
        snippet_score_validity: null,
        snippet_scores_received: null,
        source_verdict_valid: false,
        not_dispatched_reason: 'breaker_open' as const,
        snippet_keys: ['0'],
        snippet_texts: [articleBody],
      },
      {
        src: 's2',
        url: 'https://b.example/',
        title: 'B Page',
        request_id: 'j1',
        array_index: 1,
        dispatched: false,
        answered: false,
        snippet_score_validity: null,
        snippet_scores_received: null,
        source_verdict_valid: false,
        not_dispatched_reason: 'breaker_open' as const,
        snippet_keys: ['0'],
        snippet_texts: [uniqueBody],
      },
    ];
    const jevRequests: JevRequestRecord[] = [
      {
        request_id: 'j1',
        source_ids: ['s0', 's2'],
        dispatched: false,
        state: null,
        questions: null,
        answered: false,
        input_tokens: null,
        usage_complete: false,
        http_attempts: 0,
        latency_ms: 0,
        fail_kind: 'breaker_open',
        mapping: [
          { source_id: 's0', array_index: 0, snippet_keys: ['0'], question_keys: {} },
          { source_id: 's2', array_index: 1, snippet_keys: ['0'], question_keys: {} },
        ],
      },
    ];

    const writer = createSampleWriter(config);
    const requestId = 'aaaaaaa3-2222-3333-4444-555555555555';
    const path = writer.allocatePath(requestId);
    writer.save({
      requestId,
      path,
      originalParams: { query: QUERY },
      braveParams: { query: QUERY },
      filterParams: { query: QUERY },
      intent: INTENT,
      preFilter: richResponse,
      stats,
      jevDispatch,
      jevRequests,
      payload: { output: stats.output },
      statusLine: stats.output.status_line ?? null,
    });

    const sample = JSON.parse(readFileSync(path.absolute, 'utf8')) as {
      jev: {
        status: string;
        n_requests: number;
        per_source: Array<{ src: string; status: string; fail_kind?: string }>;
        requests: Array<{
          request_id: string;
          source_ids: string[];
          dispatched: boolean;
          answered: boolean;
          state: string | null;
          fail_kind?: string;
          http_attempts?: number;
        }>;
        sent: Array<{
          src: string;
          request_id?: string;
          dispatched: boolean;
          answered: boolean;
          not_dispatched_reason?: string;
        }>;
      };
    };
    // 熔断记账原样：breaker_open 行都进样本，不伪装成完成检查
    assert.equal(sample.jev.status, 'breaker_open');
    for (const row of sample.jev.per_source) {
      assert.equal(row.status, 'breaker_open');
    }
    // 请求级：未派发短路——零 fetch 不计 n_requests、载荷 null、attempts 0
    assert.equal(sample.jev.requests.length, 1);
    assert.equal(sample.jev.n_requests, 0);
    const request = sample.jev.requests[0]!;
    assert.equal(request.dispatched, false);
    assert.equal(request.answered, false);
    assert.equal(request.state, null);
    assert.equal(request.fail_kind, 'breaker_open');
    assert.equal(request.http_attempts, 0);
    // 来源级经 request_id 关联；未派发原因 breaker_open
    const sent = new Map(sample.jev.sent.map((entry) => [entry.src, entry]));
    const s0 = sent.get('s0');
    assert.ok(s0);
    assert.equal(s0.request_id, 'j1');
    assert.equal(s0.dispatched, false);
    assert.equal(s0.not_dispatched_reason, 'breaker_open');
    const s2 = sent.get('s2');
    assert.ok(s2);
    assert.equal(s2.request_id, 'j1');
    assert.equal(s2.dispatched, false);
    assert.equal(s2.not_dispatched_reason, 'breaker_open');
  });

  it('fails open without throwing when record construction itself explodes (boundary)', () => {
    // 构建或序列化异常也应返回 failed 并告警，不能越过写入器错误处理。
    const logDir = join(root, 'circular', 'logs');
    const config = configOf(logDir);
    const writer = createSampleWriter(config);
    const requestId = 'aaaaaaa6-2222-3333-4444-555555555555';
    const path = writer.allocatePath(requestId);
    const circular: { self?: unknown } = {};
    circular.self = circular;

    const errors: unknown[][] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args);
    };
    let outcome: { status: string };
    try {
      outcome = writer.save({
        requestId,
        path,
        originalParams: {},
        braveParams: {},
        filterParams: { query: QUERY },
        intent: INTENT,
        preFilter: { grounding: { generic: [] }, sources: {} },
        stats: emptyStats('test'),
        jevDispatch: [],
        jevRequests: [],
        payload: circular,
        statusLine: null,
      });
    } finally {
      console.error = originalError;
    }
    assert.deepEqual(outcome, { status: 'failed' });
    assert.equal(errors.length, 1);
    assert.ok(errors[0].some((arg) => String(arg).includes(path.absolute)));
    assert.equal(existsSync(path.absolute), false);
  });

  it('resolves a relative log_dir to an absolute allocated path that matches the real file (review R5)', () => {
    // 相对日志目录的绝对路径须按进程工作目录解析，与实际写文件使用相同基准。
    const relativeDir = join('test-relative-log-dir', 'sample-writer');
    const config = configOf(relativeDir);
    const writer = createSampleWriter(config);
    const requestId = 'aaaaaaa4-2222-3333-4444-555555555555';
    const path = writer.allocatePath(requestId);
    try {
      assert.equal(isAbsolute(path.absolute), true);
      assert.equal(path.absolute, resolve(process.cwd(), relativeDir, path.relative));
      // JSONL 信封的相对指针不受影响：仍相对日志目录（正斜杠口径）
      assert.match(path.relative, /^samples\/\d{4}-\d{2}-\d{2}\/[0-9a-f]{8}\.json$/);

      const outcome = writer.save({
        requestId,
        path,
        originalParams: {},
        braveParams: {},
        filterParams: { query: QUERY },
        intent: INTENT,
        preFilter: { grounding: { generic: [] }, sources: {} },
        stats: emptyStats('test'),
        jevDispatch: [],
        jevRequests: [],
        payload: {},
        statusLine: null,
      });
      assert.deepEqual(outcome, { status: 'saved' });
      // 返回路径与实际文件位置一致：absolute 指向的文件真实存在
      assert.equal(existsSync(path.absolute), true);
    } finally {
      rmSync(resolve(process.cwd(), 'test-relative-log-dir'), { recursive: true, force: true });
    }
  });

  it('distinguishes filter implementations by the rules version under the same question set (review R4)', () => {
    // 同题库（QUESTION_SET_ID 不变）、同阈值，两个不同的过滤实现常量 → 记录里的
    // filter_rules_version 必须不同——回放时能确认某次裁决用的是哪一版规则。
    const logDir = join(root, 'rules-version', 'logs');
    const config = configOf(logDir);
    const requestId = 'aaaaaaa5-2222-3333-4444-555555555555';
    const readVersionA = createSampleWriter(config, { readFilterRulesVersion: () => 'rules-A' });
    const readVersionB = createSampleWriter(config, { readFilterRulesVersion: () => 'rules-B' });
    const pathA = readVersionA.allocatePath(requestId);
    const pathB = readVersionB.allocatePath(`${requestId}-b`);

    const baseInput = {
      originalParams: {} as Record<string, unknown>,
      braveParams: {} as Record<string, unknown>,
      filterParams: { query: QUERY },
      intent: INTENT,
      preFilter: { grounding: { generic: [] }, sources: {} },
      stats: emptyStats('test'),
      jevDispatch: [] as JevDispatchRecord[],
      jevRequests: [] as JevRequestRecord[],
      payload: {},
      statusLine: null,
    };
    assert.deepEqual(readVersionA.save({ requestId, path: pathA, ...baseInput }), {
      status: 'saved',
    });
    assert.deepEqual(readVersionB.save({ requestId, path: pathB, ...baseInput }), {
      status: 'saved',
    });

    const sampleA = JSON.parse(readFileSync(pathA.absolute, 'utf8')) as {
      question_set_id: string;
      config_snapshot: Record<string, unknown>;
      filter_rules_version: string;
    };
    const sampleB = JSON.parse(readFileSync(pathB.absolute, 'utf8')) as {
      filter_rules_version: string;
    };
    // 同题库同阈值：question_set_id 与 config_snapshot 全等
    assert.equal(sampleA.question_set_id, QUESTION_SET_ID);
    // 不同过滤实现：规则版本可区分——包版本无法提供的定位能力
    assert.notEqual(sampleA.filter_rules_version, sampleB.filter_rules_version);
    assert.equal(sampleA.filter_rules_version, 'rules-A');
    assert.equal(sampleB.filter_rules_version, 'rules-B');
  });
  it('records GitHub UI cleanup actions traceable to pre_filter lines and the cleaned final payload (filter-rules-9)', async () => {
    const logDir = join(root, 'github-cleanup', 'logs');
    const config = configOf(logDir);
    const ghPayload: BraveLlmContextResponse = {
      grounding: {
        generic: [
          {
            url: 'https://github.com/lotillc/redlib-loti',
            title: 'redlib-loti',
            snippets: [
              '## Repository files navigation\n# Saved searches\n# Search code, repositories, users, issues, pull requests...\n\n# Provide feedback\n\nPrivate front-end for Reddit, a brave browser project.',
              '## About\n### Topics\nbrowser-extension privacy typescript',
              '## About\nPrivate front-end for Reddit, a brave browser project.',
            ],
          },
          {
            url: 'https://github.com/HexRaysSA/ida-mcp/pull/8',
            title: 'ida-mcp PR 8',
            snippets: [
              'migrate-mcp HexRaysSA/ida-mcp:migrate-mcp Copy head branch name to clipboard\nBrave browser patch discussion.',
            ],
          },
        ],
        map: [],
      },
      sources: {},
    };
    const { result, stats, jev_dispatch, jev_requests } = await filterLlmContext(
      ghPayload,
      { params: { query: QUERY }, intent: INTENT },
      config,
      { classify: keepAllClassify }
    );
    const payload = result;
    const writer = createSampleWriter(config);
    const requestId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const path = writer.allocatePath(requestId);
    assert.deepEqual(
      writer.save({
        requestId,
        path,
        originalParams: { query: QUERY },
        braveParams: { query: QUERY },
        filterParams: { query: QUERY },
        intent: INTENT,
        preFilter: ghPayload,
        stats,
        jevDispatch: jev_dispatch,
        jevRequests: jev_requests,
        payload,
        statusLine: null,
      }),
      { status: 'saved' }
    );

    const sample = JSON.parse(readFileSync(path.absolute, 'utf8')) as {
      pre_filter: BraveLlmContextResponse;
      final_return: { payload: { grounding: { generic: { snippets: string[] }[] } } } | null;
      outcome?: {
        local: { github_cleanup_actions: number };
        sources: { snippets: { github_cleanup?: unknown }[] }[];
      };
    };

    // 计数与逐片段动作进 outcome（v4 可选键，format_version 不因增补递增）
    assert.equal(sample.outcome?.local.github_cleanup_actions, 7);
    const repoRow = sample.outcome?.sources[0].snippets[0];
    assert.deepEqual(repoRow?.github_cleanup, [{ rule: 'repo_nav', line: 1 }]);
    assert.deepEqual(sample.outcome?.sources[0].snippets[1].github_cleanup, [
      { rule: 'repo_topics', line: 1 },
      { rule: 'repo_topics', line: 2 },
      { rule: 'repo_topics', line: 3 },
    ]);
    assert.deepEqual(sample.outcome?.sources[0].snippets[2].github_cleanup, [
      { rule: 'about_echo', line: 1 },
      { rule: 'about_echo', line: 2 },
    ]);
    assert.deepEqual(sample.outcome?.sources[1].snippets[0].github_cleanup, [
      { rule: 'copy_branch_button', line: 1, partial: true },
    ]);

    // 动作行号可回溯 pre_filter 原文：行号-1 恰是界面行
    const original = sample.pre_filter.grounding.generic[0].snippets[0] as string;
    const lines = original.split('\n');
    assert.equal(lines[0], '## Repository files navigation');
    assert.equal(lines[1], '# Saved searches');
    assert.equal(lines[2], '# Search code, repositories, users, issues, pull requests...');
    assert.equal(lines[4], '# Provide feedback');
    // 原始 pre_filter 未被清洗改写（原地不修改）
    assert.ok(original.startsWith('## Repository files navigation'));

    // 最终返回来自同一份清洗后文本
    assert.deepEqual(sample.final_return?.payload.grounding.generic[0].snippets, [
      '# Saved searches\n# Search code, repositories, users, issues, pull requests...\n\n# Provide feedback\n\nPrivate front-end for Reddit, a brave browser project.',
    ]);
  });
});
