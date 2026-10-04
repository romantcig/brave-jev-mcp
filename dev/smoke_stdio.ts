/**
 * 通过 MCP SDK 启动真实 stdio 服务器并检查工具声明、返回内容、日志与样本。
 * 用法：node --import tsx dev/smoke_stdio.ts [--mode off|test|on] [--live]
 * 默认使用 fetch 桩，零网络运行三种模式；test/on 单模式也会运行另一模式作对照。
 * --live 与 --mode 互斥，显式使用真实网络；配置副本与日志写入独享临时目录。
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { JEV_CONFIG_FILE_ENV, parseFilterConfigObject } from '../src/filter/config.js';
import { JEVI_ENDPOINT } from '../src/filter/jev/client.js';
import {
  DEFAULT_JEV_MODEL,
  SNIPPET_CRITERIA,
  SOURCE_QUESTIONS,
} from '../src/filter/jev/questions.js';

// ---------------------------------------------------------------------------
// argv：--mode off|test|on（缺省三模式全量）；--live 真实网络手动开关（互斥）
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const die = (message: string): never => {
  console.error(message);
  process.exit(1);
};

const MODES = ['off', 'test', 'on'] as const;
type SmokeMode = (typeof MODES)[number];

let modeFilter: SmokeMode | undefined;
const modeIndex = args.indexOf('--mode');
if (modeIndex !== -1) {
  const value = args[modeIndex + 1] ?? '';
  if (!(MODES as readonly string[]).includes(value)) {
    die(`--mode 只认 off|test|on，收到：${value || '(缺值)'}`);
  }
  modeFilter = value as SmokeMode;
}
const live = args.includes('--live');
if (live && modeFilter !== undefined) {
  die('--live 与 --mode 互斥：--live 是真实网络手动开关（D-18），单独跑');
}

// ---------------------------------------------------------------------------
// 装载：仓库内路径与夹具（冒烟客户端侧一次性读，桩侧由 stub_fetch.mjs 自行装载）
// ---------------------------------------------------------------------------

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const stubPath = join(repoRoot, 'dev', 'stub_fetch.mjs');
const distIndexJs = join(repoRoot, 'dist', 'index.js');
const toolName = 'brave_llm_context';

// 非空假密钥让 test/on 进入分类器，并满足服务器启动要求；fetch 桩保证零网络。
// 常量单独声明，避免被密钥泄漏检查误报。
const FAKE_JEV_KEY = 'smoke-stub';
const FAKE_BRAVE_KEY = 'smoke-stub';

// off 期望来自夹具的手工标注 final 节，与 pipeline.fixtures.test.ts 共用。
const expected = JSON.parse(
  readFileSync(join(repoRoot, 'fixtures', 'expected', 'jev_release_default.off.json'), 'utf8')
) as {
  query: string;
  intent: string;
  request: Record<string, unknown>;
  final: {
    urls: string[];
    kept_snippets: Record<string, (number | string)[]>;
    n_snippets: number;
  };
};

// 固定夹具契约；调整时与 pipeline.fixtures.test.ts 同步。

// on/off 的差集计数来自固定夹具契约，与下方片段身份集合交叉核对。
const ON_DELTA_REMOVED = 9;
const ON_DELTA_RESTORED = 9;

// off 总数来自期望文件；on 总数按固定差集计算。
const OFF_N_SNIPPETS = expected.final.n_snippets;
const ON_N_SNIPPETS = OFF_N_SNIPPETS - ON_DELTA_REMOVED + ON_DELTA_RESTORED;

// on 的逐 URL 幸存身份，键为 i 或 i.p，按幸存序排列。
// 由独立夹具运行固化；导出前先核对 off 与手工标注一致，不由本次被测运行反推。
// 修改夹具或过滤语义时，需重新核对并与 pipeline.fixtures.test.ts 同步。
const ON_KEPT_SNIPPETS: Record<string, string[]> = {
  'https://www.theregister.com/ai-and-ml/2026/09/16/typesafe-ai-debuts-model-for-machines-that-plays-doom/5296711':
    ['0', '1', '2', '3', '4', '5', '6', '7'],
  'https://www.heise.de/en/news/AI-model-Jev-to-make-machines-decide-faster-11457071.html': [
    '0',
    '1',
    '2',
    '3',
    '4',
    '5',
    '6',
  ],
  'https://pasqualepillitteri.it/en/news/16460/typesafe-jev-chatless-ai-beats-claude': ['1', '2'],
  'https://aiwiki.ai/wiki/typesafe_ai': ['0', '1', '2', '3', '4', '5'],
  'https://www.explainx.ai/blog/typesafe-ai-jev-system-one-models-launch-2026': [
    '0',
    '1.0',
    '1.1',
    '1.2',
    '1.3',
    '1.4',
    '1.5',
  ],
  'https://flowtivity.ai/blog/jev-typesafe-ai-decision-model/': [
    '0',
    '1',
    '2',
    '3.0',
    '3.1',
    '3.2',
    '3.3',
    '3.4',
  ],
  'https://www.datacamp.com/blog/system-one-models-jev': ['3', '4', '5', '6', '7'],
  'https://www.kucoin.com/news/flash/typesafe-ai-launches-jev-a-non-chat-ai-model-193x-faster-than-claude':
    ['1', '2', '4'],
  'https://typesafe.ai/blog/introducing-system-one-models-and-jev': ['0', '1', '2', '3'],
  'https://ua.news/en/technologies/typesafe-predstaviv-model-jev-dlia-avtomatizatsiyi-pz-techcrunch':
    ['0', '2', '3'],
  'https://mezha.net/eng/news/d559e594_typesafe_ai_unveils/': ['1', '3', '5', '7'],
  'https://www.therundown.ai/news/typesafe-jev-ai-decisions-software': ['3', '4'],
};

// 转换后的片段文本期望，与 ON_KEPT_SNIPPETS 同次独立运行固化。
// 涵盖 JSON-LD 提取与样板剥离后的重组文本；其余片段直接与夹具原文逐字比较。
const SNIPPET_WITNESS_TEXTS: Record<string, Record<string, string>> = {
  'https://www.heise.de/en/news/AI-model-Jev-to-make-machines-decide-faster-11457071.html': {
    '1': 'TypeSafe AI demonstrates how Jev could help companies using customer service routing as an example. Jev decides there how an incoming request should be processed. A simple question about order status can go to normal program code, a product question to a language model, and a complex or uncertain case to a human.',
  },
  'https://pasqualepillitteri.it/en/news/16460/typesafe-jev-chatless-ai-beats-claude': {
    '2': '#### 1. What is TypeSafe\'s Jev?\n**Jev is an AI model that doesn\'t chat.** Instead of generating text it returns a typed decision, picked from the options you supply, with a confidence score. TypeSafe calls it the first "System One Model," built for fast decisions inside software',
  },
  'https://www.theregister.com/ai-and-ml/2026/09/16/typesafe-ai-debuts-model-for-machines-that-plays-doom/5296711':
    {
      '1': '# TypeSafe AI debuts model for machines that plays Doom\nTypeSafe AI, a startup bestowed with $40 million in funding, on Tuesday declared itself a maker of frontier models with the release of Jev, a new type of AI model intended for interaction with machines rather than people.\n\nInstead of returning natural language in response to a text-based prompt, TypeSafe AI designed Jev to return typed probabilistic decisions for use by other software or AI models',
    },
  'https://aiwiki.ai/wiki/typesafe_ai': {
    '0': '# TypeSafe AI\nTypeSafe AI (styled TypeSafe) is a San Francisco AI lab founded in 2024 that builds what it calls "machine-native, composable AI": models whose outputs are typed decisions with probabilities for other software to consume, rather than text for people to read. The company came out of stealth on 15 September 2026 with a seed round of approximately $40 million led by DCVC and released its first model, Jev, into early access the same day ^[1]^[2]',
  },
  'https://www.explainx.ai/blog/typesafe-ai-jev-system-one-models-launch-2026': {
    '1.0':
      'Q: What is Jev by TypeSafe AI?\nA: Jev is the first "System One Model" from TypeSafe AI, launched September 15, 2026 by founder Diogo Almeida (a co-inventor of the RLHF work behind ChatGPT). It takes structured or text input and returns typed decisions — a choice, a 0-1 score, or a yes/no probability — instead of generating free-form text, along with a calibrated confidence value on every answer.',
    '1.1':
      'Q: Is Jev a large language model?\nA: No. TypeSafe AI explicitly says Jev is not a language model — it cannot generate strings at all. It takes natural-language or JSON input but only outputs from three fixed primitives (choice, score, or a boolean "noul"), each attached to a probability, which is what lets it skip autoregressive token-by-token generation entirely.',
    '1.2':
      "Q: How much faster and cheaper is Jev than GPT or Claude?\nA: TypeSafe AI claims 70ms-500ms end-to-end latency versus 3-329 seconds for comparable LLM tasks (20-200x faster), and $0.042 per million input tokens with free output tokens (40-400x cheaper). Independent verification is limited to TypeSafe's own published workflow evals and early-access user reports as of this writing.",
    '1.3':
      'Q: Can Jev really "never hallucinate"?\nA: It cannot emit an invalid or malformed answer, because its output space is fixed in advance and schema-checked — that part is mathematically guaranteed. But as Hacker News commenters pointed out during the launch discussion, a schema-valid answer can still be factually wrong, so "no type errors" is not the same claim as "always correct."',
    '1.4':
      'Q: Does Jev replace LLMs like GPT-5.6 or Claude?\nA: No — TypeSafe AI and its own early users describe it as complementary. Jev has no image input, a 32K context window, and cannot generate text, code, or hold a conversation. The suggested pattern is using an LLM to define or refine the decision logic, then routing the repeated, structured part of that logic through Jev in production.',
    '1.5':
      "Q: What is RLCD (Reinforcement Learning for Calibrated Decisions)?\nA: RLCD is TypeSafe AI's training method for Jev, explicitly optimizing for calibrated probabilities on System One-style decisions rather than for human preference (RLHF) or verifiable code/math rewards (RLVR). TypeSafe has not published an architecture paper, so the training mechanics beyond that framing are undisclosed as of September 2026.",
  },
  'https://flowtivity.ai/blog/jev-typesafe-ai-decision-model/': {
    '3.0':
      'Q: What is Jev by TypeSafe AI?\nA: Jev is the first System One Model from TypeSafe AI, launched September 15, 2026. It is built for decisions inside software, not conversation. It takes text or JSON state and returns typed answers (a choice, a score, or a yes/no probability) with calibrated confidence, in 70-500ms, priced at $0.042 per million input tokens with free outputs.',
    '3.1':
      "Q: Is Jev really 20-200x faster and 40-400x cheaper than LLMs?\nA: TypeSafe's own workflow evals show up to 193.6x faster and 444.6x cheaper on decision-shaped tasks. The speed comes from parallel sampling with no text generation loop. The numbers are vendor-run benchmarks against LLMs wrapped in TypeSafe's own adapter, so treat the top end as marketing-adjacent until third-party results exist.",
    '3.2':
      'Q: Can Jev generate text, code, or chat responses?\nA: No. Jev cannot generate strings at all. It only returns one of three typed primitives: Choice (pick one of up to 255 options), Score (a value on a rubric), or Noul (a yes/no probability). Anything that needs writing stays with an LLM.',
    '3.3':
      'Q: What does RLCD mean?\nA: RLCD stands for Reinforcement Learning for Calibrated Decisions. Unlike RLHF, which optimizes for human-preferred text, RLCD trains the model to output decisions with honest probabilities: when Jev says 70 percent confidence, it should be right about 70 percent of the time.',
    '3.4':
      'Q: Is Jev available to use today?\nA: Only via early access waitlist at typesafe.ai as of September 16, 2026. There is no OpenRouter or AWS Bedrock listing yet, and TypeSafe has published no architecture paper or public benchmark scores.',
  },
  'https://ua.news/en/technologies/typesafe-predstaviv-model-jev-dlia-avtomatizatsiyi-pz-techcrunch':
    {
      '1': '# TypeSafe unveils Jev model for software automation — TechCrunch\nLev Shevtsov 18 September 2026 21:58',
    },
  'https://mezha.net/eng/news/d559e594_typesafe_ai_unveils/': {
    '1': '# TypeSafe AI Unveils Jev, a Fast AI Model Built for Software Automation\n### Russian Drones Kill Two Men in Tekstylne, Kherson Region\n\nFriday, 18 September 2026, 23:01\n\n\nA former OpenAI contributor says the next automation breakthrough may not speak back at all, but quietly choose the right action',
  },
};

// 差集只从固定的 off/on 身份集合推导，再与计数常量核对，避免期望自证。
const keptIdentitySet = (kept: Record<string, (number | string)[]>): Set<string> =>
  new Set(Object.entries(kept).flatMap(([url, keys]) => keys.map((key) => `${url}#${key}`)));
const offIdentity = keptIdentitySet(expected.final.kept_snippets);
const onIdentity = keptIdentitySet(ON_KEPT_SNIPPETS);
const removedIdentities = [...offIdentity].filter((key) => !onIdentity.has(key));
const restoredIdentities = [...onIdentity].filter((key) => !offIdentity.has(key));
assert.equal(
  removedIdentities.length,
  ON_DELTA_REMOVED,
  `fixture contract: off−on removed identities must be ${ON_DELTA_REMOVED}, got ${removedIdentities.length} — ${removedIdentities.join(', ')}`
);
assert.equal(
  restoredIdentities.length,
  ON_DELTA_RESTORED,
  `fixture contract: on−off restored identities must be ${ON_DELTA_RESTORED}, got ${restoredIdentities.length} — ${restoredIdentities.join(', ')}`
);
assert.equal(
  onIdentity.size,
  ON_N_SNIPPETS,
  `fixture contract: ON_KEPT_SNIPPETS must cover ${ON_N_SNIPPETS} identities, got ${onIdentity.size}`
);

// Jev 回放表：per_source 全 answered 契约的期望值来源（键数、id↔url、每源候选数）。
// 录制响应的 answers 带 snip0..snip(k-1) 键——k 就是录制时发出的候选片段数真值，
// 桩的数量对齐与日志 snippet_scores 齐全检查共用，不需要 import 管道去推。
const jevRecording = JSON.parse(
  readFileSync(join(repoRoot, 'fixtures', 'jev_release_default.jev.json'), 'utf8')
) as {
  results: Record<
    string,
    { url: string; http: number; response: { answers?: Record<string, unknown> } }
  >;
};
const nRecordedSources = Object.keys(jevRecording.results).length;
// 来源题键统一取自 SOURCE_QUESTIONS，桩只投影对应的录制回答。
const CURRENT_SOURCE_KEYS = Object.keys(SOURCE_QUESTIONS).sort();

// 录制夹具装载自检：全 200（全 answered 契约的前提）且每源 snip 答案键连续——
// 夹具坏了在这里死，不留给断言去误报
for (const [id, entry] of Object.entries(jevRecording.results)) {
  if (entry.http !== 200) die(`录制 ${id} 不是 200 条目——per_source 全 answered 契约不成立`);
  const snipIndices = Object.keys(entry.response?.answers ?? {})
    .filter((key) => /^snip\d+$/.test(key))
    .map((key) => Number(key.slice(4)))
    .sort((a, b) => a - b);
  if (snipIndices.length === 0 || !snipIndices.every((n, i) => n === i)) {
    die(`录制 ${id} 的 snip 答案键不是连续 snip0..snip(k-1)：${snipIndices.join(',')}`);
  }
}
const recordedSnipCounts: Record<string, number> = Object.fromEntries(
  Object.entries(jevRecording.results).map(([id, entry]) => [
    id,
    Object.keys(entry.response?.answers ?? {}).filter((key) => /^snip\d+$/.test(key)).length,
  ])
);

// 正文泄漏检查取片段前 30 字符；跳过恰好出现在标题或 URL 中的文本，避免误报。
const braveFixture = JSON.parse(
  readFileSync(join(repoRoot, 'fixtures', 'jev_release_default.json'), 'utf8')
) as {
  response: {
    grounding: { generic: Array<{ url: string; title?: string; snippets?: string[] }> };
  };
};
const negativeSample = (): { head: string; body: string } => {
  const titlesAndUrls = braveFixture.response.grounding.generic.flatMap((item) => [
    item.url,
    item.title ?? '',
  ]);
  for (const item of braveFixture.response.grounding.generic) {
    for (const text of item.snippets ?? []) {
      const head = text.slice(0, 30);
      if (head.length === 30 && !titlesAndUrls.some((t) => t.includes(head))) {
        return { head, body: text };
      }
    }
  }
  return die('夹具 generic 里找不到可用的 LOG-03 负样本片段（前 30 字符）');
};
const { head: snippetHead, body: snippetBody } = negativeSample();

/**
 * 按 JSON.stringify 的转义形态检查日志是否含正文。
 * 原文含 TAB 或换行时，直接 includes 原文会漏检。
 */
