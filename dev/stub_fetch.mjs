/**
 * stdio 冒烟预加载桩（D-17；all-only 清理后重构为全量共享请求回放）：
 * `node --import <本文件> dist/index.js --transport stdio` 启动真服务器进程，在应用
 * 求值前替换 globalThis.fetch——Brave 与 Jev 两个网络出口都走裸 fetch（src/BraveAPI/
 * index.ts 与 src/filter/jev/client.ts），桩在进程内一网打尽，冒烟全程零网络、确定性
 * 回放，不改上游任何文件。
 *
 * 分派规则（R-12 请求身份校验；旧版"任意非 Brave 地址都按 Jev id 查回放"的兜底是
 * E-05 实证的漏洞，不保留）：
 * - URL 以 https://api.search.brave.com/ 开头 → 整体回 fixtures/jev_release_default.json
 *   的 response 字段（wrapped 夹具：request / fetched_at / latency_s / response，
 *   HTTP 响应体是内层 response）。不校验 Brave 请求参数——录制请求带 count=20 /
 *   freshness=pm 而当前 smoke 不带，是有意差异不是漂移（审计已核），不逐字硬锁。
 * - URL 与方法都匹配预期 Jev 出口（POST 到 SMOKE_JEV_ENDPOINT）→ 校验**一次全量
 *   共享请求**的身份，全部通过才返回单个完整 answers 表（all-only 唯一请求形状，
 *   all-only 清理前这里是逐来源 single 请求、每源一次回放）：
 *   ① mode 闸：配置 mode 为 off 时任何 Jev 请求都响亮拒绝（E-03 双层闸的桩侧，
 *     smoke 对日志 jev === null 的断言是记账侧——日志是证据，桩拒绝才是拦截）；
 *   ② 请求体 model 必须等于冒烟期望的钉版模型（SMOKE_JEV_MODEL，smoke 从 src 的
 *     钉版常量取值经环境变量传入——单一来源，不在两处硬编码）；
 *   ③ 全量 state 校验：state.sources 是非空数组（零候选不发送——管道保证）；query /
 *     intent 与 expected 夹具三件套一致；来源按 Brave 原序（id 数字部分严格递增），
 *     每来源 id 在回放表里、url 与该 id 的录制来源逐字一致、snippets 非空；
 *   ④ 题目集合与数组位置（全局题键 `{sourceId}__{localKey}`）：来源级恰为当前四题
 *     `has_original_reasoning / is_template_filler / is_off_topic / is_listing`（旧
 *     v3 十题的其余键一律不许出现——旧来源题混进请求在这里现形），题干按数组位置
 *     引用 `sources[i]`；片段级恰为 `{id}__snip0..snip(k-1)`，k 同时等于该源
 *     state.snippets.length（请求自洽）与该源录制答案里的 snip 键数（录制时发出的
 *     候选数真值——URL 一样但片段/题目变了在这里现形），题干引用对应
 *     `sources[i].snippets[j]`，criteria 逐字等于 SMOKE_JEV_CRITERIA（smoke 从 src
 *     的 SNIPPET_CRITERIA 传入——旧录制顶层 levels 是退役 legend，不再作对照源）。
 *   任一不符 → console.error 一行 `[smoke-stub]` 后抛错：fetch 拒绝走服务器侧的
 *   network 失败兜底，smoke 的 stderr 断言当场红——响亮失败，不做静默 500。
 * - 其余 URL / 方法一律同样响亮拒绝。
 *
 * 回放表构造：录制 results[id].response.answers 的键是 v3 十题时代的局部键（当前
 * 四题是其子集）——桩只把当前四题与 snip0..snip(k-1) 的录制值映射到全局题键（如
 * s0 的 is_off_topic → s0__is_off_topic），旧额外题（worth_keeping 等）不进响应。
 * 用量是合成值 0：共享请求没有对应的真实用量事实，不把旧 single 用量合计冒充
 * 共享请求用量（stderr 记账行注明 synthetic）。
 *
 * 不做片段文本/长度对齐：录制只存响应不存发送时的片段原文，而 Brave 原文与发送
 * 片段之间隔着剥样板与 JSON-LD 转换，对照会误报（审计口径里的"可选"项，不做）。
 *
 * stderr 约定：`[smoke-stub] ` 前缀 = 失败标记（smoke 断言其不出现）；
 * `[smoke-replay] ` 前缀 = 每次成功回放的记账行（smoke 按模式数：all-only 下
 * test/on 恰 1、off 恰 0）。桩在服务器进程内，stderr 不是协议通道（stdout 才是），
 * 不会污染 stdio 分帧。本文件不 import 任何 src 模块（预加载时序在应用求值之前）。
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

/** 配置 mode（① 的判据）：与 src/filter/config.ts 同口径读 JEV_FILTER_CONFIG_FILE
 * 指向的 JSON——BOM 容忍、trim + 小写后只认 off|test|on；未设 / 读不到 / 坏 JSON /
 * 集合外的值一律按 'off'（与生产缺省一致），off 下 Jev 请求会被响亮拒绝。 */
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

  // ① mode 闸（E-03）：off 配置下不该有任何 Jev 请求
  if (configMode === 'off') {
    return fail(
      `JEV request received while config mode is off — off must never call Jev (double gate, E-03)`
    );
  }

  // ② 请求体 model（E-05 注入实证：只对账日志信封挡不住错误的出站 model）
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
  if (body?.state?.query !== expectedFixture.query || body?.state?.intent !== expectedFixture.intent) {
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
    // 来源级：恰为当前四题的全局键——旧 v3 十题的其余键一律不许出现
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

  // 单个完整 answers 表：当前四题 + 每片段 score 的录制值映射到全局题键；
  // 旧额外题不进响应。用量为合成 0（共享请求无对应真实用量，不冒充）。
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
