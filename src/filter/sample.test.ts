/**
 * 样本写入器单测（04-02）：记录形状与 pretty 格式、片段配对身份（URL 合并 /
 * JSON-LD 拆分 / 页内重复 / 空源排除）、sent 映射（snippet_scores 对齐与 cut_tail
 * 短于候选）、no_key 如实记账、写入失败路径与目录自愈、QUESTION_SET_ID 格式。
 *
 * 身份与过程映射断言跑真实管道（filterLlmContext + 合成 classify 全保留），
 * 不复述实现——统计投影与候选口径都是生产口径。
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
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import {
  DEFAULT_JEV_MODEL,
  DEFAULT_THRESHOLDS,
  GLOBAL_INSTRUCTION,
  QUESTION_SET_ID,
  SNIPPET_LEVELS,
  SOURCE_QUESTIONS,
} from './jev/questions.js';
import { filterLlmContext } from './pipeline.js';
import { createSampleWriter } from './sample.js';
import { createNoKeyJevStats } from './stats.js';
import type { BraveLlmContextResponse, ClassifyDeps, FilterConfig, FilterStats } from './types.js';

const INTENT = 'What Brave Search is and how it differs from other engines';
const QUERY = 'brave browser';

/** 手工配置（照 pipeline.test.ts 的 offConfig 先例）：test 模式 + 临时 log_dir + 非空黑名单。 */
const configOf = (logDir: string): FilterConfig => ({
  mode: 'test',
  overfetchFactor: 1,
  blocklist: new Set(['farm.example', 'a.farm.example']),
  thresholds: { ...DEFAULT_THRESHOLDS },
  jev: { model: DEFAULT_JEV_MODEL, timeoutMs: 15000, concurrency: 12 },
  logDir,
});

/** 全保留合成 classify：十道来源级题全 0.0（低于一切丢弃门槛），片段分全 2.0。 */
const keepAllClassify: ClassifyDeps['classify'] = async () => ({
  status: 'answered',
  model: DEFAULT_JEV_MODEL,
  answers: {
    worth_keeping: { kind: 'noul', probability: 0 },
    is_primary: { kind: 'noul', probability: 0 },
    has_original_reasoning: { kind: 'noul', probability: 0 },
    is_attributed_rewrite: { kind: 'noul', probability: 0 },
    is_template_filler: { kind: 'noul', probability: 0 },
    is_off_topic: { kind: 'noul', probability: 0 },
    is_listing: { kind: 'noul', probability: 0 },
    self_deprecated: { kind: 'noul', probability: 0 },
    stale: { kind: 'noul', probability: 0 },
    paywalled: { kind: 'noul', probability: 0 },
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

/** 跑真实管道取生产口径的 stats（步 10 状态行已写入）。 */
const runPipeline = async (config: FilterConfig): Promise<FilterStats> => {
  const { stats } = await filterLlmContext(
    richResponse,
    { params: { query: QUERY }, intent: INTENT },
    config,
    { classify: keepAllClassify }
  );
  return stats;
};

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
    novelty: [],
  },
  sources: [],
  jev: null,
  output: { n_sources: 0, n_snippets: 0, chars: 0, est_tokens: 0 },
  shadow_diff: null,
});