const recordLeaksSnippet = (recordText: string, head: string): boolean =>
  recordText.includes(JSON.stringify(head).slice(1, -1));

// 向正文副本注入 TAB 并序列化为伪日志，自检泄漏检查器能命中；干净日志应不命中。
{
  const tabbedBody = `${snippetBody.slice(0, 20)}\t${snippetBody.slice(20)}`;
  const tabbedHead = tabbedBody.slice(0, 30);
  const fakeRecord = JSON.stringify({ sources: [{ leaked: tabbedBody }] });
  assert.equal(
    recordLeaksSnippet(fakeRecord, tabbedHead),
    true,
    'F-06 canary: the escaped-comparison check must hit a TAB-bearing body serialized into a record line'
  );
  assert.equal(
    fakeRecord.includes(tabbedHead),
    false,
    'F-06 canary: the raw includes() form must miss the same record line (the false green this fix removes)'
  );
  assert.equal(
    recordLeaksSnippet('{"mode":"on"}', tabbedHead),
    false,
    'F-06 canary: a clean record line must not trip the leak check'
  );
}

// 按 URL 索引夹具原始片段，供位置级身份核对。
const rawSnippetsByUrl = new Map(
  braveFixture.response.grounding.generic.map((item) => [item.url, item.snippets ?? []])
);

