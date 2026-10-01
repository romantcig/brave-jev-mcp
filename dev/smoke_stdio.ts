/**
 * stdio 冒烟脚本（TOOLS-02，D-17/D-19）：spawn 真服务器进程（dist/index.js + 预加载
 * 桩 dev/stub_fetch.mjs），用 MCP SDK Client + StdioClientTransport 走 initialize →
 * tools/list → tools/call 全程，零网络确定性地验证返回形状与状态行——切到
 * ~/.claude.json（03-04）之前的最后一道自动闸，冒烟通过是切换任务的硬前置。
 *
 * 用法：node --import tsx dev/smoke_stdio.ts [--mode off|test|on] [--live]
 *   不带 --mode 跑三模式全量（off → test → on，每模式各自 spawn 一次服务器、
 *   各自临时配置与临时 log_dir——mode 在配置文件里、服务器启动读一次）；单独
 *   --mode test 或 --mode on 时自动先跑另一个模式作逐字段对照（test==on 互证
 *   需要两份独立 spawn 的结果）。--live 是真实网络
 *   手动开关（D-18，不进自动验证，切换前跑一次确认 key 与代理通），与 --mode 互斥。
 *
 * 三模式行为断言（R-11，E 包假绿缺口的收口；期望全部来自固定发布夹具契约）：
 *   - 三模式共同：返回 content 恰两个 text 块（本夹具必有删除 → 状态行必在）；
 *     content[0] JSON 里 grounding.generic[] 的片段扁平总数独立清点（不信任
 *     output.n_snippets 自报值，同时断言两者一致）；幸存来源 URL 序与逐 URL 幸存
 *     片段索引身份（位置级文本形态匹配——off/test 对照期望文件 final 节、on 对照
 *     ON_KEPT_SNIPPETS 常数，F-05）；日志 sources 裁决表与 content 逐 URL 对账；
 *     临时 log_dir 恰一条
 *     成功记录（无 error 字段、有 stats 主体），mode / model_config / request 与
 *     本次调用一致；
 *   - off：片段总数 = off 期望（59）；日志 jev 严格为 null；桩侧 Jev 请求数 0
 *     （stderr 无 [smoke-replay] 行；桩对 off 下的 Jev 请求直接拒绝——E-03 双层闸）；
 *   - test：完整 content 数组与 on 那次独立 spawn 的结果逐字段相同（同夹具同预加载
 *     桩，04-01 单链语义的端到端互证，含每个 text 块；比较前剥除状态行 sample 后缀
 *     ——CONTEXT 允许 test 多出样本定位元信息，04-02）；状态行 sample 路径指向真实
 *     存在的样本文件、样本 request_id 与该次 JSONL 记录相同、JSONL 信封
 *     sample.status 为 saved（SC3 全链）；per_source 断言（恰 12 行
 *     全部 answered、无 fail_kind、十题答案与 snippet_scores 对齐录制真值）与 on
 *     同口径；新记录不再产生 shadow_diff（恒 null，字段仅为读旧记录保留）；
 *   - on：片段总数 = on 期望（61，由夹具契约差集推导：59 − 删 9 + 恢复 11）；
 *     逐 URL 幸存索引身份对照 ON_KEPT_SNIPPETS 常数（独立运行固化，9 删/11 恢复以
 *     身份差集互钉）；per_source 断言同 test——no_key 静默短路、空回答、
 *     validation 兜底都在这里现形（E-01/E-02 的直接防线）。
 *
 * --live（D-18，R-09 合并 E-04/IN-01，F-03/F-04）：真实网络手动开关，目标是确认
 * Brave + Jev 链路。配置解析与生产同口径（复用 src/filter/config.ts 导出的
 * parseFilterConfigObject：~ / ~/ / ~\ 展开、字面 ~foo 原样、空白与坏值回落）；
 * 读出生产配置原始 JSON 后只把 log_dir 替换为本次冒烟的独享临时目录，写成临时
 * 配置副本传给子进程（其余字段——mode、jev.model、阈值、blocklist 等——原样
 * 保留，TYPESAFE_API_KEY 仍走环境变量），轮询独享目录下全部 .jsonl 文件：目录里
 * 只有本次记录，不存在同查询的其他进程写入，也不受写入器跨零点换日期文件影响；
 * ENOENT / 无完整记录视为尚未写出继续短轮询，其他读错误明确诊断。query + intent
 * 匹配保留为辅助校验，不再是记录归属依据（独享目录本身就是身份保证）。从记录的
 * per_source 分别统计"已收到响应"与"可用来源级裁决"（F-03）：可用行要求 answered
 * 且无 fail_kind（R-04：关键答案缺失/越界时仍是 answered + fail_kind='validation'）
 * 并核 answers.is_off_topic 为有限数；mode off / no_key / 零请求 / 零可用一律失败
 * （仅 Brave 成功绝不输出"两者已发生"）；部分无效如实打出逐源降级明细（有效 N /
 * validation M / failed K，只有全部可用才算全绿）；绝不检查不存在的汇总 answered
 * 字段（record.jev.status 只有 ok/no_key/degraded/breaker_open，层级错误会把正常
 * 请求误判）。
 *
 * 断言清单（D-19 照 src/tools/llm_context/index.test.ts 既有断言抄的部分）：
 *   1. 工具声明：inputSchema.properties == 白名单九键 + intent、required ==
 *      ['query','intent']、无 outputSchema；
 *   2. 状态行：以 `[filter] ` 开头、单行、D-02 形状、与 JSON 块内
 *      output.status_line 逐字同源（D-08）、无 on 专属未判定段（D-06）；
 *   3. stderr：无 `[jev-filter] Unable to write`（日志写成功）、无 `[smoke-stub]`
 *      失败标记（桩身份校验全过、off 闸未触发）。
 *
 * 两个关键坑（RESEARCH 六问 3/4）：
 *   - SDK spawn 的 env 白名单 12 变量不含 TYPESAFE_API_KEY / JEV_FILTER_CONFIG_FILE，
 *     冒烟需要的每个变量必须显式放进 serverParams.env；
 *   - on/test 不设假 key 会走 no_key 静默短路（Pitfall 2 假绿）——off 也统一传假值。
 *
 * dev/ 不进 tsc / prettier 门禁；相对导入带 .js 后缀（NodeNext ESM 直跑约定）。
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
import { DEFAULT_JEV_MODEL } from '../src/filter/jev/questions.js';

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

// 假 key（T-03-06）：值非空即可让 on/test 走真分类器路径，桩会截住全部请求。
// BRAVE_API_KEY 是上游 CLI 的启动硬前置（缺了直接退出），桩模式同样传假值——
// 零网络由桩保证，不依赖 key 真实性。两个 key 都写成常量再引用——不把 key 名与
// 引号字面量相邻，保持 key 泄漏闸 grep 形态干净。
const FAKE_JEV_KEY = 'smoke-stub';
const FAKE_BRAVE_KEY = 'smoke-stub';

// 期望文件：三件套取 off 标注（与 dev/compare.ts 同式）；final 节是
// pipeline.fixtures.test.ts 逐条对账过的手工标注——off 的幸存 URL 序与逐 URL
// 幸存片段数（R-11 URL 级身份的期望来源）
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

// ---------------------------------------------------------------------------
// 固定夹具契约常数（R-11）：改动必须与 pipeline.fixtures.test.ts 同步
// ---------------------------------------------------------------------------

// on 相对 off 的片段差集计数（夹具契约，与 pipeline.fixtures.test.ts 的差集真值
// 同源）：off − on 删 9 条、on − off 恢复 11 条（逐条身份清单见 ON_KEPT_SNIPPETS
// 注释），净增 2。旧 shadow_diff 四字段随双链退役（04-01）不再产生，这里只保留
// 差集计数作 on 期望推导与身份差集互钉。
const ON_DELTA_REMOVED = 9;
const ON_DELTA_RESTORED = 11;

// off 幸存片段总数来自期望文件 final.n_snippets；on 期望按夹具契约差集推导
// （59 − 9 + 11 = 61），与夹具测试同口径，不另立硬编码
const OFF_N_SNIPPETS = expected.final.n_snippets;
const ON_N_SNIPPETS = OFF_N_SNIPPETS - ON_DELTA_REMOVED + ON_DELTA_RESTORED;

// on 侧逐 URL 幸存片段索引（F-05，R-11 身份验收的 on 半边；键与 off 期望文件同式，
// "i" 或 "i.p"，幸存序）。导出方法：2026-09-29 一次性脚本 import src/filter 的
// filterLlmContext，同 pipeline.fixtures.test.ts 口径（fixtures/jev_release_default.
// jev.json 录制 + 夹具答案回放）跑 off 与 on 各一次——off 先对期望文件逐条核对
// （URL 序 / 逐 URL 幸存索引 / 总数 59）通过后，才取 on 的 stats.sources 幸存键。
// 期望不由冒烟自身的被测运行反推；夹具或过滤语义改动时必须重跑导出并与
// pipeline.fixtures.test.ts 同步。差集身份（与 ON_DELTA_REMOVED / ON_DELTA_RESTORED
// 的 9/11 互钉）：
// off − on 删 9 = typesafe.ai#4/#5/#6/#7、ua.news#1/#4/#6、mezha#0/#2；
// on − off 恢复 11 = theregister#7、explainx#1.0/#1.4、flowtivity#1/#3.0/#3.1/#3.3、
// datacamp#0、typesafe.ai#0/#2、mezha#4。
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
  'https://www.datacamp.com/blog/system-one-models-jev': ['0', '3', '4', '5', '6', '7'],
  'https://www.kucoin.com/news/flash/typesafe-ai-launches-jev-a-non-chat-ai-model-193x-faster-than-claude':
    ['1', '2', '4'],
  'https://typesafe.ai/blog/introducing-system-one-models-and-jev': ['0', '1', '2', '3'],
  'https://ua.news/en/technologies/typesafe-predstaviv-model-jev-dlia-avtomatizatsiyi-pz-techcrunch':
    ['0', '2', '3'],
  'https://mezha.net/eng/news/d559e594_typesafe_ai_unveils/': ['1', '3', '4', '5', '7'],
  'https://www.therundown.ai/news/typesafe-jev-ai-decisions-software': ['3', '4'],
};

// 片段文本形态见证（F-05/R2）：返回文本 → 片段索引位置级匹配的期望。46 条原文
// 形态无需见证（夹具原文逐字相等）；17 条按独立运行的幸存输出逐字固化：JSON-LD
// 转换段（explainx#1 六段、flowtivity#3 五段——文本派生自 JSON 不在原文里）、样板
// 行剥除后按行重组的 theregister#1 与 aiwiki#0（不再是原文连续片段）、剥样板后的
// 完整尾部 heise#1 与 pasquale#2（R2 起逐字相等，通用后缀匹配已删——空串与任意
// 截断不再假绿）。与 ON_KEPT_SNIPPETS 同一次脚本导出，覆盖 off/on 两模式的全部
// 转换形态（转换形态与模式无关）。
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
};

// 9 删 / 11 恢复从计数升级为身份清单（F-05）：差集只从两份常数推导（off 期望文件
// 与 ON_KEPT_SNIPPETS，都不由被测运行产生），与 ON_DELTA_REMOVED / ON_DELTA_RESTORED
// 互钉——任一常数漂移或两者失配，冒烟还没 spawn 服务器就当场红。
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
  questions?: Record<string, string>;
};
const nRecordedSources = Object.keys(jevRecording.results).length;
const SOURCE_QUESTION_KEYS = Object.keys(jevRecording.questions ?? {}).sort();

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

// LOG-03 负样本：从夹具 generic 里取一条片段正文的前 30 字符（F-06：不再排除
// 引号/反斜杠——泄漏检查用一致 JSON 转义比较，转义形态含引号、反斜杠、TAB 都能
// 正确命中）；只跳过恰好撞上标题/URL 的片段，保证负样本断言有意义
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
 * LOG-03 泄漏检查（F-06，IN-03 在冒烟侧的落地）：记录文本是 JSON 行，片段正文若
 * 泄入必以 JSON 转义形态出现——用同一 JSON.stringify 的转义形态做一致比较。旧式
 * 未转义 includes 在前缀含 TAB/换行等控制字符时假绿（JSON 从不原样输出控制字符，
 * 字面查找永远落空），logging.test.ts 的同类修复不覆盖冒烟这条检查路径。
 */
