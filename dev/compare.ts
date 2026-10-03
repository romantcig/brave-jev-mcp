/**
 * 本地对比 Brave 夹具过滤前后的规模与逐来源裁决，默认 off。
 * 用法：node --import tsx dev/compare.ts <fixture-relative-path> [--mode off|test|on]
 * 请求参数来自对应 expected 文件；test/on 使用同目录历史 Jev 回答，始终零网络。
 * 这是固定回答的规则验证，不代表模型对当前题目的真实判断。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { parseFilterConfigObject } from '../src/filter/config.js';
import { parseJevResponse } from '../src/filter/jev/client.js';
import { allQuestionKey } from '../src/filter/jev/context.js';
import { SOURCE_QUESTIONS } from '../src/filter/jev/questions.js';
import { collectJevCandidates, filterLlmContext } from '../src/filter/pipeline.js';
import type {
  BraveLlmContextResponse,
  ClassifyDeps,
  FilterRequest,
  FilterResult,
  JevAnswer,
  SourceStats,
} from '../src/filter/types.js';

// ---------------------------------------------------------------------------
// argv：夹具路径必填；--mode 只认 off|test|on（缺省 off）
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const fxPath = args[0];
if (!fxPath) {
  console.error(
    'usage: node --import tsx dev/compare.ts <fixture-relative-path> [--mode off|test|on]'
  );
  process.exit(2);
}

let mode: 'off' | 'test' | 'on' = 'off';
const modeIndex = args.indexOf('--mode');
if (modeIndex !== -1) {
  const value = args[modeIndex + 1];
  if (value !== 'off' && value !== 'test' && value !== 'on') {
    console.error(`--mode 只认 off|test|on，收到：${value ?? '(缺值)'}`);
    process.exit(1);
  }
  mode = value;
}

const die = (message: string): never => {
  console.error(message);
  process.exit(1);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// ---------------------------------------------------------------------------
// 装载：三形状加载器 + 期望文件 + （test/on 模式）录制
// ---------------------------------------------------------------------------

/** 三形状加载器（wrapped / bare / noise），与 src/filter/pipeline.fixtures.test.ts 同逻辑。 */
const loadBraveFixture = (raw: string): BraveLlmContextResponse => {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed === 'object' && parsed !== null && 'response' in parsed) {
    return (parsed as { response: BraveLlmContextResponse }).response;
  }
  if (Array.isArray((parsed as BraveLlmContextResponse)?.grounding?.generic)) {
    return parsed as BraveLlmContextResponse;
  }
  const noise = parsed as {
    generic: BraveLlmContextResponse['grounding']['generic'][number];
    source?: BraveLlmContextResponse['sources'];
  };
  return {
    grounding: { generic: [noise.generic], map: [] },
    sources: noise.source ?? {},
  };
};

let rawText: string;
try {
  rawText = readFileSync(fxPath, 'utf8');
} catch (error) {
  die(`读不到夹具 ${fxPath}：${error instanceof Error ? error.message : String(error)}`);
}
const data = loadBraveFixture(rawText);

const stem = basename(fxPath).replace(/\.json$/, '');

/** 在 expected/ 目录（含子目录）里找 `<stem>.off.json`；目录不存在返回 undefined。 */
const scanExpected = (expectedRoot: string, filename: string): string | undefined => {
  try {
    const hits = readdirSync(expectedRoot, { recursive: true })
      .map((entry) => String(entry).split('\\').join('/'))
      .filter((entry) => entry === filename || entry.endsWith(`/${filename}`))
      .sort();
    return hits.length > 0 ? join(expectedRoot, hits[0].split('/').join('\\')) : undefined;
  } catch {
    return undefined;
  }
};

/** 沿夹具目录向上逐级找 expected/ 下的同名期望文件（顶层夹具第一级即中）。 */
const findExpectedPath = (): string => {
  let dir = dirname(fxPath);
  for (let depth = 0; depth < 6; depth += 1) {
    const hit = scanExpected(join(dir, 'expected'), `${stem}.off.json`);
    if (hit !== undefined) return hit;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return die(`找不到期望文件 ${stem}.off.json——fixtures/expected/ 下应有对应标注`);
};

const expectedPath = findExpectedPath();
const expected: unknown = JSON.parse(readFileSync(expectedPath, 'utf8'));
if (
  !isRecord(expected) ||
  typeof expected.query !== 'string' ||
  typeof expected.intent !== 'string' ||
  !isRecord(expected.request)
) {
  die(`期望文件缺 query / intent / request 三件套：${expectedPath}`);
}
const request = {
  params: { query: expected.query, ...(expected.request as Omit<FilterRequest, 'query'>) },
  intent: expected.intent,
};

/** 录制夹具里单个来源的答案条目（只声明回放关心的字段，形状以 probe 落盘为准）。 */
type RecordedEntry = { url: string; http: number; response: unknown };

/** 录制装载：缺失或 results 为空 → stderr 说明并以退出码 1 结束。录制是历史固定
 * 回答资产（v3 十题时代录制，仅作数值来源），不再由 probe 工具重录。 */
const loadRecording = (): Record<string, RecordedEntry> => {
  const recPath = join(dirname(fxPath), `${stem}.jev.json`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(recPath, 'utf8'));
  } catch {
    die(`读不到录制 ${recPath}——test/on 模式需要同目录录制夹具作为固定回答的数值来源`);
  }
  if (!isRecord(parsed) || !isRecord(parsed.results)) {
    die(`录制缺 results 表：${recPath}`);
  }
  const results = parsed.results as Record<string, RecordedEntry>;
  if (Object.keys(results).length === 0) {
    die(`录制 results 为空：${recPath}`);
  }
  return results;
};