/**
 * 按返回位置与固定身份核对文本，必须等于转换期望或夹具原文。
 * 不使用通用后缀匹配：任何字符串都 endsWith 空串，会让空文本和任意截断通过。
 * 同 URL 下等数量替换片段也必须被发现。
 */
const snippetMatchesIdentity = (url: string, key: string, text: string): boolean => {
  const witness = SNIPPET_WITNESS_TEXTS[url]?.[key];
  if (witness !== undefined) return text === witness;
  if (key.includes('.')) return false; // 转换段键必须有见证文本
  const raw = rawSnippetsByUrl.get(url)?.[Number(key)];
  if (raw === undefined) return false;
  return raw === text;
};

// 工具输入白名单，与宿主适配测试一致。
const WHITELIST = [
  'query',
  'country',
  'search_lang',
  'count',
  'maximum_number_of_urls',
  'maximum_number_of_tokens',
  'maximum_number_of_tokens_per_url',
  'freshness',
  'goggles',
];

// ---------------------------------------------------------------------------
// 记录与返回的局部形状（JSON.parse 收窄；字段层级以 src/filter/types.ts 为准）
// ---------------------------------------------------------------------------

type ContentBlock = { type: string; text: string };

type SmokePayload = {
  grounding?: { generic?: Array<{ url: string; snippets?: string[] }> };
};

