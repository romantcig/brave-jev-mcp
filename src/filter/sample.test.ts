/**
 * 样本写入器单测（04-02；04-04 R1-R5 返修；v4 六题全量上下文请求级载荷）：记录形状
 * 与 pretty 格式、片段配对身份（URL 合并 / JSON-LD 拆分 / 页内重复 / 空源排除）、
 * 请求级实发载荷（真实超限路径 + fetch 桩的深相等、已派发失败保留输入证据、
 * skipped / too_large / breaker_open 分状态）、no_key 如实记账、写入失败路径与目录
 * 自愈、相对 log_dir 的绝对路径、过滤规则版本区分能力、构建异常 fail-open。
 *
 * v4 语义：实发 state / questions / answers / 映射在 jev.requests[]（每逻辑请求
 * 一份），来源级 sent[] 经 request_id 引用；in_state / score_question_sent 按题目
 * 映射对实发载荷逐位检查——没有实发载荷（注入面 answered 无 dispatch）就不冒充。
 *
 * 身份与过程映射断言跑真实管道（filterLlmContext + 合成 classify 全保留），
 * 不复述实现——统计投影与候选口径都是生产口径。实发断言用**生产客户端**
 * （createJevClassifier）+ fetch 桩截获请求体，样本 state 与截获 state 深相等
 * （审查 R1：不许只手动缩短 stats 的 snippet_scores 来证明映射）。
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
  EXPLICIT_YEAR_PATTERN,
  temporalQuestionText,
  QUESTION_SET_ID,
  SNIPPET_LEVELS,
  SOURCE_QUESTIONS,
  buildState,
} from './jev/questions.js';
import { createJevClassifier } from './jev/client.js';
import { filterLlmContext } from './pipeline.js';
import { createSampleWriter, type SampleRecord } from './sample.js';
import { createNoKeyJevStats } from './stats.js';
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

/** 手工配置（照 pipeline.test.ts 的 offConfig 先例）：test 模式 + 临时 log_dir + 非空黑名单。 */
const configOf = (logDir: string, concurrency = 12): FilterConfig => ({
  mode: 'test',
  overfetchFactor: 1,
  blocklist: new Set(['farm.example', 'a.farm.example']),
  thresholds: { ...DEFAULT_THRESHOLDS },
  jev: { model: DEFAULT_JEV_MODEL, timeoutMs: 15000, concurrency, contextMode: 'single' },
  logDir,
});

/** 全保留合成 classify：六道来源级题全 0.0（低于一切丢弃门槛），片段分全 2.0。 */
const keepAllClassify: ClassifyDeps['classify'] = async () => ({
  status: 'answered',
  model: DEFAULT_JEV_MODEL,
  answers: {
    has_original_reasoning: { kind: 'noul', probability: 0 },
    is_template_filler: { kind: 'noul', probability: 0 },
    is_off_topic: { kind: 'noul', probability: 0 },
    is_listing: { kind: 'noul', probability: 0 },
    self_deprecated: { kind: 'noul', probability: 0 },
    stale: { kind: 'noul', probability: 0 },
    snip0: { kind: 'score', score: 2 },
    snip1: { kind: 'score', score: 2 },
    snip2: { kind: 'score', score: 2 },
    snip3: { kind: 'score', score: 2 },
  },
  input_tokens: 42,
});

