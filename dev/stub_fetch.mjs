/**
 * stdio 冒烟的 fetch 预加载桩；在应用启动前接管 Brave 与 Jev 请求，默认零网络。
 * 用法：node --import ./dev/stub_fetch.mjs dist/index.js --transport stdio
 * 只允许预期出口，校验 Jev 模型、来源身份、题目集合和位置；异常请求告警并抛错。
 * 回答取录制夹具后投影到当前题键，用量为合成 0，不代表当前共享请求的真实结果。
 * 录制未保存发送文本，因此不校验片段正文；只检查身份、数量和题目引用。
 * [smoke-stub] 是失败标记，[smoke-replay] 是成功桩请求计数，均写 stderr。
 */
import { readFileSync } from 'node:fs';

const braveFixture = JSON.parse(
  readFileSync(new URL('../fixtures/jev_release_default.json', import.meta.url), 'utf8')
);
const jevRecording = JSON.parse(
  readFileSync(new URL('../fixtures/jev_release_default.jev.json', import.meta.url), 'utf8')
);
// state 的 query / intent 与 smoke 同源：expected 夹具（smoke 把它原样发进工具调用，
// 管道原样放进 state——两处都读同一份文件，不另立期望）
const expectedFixture = JSON.parse(
  readFileSync(
    new URL('../fixtures/expected/jev_release_default.off.json', import.meta.url),
    'utf8'
  )
);

// wrapped 夹具解包：Brave API 的 HTTP 响应体是内层 response（grounding + sources）
const braveResponse = braveFixture.response ?? braveFixture;
const results = jevRecording.results ?? {};

// 冒烟期望（smoke 经环境变量传入，单一来源是 src 的钉版常量、端点与 criteria 导出）；
// 缺任何一个都不猜默认值——Jev 请求一律响亮拒绝，让 smoke 红
const expectedModel = process.env.SMOKE_JEV_MODEL ?? '';
const expectedEndpoint = process.env.SMOKE_JEV_ENDPOINT ?? '';
const expectedCriteriaText = process.env.SMOKE_JEV_CRITERIA ?? '';

/** 当前题库的唯一来源级四题（与 src/filter/jev/questions.ts 的 SOURCE_QUESTIONS 键
 * 集合一致；stub 不 import src——键集合是题库身份契约，改动必须两侧同步）。 */
const CURRENT_SOURCE_KEYS = [
  'has_original_reasoning',
  'is_template_filler',
  'is_off_topic',
  'is_listing',
];

/** 读取桩模式，容忍 BOM 并归一大小写；缺失或坏值按 off，拒绝 Jev 请求。 */
const resolveConfigMode = () => {
  const file = process.env.JEV_FILTER_CONFIG_FILE;
  if (typeof file !== 'string' || file === '') return 'off';
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    const text = typeof parsed?.mode === 'string' ? parsed.mode.trim().toLowerCase() : '';
    return text === 'off' || text === 'test' || text === 'on' ? text : 'off';
  } catch {
    return 'off';
  }
};
const configMode = resolveConfigMode();

/** 响亮失败：失败标记行 + 抛错（smoke 的 stderr 断言拦下，绝不静默放行）。 */
const fail = (message) => {
  console.error(`[smoke-stub] ${message}`);
  throw new Error(`smoke-stub: ${message}`);
};

let jevReplays = 0;