type PerSourceRecord = {
  src?: string;
  url?: string;
  status?: string;
  fail_kind?: string;
  answers?: Record<string, unknown>;
  snippet_scores?: unknown;
};

type SmokeLogRecord = {
  mode?: string;
  model_config?: string;
  model_reported?: string[];
  /** 日志与样本共用的请求身份。 */
  request_id?: string;
  /** test 模式的样本相对路径与保存状态。 */
  sample?: { path?: string; status?: string };
  request?: { query?: string; intent?: string };
  jev?: {
    n_requests?: number;
    status?: string;
    per_source?: PerSourceRecord[];
  } | null;
  shadow_diff?: unknown;
  sources?: Array<{ url?: string; verdict?: string; snippets?: Array<{ kept?: boolean }> }>;
  output?: { status_line?: string; n_snippets?: number };
  error?: unknown;
};

/** 冒烟读取的样本字段子集，完整契约见 src/filter/sample.ts。 */
type SmokeSample = {
  format_version?: number;
  request_id?: string;
  pre_filter?: { grounding?: { generic?: unknown[] } };
  final_return?: { payload?: unknown; status_line?: string | null };
  jev?: {
    status?: string;
    per_source?: unknown[];
    requests?: Array<{
      request_id: string;
      dispatched: boolean;
      state: string | null;
      questions: Record<string, unknown> | null;
      mapping: Array<{ source_id: string; array_index: number }>;
    }>;
    sent?: Array<{
      src?: string;
      request_id?: string;
      array_index?: number;
      snippets?: Array<{
        snippet?: string;
        in_state?: boolean;
        score_question_sent?: boolean;
        scored?: boolean;
      }>;
    }>;
  } | null;
};

// ---------------------------------------------------------------------------
// 单模式冒烟：spawn（桩 + 临时配置 + 临时 log_dir）→ 断言 → 清理
// ---------------------------------------------------------------------------

type ModeResult = { content: ContentBlock[] };

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 等子进程把日志落盘（写入在进程内 promise 链里异步完成），轮询至多 ~5 s。
 * 半行/写入中的读取（JSON 尚不完整）继续等完整行，不把竞态误报成坏记录。
 */
const pollForLogLines = async (logDir: string): Promise<string[]> => {
  for (let waited = 0; waited < 5000; waited += 50) {
    const files = readdirSync(logDir).filter((file) => file.endsWith('.jsonl'));
    if (files.length > 0) {
      const lines = readFileSync(join(logDir, files[0]), 'utf8').split('\n').filter(Boolean);
      const allParsed =
        lines.length > 0 &&
        lines.every((line) => {
          try {
            JSON.parse(line);
            return true;
          } catch {
            return false;
          }
        });
      if (allParsed) return lines;
    }
    await sleep(50);
  }
  return [];
};

/** content[0] 的 JSON 解析：抛错带断言名，由 main 统一 die（finally 仍会清理临时目录）。 */
const parseJsonBlock = (text: string): SmokePayload => {
  try {
    return JSON.parse(text) as SmokePayload;
  } catch (error) {
    throw new Error(`return: content[0] JSON parse failed — ${String(error)}`);
  }
};