/**
 * 身份夹具：s0 带 JSON-LD（articleBody + FAQ → .part 拆分）；s1 与 s0 同规范 URL
 * （www + utm 跟踪参数）→ 步 2 并入（mergedFrom）；s2 页内逐字重复（第二步删）；
 * s3 空白片段 → 步 8 整源丢弃。合并片段与 articleBody 都长于 200 字符且含 query
 * 实词，步 3 预筛不命中。
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
  request: { query: QUERY, intent: INTENT, max_urls: 20, max_tokens: 8192, overfetch_factor: 1 },
  brave: { n_sources: 0, n_snippets: 0, chars: 0, est_tokens: 0 },
  local: {
    jsonld_converted: 0,
    jsonld_dropped: 0,
    jsonld_kept_raw: 0,
    url_merged: 0,
    snippets_prefiltered: 0,
    dup_removed: 0,
    paywall_truncated: 0,
    feed_hits: 0,
    blocklist_hits: 0,
    empty_dropped: 0,
    budget_dropped_sources: 0,
    budget_trimmed_snippets: 0,
    novelty_removed: 0,
    cross_source_dup_removed: 0,
    github_cleanup_actions: 0,
    novelty: [],
  },
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
    // 食谱镜像：常规题库、年份选择条件与时间题模板的规范化 JSON SHA-256 前 12 位——
    // 意外改配方（键序、包裹方式）会在这里红
    const expected = createHash('sha256')
      .update(
        JSON.stringify([
          GLOBAL_INSTRUCTION,
          SOURCE_QUESTIONS,
          SNIPPET_LEVELS,
          EXPLICIT_YEAR_PATTERN.source,
          temporalQuestionText(0),
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
  // 层收下额外键、管道按当前六题收集（旧键不进 per_source.answers）、裁决不受影响。
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
              ? { type: 'score', score: key === 'snip0' ? 2 : 0.4 }
              : { type: 'noul', noul: key === 'has_original_reasoning' ? 0.9 : 0 };
        }
        if (scenario === 'missing-score') delete answers.snip0;
        if (scenario === 'wrong-score-type') answers.snip0 = { type: 'noul', noul: 0 };
        if (scenario === 'negative-score') answers.snip0.score = -1;
        if (scenario === 'above-range') answers.snip0.score = 3;
        if (scenario === 'nonfinite-score') answers.snip0.score = 'overflow';
        if (scenario === 'missing-source-answer') delete answers.stale;
        if (scenario === 'legacy-extra-answer')
          answers.worth_keeping = { type: 'noul', noul: 0.42 };
        if (scenario === 'source-drop') answers.is_off_topic.noul = 1;
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
      // v4：实发载荷在请求级（single 模式一请求一来源），来源行经 request_id 引用
      assert.equal(sample.jev!.requests.length, 1);
      const request = sample.jev!.requests[0]!;
      const sent = sample.jev!.sent[0]!;
      assert.equal(sent.request_id, request.request_id);
      assert.equal(request.mode, 'single');
      assert.equal(request.requested, 'single');
      assert.equal(request.effective, 'single');
      assert.equal(request.fallback_reason, undefined);
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
          question_keys: Object.fromEntries(
            Object.keys(captured[0]!.questions).map((key) => [key, key])
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
        // 旧键回答被解析层收下、被当前题库的收集层忽略；六键齐全即有效裁决，
        // 不因响应里多了历史字段而误判 validation 或改变裁决
        assert.equal(sent.source_verdict_valid, true);
        const collected = sample.jev!.per_source[0].answers ?? {};
        assert.deepEqual(Object.keys(collected).sort(), [
          'has_original_reasoning',
          'is_listing',
          'is_off_topic',
          'is_template_filler',
          'self_deprecated',
          'stale',
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

    // 记录形状：语义字段齐备、顺序稳定（04-04 R4：新增 filter_rules_version）
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
    assert.equal(sample.format_version, 4);
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

    // config_snapshot：十一项阈值 snake_case 投影 + jev 组（v4 加 context_mode）+ 黑名单 + mode
    const snapshot = sample.config_snapshot as Record<string, unknown>;
    assert.deepEqual(Object.keys(snapshot), [
      'thresholds',
      'jev',
      'overfetch_factor',
      'mode',
      'blocklist',
    ]);
    assert.deepEqual(snapshot.thresholds, {
      off_topic_drop: DEFAULT_THRESHOLDS.offTopicDrop,
      listing_drop: DEFAULT_THRESHOLDS.listingDrop,
      self_deprecated: DEFAULT_THRESHOLDS.selfDeprecated,
      stale_drop: DEFAULT_THRESHOLDS.staleDrop,
      filler_drop: DEFAULT_THRESHOLDS.fillerDrop,
      reasoning_protect: DEFAULT_THRESHOLDS.reasoningProtect,
      snippet_min: DEFAULT_THRESHOLDS.snippetMin,
      min_facts: DEFAULT_THRESHOLDS.minFacts,
      novelty_min: DEFAULT_THRESHOLDS.noveltyMin,
      cjk_bonus: DEFAULT_THRESHOLDS.cjkBonus,
      cjk_share: DEFAULT_THRESHOLDS.cjkShare,
    });
    assert.deepEqual(snapshot.jev, {
      model: DEFAULT_JEV_MODEL,
      timeout_ms: 15000,
      concurrency: 12,
      context_mode: 'single',
    });
    assert.equal(snapshot.overfetch_factor, 1);
    assert.equal(snapshot.mode, 'test');
    assert.deepEqual(snapshot.blocklist, ['a.farm.example', 'farm.example']);

    // 版本锚：题库哈希 + 包版本 + 过滤规则版本（04-04 R4：三者各司其职）
    assert.match(String(sample.question_set_id), /^[0-9a-f]{12}$/);
    assert.equal(sample.filter_program_version, '2.1.4');
    assert.equal(sample.filter_rules_version, FILTER_RULES_VERSION);
  });

  it('carries stable snippet identities: URL merge (mergedFrom), JSON-LD split (.part), in-page dup and empty-source exclusion', async () => {
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
        per_source: Array<{ src: string; status: string; snippet_scores?: number[] }>;
        requests: Array<{
          request_id: string;
          mode: string;
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
            merged_from?: number;
            kept: boolean;
            reason?: string;
          }>;
        }>;
      };
    };

    // 过程映射（SC2）：删除项的原因与执行阶段可凭样本定位——s1 merged（步 2）、
    // s3 empty（步 8）、s2 第二片段 dup（步 3），身份键齐备
    const outcomeByIndex = new Map(sample.outcome.sources.map((row) => [row.index, row]));
    assert.equal(outcomeByIndex.get(1)?.verdict, 'drop');
    assert.equal(outcomeByIndex.get(1)?.reason, 'merged');
    assert.equal(outcomeByIndex.get(3)?.verdict, 'drop');
    assert.equal(outcomeByIndex.get(3)?.reason, 'empty');
    const bSnippets = outcomeByIndex.get(2)?.snippets ?? [];
    assert.equal(bSnippets[1]?.kept, false);
    assert.equal(bSnippets[1]?.reason, 'dup');

    // Jev 判断：s0 与 s2 answered 且片段分数齐备（3 与 1）
    assert.equal(sample.jev.status, 'ok');
    const perSource = new Map(sample.jev.per_source.map((row) => [row.src, row]));
    assert.equal(perSource.get('s0')?.status, 'answered');
    assert.deepEqual(perSource.get('s0')?.snippet_scores, [2, 2, 2]);
    assert.equal(perSource.get('s2')?.status, 'answered');
    assert.deepEqual(perSource.get('s2')?.snippet_scores, [2]);

    // 实发映射：全部步 5 时刻的 keep 来源——s0（含并入片段）、s2（重复片段
    // 不在候选）已取得回答；s3 的片段在步 3 已被删光（步 8 才整源 drop），是
    // "无内容可发"的 skipped——不再从 jev 段隐身
    assert.deepEqual(
      sample.jev.sent.map((entry) => entry.src),
      ['s0', 's2', 's3']
    );
    // 注入面（合成 classify）无实发载荷：每个请求记录存在但 state/questions 为
    // null——v4 的 in_state / score_question_sent 按映射对实发载荷检查，无载荷
    // 即 false，绝不按 answered 冒充"已提交"
    assert.equal(sample.jev.requests.length, 2);
    assert.ok(
      sample.jev.requests.every((request) => request.state === null && request.questions === null)
    );
    const s0 = sample.jev.sent[0]!;
    assert.equal(s0.dispatched, false);
    assert.equal(s0.answered, true);
    assert.ok(s0.request_id, 'request_id links the source row to its request record');
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
        ['1:0', 2, false, false, true], // 步 2 并入片段（mergedFrom 1 的 index 0）
      ]
    );
    assert.equal(s0.snippets[0]?.text, articleBody);
    assert.equal(s0.snippets[2]?.text, mergedBody);
    // s2：页内重复删掉第二片段，候选只有幸存第一片段
    const s2 = sample.jev.sent[1]!;
    assert.deepEqual(
      s2.snippets.map((snippet) => [snippet.snippet, snippet.in_state, snippet.scored]),
      [['0', false, true]]
    );
    assert.equal(s2.snippets[0]?.text, uniqueBody);
  });

  it('records the real dispatched payload deep-equal to the intercepted request when a cut ladder fires (review R1)', async () => {
    // 真实超限路径：生产客户端（createJevClassifier + applyOversizeLadder）+ fetch 桩。
    // 第二片段是 32000 个 CJK 字符（×0.9 ×1.15 余量 > 32k）→ 阶梯砍尾 → 实发 state
    // 只有第一段；样本请求级载荷必须记录砍后 state 且与截获请求深相等——阶梯前的
    // 重建口径（v1 的病灶）在这里会带两段，当场红。
    const logDir = join(root, 'cut-tail', 'logs');
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
    const lastRequest = captured.at(-1);
    assert.ok(lastRequest, 'the classifier must have dispatched a request');
    assert.ok('source' in lastRequest.state, 'single dispatches carry a single-source state');
    // 截获请求实证：阶梯把实发 state 砍到只剩第一段、snip 题只剩 snip0
    assert.equal(lastRequest.state.source.snippets.length, 1);
    assert.equal(lastRequest.state.source.snippets[0], articleBody);
    assert.deepEqual(
      Object.keys(lastRequest.questions).filter((key) => /^snip/.test(key)),
      ['snip0']
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
        per_source: Array<{ src: string; status: string; ladder?: string; sent_snippets?: number }>;
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
    assert.equal(sample.jev.per_source[0]?.ladder, 'cut_tail');
    assert.equal(sample.jev.per_source[0]?.sent_snippets, 1);
    // R1 核心证据：请求级记录的实发 state 与截获请求深相等（砍后实发，仅 1 段）
    assert.equal(sample.jev.requests.length, 1);
    const request = sample.jev.requests[0]!;
    assert.equal(request.dispatched, true);
    assert.ok(request.state, 'dispatched request must carry the input evidence');
    assert.deepEqual(JSON.parse(request.state), lastRequest.state);
    assert.deepEqual(request.questions, lastRequest.questions);
    const s0 = sample.jev.sent[0]!;
    assert.equal(s0.request_id, request.request_id);
    assert.equal(s0.dispatched, true);
    // 状态三维拆分：第二片段没进 state、题没提交（按映射检查）、也没有评分——各字段独立表达
    assert.deepEqual(
      s0.snippets.map((snippet) => [
        snippet.snippet,
        snippet.in_state,
        snippet.score_question_sent,
        snippet.scored,
      ]),
      [
        ['0', true, true, true],
        ['1', false, false, false],
      ]
    );
    // 被砍片段的候选口径文本保留（凭身份键回 pre_filter 对齐），但不冒充实发
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

  it('separates too_large and breaker_open from dispatched failures in the dispatch map (review R1)', async () => {
    // 生产客户端 + 串行并发闸：前三个来源网络失败各计一次熔断计数（1→2→3 达阈值），
    // 第四个来源进闸即被熔断短路（零 fetch）——too_large / breaker_open 与
    // "已派发但失败"三种状态在同一份派发映射里可区分。
    const logDir = join(root, 'ladder-states', 'logs');
    const config = configOf(logDir, 1);
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
    assert.equal(captured.length, 9, 'three sources x three attempts must dispatch nine fetches');
    assert.equal(degraded.stats.jev?.status, 'breaker_open');

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
          not_dispatched_reason?: string;
        }>;
      };
    };
    // 请求级账目：4 个逻辑请求（各一来源）；前三个已派发失败（各 3 次 fetch、
    // 计 n_requests），第四个熔断短路（0 次 fetch、不计 n_requests）——N 来源
    // 不冒充 N 次正常请求，重试可见
    assert.equal(sample.jev.requests.length, 4);
    assert.equal(sample.jev.n_requests, 3);
    assert.equal(sample.jev.n_http_attempts, 9);
    const requests = new Map(sample.jev.requests.map((entry) => [entry.request_id, entry]));
    const sent = new Map(sample.jev.sent.map((entry) => [entry.src, entry]));
    // 已派发但网络失败：dispatched=true、输入证据保留、usage 未知不伪称、attempts=3
    for (const src of ['s0', 's1', 's2']) {
      const entry = sent.get(src);
      assert.ok(entry, src);
      assert.equal(entry.dispatched, true, src);
      assert.equal(entry.answered, false, src);
      const request = requests.get(entry.request_id ?? '');
      assert.ok(request, `${src} links to its request record`);
      assert.ok(request.state, `${src} keeps its dispatched input evidence`);
      assert.equal(request.fail_kind, 'network');
      assert.equal(request.input_tokens, null);
      assert.equal(request.usage_complete, false);
      assert.equal(request.http_attempts, 3);
    }
    // 熔断短路：零 fetch，未派发，原因明确——不与失败混同
    const s3 = sent.get('s3');
    assert.ok(s3);
    assert.equal(sample.jev.per_source[3]?.status, 'breaker_open');
    const s3Request = requests.get(s3.request_id ?? '');
    assert.ok(s3Request);
    assert.equal(s3Request.dispatched, false);
    assert.equal(s3Request.state, null);
    assert.equal(s3Request.fail_kind, 'breaker_open');
    assert.equal(s3Request.http_attempts, 0);
    assert.equal(s3.dispatched, false);
    assert.equal(s3.answered, false);
    assert.equal(s3.not_dispatched_reason, 'breaker_open');
  });

  it('marks skipped sources (nothing to dispatch) and too_large states distinctly from sent ones', async () => {
    // 巨型 title：砍光片段后 state + 来源级题仍超 32k → 阶梯 ④ too_large（零 fetch）；
    // 第二来源片段全空白 → 本地规则删光 → skipped 占位（零 fetch）。
    const logDir = join(root, 'skip-too-large', 'logs');
    const config = configOf(logDir, 1);
    const response: BraveLlmContextResponse = {
      grounding: {
        generic: [
          { url: 'https://a.example/post', title: 'x'.repeat(200000), snippets: [articleBody] },
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
    assert.equal(captured.length, 0, 'neither source may dispatch a real request');

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
          dispatched: boolean;
          state: string | null;
          questions: Record<string, unknown> | null;
          fail_kind?: string;
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
    // 预检拒绝不计 n_requests；请求记录如实保留（state null、fail_kind too_large）
    assert.equal(sample.jev.n_requests, 0);
    assert.equal(sample.jev.requests.length, 1);
    const request = sample.jev.requests[0]!;
    assert.equal(request.dispatched, false);
    assert.equal(request.state, null);
    assert.equal(request.questions, null);
    assert.equal(request.fail_kind, 'too_large');
    const sent = new Map(sample.jev.sent.map((entry) => [entry.src, entry]));
    const s0 = sent.get('s0');
    assert.ok(s0, 's0 must appear in the dispatch map');
    assert.equal(s0.dispatched, false);
    assert.equal(s0.not_dispatched_reason, 'too_large');
    assert.deepEqual(
      s0.snippets.map((snippet) => snippet.in_state),
      [false]
    );
    assert.deepEqual(
      s0.snippets.map((snippet) => snippet.score_question_sent),
      [false]
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
    // 相对路径口径：samples/<本地日期>/<request_id>.json
    assert.match(path.relative, /^samples\/\d{4}-\d{2}-\d{2}\/[0-9]{6}-[A-Za-z0-9_-]{10}\.json$/);

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

  it('records degraded jev bodies verbatim (fail_kind, breaker_open) without pretending completion', async () => {
    const logDir = join(root, 'degraded', 'logs');
    const config = configOf(logDir);
    const stats = emptyStats('test');
    stats.jev = {
      n_requests: 1,
      input_tokens: 0,
      latency_ms_total: 20,
      status: 'degraded',
      n_http_attempts: 2,
      requests: [],
      per_source: [
        {
          src: 's0',
          url: 'https://a.example/post',
          status: 'failed',
          fail_kind: 'timeout',
          latency_ms: 15,
        },
        { src: 's2', url: 'https://b.example/', status: 'breaker_open', latency_ms: 0 },
      ],
    };
    // 手工派发与请求记录同形（生产管道形状）：s0 已派发但超时（实发 state 保留在
    // 请求级）、s2 熔断短路（未派发）
    const dispatchedState = buildState(
      's0',
      'https://a.example/post',
      'A Post',
      [articleBody],
      QUERY,
      INTENT
    );
    const jevDispatch = [
      {
        src: 's0',
        url: 'https://a.example/post',
        title: 'A Post',
        request_id: 'j1',
        array_index: 0,
        dispatched: true,
        answered: false,
        snippet_score_validity: null,
        snippet_scores_received: null,
        source_verdict_valid: false,
        snippet_keys: ['0'],
        snippet_texts: [articleBody],
      },
      {
        src: 's2',
        url: 'https://b.example/',
        title: 'B Page',
        request_id: 'j2',
        array_index: 0,
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
        mode: 'single',
        requested: 'single',
        effective: 'single',
        source_ids: ['s0'],
        dispatched: true,
        state: dispatchedState,
        questions: null,
        answered: false,
        input_tokens: null,
        usage_complete: false,
        http_attempts: 2,
        latency_ms: 15,
        fail_kind: 'timeout',
        mapping: [
          {
            source_id: 's0',
            array_index: 0,
            snippet_keys: ['0'],
            question_keys: {},
          },
        ],
      },
      {
        request_id: 'j2',
        mode: 'single',
        requested: 'single',
        effective: 'single',
        source_ids: ['s2'],
        dispatched: false,
        state: null,
        questions: null,
        answered: false,
        input_tokens: null,
        usage_complete: false,
        http_attempts: 0,
        latency_ms: 0,
        fail_kind: 'breaker_open',
        mapping: [{ source_id: 's2', array_index: 0, snippet_keys: ['0'], question_keys: {} }],
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
        per_source: Array<{ src: string; status: string; fail_kind?: string }>;
        requests: Array<{
          request_id: string;
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
    // 降级记账原样：failed kind 与熔断行都进样本，不伪装成完成检查
    assert.equal(sample.jev.status, 'degraded');
    const rows = new Map(sample.jev.per_source.map((row) => [row.src, row]));
    assert.equal(rows.get('s0')?.fail_kind, 'timeout');
    assert.equal(rows.get('s2')?.status, 'breaker_open');
    // 请求级状态区分：超时请求已派发、实发 state 保留输入证据；熔断请求未派发
    const requests = new Map(sample.jev.requests.map((entry) => [entry.request_id, entry]));
    const s0Request = requests.get('j1');
    assert.ok(s0Request);
    assert.equal(s0Request.dispatched, true);
    assert.equal(s0Request.answered, false);
    assert.ok(s0Request.state);
    assert.deepEqual(JSON.parse(s0Request.state), dispatchedState);
    assert.equal(s0Request.http_attempts, 2);
    const s2Request = requests.get('j2');
    assert.ok(s2Request);
    assert.equal(s2Request.dispatched, false);
    assert.equal(s2Request.state, null);
    assert.equal(s2Request.fail_kind, 'breaker_open');
    // 来源级经 request_id 关联；熔断行原因 breaker_open
    const sent = new Map(sample.jev.sent.map((entry) => [entry.src, entry]));
    const s0 = sent.get('s0');
    assert.ok(s0);
    assert.equal(s0.request_id, 'j1');
    assert.equal(s0.dispatched, true);
    assert.equal(s0.answered, false);
    const s2 = sent.get('s2');
    assert.ok(s2);
    assert.equal(s2.request_id, 'j2');
    assert.equal(s2.dispatched, false);
    assert.equal(s2.not_dispatched_reason, 'breaker_open');
  });

  it('fails open without throwing when record construction itself explodes (boundary)', () => {
    // 辅助边界（审查尾注）：记录构建/序列化在文件写入 try 内——不可序列化的循环
    // 引用不再向外抛，与写入失败同口径（stderr 一行 + status failed）。
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
    // 相对 log_dir（配置允许的合法输入）：allocatePath 必须按写文件的解析基准
    // （进程工作目录）给出绝对路径——v1 用 join 返回相对路径（审查复现
    // isAbsolute=false），审核 AI 拿着它无法跨工作目录定位文件。
    const relativeDir = join('test-relative-log-dir', 'sample-writer');
    const config = configOf(relativeDir);
    const writer = createSampleWriter(config);
    const requestId = 'aaaaaaa4-2222-3333-4444-555555555555';
    const path = writer.allocatePath(requestId);
    try {
      assert.equal(isAbsolute(path.absolute), true);
      assert.equal(path.absolute, resolve(process.cwd(), relativeDir, path.relative));
      // JSONL 信封的相对指针不受影响：仍相对日志目录（正斜杠口径）
      assert.match(path.relative, /^samples\/\d{4}-\d{2}-\d{2}\/[0-9]{6}-[A-Za-z0-9_-]{10}\.json$/);

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
    assert.equal(sample.outcome?.local.github_cleanup_actions, 5);
    const repoRow = sample.outcome?.sources[0].snippets[0];
    assert.deepEqual(repoRow?.github_cleanup, [
      { rule: 'repo_nav', line: 1 },
      { rule: 'search_block', line: 2 },
      { rule: 'search_block', line: 3 },
      { rule: 'search_block', line: 5 },
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
      'Private front-end for Reddit, a brave browser project.',
    ]);
  });
});
