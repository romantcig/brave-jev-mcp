/**
 * stdio 冒烟预加载桩（D-17）：`node --import <本文件> dist/index.js --transport stdio`
 * 启动真服务器进程，在应用求值前替换 globalThis.fetch——Brave 与 Jev 两个网络出口
 * 都走裸 fetch（src/BraveAPI/index.ts 与 src/filter/jev/client.ts），桩在进程内一网
 * 打尽，冒烟全程零网络、确定性回放，不改上游任何文件。
 *
 * 分派规则（R-12 请求身份校验；旧版"任意非 Brave 地址都按 Jev id 查回放"的兜底是
 * E-05 实证的漏洞，不保留）：
 * - URL 以 https://api.search.brave.com/ 开头 → 整体回 fixtures/jev_release_default.json
 *   的 response 字段（wrapped 夹具：request / fetched_at / latency_s / response，
 *   HTTP 响应体是内层 response）。不校验 Brave 请求参数——录制请求带 count=20 /
 *   freshness=pm 而当前 smoke 不带，是有意差异不是漂移（审计已核），不逐字硬锁。
 * - URL 与方法都匹配预期 Jev 出口（POST 到 SMOKE_JEV_ENDPOINT）→ 逐项校验请求
 *   身份，全部通过才回放 fixtures/jev_release_default.jev.json 的 results 表：
 *   ① mode 闸：配置 mode 为 off 时任何 Jev 请求都响亮拒绝（E-03 双层闸的桩侧，
 *     smoke 对日志 jev === null 的断言是记账侧——日志是证据，桩拒绝才是拦截）；
 *   ② 请求体 model 必须等于冒烟期望的钉版模型（SMOKE_JEV_MODEL，smoke 从 src 的
 *     钉版常量取值经环境变量传入——单一来源，不在两处硬编码）；
 *   ③ state.source.id 必须在回放表里，且 url 与该 id 的录制来源逐字一致；
 *   ④ 题目集合与候选数量：十道来源级题的键与题干逐字等于录制顶层 questions；
 *     片段题必须恰为 snip0..snip(k-1)、题干引用对应下标、criteria 逐字等于录制
 *     顶层 levels；k 必须同时等于 state.source.snippets.length（请求自洽）与该源
 *     录制答案里的 snip 键数（录制时发出的候选数真值——URL 一样但片段/题目变了
 *     在这里现形）。state 的 query / intent 必须等于 expected 夹具三件套。
 *   任一不符 → console.error 一行 `[smoke-stub]` 后抛错：fetch 拒绝走服务器侧的
 *   network 失败兜底，smoke 的 stderr 断言当场红——响亮失败，不做静默 500。
 * - 其余 URL / 方法一律同样响亮拒绝。
 *
 * 不做片段文本/长度对齐：录制只存响应不存发送时的片段原文，而 Brave 原文与发送
 * 片段之间隔着剥样板与 JSON-LD 转换，对照会误报（审计口径里的"可选"项，不做）。
 *
 * stderr 约定：`[smoke-stub] ` 前缀 = 失败标记（smoke 断言其不出现）；
 * `[smoke-replay] ` 前缀 = 每次成功回放的记账行（smoke 按模式数：shadow/on 恰 12、
 * off 恰 0）。桩在服务器进程内，stderr 不是协议通道（stdout 才是），不会污染
 * stdio 分帧。本文件不 import 任何 src 模块（预加载时序在应用求值之前）。
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
const recordedQuestions = jevRecording.questions ?? {};
const recordedLevels = jevRecording.levels ?? [];

// 冒烟期望（smoke 经环境变量传入，单一来源是 src 的钉版常量与端点导出）；
// 缺任何一个都不猜默认值——Jev 请求一律响亮拒绝，让 smoke 红
const expectedModel = process.env.SMOKE_JEV_MODEL ?? '';
const expectedEndpoint = process.env.SMOKE_JEV_ENDPOINT ?? '';

/** 配置 mode（① 的判据）：与 src/filter/config.ts 同口径读 JEV_FILTER_CONFIG_FILE
 * 指向的 JSON——BOM 容忍、trim + 小写后只认 off|shadow|on；未设 / 读不到 / 坏 JSON /
 * 集合外的值一律按 'off'（与生产缺省一致），off 下 Jev 请求会被响亮拒绝。 */
const resolveConfigMode = () => {
  const file = process.env.JEV_FILTER_CONFIG_FILE;
  if (typeof file !== 'string' || file === '') return 'off';
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    const text = typeof parsed?.mode === 'string' ? parsed.mode.trim().toLowerCase() : '';
    return text === 'off' || text === 'shadow' || text === 'on' ? text : 'off';
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

  // ③ id ↔ url 对应：id 必须在回放表里，url 必须与该 id 的录制来源一致
  const source = body?.state?.source;
  const id = source?.id;
  const entry = typeof id === 'string' ? results[id] : undefined;
  if (entry === undefined) {
    return fail(`no replay entry for source id ${JSON.stringify(id ?? null)} (${url})`);
  }
  if (source?.url !== entry.url) {
    return fail(
      `source url mismatch for ${id}: request ${JSON.stringify(source?.url)} !== recorded ${JSON.stringify(entry.url)}`
    );
  }

  // ④ 题目集合与候选数量对齐（"URL 一样但片段/题目变了能被发现"）
  const questions = body?.questions ?? {};
  const questionKeys = Object.keys(questions);
  const snipKeys = questionKeys.filter((key) => /^snip\d+$/.test(key));
  const sourceKeys = questionKeys.filter((key) => !/^snip\d+$/.test(key));
  const expectedSourceKeys = Object.keys(recordedQuestions);
  if (JSON.stringify([...sourceKeys].sort()) !== JSON.stringify([...expectedSourceKeys].sort())) {
    return fail(
      `source-level question keys mismatch for ${id}: request [${sourceKeys.sort().join(',')}] !== recording [${expectedSourceKeys.sort().join(',')}]`
    );
  }
  for (const key of expectedSourceKeys) {
    if (questions[key]?.instructions !== recordedQuestions[key]) {
      return fail(`question "${key}" instructions drifted from the recording for ${id}`);
    }
  }
  const snippets = Array.isArray(source?.snippets) ? source.snippets : undefined;
  if (snippets === undefined) {
    return fail(`JEV request state.source.snippets missing for ${id}`);
  }
  const k = snippets.length;
  if (
    snipKeys.length !== k ||
    !Array.from({ length: k }, (_, i) => `snip${i}`).every((key) => questions[key] !== undefined)
  ) {
    return fail(
      `snippet questions must be exactly snip0..snip${k - 1} for ${id}, got [${snipKeys.sort().join(',')}]`
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
    const question = questions[`snip${i}`];
    if (
      typeof question?.instructions !== 'string' ||
      !question.instructions.includes(`source.snippets[${i}]`)
    ) {
      return fail(`question snip${i} must reference source.snippets[${i}] for ${id}`);
    }
    if (JSON.stringify(question.criteria) !== JSON.stringify(recordedLevels)) {
      return fail(`question snip${i} criteria drifted from the recording levels for ${id}`);
    }
  }
  if (
    body?.state?.query !== expectedFixture.query ||
    body?.state?.intent !== expectedFixture.intent
  ) {
    return fail(`state query/intent drifted from the expected fixture for ${id}`);
  }

  jevReplays += 1;
  console.error(`[smoke-replay] jev ${id} (#${jevReplays}) -> 200`);
  return Response.json(entry.response);
};