/**
 * 按候选 ID 将历史录制投影到当前题键，片段数量不匹配时不给该来源评分。
 * 仅注入答案，无 dispatch；计零实发，合成用量为 0 且 usage_complete=false。
 */
const replayClassifier =
  (results: Record<string, RecordedEntry>): ClassifyDeps['classify'] =>
  async ({ state }) => {
    const answers: Record<string, JevAnswer> = {};
    for (const source of state.sources) {
      const entry = results[source.id];
      if (!entry || entry.http !== 200) continue;
      const parsed = parseJevResponse(entry.http, JSON.stringify(entry.response));
      if (!parsed.ok) continue;
      const recorded = parsed.answers;
      for (const localKey of Object.keys(SOURCE_QUESTIONS)) {
        const answer = recorded[localKey];
        if (answer?.kind === 'noul') answers[allQuestionKey(source.id, localKey)] = answer;
      }
      const recordedSnipCount = Object.keys(recorded).filter((key) => /^snip\d+$/.test(key)).length;
      if (recordedSnipCount === source.snippets.length) {
        for (let i = 0; i < source.snippets.length; i += 1) {
          const answer = recorded[`snip${i}`];
          if (answer?.kind === 'score') answers[allQuestionKey(source.id, `snip${i}`)] = answer;
        }
      }
    }
    return {
      status: 'answered',
      model: 'fixture-replay',
      answers,
      input_tokens: 0,
      usage_complete: false,
    };
  };

// ---------------------------------------------------------------------------
// 跑过滤：off 直接跑；test / on 回放（先核对候选覆盖）
// ---------------------------------------------------------------------------

const config = parseFilterConfigObject(mode === 'off' ? {} : { mode });
const results = mode === 'off' ? undefined : loadRecording();

// 候选覆盖核对（与管道步 5 同源 collectJevCandidates）：录制里缺的候选 id 打一行
// WARN（源 id 加 url）后照跑——注入桩对缺失候选不给答案，来源级缺答保守 → "留"
if (results !== undefined) {
  for (const candidate of collectJevCandidates(data, request, config)) {
    if (!(candidate.id in results)) {
      console.error(`WARN: ${candidate.id} (${candidate.url}) 在录制中缺失——按失败"留"处理`);
    }
  }
}

const { result, stats }: FilterResult = await filterLlmContext(
  data,
  request,
  config,
  results !== undefined ? { classify: replayClassifier(results) } : undefined
);
void result;

// ---------------------------------------------------------------------------
// 输出：首行 + 逐来源对比表 + 汇总行（+ test/on 模式的 stats.jev 一行）
// ---------------------------------------------------------------------------

const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

const clip = (text: string, width: number): string => text.slice(0, width).padEnd(width);

/** 过滤前：原始夹具该来源的片段数与字符数。 */
const beforeOf = (index: number): { snippets: number; chars: number } => {
  const item = data.grounding.generic[index];
  const snippets = Array.isArray(item?.snippets) ? item.snippets : [];
  return {
    snippets: snippets.length,
    chars: snippets.reduce((sum, text) => sum + (typeof text === 'string' ? text.length : 0), 0),
  };
};

/**
 * 过滤后：统计表该行的幸存片段数与字符数。被整体丢弃的来源（含归并）对输出
 * 零贡献——rebuildOutput 只收 verdict keep 的来源，这里按同一口径记 0。
 */
const afterOf = (row: SourceStats): { snippets: number; chars: number } => {
  if (row.verdict !== 'keep') return { snippets: 0, chars: 0 };
  const kept = row.snippets.filter((snippet) => snippet.kept);
  return {
    snippets: kept.length,
    chars: kept.reduce((sum, snippet) => sum + snippet.chars, 0),
  };
};

console.log(`compare ${fxPath} mode=${mode}`);
console.log(
  `${'src'.padEnd(5)}${'host'.padEnd(42)}${'snips'.padStart(9)}${'chars'.padStart(15)}  ${'verdict'.padEnd(9)}reason`
);
for (const row of stats.sources) {
  const before = beforeOf(row.index);
  const after = afterOf(row);
  const snips = `${before.snippets}→${after.snippets}`;
  const chars = `${before.chars}→${after.chars}`;
  console.log(
    `${`s${row.index}`.padEnd(5)}${clip(hostOf(row.url), 40).padEnd(42)}${snips.padStart(9)}${chars.padStart(15)}  ${row.verdict.padEnd(9)}${row.reason ?? '-'}`
  );
}
console.log(
  `total sources ${stats.brave.n_sources}→${stats.output.n_sources} | snippets ${stats.brave.n_snippets}→${stats.output.n_snippets} | chars ${stats.brave.chars}→${stats.output.chars}`
);
if (stats.jev !== null) {
  console.log(
    `jev: n_requests=${stats.jev.n_requests} input_tokens=${stats.jev.input_tokens} status=${stats.jev.status}`
  );
}