const runStubbedMode = async (runMode: SmokeMode): Promise<ModeResult> => {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'jev-smoke-stdio-'));
  const configPath = join(tmpRoot, 'config.json');
  writeFileSync(configPath, JSON.stringify({ mode: runMode, log_dir: tmpRoot }), 'utf8');

  const stderrChunks: Buffer[] = [];
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', pathToFileURL(stubPath).href, distIndexJs, '--transport', 'stdio'],
    // SDK 不会默认继承所有环境变量；显式传入配置路径、假密钥和桩的请求期望。
    // 模型与端点取源码导出，避免两处常量漂移。
    env: {
      JEV_FILTER_CONFIG_FILE: configPath,
      TYPESAFE_API_KEY: FAKE_JEV_KEY,
      BRAVE_API_KEY: FAKE_BRAVE_KEY,
      SMOKE_JEV_MODEL: DEFAULT_JEV_MODEL,
      SMOKE_JEV_ENDPOINT: JEVI_ENDPOINT,
      SMOKE_JEV_CRITERIA: JSON.stringify(SNIPPET_CRITERIA),
    },
    stderr: 'pipe',
  });
  transport.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

  const client = new Client({ name: 'smoke-stdio', version: '0.0.0' });
  try {
    // connect 自动完成 initialize 握手。
    await client.connect(transport);

    // 工具声明
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === toolName);
    assert.ok(tool, `declaration: ${toolName} is not listed`);
    assert.deepEqual(
      Object.keys(tool.inputSchema.properties ?? {}).sort(),
      [...WHITELIST, 'intent'].sort(),
      'declaration: inputSchema properties must be the whitelist plus intent'
    );
    assert.deepEqual(
      tool.inputSchema.required,
      ['query', 'intent'],
      'declaration: required must be [query, intent]'
    );
    assert.equal(tool.outputSchema, undefined, 'declaration: outputSchema must be absent');

    // 按固定夹具参数调用工具。
    const result = (await client.callTool({
      name: toolName,
      arguments: {
        query: expected.query,
        intent: expected.intent,
        ...expected.request,
      },
    })) as { isError?: boolean; structuredContent?: unknown; content: ContentBlock[] };

    assert.equal(
      result.isError ?? false,
      false,
      `return: call failed — ${JSON.stringify(result.content)}`
    );
    assert.equal(result.structuredContent, undefined, 'return: structuredContent must be absent');
    const content = result.content;
    // 当前夹具必有删除，因此应返回两个 text 块；普通无状态行请求可只返回一块。
    assert.equal(
      content.length,
      2,
      `return: exactly two text blocks expected — got ${content.length}`
    );
    assert.equal(content[0]?.type, 'text', 'return: content[0] must be a text block');
    assert.equal(content[1]?.type, 'text', 'return: content[1] must be a text block');
    const payload = parseJsonBlock(content[0].text);

    // 实际片段数与来源身份
    const generic = payload.grounding?.generic;
    assert.ok(Array.isArray(generic), 'return: grounding.generic must be an array');
    const counted = generic.reduce((sum, item) => sum + (item.snippets?.length ?? 0), 0);
    assert.deepEqual(
      generic.map((item) => item.url),
      expected.final.urls,
      'return: surviving source URLs must equal the fixture final.urls in Brave order'
    );
    // test/on 使用同一组期望；off 使用本地过滤的期望文件。
    const expectedCount = runMode === 'off' ? OFF_N_SNIPPETS : ON_N_SNIPPETS;
    assert.equal(
      counted,
      expectedCount,
      `return: counted snippets must be ${expectedCount} in ${runMode} (fixture contract), got ${counted}`
    );
    // 逐 URL、逐位置核对幸存身份，防止等数量换成已删片段却通过总数检查。
    const expectedKept: Record<string, (number | string)[]> =
      runMode === 'off' ? expected.final.kept_snippets : ON_KEPT_SNIPPETS;
    for (const item of generic) {
      const keys = expectedKept[item.url];
      assert.ok(
        Array.isArray(keys),
        `return: URL ${item.url} missing from the ${runMode} kept-snippet contract`
      );
      assert.equal(
        item.snippets?.length,
        keys.length,
        `return: snippet count for ${item.url} must equal the ${runMode} kept list`
      );
      item.snippets?.forEach((text, position) => {
        const key = String(keys[position]);
        assert.ok(
          snippetMatchesIdentity(item.url, key, text),
          `return: snippet #${position} of ${item.url} does not match the ${runMode} fixture identity ${key} (got head ${JSON.stringify(text.slice(0, 60))})`
        );
      });
    }
    assert.equal(Object.hasOwn(payload, 'output'), false, '规模统计只写日志');

    // 状态行与统计同源；此夹具可只有片段删除。test 额外带样本定位后缀。
    const statusLine = content[1]?.text;
    assert.ok(
      statusLine.startsWith('[filter] '),
      `status line: must start with "[filter] " — ${statusLine}`
    );
    assert.ok(!statusLine.includes('\n'), 'status line: must be a single line');
    assert.match(
      statusLine,
      /^\[filter\] (dropped \d+ of \d+ sources: .+; )?\d+ snippets? removed(; .+)?( sample for filter debugging - original results, filtered results, Jev decisions: .+)?$/,
      `status line: D-02 shape mismatch — ${statusLine}`
    );
    if (runMode === 'test') {
      assert.ok(
        statusLine.includes(
          ' sample for filter debugging - original results, filtered results, Jev decisions: '
        ),
        `status line: test mode must carry the sample suffix — ${statusLine}`
      );
    } else {
      assert.ok(
        !statusLine.includes(
          ' sample for filter debugging - original results, filtered results, Jev decisions: '
        ),
        `status line: ${runMode} must not carry a sample suffix — ${statusLine}`
      );
    }
    assert.ok(
      !statusLine.includes('not checked by Jev'),
      `status line: the unchecked segment must not appear in ${runMode} (default fixture is fully answered) — ${statusLine}`
    );
    assert.equal(
      Object.hasOwn(payload, 'output'),
      false,
      '状态行只在第二个文本块返回，正文不重复携带'
    );

    // 固定夹具的一次成功调用应恰好写一条日志。
    const files = readdirSync(tmpRoot).filter((file) => file.endsWith('.jsonl'));
    assert.equal(files.length, 1, `log: exactly one dated .jsonl expected, got ${files.length}`);
    assert.match(
      files[0],
      /^\d{4}-\d{2}-\d{2}\.jsonl$/,
      `log: file must be a local-date name — ${files[0]}`
    );
    await pollForLogLines(tmpRoot);
    // 等待写入链安静后再数一次，避免先读到部分记录导致假通过。
    await sleep(250);
    const lines = readFileSync(join(tmpRoot, files[0]), 'utf8').split('\n').filter(Boolean);
    assert.equal(
      lines.length,
      1,
      `log: exactly one record expected for a single call, got ${lines.length}`
    );
    const recordText = lines[0];
    let record: SmokeLogRecord;
    try {
      record = JSON.parse(recordText) as SmokeLogRecord;
    } catch (error) {
      assert.fail(`log: record line is not valid JSON — ${String(error)}`);
    }
    // 成功记录形状：无 error 标记、有 stats 主体（writeError 两者恰好相反）
    assert.equal(
      record.error,
      undefined,
      'log: the record must be a success record (no error field)'
    );
    assert.ok(record.output !== undefined, 'log: the record must carry the stats body (output)');
    assert.equal(record.output.n_snippets, counted, '日志片段计数须与实际返回逐条对账');
    assert.equal(record.mode, runMode, 'log: record mode must match the config (D-16)');
    assert.equal(
      record.model_config,
      DEFAULT_JEV_MODEL,
      'log: model_config must be the pinned model'
    );
    assert.equal(
      record.request?.query,
      expected.query,
      'log: record must belong to this call (query)'
    );
    assert.equal(
      record.request?.intent,
      expected.intent,
      'log: record must belong to this call (intent)'
    );
    // 三种模式均携带 request_id，test 用它关联样本。
    assert.match(
      record.request_id ?? '',
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      'log: record must carry a request_id (04-02 envelope increment)'
    );
    if (runMode !== 'test') {
      assert.equal(record.sample, undefined, `log: ${runMode} records carry no sample pointer`);
    }
    assert.ok(
      !recordLeaksSnippet(recordText, snippetHead),
      `log: LOG-03 red line — snippet body prefix must not appear (${JSON.stringify(snippetHead)})`
    );

    // --- 6. 日志裁决表与返回内容逐 URL 对账（重建输出与统计表同源一致性）---
    const keptByUrl = new Map<string, number>();
    let keptTotal = 0;
    for (const row of record.sources ?? []) {
      if (row.verdict !== 'keep') continue;
      const kept = (row.snippets ?? []).filter((snippet) => snippet.kept === true).length;
      keptByUrl.set(row.url ?? '', (keptByUrl.get(row.url ?? '') ?? 0) + kept);
      keptTotal += kept;
    }
    assert.equal(
      keptTotal,
      counted,
      'log: total kept snippets in the stats table must equal the content count'
    );
    for (const item of generic) {
      assert.equal(
        keptByUrl.get(item.url),
        item.snippets?.length,
        `log: kept count for ${item.url} must equal the content`
      );
    }

    // Jev 请求记账
    if (runMode === 'off') {
      // off 的 jev 必须为 null。
      assert.equal(record.jev, null, 'log: off must record jev exactly null (zero Jev requests)');
      assert.deepEqual(record.model_reported, [], 'log: off must report no answered model');
      assert.equal(record.shadow_diff, null, 'log: off must record shadow_diff null');
    } else {
      const jev = record.jev;
      assert.ok(
        jev !== null && typeof jev === 'object',
        `log: ${runMode} must record a jev body — no_key silent short-circuit is the Pitfall 2 false green`
      );
      assert.equal(
        jev.status,
        'ok',
        `log: ${runMode} jev.status must be ok (got ${jev.status}) — no_key/degraded/breaker_open do not satisfy the all-answered replay contract`
      );
      assert.equal(
        jev.n_requests,
        1,
        `log: ${runMode} jev.n_requests must be 1 (one shared request covers every candidate), got ${jev.n_requests}`
      );
      const rows = jev.per_source;
      assert.ok(Array.isArray(rows), `log: ${runMode} jev.per_source must be an array`);
      assert.equal(
        rows.length,
        nRecordedSources,
        `log: ${runMode} jev.per_source must have exactly ${nRecordedSources} rows, got ${rows.length}`
      );
      assert.deepEqual(
        rows.map((row) => row.src).sort(),
        Object.keys(jevRecording.results).sort(),
        `log: ${runMode} per_source ids must be exactly the recording's s0..s${nRecordedSources - 1}`
      );
      for (const row of rows) {
        const id = row.src ?? '(missing)';
        // 夹具所有来源应完成有效裁决，不允许失败或 validation 兜底。
        assert.equal(
          row.status,
          'answered',
          `log: per_source ${id} must be answered — got ${row.status}${row.fail_kind ? `/${row.fail_kind}` : ''} (empty/invalid answers fall back to keep here)`
        );
        assert.equal(row.fail_kind, undefined, `log: per_source ${id} must carry no fail_kind`);
        assert.equal(
          row.url,
          jevRecording.results[id]?.url,
          `log: per_source ${id} url must match the recording entry`
        );
        // 答案键集合必须等于当前来源题集合。
        const answers = row.answers;
        assert.ok(
          answers !== undefined && typeof answers === 'object',
          `log: per_source ${id} must carry the four source-level answers`
        );
        assert.deepEqual(
          Object.keys(answers).sort(),
          CURRENT_SOURCE_KEYS,
          `log: per_source ${id} answers must cover exactly the current four source-level questions`
        );
        // snippet_scores 齐全：数组、长度等于该源候选数真值（录制 snip 键数）、全有限数
        assert.ok(
          Array.isArray(row.snippet_scores),
          `log: per_source ${id} snippet_scores missing — answers without scores fail the "无 validation 兜底" bar`
        );
        assert.equal(
          row.snippet_scores.length,
          recordedSnipCounts[id],
          `log: per_source ${id} snippet_scores must cover every candidate snippet (${recordedSnipCounts[id]})`
        );
        for (const score of row.snippet_scores) {
          assert.ok(
            typeof score === 'number' && Number.isFinite(score),
            `log: per_source ${id} snippet_scores must be finite numbers, got ${String(score)}`
          );
        }
      }
      assert.deepEqual(
        record.model_reported,
        [DEFAULT_JEV_MODEL],
        `log: ${runMode} model_reported must be the recorded model`
      );
      // shadow_diff 仅兼容旧记录，当前运行应为 null。
      assert.equal(record.shadow_diff, null, 'log: new records must not carry shadow_diff');

      // test 模式样本
      if (runMode === 'test') {
        const marker =
          ' sample for filter debugging - original results, filtered results, Jev decisions: ';
        const markerAt = statusLine.indexOf(marker);
        assert.ok(
          markerAt !== -1,
          `sample for filter debugging - original results, filtered results, Jev decisions: test status line must carry the path — ${statusLine}`
        );
        const sampleAbsPath = statusLine.slice(markerAt + marker.length);
        // callTool 返回时样本必须已存在，以检查先保存后返回的顺序。
        assert.ok(
          existsSync(sampleAbsPath),
          `sample for filter debugging - original results, filtered results, Jev decisions: the status-line path must exist at return time — ${sampleAbsPath}`
        );
        const sample = JSON.parse(readFileSync(sampleAbsPath, 'utf8')) as SmokeSample;
        // 按 v6 请求级记录核对实发载荷。
        assert.equal(
          sample.format_version,
          6,
          'sample for filter debugging - original results, filtered results, Jev decisions: format_version must be 6'
        );
        // all-only：一次共享请求覆盖全部候选；每来源行必须关联到这条真实请求
        assert.equal(sample.jev?.requests?.length, 1);
        for (const source of sample.jev?.sent ?? []) {
          const request = sample.jev?.requests?.find(
            (item) => item.request_id === source.request_id
          );
          assert.ok(request?.dispatched);
          assert.ok(request.state !== null && request.questions !== null);
          assert.ok(
            request.mapping.some(
              (item) => item.source_id === source.src && item.array_index === source.array_index
            )
          );
        }
        assert.equal(
          sample.request_id,
          record.request_id,
          'sample for filter debugging - original results, filtered results, Jev decisions: request_id must match the JSONL record (three-way correlation)'
        );
        assert.equal(
          record.sample?.status,
          'saved',
          'sample for filter debugging - original results, filtered results, Jev decisions: the JSONL envelope must record the sample as saved'
        );
        assert.ok(
          sample.final_return?.payload !== undefined,
          'sample for filter debugging - original results, filtered results, Jev decisions: final_return payload must be present'
        );
        // final_return 与实际返回逐字段一致（含同一条 sample 路径的状态行）
        assert.deepEqual(
          sample.final_return?.payload,
          payload,
          'sample for filter debugging - original results, filtered results, Jev decisions: final_return must be field-identical to the actual return'
        );
        assert.equal(
          sample.final_return?.status_line,
          statusLine,
          'sample for filter debugging - original results, filtered results, Jev decisions: status_line must equal the second text block'
        );
        // pre_filter 携带完整原始响应（schema 校验前捕获，未被管道修改）
        assert.equal(
          sample.pre_filter?.grounding?.generic?.length,
          nRecordedSources,
          'sample for filter debugging - original results, filtered results, Jev decisions: pre_filter must carry the full pre-filter response'
        );
        // 夹具所有 keep 来源均有有效答案，片段应已入 state、提交题目并收到有效评分。
        assert.equal(
          sample.jev?.sent?.length,
          nRecordedSources,
          'sample for filter debugging - original results, filtered results, Jev decisions: sent must cover every candidate source'
        );
        for (const entry of sample.jev?.sent ?? []) {
          assert.ok(
            (entry.snippets ?? []).every(
              (snippet) =>
                snippet.in_state === true &&
                snippet.score_question_sent === true &&
                snippet.scored === true
            ),
            `sample for filter debugging - original results, filtered results, Jev decisions: ${entry.src ?? '(missing src)'} snippets must all be dispatched and scored in the fully-answered fixture`
          );
        }
      }
    }

    // --- 8. stderr：日志写成功 + 桩零失败标记 + 桩侧 Jev 计数对账 ---
    const stderrText = Buffer.concat(stderrChunks).toString('utf8');
    assert.ok(
      !stderrText.includes('[jev-filter] Unable to write'),
      `stderr: log writes must succeed (D-14) — ${stderrText}`
    );
    assert.ok(
      !stderrText.includes('[smoke-stub]'),
      `stderr: the stub must accept every request identity (R-12 markers absent) — ${stderrText}`
    );
    // 桩独立统计请求数：off 为 0，test/on 为 1，与服务器日志交叉验证。
    const replays = [...stderrText.matchAll(/\[smoke-replay\] shared request /g)].length;
    assert.equal(
      replays,
      runMode === 'off' ? 0 : 1,
      `stderr: stub replay count must be ${runMode === 'off' ? 0 : 1} in ${runMode}, got ${replays}`
    );

    return { content };
  } finally {
    await client.close();
    rmSync(tmpRoot, { recursive: true, force: true });
  }
};