const recordLeaksSnippet = (recordText: string, head: string): boolean =>
  recordText.includes(JSON.stringify(head).slice(1, -1));

// 金丝雀（F-06 负例，每次冒烟自检）：夹具片段本身不含 TAB（已核），对真实正文副本
// 注入 TAB 后按记录写入器口径序列化进伪造记录文本——转义比较必须命中，未转义的
// 字面 includes 必然漏检（命中差异就是本检查的存在理由）；干净文本必须不命中。
// 检查器坏了当场死，不让 LOG-03 闸空转。
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

// 原始片段表（F-05 位置级身份匹配的比对源）：URL → 夹具原文片段数组
const rawSnippetsByUrl = new Map(
  braveFixture.response.grounding.generic.map((item) => [item.url, item.snippets ?? []])
);

/**
 * 位置级身份匹配（F-05/R2）：返回里 URL u 的某条片段文本必须与契约常数在该位置
 * 的期望**逐字相等**——见证文本（JSON-LD 段、样板行重组形态、剥样板后的完整文本）
 * 或夹具原文。没有任何通用后缀/包含匹配：JavaScript 里任意串都 endsWith('')，通用
 * 后缀兜底会让空串与任意截断假绿（R2 复核复现）；样板前缀加回（原文）也不匹配剥
 * 样板见证。同 URL 被删片段的原文各条路都不匹配——等数量替换（总数、URL 序、
 * 日志计数全不变）在这里现形。
 */
