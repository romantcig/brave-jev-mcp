/**
 * stdio 冒烟预加载桩（D-17）：`node --import <本文件> dist/index.js --transport stdio`
 * 启动真服务器进程，在应用求值前替换 globalThis.fetch——Brave 与 Jev 两个网络出口
 * 都走裸 fetch（src/BraveAPI/index.ts 与 src/filter/jev/client.ts，地址在上游写死），
 * 桩在进程内一网打尽，冒烟全程零网络、确定性回放，不改上游任何文件。
 *
 * 分派规则（与 dev/compare.ts 的 replayClassifier 同口径）：
 * - URL 以 https://api.search.brave.com/ 开头 → 整体回 fixtures/jev_release_default.json
 *   的 response 字段（夹具是 wrapped 形状：request / fetched_at / latency_s / response，
 *   HTTP 响应体是内层 response）；
 * - 其余一律视为 Jev 出口 → 解析 POST body 的 state.source.id（s0..s{index}，与管道
 *   步 5 候选集同源对齐）查 fixtures/jev_release_default.jev.json 的 results 表；
 *   条目存在且 http === 200 → 回原始 response 对象（服务器走生产 parseJevResponse
 *   路径）；缺失或非 200 → 500（该源按"留"兜底）。
 *
 * 本文件不 import 任何 src 模块（预加载时序在应用求值之前，也不该依赖应用）；
 * 未匹配 URL 一律按 Jev 500 兜底并 console.error 一行提示——桩在服务器进程内，
 * stderr 不是协议通道（stdout 才是），不会污染 stdio 分帧。
 */
import { readFileSync } from 'node:fs';

const braveFixture = JSON.parse(
  readFileSync(new URL('../fixtures/jev_release_default.json', import.meta.url), 'utf8')
);
const jevRecording = JSON.parse(
  readFileSync(new URL('../fixtures/jev_release_default.jev.json', import.meta.url), 'utf8')
);

// wrapped 夹具解包：Brave API 的 HTTP 响应体是内层 response（grounding + sources）
const braveResponse = braveFixture.response ?? braveFixture;
const results = jevRecording.results ?? {};

globalThis.fetch = async (input, init) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.startsWith('https://api.search.brave.com/')) {
    return Response.json(braveResponse);
  }
  // Jev 出口：按请求体 state.source.id 查回放表；解析失败/缺失/非 200 一律 500
  let sourceId;
  try {
    sourceId = JSON.parse(init?.body)?.state?.source?.id;
  } catch {
    sourceId = undefined;
  }
  const entry = sourceId === undefined ? undefined : results[sourceId];
  if (entry !== undefined && entry.http === 200) {
    return Response.json(entry.response);
  }
  console.error(
    `[smoke-stub] no replay entry for ${sourceId ?? '(unparsed body)'} (${url}) — replying 500`
  );
  return new Response('{}', { status: 500 });
};