// 显式 live 模式：密钥与代理从环境传入，不注入桩。
// 配置副本只替换 log_dir；独享目录用于确定日志归属，不进入默认自动验证。

/** live 需显式透传的环境变量；配置路径单独指向本次临时副本。 */
const LIVE_ENV_KEYS = [
  'TYPESAFE_API_KEY',
  'BRAVE_API_KEY',
  'ALL_PROXY',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'NODE_USE_ENV_PROXY',
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * 读取生产配置原始 JSON，容忍 BOM；缺失或格式错误时告警并返回 undefined。
 * 值校验与路径展开交给 parseFilterConfigObject，避免复制配置解析逻辑。
 */
const readProductionConfigRaw = (configPath: string | undefined): unknown => {
  if (configPath === undefined) return undefined;
  try {
    const raw: unknown = JSON.parse(readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''));
    if (raw === null) {
      console.error('[smoke] live: config top level is null; the server will use all defaults.');
      return undefined;
    }
    return raw;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(
      `[smoke] live: config file '${configPath}' is unreadable or bad JSON (${reason}); the server falls back to defaults — mirroring that here.`
    );
    return undefined;
  }
};

/**
 * 读取独享目录全部 JSONL，兼容跨午夜滚动。
 * 目录不存在或末尾半行表示尚未写完；完整坏行和其他读取错误需明确诊断。
 */