const snippetMatchesIdentity = (url: string, key: string, text: string): boolean => {
  const witness = SNIPPET_WITNESS_TEXTS[url]?.[key];
  if (witness !== undefined) return text === witness;
  if (key.includes('.')) return false; // 转换段键必须有见证文本
  const raw = rawSnippetsByUrl.get(url)?.[Number(key)];
  if (raw === undefined) return false;
  return raw === text;
};

// 工具声明白名单：照 src/tools/llm_context/index.test.ts 的 WHITELIST 逐字抄
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
  output?: { status_line?: string; n_snippets?: number };
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
  /** 04-02 信封增量：与样本文件名三处同值 */
  request_id?: string;
  /** 04-02 信封增量：样本相对路径与记录状态（仅 test 模式出现） */
  sample?: { path?: string; status?: string };
  request?: { query?: string; intent?: string };
  jev?: {
    n_requests?: number;
    status?: string;
    per_source?: PerSourceRecord[];
  } | null;
  shadow_diff?: unknown;
  sources?: Array<{ url?: string; verdict?: string; snippets?: Array<{ kept?: boolean }> }>;
  output?: unknown;
  error?: unknown;
};

/** 样本记录里冒烟要看的切片（04-02；完整契约在 src/filter/sample.ts）。 */
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
    // SDK spawn env = 默认白名单 12 变量 ∪ 这里显式给出的键——配置文件路径与假 key
    // 都不在白名单里，缺一即假绿/读不到配置/启动即退（六问 4）；桩期望的模型与
    // 端点同批传入，单一来源是 src 的钉版常量与端点导出（R-12）
    env: {
      JEV_FILTER_CONFIG_FILE: configPath,
      TYPESAFE_API_KEY: FAKE_JEV_KEY,
      BRAVE_API_KEY: FAKE_BRAVE_KEY,
      SMOKE_JEV_MODEL: DEFAULT_JEV_MODEL,
      SMOKE_JEV_ENDPOINT: JEVI_ENDPOINT,
    },
    stderr: 'pipe',
  });
  transport.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

  const client = new Client({ name: 'smoke-stdio', version: '0.0.0' });
  try {
    // initialize 握手由 connect 自动完成（D-19：发 initialize）
    await client.connect(transport);

    // --- 1. 工具声明（照 index.test.ts:115-129 抄）---
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

    // --- 2. tools/call（参数从 expected 三件套构造，照 compare.ts 同式）---
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
    // E-06：本夹具必有删除 → 状态行必在，恰两个 text 块（仅当前夹具期望，不是
    // 所有生产请求都必须两块——无状态行时一块仍是合法契约）
    assert.equal(
      content.length,
      2,
      `return: exactly two text blocks expected — got ${content.length}`
    );
    assert.equal(content[0]?.type, 'text', 'return: content[0] must be a text block');
    assert.equal(content[1]?.type, 'text', 'return: content[1] must be a text block');
    const payload = parseJsonBlock(content[0].text);

    // --- 3. 真实片段计数与 URL 级身份（R-11 #5，E-02 的直接防线）---
    const generic = payload.grounding?.generic;
    assert.ok(Array.isArray(generic), 'return: grounding.generic must be an array');
    const counted = generic.reduce((sum, item) => sum + (item.snippets?.length ?? 0), 0);
    assert.deepEqual(
      generic.map((item) => item.url),
      expected.final.urls,
      'return: surviving source URLs must equal the fixture final.urls in Brave order'
    );
    // 04-01 单链语义：test 与 on 共用 runOnChain，裁决真实生效——test 的期望与 on
    // 同源（ON_N_SNIPPETS / ON_KEPT_SNIPPETS），off 独用期望文件
    const expectedCount = runMode === 'off' ? OFF_N_SNIPPETS : ON_N_SNIPPETS;
    assert.equal(
      counted,
      expectedCount,
      `return: counted snippets must be ${expectedCount} in ${runMode} (fixture contract), got ${counted}`
    );
    // 逐 URL 幸存片段身份（F-05，把 R-11 的计数对账升级为位置级索引身份）：三模式
    // 各自对照自己的契约——off 对照期望文件 final.kept_snippets，test/on 对照
    // ON_KEPT_SNIPPETS（9 删/11 恢复的身份差集已在顶部与差集常数互钉）。同 URL
    // 等数量换成已删片段（总数、URL 序、日志计数全不变）在这里红。
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
    assert.equal(
      payload.output?.n_snippets,
      counted,
      'return: output.n_snippets must equal the independently counted snippets'
    );

    // --- 4. 状态行（D-02 形状 + D-08 同源 + D-06；04-02 sample 后缀两态）---
    // default 夹具 off 无来源丢弃（12→12）只有片段删除（76→59）：dropped 段按
    // D-04 条件可有可无，形状断言两态都接受；片段总数段必然在；test 模式末尾可
    // 多出 ` sample for filter debugging - original results, filtered results, Jev decisions: <绝对路径>` 后缀（CONTEXT：样本定位元信息），off/on 绝不出现
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
      Object.hasOwn(payload.output ?? {}, 'status_line'),
      false,
      '状态行只在第二个文本块返回，正文不重复携带'
    );

    // --- 5. 临时 log_dir（R-11 #6：固定夹具一次成功调用恰一条成功记录）---
    const files = readdirSync(tmpRoot).filter((file) => file.endsWith('.jsonl'));
    assert.equal(files.length, 1, `log: exactly one dated .jsonl expected, got ${files.length}`);
    assert.match(
      files[0],
      /^\d{4}-\d{2}-\d{2}\.jsonl$/,
      `log: file must be a local-date name — ${files[0]}`
    );
    await pollForLogLines(tmpRoot);
    // E-06 保险：等写入链彻底安静后再数一次——"恰一条"的判定不留"先读到一半"的竞态
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
    // 04-02 信封增量：request_id 对三档模式一致（与样本文件名关联的锚）
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

    // --- 7. Jev 记账（R-11 #1/#2；字段层级见 notes/test-mode-logging.md）---
    if (runMode === 'off') {
      // E-03 记账侧：off 的 jev 严格为 null（不是缺键、不是零值对象）
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
        nRecordedSources,
        `log: ${runMode} jev.n_requests must equal the recording's ${nRecordedSources} sources, got ${jev.n_requests}`
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
        // E-01：answered 是唯一可用状态；fail_kind（含 validation 兜底）一律不许出现
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
        // 十题答案齐全：键集合等于录制顶层 questions 的来源级键
        const answers = row.answers;
        assert.ok(
          answers !== undefined && typeof answers === 'object',
          `log: per_source ${id} must carry the ten source-level answers`
        );
        assert.deepEqual(
          Object.keys(answers)
            .filter((key) => !/^time_snip\d+$/.test(key))
            .sort(),
          SOURCE_QUESTION_KEYS,
          `log: per_source ${id} answers must cover exactly the recorded source-level questions`
        );
        // 仅离线冒烟的新增时间题使用合成零值；旧十题仍逐键对账。
        for (const [key, value] of Object.entries(answers)) {
          if (/^time_snip\d+$/.test(key)) assert.equal(value, 0);
        }
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
      // 04-01 起旧影子双链退役：新记录不再产生 shadow_diff（恒 null，字段仅为读
      // 旧记录保留）——would 链若被意外复活，这里当场红
      assert.equal(record.shadow_diff, null, 'log: new records must not carry shadow_diff');

      // --- 7.5 样本断言（04-02 SC3 全链，test 模式独有）---
      if (runMode === 'test') {
        const marker =
          ' sample for filter debugging - original results, filtered results, Jev decisions: ';
        const markerAt = statusLine.indexOf(marker);
        assert.ok(
          markerAt !== -1,
          `sample for filter debugging - original results, filtered results, Jev decisions: test status line must carry the path — ${statusLine}`
        );
        const sampleAbsPath = statusLine.slice(markerAt + marker.length);
        // 先写后返（SC3）：callTool 返回时样本文件必须已经真实存在——路径不存在
        // 或文件缺失都说明写入顺序坏了
        assert.ok(
          existsSync(sampleAbsPath),
          `sample for filter debugging - original results, filtered results, Jev decisions: the status-line path must exist at return time — ${sampleAbsPath}`
        );
        const sample = JSON.parse(readFileSync(sampleAbsPath, 'utf8')) as SmokeSample;
        // 全量接入：v4 按请求保存实发载荷；历史 v1–v3 必须按旧格式读取
        assert.equal(
          sample.format_version,
          4,
          'sample for filter debugging - original results, filtered results, Jev decisions: format_version must be 4'
        );
        // v4 来源必须关联到真实请求；不能只改版本号而漏掉新的证据链。
        assert.equal(sample.jev?.requests?.length, nRecordedSources);
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
        // 实发映射（04-04 R1 v2 捕获口径）：keep 来源恰 12（本夹具全部来源
        // answered），片段三维全 true（无阶梯降级、分数收齐、全部进入实发 state）
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
    // 桩侧 Jev 请求数（R-11 #1 的桩侧计数 / #8 的记账对账）：off 恰 0，test/on 恰 12。
    // 日志 n_requests 是服务器自报，这里以桩的独立计数交叉验证
    const replays = [...stderrText.matchAll(/\[smoke-replay\] jev /g)].length;
    assert.equal(
      replays,
      runMode === 'off' ? 0 : nRecordedSources,
      `stderr: stub replay count must be ${runMode === 'off' ? 0 : nRecordedSources} in ${runMode}, got ${replays}`
    );

    return { content };
  } finally {
    await client.close();
    rmSync(tmpRoot, { recursive: true, force: true });
  }
};