globalThis.fetch = async (input, init) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.startsWith('https://api.search.brave.com/')) {
    return Response.json(braveResponse);
  }

  // Jev 出口的第一道身份：端点与方法必须与预期逐字一致
  if (expectedEndpoint === '' || url !== expectedEndpoint) {
    return fail(
      `unexpected request URL ${url} — only the Brave fixture and the expected Jev endpoint are replayable`
    );
  }
  const method = (
    init?.method ??
    (input instanceof Request ? input.method : 'GET') ??
    'GET'
  ).toUpperCase();
  if (method !== 'POST') {
    return fail(`unexpected method ${method} for ${url} — Jev requests must be POST`);
  }

  // off 下任何 Jev 请求都应失败。
  if (configMode === 'off') {
    return fail(
      `JEV request received while config mode is off — off must never call Jev (double gate, E-03)`
    );
  }

  // 直接校验出站 model，仅检查日志无法发现发错模型。
  let body;
  try {
    body = JSON.parse(typeof init?.body === 'string' ? init.body : String(init?.body ?? ''));
  } catch {
    return fail(`JEV request body is not JSON (${url})`);
  }
  if (expectedModel === '' || body?.model !== expectedModel) {
    return fail(
      `JEV request model ${JSON.stringify(body?.model)} !== expected ${JSON.stringify(expectedModel)}`
    );
  }

  // ③ 全量 state 校验：sources[] 非空数组、query/intent 同源、来源保序、id↔url 对应
  const sources = body?.state?.sources;
  if (!Array.isArray(sources) || sources.length === 0) {
    return fail(
      `JEV request state.sources must be a non-empty array (all-only sends every candidate in one shared request), got ${JSON.stringify(sources?.length ?? null)}`
    );
  }
  if (
    body?.state?.query !== expectedFixture.query ||
    body?.state?.intent !== expectedFixture.intent
  ) {
    return fail(`state query/intent drifted from the expected fixture`);
  }
  let previousIndex = -1;
  for (const [arrayIndex, source] of sources.entries()) {
    const id = source?.id;
    if (typeof id !== 'string' || !/^s\d+$/.test(id)) {
      return fail(`state.sources[${arrayIndex}].id is not an s{index} id: ${JSON.stringify(id)}`);
    }
    const numeric = Number(id.slice(1));
    if (numeric <= previousIndex) {
      return fail(
        `state.sources ids must stay in Brave order (strictly increasing), got ${id} after index ${previousIndex}`
      );
    }
    previousIndex = numeric;
    const entry = results[id];
    if (entry === undefined) {
      return fail(`no replay entry for source id ${id} (${url})`);
    }
    if (source?.url !== entry.url) {
      return fail(
        `source url mismatch for ${id}: request ${JSON.stringify(source?.url)} !== recorded ${JSON.stringify(entry.url)}`
      );
    }
    if (!Array.isArray(source?.snippets) || source.snippets.length === 0) {
      return fail(`state.sources[${arrayIndex}] (${id}) carries no snippets`);
    }
  }

  // ④ 题目集合与数组位置对齐（全局题键；"URL 一样但片段/题目变了能被发现"）
  const questions = body?.questions ?? {};
  const byKey = new Map(Object.entries(questions));
  for (const [arrayIndex, source] of sources.entries()) {
    const id = source.id;
    const entry = results[id];
    // 来源题必须恰为当前四题的全局键。
    const expectedKeys = CURRENT_SOURCE_KEYS.map((key) => `${id}__${key}`);
    const actualKeys = Object.keys(questions).filter((key) => key.startsWith(`${id}__`));
    const sourceLevelKeys = actualKeys.filter((key) => !/^s\d+__snip\d+$/.test(key));
    if (JSON.stringify([...sourceLevelKeys].sort()) !== JSON.stringify([...expectedKeys].sort())) {
      return fail(
        `source-level question keys mismatch for ${id}: request [${sourceLevelKeys.sort().join(',')}] !== current four [${expectedKeys.sort().join(',')}]`
      );
    }
    for (const key of expectedKeys) {
      const question = byKey.get(key);
      if (
        typeof question?.instructions !== 'string' ||
        !question.instructions.includes(`sources[${arrayIndex}]`)
      ) {
        return fail(
          `question "${key}" must reference sources[${arrayIndex}] (the array position of ${id})`
        );
      }
    }
    // 片段级：恰为 {id}__snip0..snip(k-1)，k 同时等于请求自洽与录制真值
    const snippets = source.snippets;
    const k = snippets.length;
    const snipKeys = actualKeys.filter((key) => /^s\d+__snip\d+$/.test(key));
    const expectedSnipKeys = Array.from({ length: k }, (_, i) => `${id}__snip${i}`);
    if (JSON.stringify([...snipKeys].sort()) !== JSON.stringify([...expectedSnipKeys].sort())) {
      return fail(
        `snippet questions must be exactly ${id}__snip0..snip${k - 1}, got [${snipKeys.sort().join(',')}]`
      );
    }
    const recordedSnips = Object.keys(entry.response?.answers ?? {}).filter((key) =>
      /^snip\d+$/.test(key)
    ).length;
    if (k !== recordedSnips) {
      return fail(
        `candidate count mismatch for ${id}: request carries ${k} snippets, the recording answered ${recordedSnips}`
      );
    }
    for (let i = 0; i < k; i += 1) {
      const question = byKey.get(`${id}__snip${i}`);
      if (
        typeof question?.instructions !== 'string' ||
        !question.instructions.startsWith(
          `How useful is \`sources[${arrayIndex}].snippets[${i}]\` for answering`
        )
      ) {
        return fail(
          `question ${id}__snip${i} must open by referencing sources[${arrayIndex}].snippets[${i}]`
        );
      }
      if (JSON.stringify(question.criteria) !== expectedCriteriaText) {
        return fail(
          `question ${id}__snip${i} criteria drifted from the expected SNIPPET_CRITERIA for ${id}`
        );
      }
    }
  }

  // 录制回答映射到当前全局题键；用量为合成 0，不合计旧请求用量。
  const answers = {};
  for (const source of sources) {
    const id = source.id;
    const recordedAnswers = results[id].response?.answers ?? {};
    for (const localKey of CURRENT_SOURCE_KEYS) {
      const value = recordedAnswers[localKey];
      if (value !== undefined) answers[`${id}__${localKey}`] = value;
    }
    for (let i = 0; i < source.snippets.length; i += 1) {
      const value = recordedAnswers[`snip${i}`];
      if (value !== undefined) answers[`${id}__snip${i}`] = value;
    }
  }
  const response = {
    model: results[sources[0].id].response?.model ?? expectedModel,
    usage: { input_tokens: 0 },
    answers,
  };

  jevReplays += 1;
  console.error(
    `[smoke-replay] shared request #${jevReplays} (${sources.length} sources, synthetic usage) -> 200`
  );
  return Response.json(response);
};