const readPrivateLogRecords = (logDir: string): Record<string, unknown>[] => {
  let files: string[];
  try {
    files = readdirSync(logDir)
      .filter((file) => file.endsWith('.jsonl'))
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new Error(
      `live: cannot read the private log dir — ${String(error)}（权限/占用等读错误需要明确诊断，不能当作没写）`
    );
  }
  const records: Record<string, unknown>[] = [];
  for (const file of files) {
    const text = readFileSync(join(logDir, file), 'utf8');
    const lastNewline = text.lastIndexOf('\n');
    if (lastNewline === -1) continue;
    for (const line of text.slice(0, lastNewline).split('\n')) {
      if (line.trim() === '') continue;
      try {
        records.push(JSON.parse(line) as Record<string, unknown>);
      } catch {
        console.error('[smoke] live: skipping an unparseable complete log line.');
      }
    }
  }
  return records;
};

/** 最多轮询约 10 秒；独享目录确定记录归属，query/intent 只作辅助校验。 */
const pollForNewRecord = async (logDir: string): Promise<SmokeLogRecord> => {
  for (let waited = 0; waited < 10000; waited += 100) {
    const matching = readPrivateLogRecords(logDir).filter(
      (record) =>
        (record.request as SmokeLogRecord['request'])?.query === expected.query &&
        (record.request as SmokeLogRecord['request'])?.intent === expected.intent
    );
    if (matching.length > 0) return matching[matching.length - 1] as SmokeLogRecord;
    await sleep(100);
  }
  throw new Error(
    'live: no log record within 10s in the private log dir — 独享目录零记录 = 本次调用没有落账（R-09）'
  );
};