// ---------------------------------------------------------------------------
// --live（D-18，R-09；F-03/F-04）：真实网络手动开关——不注入桩，key 与代理从当前
// 进程环境透传。生产配置原始 JSON 只换 log_dir 写成临时副本给子进程（独享日志
// 目录就是本次记录的身份保证）；轮询独享目录全部 .jsonl（跨午夜安全）；从
// per_source 分别统计已收到响应与可用来源级裁决并如实报告降级。stderr 直通终端
// 便于人工观察。不进自动验证，切换前跑一次。
// ---------------------------------------------------------------------------

/** live 透传的白名单外变量（有则传无则跳过）；TYPESAFE_API_KEY 是当前识别的 key。
 * JEV_FILTER_CONFIG_FILE 不在列——子进程一律读本次的临时配置副本（F-04）。 */
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
 * 读生产配置的原始 JSON（F-04 临时副本的来源）：BOM 容忍；读不到 / 坏 JSON /
 * 顶层 null → undefined 并各报一行（与生产 loadFilterConfig 的 fail-open 同因，
 * 服务器侧行为一致）。只取原始值——解析与 ~ / ~/ / ~\ 展开、字面 ~foo 原样、
 * 空白与坏值回落全部交给 parseFilterConfigObject，不复制其内部私有函数。
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
 * 读独享日志目录下全部 .jsonl 的完整成行记录（F-04）：目录由本次冒烟 mkdtemp 新建、
 * 绝对路径只进过本次子进程的环境，里面出现的记录必然来自本次调用——不存在同查询
 * 的其他进程的行，按文件全读也天然跨午夜安全（写入器零点后换日期文件，两个文件
 * 都在目录里）。目录未建（ENOENT）= 尚未写出，返回空；末尾不成行的半行留待下次
 * 轮询；完整行解析不了才跳过并提示。权限/占用等其他读错误明确诊断，不一概当没写
 * （IN-01）。
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