describe('QUESTION_SET_ID', () => {
  it('is 12 lowercase hex chars derived from the normalized question bank (recipe pinned)', () => {
    assert.match(QUESTION_SET_ID, /^[0-9a-f]{12}$/);
    // 食谱镜像：数组包裹 [总指令, 题表, legend] 的规范化 JSON SHA-256 前 12 位——
    // 意外改配方（键序、包裹方式）会在这里红
    const expected = createHash('sha256')
      .update(JSON.stringify([GLOBAL_INSTRUCTION, SOURCE_QUESTIONS, SNIPPET_LEVELS]))
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

  it('writes a pretty sample with stable field order, config snapshot and program ids', async () => {
    const logDir = join(root, 'shape', 'logs');
    const config = configOf(logDir);
    const stats = await runPipeline(config);
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
      payload,
      statusLine,
    });
    assert.deepEqual(outcome, { status: 'saved' });

    const raw = readFileSync(path.absolute, 'utf8');
    const sample = JSON.parse(raw) as Record<string, unknown>;
    // pretty 格式：两空格缩进 + 末尾换行（整份重序列化逐字一致即证明）
    assert.equal(raw, `${JSON.stringify(sample, null, 2)}\n`);

    // 记录形状：语义字段齐备、顺序稳定
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
      'filter_program_version',
    ]);
    assert.equal(sample.format_version, 1);
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

    // config_snapshot：十一项阈值 snake_case 投影 + jev 组 + 黑名单排序 + mode
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
    });
    assert.equal(snapshot.overfetch_factor, 1);
    assert.equal(snapshot.mode, 'test');
    assert.deepEqual(snapshot.blocklist, ['a.farm.example', 'farm.example']);

    // 版本锚
    assert.match(String(sample.question_set_id), /^[0-9a-f]{12}$/);
    assert.equal(sample.filter_program_version, '2.1.4');
  });

  it('carries stable snippet identities: URL merge (mergedFrom), JSON-LD split (.part), in-page dup and empty-source exclusion', async () => {
    const logDir = join(root, 'identity', 'logs');
    const config = configOf(logDir);
    const stats = await runPipeline(config);
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
        payload: { output: stats.output },
        statusLine: stats.output.status_line ?? null,
      }),
      { status: 'saved' }
    );

    const sample = JSON.parse(readFileSync(path.absolute, 'utf8')) as {
      jev: {
        status: string;
        per_source: Array<{ src: string; status: string; snippet_scores?: number[] }>;
        sent: Array<{
          src: string;
          state: string;
          snippets: Array<{ snippet: string; position: number; sent: boolean; text: string }>;
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

    // 实发映射：候选只有 s0（含并入片段）与 s2（重复片段不在候选）；s1/s3 不在
    assert.deepEqual(
      sample.jev.sent.map((entry) => entry.src),
      ['s0', 's2']
    );
    const s0 = sample.jev.sent[0];
    assert.deepEqual(
      s0.snippets.map((snippet) => [snippet.snippet, snippet.position, snippet.sent]),
      [
        ['0.0', 0, true], // JSON-LD 拆分 part 0
        ['0.1', 1, true], // JSON-LD 拆分 part 1
        ['1:0', 2, true], // 步 2 并入片段（mergedFrom 1 的 index 0）
      ]
    );
    assert.equal(s0.snippets[0]?.text, articleBody);
    assert.equal(s0.snippets[2]?.text, mergedBody);
    // state 文本还原：与 buildState 口径一致（构造时 state，阶梯前全量）
    const state = JSON.parse(s0.state) as {
      query: string;
      intent: string;
      source: { id: string; snippets: string[] };
    };
    assert.equal(state.source.id, 's0');
    assert.deepEqual(
      state.source.snippets,
      s0.snippets.map((snippet) => snippet.text)
    );
    assert.equal(state.intent, INTENT);
    // s2：页内重复删掉第二片段，候选只有幸存第一片段
    const s2 = sample.jev.sent[1];
    assert.deepEqual(
      s2.snippets.map((snippet) => [snippet.snippet, snippet.sent]),
      [['0', true]]
    );
    assert.equal(s2.snippets[0]?.text, uniqueBody);
  });

  it('aligns the sent map with snippet_scores when a cut ladder sends fewer snippets', async () => {
    const logDir = join(root, 'cut-tail', 'logs');
    const config = configOf(logDir);
    const stats = await runPipeline(config);
    // 模拟 cut_tail：s0 只发了前两个片段的分数（snippet_scores 长度即实发数）
    const cut = structuredClone(stats);
    const s0 = cut.jev?.per_source.find((row) => row.src === 's0');
    assert.ok(s0, 's0 row missing');
    s0.snippet_scores = [2, 2];
    s0.sent_snippets = 2;
    s0.ladder = 'cut_tail';

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
      preFilter: richResponse,
      stats: cut,
      payload: { output: cut.output },
      statusLine: cut.output.status_line ?? null,
    });

    const sample = JSON.parse(readFileSync(path.absolute, 'utf8')) as {
      jev: { sent: Array<{ src: string; snippets: Array<{ snippet: string; sent: boolean }> }> };
    };
    const sentS0 = sample.jev.sent.find((entry) => entry.src === 's0');
    assert.ok(sentS0);
    // 前两个在实发范围，第三个（并入片段 1:0）未发送——不伪造判断
    assert.deepEqual(
      sentS0.snippets.map((snippet) => [snippet.snippet, snippet.sent]),
      [
        ['0.0', true],
        ['0.1', true],
        ['1:0', false],
      ]
    );
  });

  it('records the no_key jev body verbatim and marks every candidate snippet as unsent', async () => {
    const logDir = join(root, 'no-key', 'logs');
    const config = configOf(logDir);
    const stats = await runPipeline(config);
    stats.jev = createNoKeyJevStats(); // no_key：零值对象，per_source 空

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
      preFilter: richResponse,
      stats,
      payload: { output: stats.output },
      statusLine: stats.output.status_line ?? null,
    });

    const sample = JSON.parse(readFileSync(path.absolute, 'utf8')) as {
      jev: {
        status: string;
        n_requests: number;
        per_source: unknown[];
        sent: Array<{ src: string; snippets: Array<{ sent: boolean }> }>;
      };
    };
    // no_key 如实记账（不伪装成完成检查）；候选仍列出但全部未发送
    assert.equal(sample.jev.status, 'no_key');
    assert.equal(sample.jev.n_requests, 0);
    assert.deepEqual(sample.jev.per_source, []);
    for (const entry of sample.jev.sent) {
      assert.ok(entry.snippets.length > 0);
      assert.ok(
        entry.snippets.every((snippet) => snippet.sent === false),
        entry.src
      );
    }
  });

  it('fails open with exactly one stderr line when the log dir is unwritable, leaving no sample', async () => {
    const blockedPath = join(root, 'blocked-file');
    writeFileSync(blockedPath, 'not a directory', 'utf8'); // logDir 指向一个文件
    const config = configOf(blockedPath);
    const stats = await runPipeline(config);
    const writer = createSampleWriter(config);
    const requestId = '55555555-2222-3333-4444-555555555555';
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
    const requestId = '66666666-2222-3333-4444-555555555555';
    const path = writer.allocatePath(requestId);
    // 相对路径口径：samples/<本地日期>/<request_id>.json
    assert.match(
      path.relative,
      /^samples\/\d{4}-\d{2}-\d{2}\/66666666-2222-3333-4444-555555555555\.json$/
    );

    const outcome = writer.save({
      requestId,
      path,
      originalParams: {},
      braveParams: {},
      filterParams: { query: QUERY },
      intent: INTENT,
      preFilter: { grounding: { generic: [] }, sources: {} },
      stats: emptyStats('test'),
      payload: {},
      statusLine: null,
    });
    assert.deepEqual(outcome, { status: 'saved' });
    assert.equal(existsSync(path.absolute), true);
    // 目录树被自愈创建：samples/ 下恰一个日期子目录
    const samplesDir = join(logDir, 'samples');
    const dateDirs = readdirSync(samplesDir);
    assert.equal(dateDirs.length, 1);
    assert.match(dateDirs[0], /^\d{4}-\d{2}-\d{2}$/);
  });

  it('leaves only the final file after the temp-file rename, never a leftover .tmp', () => {
    const logDir = join(root, 'atomic', 'logs');
    mkdirSync(logDir, { recursive: true });
    const config = configOf(logDir);
    const writer = createSampleWriter(config);
    const requestId = '77777777-2222-3333-4444-555555555555';
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
      payload: {},
      statusLine: null,
    });
    assert.deepEqual(outcome, { status: 'saved' });
    // 原子形状：目标目录里只有最终文件，无 .tmp 残留
    const dateDir = join(logDir, 'samples', path.relative.split('/')[1]);
    assert.deepEqual(readdirSync(dateDir), [`${requestId}.json`]);
  });

  it('leaves no parseable half record when the write fails midway (hooks injection)', async () => {
    const logDir = join(root, 'half-file', 'logs');
    const config = configOf(logDir);
    const stats = await runPipeline(config);
    const writer = createSampleWriter(config, {
      // 故障注入：临时文件写一半（不可能解析成完整 JSON）再抛——rename 永不发生
      writeFile: (tmpPath, data) => {
        writeFileSync(tmpPath, data.slice(0, 20), 'utf8');
        throw new Error('injected mid-write failure');
      },
    });
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
        payload: {},
        statusLine: null,
      });
    } finally {
      console.error = originalError;
    }
    assert.deepEqual(outcome, { status: 'failed' });
    // 防护断言：目录里既无最终 .json 也无半截 .tmp（fail 路径尽力清理）——
    // 绝无可误读为完整成功记录的半截 JSON 落盘
    const dateDir = join(logDir, 'samples', path.relative.split('/')[1]);
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
      n_requests: 2,
      input_tokens: 10,
      latency_ms_total: 20,
      status: 'degraded',
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

    const writer = createSampleWriter(config);
    const requestId = '99999999-2222-3333-4444-555555555555';
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
      payload: { output: stats.output },
      statusLine: stats.output.status_line ?? null,
    });

    const sample = JSON.parse(readFileSync(path.absolute, 'utf8')) as {
      jev: {
        status: string;
        per_source: Array<{ src: string; status: string; fail_kind?: string }>;
        sent: Array<{ src: string; snippets: Array<{ sent: boolean }> }>;
      };
    };
    // 降级记账原样：failed kind 与熔断行都进样本，不伪装成完成检查
    assert.equal(sample.jev.status, 'degraded');
    const rows = new Map(sample.jev.per_source.map((row) => [row.src, row]));
    assert.equal(rows.get('s0')?.fail_kind, 'timeout');
    assert.equal(rows.get('s2')?.status, 'breaker_open');
    // failed / breaker_open 行没有可对齐的片段级判断：映射全部标未发送
    for (const entry of sample.jev.sent) {
      assert.ok(
        entry.snippets.every((snippet) => snippet.sent === false),
        entry.src
      );
    }
  });
});