const runLiveMode = async (): Promise<void> => {
  // 默认配置路径，与生产解析一致。
  const homeConfig = join(homedir(), '.brave-jev', 'config.json');
  const env: Record<string, string> = {};
  for (const key of LIVE_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined && value !== '') env[key] = value;
  }
  // 显式配置环境变量优先，否则使用默认配置位置。
  const envConfigPath = process.env[JEV_CONFIG_FILE_ENV]?.trim() || undefined;
  const productionConfigPath = envConfigPath ?? (existsSync(homeConfig) ? homeConfig : undefined);
  const productionRaw = readProductionConfigRaw(productionConfigPath);
  const liveConfig = parseFilterConfigObject(productionRaw);
  const configMode = liveConfig.mode;
  if (configMode === 'off') {
    die(
      'live: 生效配置 mode=off——Jev 永远不会被调用，仅 Brave 成功不能确认 Brave + Jev 链路（R-09）。把配置改为 test/on 后再跑。'
    );
  }

  // 配置副本只替换 log_dir，以隔离生产日志和其他进程；其余字段原样保留。
  const tmpRoot = mkdtempSync(join(tmpdir(), 'jev-smoke-live-'));
  const privateLogDir = join(tmpRoot, 'logs');
  const privateConfigPath = join(tmpRoot, 'config.json');
  writeFileSync(
    privateConfigPath,
    JSON.stringify({
      ...(isRecord(productionRaw) ? productionRaw : {}),
      log_dir: privateLogDir,
    }),
    'utf8'
  );
  env[JEV_CONFIG_FILE_ENV] = privateConfigPath;
  console.error(`[smoke] live: private log dir ${privateLogDir}`);

  console.error('*** LIVE MODE: 即将发起真实网络请求（Brave + Jev），key 与代理走本机环境 ***');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [distIndexJs, '--transport', 'stdio'],
    env,
    stderr: 'inherit',
  });
  const client = new Client({ name: 'smoke-stdio-live', version: '0.0.0' });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.ok(
      tools.some((t) => t.name === toolName),
      `live: ${toolName} is not listed`
    );

    const result = (await client.callTool({
      name: toolName,
      arguments: { query: expected.query, intent: expected.intent, ...expected.request },
    })) as { isError?: boolean; content: ContentBlock[] };
    assert.equal(result.isError ?? false, false, 'live: callTool failed');
    assert.equal(result.content[0]?.type, 'text', 'live: content[0] must be a text block');
    try {
      JSON.parse(result.content[0].text);
    } catch (error) {
      throw new Error(`live: content[0] JSON parse failed — ${String(error)}`);
    }

    const record = await pollForNewRecord(privateLogDir);
    // 交叉核对模式、模型与请求参数，确认子进程读到了预期配置。
    assert.equal(
      record.mode,
      configMode,
      `live: record mode must match the resolved config (${configMode})`
    );
    assert.equal(
      record.model_config,
      liveConfig.jev.model,
      'live: record model_config must match the configured pinned model'
    );
    assert.equal(
      record.request?.query,
      expected.query,
      'live: record must belong to this call (query)'
    );
    assert.equal(
      record.request?.intent,
      expected.intent,
      'live: record must belong to this call (intent)'
    );

    // 裁决状态读取 per_source 行；汇总 jev.status 没有 answered 值。
    const jev = record.jev;
    assert.ok(
      jev !== null && typeof jev === 'object',
      'live: jev body missing while mode is not off — 服务器记账与配置不一致，链路未确认'
    );
    assert.notEqual(
      jev.status,
      'no_key',
      'live: key 未生效（no_key 静默短路）——仅 Brave 成功不能确认 Brave + Jev 链路'
    );
    const rows = Array.isArray(jev.per_source) ? jev.per_source : [];
    assert.ok(
      (jev.n_requests ?? 0) > 0,
      'live: zero Jev requests went out — 仅 Brave 成功不能确认 Brave + Jev 链路（R-09）'
    );

    // 收到响应与取得有效裁决分别统计；answered 且无 fail_kind 才可能有效。
    // 还需有限的 is_off_topic 概率，避免把空答案误计为有效裁决。
    const stateOf = (row: PerSourceRecord): 'usable' | 'validation' | 'failed' => {
      if (row.status !== 'answered') return 'failed';
      const pOffTopic = row.answers?.is_off_topic;
      return row.fail_kind === undefined &&
        typeof pOffTopic === 'number' &&
        Number.isFinite(pOffTopic)
        ? 'usable'
        : 'validation';
    };
    const usableRows = rows.filter((row) => stateOf(row) === 'usable');
    const validationRows = rows.filter((row) => stateOf(row) === 'validation');
    const failedRows = rows.filter((row) => stateOf(row) === 'failed');
    const perSourceStates = rows.map(
      (row) => `${row.src}:${row.status}${row.fail_kind ? `/${row.fail_kind}` : ''}`
    );
    assert.ok(
      usableRows.length >= 1,
      `live: zero usable per_source rows (requests=${jev.n_requests}, received=${rows.length - failedRows.length}, validation=${validationRows.length}, failed=${failedRows.length}) — 全部无效不确认链路：${JSON.stringify(perSourceStates)}`
    );

    // 写入链安静后核对独享目录恰好一条记录。
    await sleep(250);
    const settled = readPrivateLogRecords(privateLogDir);
    assert.equal(
      settled.length,
      1,
      `live: the private log dir must hold exactly one record for this call, got ${settled.length}`
    );

    // 逐源报告有效、validation 和 failed 数量，仅全部有效时通过。
    const summary =
      `mode=${record.mode} requests=${jev.n_requests} ` +
      `usable=${usableRows.length} validation=${validationRows.length} failed=${failedRows.length}`;
    if (validationRows.length > 0 || failedRows.length > 0) {
      console.error(`*** LIVE 部分降级：${summary} ***`);
      for (const row of rows) {
        if (stateOf(row) === 'usable') continue;
        console.error(
          `  [smoke] live degraded: ${row.src} ${row.url ?? '(no url)'} -> ${row.status}${row.fail_kind ? `/${row.fail_kind}` : ''}`
        );
      }
      console.log(`smoke live: all assertions passed (degraded) — ${summary}`);
    } else {
      console.log(`smoke live: all assertions passed — ${summary}`);
      console.error('*** LIVE 完成：本次调用确认 Brave + Jev 链路（全部来源实际可用）***');
    }
  } finally {
    await client.close();
    rmSync(tmpRoot, { recursive: true, force: true });
  }
};

// ---------------------------------------------------------------------------
// 主流程：三模式循环（test 与 on 逐字段对照）或 --live；汇总行便于 verify grep
// ---------------------------------------------------------------------------

try {
  if (live) {
    await runLiveMode();
  } else {
    const runs = new Map<SmokeMode, ModeResult>();
    const modes: SmokeMode[] = modeFilter ? [modeFilter] : [...MODES];
    for (const m of modes) {
      // test/on 单模式也启动另一个模式，以比较两份独立进程的结果。
      if (modeFilter !== undefined && m === 'test' && !runs.has('on')) {
        runs.set('on', await runStubbedMode('on'));
      }
      if (modeFilter !== undefined && m === 'on' && !runs.has('test')) {
        runs.set('test', await runStubbedMode('test'));
      }
      const run = await runStubbedMode(m);
      runs.set(m, run);
      console.log(`smoke ${m}: all assertions passed`);
    }
    // 比较完整 content 数组，仅剥除 test 状态行的样本定位后缀，正文仍逐字核对。
    const testRun = runs.get('test');
    const onRun = runs.get('on');
    if (testRun !== undefined && onRun !== undefined) {
      const stripSampleSuffix = (run: ModeResult): ModeResult => {
        const content: ContentBlock[] = run.content.map((block) => ({ ...block }));
        const statusBlock = content[1];
        if (statusBlock?.type === 'text') {
          const at = statusBlock.text.indexOf(
            ' sample for filter debugging - original results, filtered results, Jev decisions: '
          );
          if (at !== -1) statusBlock.text = statusBlock.text.slice(0, at);
        }
        return { content };
      };
      assert.deepEqual(
        stripSampleSuffix(testRun),
        stripSampleSuffix(onRun),
        'test: full content array must be field-identical to the on run after stripping the sample suffix (same fixture, same stub, independent spawns)'
      );
    }
    if (modeFilter === undefined) {
      console.log('smoke all: 3 modes passed');
    }
  }
} catch (error) {
  const where = live ? 'live' : (modeFilter ?? 'all');
  die(`smoke FAILED [${where}]: ${error instanceof Error ? error.message : String(error)}`);
}