/**
 * 轮询本次调用的记录（至多 ~10 s）：独享目录本身就是记录归属的依据（F-04），
 * query + intent 匹配只是辅助校验——不再是"最后匹配行就是本次"的时序猜测（同
 * 查询的两进程互认在独享目录下不成立）。零记录 = 本次调用没有落账，旧记录或
 * 其他进程的记录都进不了这个目录（R-09）。
 */
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
  // 默认配置位置（D-24）：存在则读它并按同口径解析，缺省则双方都走全默认
  const homeConfig = join(homedir(), '.brave-jev', 'config.json');
  const env: Record<string, string> = {};
  for (const key of LIVE_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined && value !== '') env[key] = value;
  }
  // 配置位置与服务器同序（loadFilterConfig 只认 JEV_FILTER_CONFIG_FILE）：显式
  // 环境变量优先；未设则回默认位置 ~/.brave-jev/config.json（D-24，存在才读）
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

  // 独享日志目录（F-04）：临时配置副本只把 log_dir 换成本次 mkdtemp 的私有目录，
  // 其余字段（mode、jev.model、阈值、blocklist_file 等）原样保留——子进程的记录
  // 全部落在这里，与生产日志目录、其他进程物理隔离。原配置缺失/坏 JSON 时副本
  // 只含 log_dir（生产 fail-open 全默认，mode off 已在上面早退）。
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
    // 辅助校验（F-04）：记录归属由独享目录保证；mode / model / query / intent 是
    // 服务器读对配置、发对请求的交叉证据
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

    // R-09/E-04：裁决只认 per_source 行——record.jev.status 的合法值是
    // ok/no_key/degraded/breaker_open，没有 answered，层级检查会把正常请求误判
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

    // F-03：已收到响应与可用来源级裁决分开统计。可用行 = answered 且无 fail_kind
    // （R-04：关键答案缺失/越界时生产记 answered + fail_kind='validation'），再核
    // answers.is_off_topic 为有限数（与 applySourceVerdicts 消费的判定概率同源，
    // 防 answers 空表误计；answered 行缺可用概率时按 validation 归桶）。只改冒烟
    // 验收判定，不改生产 status、重试或熔断语义。
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

    // 独享目录恰一条记录（等写入链安静后复核）：F-04 身份保证的实证——出现第二行
    // 说明目录被外部写入或一次调用落了多账
    await sleep(250);
    const settled = readPrivateLogRecords(privateLogDir);
    assert.equal(
      settled.length,
      1,
      `live: the private log dir must hold exactly one record for this call, got ${settled.length}`
    );

    // 如实报告（F-03）：部分无效打出逐源降级明细（有效 N / validation M / failed K），
    // 只有全部可用才算全绿
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
      // 单独 --mode test / --mode on：先静默跑另一个模式作对照——test==on 逐字段
      // 断言需要两份独立 spawn 的结果（同夹具同预加载桩，dev/compare.ts 先例）
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
    // T-04-01-2 双载体互证：test 与 on 的完整 content 数组逐字段相同（同夹具同
    // 预加载桩，两模式各自独立 spawn）——含每个 text 块，不是只比第一个 JSON 块。
    // 04-02 修订：比较前剥除 test 的 sample 后缀（CONTEXT 允许 test 多出样本定位
    // 元信息；两载体同法归一——JSON 块重序列化、状态行截断，两侧同函数处理）
    const testRun = runs.get('test');
    const onRun = runs.get('on');
    if (testRun !== undefined && onRun !== undefined) {
      const stripSampleSuffix = (run: ModeResult): ModeResult => {
        const content: ContentBlock[] = run.content.map((block) => ({ ...block }));
        const jsonBlock = content[0];
        if (jsonBlock?.type === 'text') {
          const parsed = JSON.parse(jsonBlock.text) as { output?: { status_line?: string } };
          const line = parsed.output?.status_line;
          if (typeof line === 'string') {
            const at = line.indexOf(
              ' sample for filter debugging - original results, filtered results, Jev decisions: '
            );
            if (at !== -1) parsed.output.status_line = line.slice(0, at);
          }
          jsonBlock.text = JSON.stringify(parsed);
        }
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
