/**
 * stdio 冒烟脚本（TOOLS-02，D-17/D-19）：spawn 真服务器进程（dist/index.js + 预加载
 * 桩 dev/stub_fetch.mjs），用 MCP SDK Client + StdioClientTransport 走 initialize →
 * tools/list → tools/call 全程，零网络确定性地验证返回形状与状态行——切到
 * ~/.claude.json（03-04）之前的最后一道自动闸，冒烟通过是切换任务的硬前置。
 *
 * 用法：node --import tsx dev/smoke_stdio.ts [--mode off|shadow|on] [--live]
 *   不带 --mode 跑三模式全量（off → shadow → on，每模式各自 spawn 一次服务器、
 *   各自临时配置与临时 log_dir——mode 在配置文件里、服务器启动读一次）；单独
 *   --mode shadow 时自动先跑一遍 off 作逐字对照（dev/compare.ts 先例）。--live
 *   是真实网络手动开关（D-18，不进自动验证，切换前跑一次确认 key 与代理通），
 *   与 --mode 互斥。
 *
 * 三模式专属断言：
 *   - shadow：状态行与 JSON 块都和 off 那次独立 spawn 的结果逐字相同（D-07 红线
 *     + "shadow 输出与 off 完全相同"的端到端确认）；
 *   - on：从临时 log_dir 的记录断言 jev.n_requests == 回放表键数——假 key 已显式
 *     传，若仍为 0 即 no_key 静默短路假绿（Pitfall 2 的直接防线）；未判定段按
 *     D-06 语义断言（本夹具 on 全部 12 源 answered，不该出现）；
 *   - 三模式共同：每模式日志至少一条且记录 mode 字段与配置一致（D-16）。
 *
 * 断言清单（D-19，照 src/tools/llm_context/index.test.ts 既有断言抄）：
 *   1. 工具声明：inputSchema.properties == 白名单九键 + intent、required ==
 *      ['query','intent']、无 outputSchema；
 *   2. 返回：isError 假、无 structuredContent、content[0] 为 text 且 JSON 可解析；
 *   3. 状态行：default 夹具有删除（76→59 片段）→ 第二块存在、以 `[filter] ` 开头、
 *      单行、D-02 形状（来源计数段按 D-04 条件可有可无——本夹具 off 无来源丢弃）、
 *      与 JSON 块内 output.status_line 逐字同源（D-08）、无 on 专属未判定段（D-06）；
 *   4. 临时 log_dir：恰一个按天 .jsonl、至少一行、每行可解析、记录 mode 与配置一致、
 *      不含夹具片段正文前 30 字符（LOG-03 红线负样本）；
 *   5. stderr：无 `[jev-filter] Unable to write`（日志写成功）、无 `[smoke-stub]`
 *      未匹配行（桩全接住，零网络旁证）。
 *
 * 两个关键坑（RESEARCH 六问 3/4）：
 *   - SDK spawn 的 env 白名单 12 变量不含 TYPESAFE_API_KEY / JEV_FILTER_CONFIG_FILE，
 *     冒烟需要的每个变量必须显式放进 serverParams.env；
 *   - on/shadow 不设假 key 会走 no_key 静默短路（Pitfall 2 假绿）——off 也统一传假值。
 *
 * dev/ 不进 tsc / prettier 门禁；相对导入带 .js 后缀（NodeNext ESM 直跑约定）。
 */
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { JEV_CONFIG_FILE_ENV } from '../src/filter/config.js';

// ---------------------------------------------------------------------------
// argv：--mode off|shadow|on（缺省三模式全量）；--live 真实网络手动开关（互斥）
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const die = (message: string): never => {
  console.error(message);
  process.exit(1);
};

const MODES = ['off', 'shadow', 'on'] as const;
type SmokeMode = (typeof MODES)[number];

let modeFilter: SmokeMode | undefined;
const modeIndex = args.indexOf('--mode');
if (modeIndex !== -1) {
  const value = args[modeIndex + 1] ?? '';
  if (!(MODES as readonly string[]).includes(value)) {
    die(`--mode 只认 off|shadow|on，收到：${value || '(缺值)'}`);
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

// 假 key（T-03-06）：值非空即可让 on/shadow 走真分类器路径，桩会截住全部请求。
// BRAVE_API_KEY 是上游 CLI 的启动硬前置（缺了直接退出），桩模式同样传假值——
// 零网络由桩保证，不依赖 key 真实性。两个 key 都写成常量再引用——不把 key 名与
// 引号字面量相邻，保持 key 泄漏闸 grep 形态干净。
const FAKE_JEV_KEY = 'smoke-stub';
const FAKE_BRAVE_KEY = 'smoke-stub';

// 请求三件套取自 expected 的 off 标注（与 dev/compare.ts:141-144 同式）
const expected = JSON.parse(
  readFileSync(join(repoRoot, 'fixtures', 'expected', 'jev_release_default.off.json'), 'utf8')
) as { query: string; intent: string; request: Record<string, unknown> };

// Jev 回放表（on 模式防假绿断言的期望值来源：results 键数）
const jevRecording = JSON.parse(
  readFileSync(join(repoRoot, 'fixtures', 'jev_release_default.jev.json'), 'utf8')
) as { results: Record<string, { url: string; http: number; response: unknown }> };
const nRecordedSources = Object.keys(jevRecording.results).length;

// LOG-03 负样本：从夹具 generic 里取一条片段正文的前 30 字符；跳过头部含引号/
// 反斜杠（JSON 转义会变形）以及恰好撞上标题/URL 的片段，保证负样本断言有意义
const braveFixture = JSON.parse(
  readFileSync(join(repoRoot, 'fixtures', 'jev_release_default.json'), 'utf8')
) as {
  response: {
    grounding: { generic: Array<{ url: string; title?: string; snippets?: string[] }> };
  };
};
const negativeSample = (): string => {
  const titlesAndUrls = braveFixture.response.grounding.generic.flatMap((item) => [
    item.url,
    item.title ?? '',
  ]);
  for (const item of braveFixture.response.grounding.generic) {
    for (const text of item.snippets ?? []) {
      const head = text.slice(0, 30);
      if (head.length === 30 && !/["\\]/.test(head) && !titlesAndUrls.some((t) => t.includes(head))) {
        return head;
      }
    }
  }
  return die('夹具 generic 里找不到可用的 LOG-03 负样本片段（前 30 字符）');
};
const snippetHead = negativeSample();

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
// 单模式冒烟：spawn（桩 + 临时配置 + 临时 log_dir）→ 断言 → 清理
// ---------------------------------------------------------------------------

type ModeResult = { jsonText: string; statusLine: string | undefined };

/** 本地日期（YYYY-MM-DD）：本地 getter，不用 getUTC*（会差 8 小时，RESEARCH 六问 6.1）。 */
const todayLocalDate = (): string => {
  const d = new Date();
  const pad2 = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
};

/** 等子进程把日志落盘（写入在进程内 promise 链里异步完成），轮询至多 ~5 s。 */
const pollForLogLines = async (
  logDir: string,
  fileFilter: (file: string) => boolean = (file) => file.endsWith('.jsonl')
): Promise<string[]> => {
  for (let waited = 0; waited < 5000; waited += 50) {
    const files = readdirSync(logDir).filter(fileFilter);
    if (files.length > 0) {
      const lines = readFileSync(join(logDir, files[0]), 'utf8').split('\n').filter(Boolean);
      if (lines.length > 0) return lines;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return [];
};

/** content[0] 的 JSON 解析：抛错带断言名，由 main 统一 die（finally 仍会清理临时目录）。 */
const parseJsonBlock = (text: string): { output?: { status_line?: string } } => {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`return: content[0] JSON parse failed — ${String(error)}`);
  }
};

const runStubbedMode = async (runMode: string): Promise<ModeResult> => {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'jev-smoke-stdio-'));
  const configPath = join(tmpRoot, 'config.json');
  writeFileSync(configPath, JSON.stringify({ mode: runMode, log_dir: tmpRoot }), 'utf8');

  const stderrChunks: Buffer[] = [];
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', pathToFileURL(stubPath).href, distIndexJs, '--transport', 'stdio'],
    // SDK spawn env = 默认白名单 12 变量 ∪ 这里显式给出的键——配置文件路径与假 key
    // 都不在白名单里，缺一即假绿/读不到配置/启动即退（六问 4）
    env: {
      JEV_FILTER_CONFIG_FILE: configPath,
      TYPESAFE_API_KEY: FAKE_JEV_KEY,
      BRAVE_API_KEY: FAKE_BRAVE_KEY,
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

    // --- 2. tools/call（参数从 expected 三件套构造，照 compare.ts:141-144）---
    const result = (await client.callTool({
      name: toolName,
      arguments: {
        query: expected.query,
        intent: expected.intent,
        ...expected.request,
      },
    })) as { isError?: boolean; structuredContent?: unknown; content: { type: string; text: string }[] };

    assert.equal(
      result.isError ?? false,
      false,
      `return: call failed — ${JSON.stringify(result.content)}`
    );
    assert.equal(result.structuredContent, undefined, 'return: structuredContent must be absent');
    const content = result.content;
    assert.equal(content[0]?.type, 'text', 'return: content[0] must be a text block');
    const jsonText = content[0].text;
    const payload = parseJsonBlock(jsonText);

    // --- 3. 状态行（D-02 形状 + D-08 同源 + D-06）---
    // default 夹具 off 无来源丢弃（12→12）只有片段删除（76→59）：dropped 段按
    // D-04 条件可有可无，形状断言两态都接受；片段总数段必然在
    const statusLine = content[1]?.text;
    assert.ok(statusLine !== undefined, 'status line: second text block expected for this fixture');
    assert.ok(statusLine.startsWith('[filter] '), `status line: must start with "[filter] " — ${statusLine}`);
    assert.ok(!statusLine.includes('\n'), 'status line: must be a single line');
    assert.match(
      statusLine,
      /^\[filter\] (dropped \d+ of \d+ sources: .+; )?\d+ snippets? removed(; .+)?$/,
      `status line: D-02 shape mismatch — ${statusLine}`
    );
    assert.ok(
      !statusLine.includes('not checked by Jev'),
      `status line: the on-only unchecked segment must not appear in ${runMode} (D-06) — ${statusLine}`
    );
    assert.equal(
      payload.output?.status_line,
      statusLine,
      'status line: must be verbatim-identical to payload.output.status_line (D-08)'
    );

    // --- 4. 临时 log_dir（D-19 第 4 项 + D-16 mode 一致）---
    const files = readdirSync(tmpRoot).filter((file) => file.endsWith('.jsonl'));
    assert.equal(files.length, 1, `log: exactly one dated .jsonl expected, got ${files.length}`);
    assert.match(files[0], /^\d{4}-\d{2}-\d{2}\.jsonl$/, `log: file must be a local-date name — ${files[0]}`);
    const lines = await pollForLogLines(tmpRoot);
    assert.ok(lines.length >= 1, 'log: at least one record expected');
    const recordText = lines.join('\n');
    for (const line of lines) {
      try {
        JSON.parse(line);
      } catch (error) {
        assert.fail(`log: record line is not valid JSON — ${String(error)}`);
      }
    }
    assert.equal(
      (JSON.parse(lines[0]) as { mode?: string }).mode,
      runMode,
      'log: record mode must match the config (D-16)'
    );
    assert.ok(
      !recordText.includes(snippetHead),
      `log: LOG-03 red line — snippet body prefix must not appear (${JSON.stringify(snippetHead)})`
    );

    // on 模式防假绿（Pitfall 2）：假 key 已显式传，Jev 请求必须真的发生过——
    // 从日志记录断言 jev.n_requests == 回放表键数，no_key 静默短路在这里现形
    if (runMode === 'on') {
      const nRequests = (JSON.parse(lines[0]) as { jev?: { n_requests?: number } | null }).jev
        ?.n_requests;
      assert.equal(
        nRequests,
        nRecordedSources,
        `anti-false-green: jev.n_requests must equal the recording's ${nRecordedSources} sources, got ${nRequests}`
      );
    }

    // --- 5. stderr：日志写成功 + 桩全接住（零网络旁证）---
    const stderrText = Buffer.concat(stderrChunks).toString('utf8');
    assert.ok(
      !stderrText.includes('[jev-filter] Unable to write'),
      `stderr: log writes must succeed (D-14) — ${stderrText}`
    );
    assert.ok(
      !stderrText.includes('[smoke-stub]'),
      `stderr: the stub must cover every request (zero-network evidence) — ${stderrText}`
    );

    return { jsonText, statusLine };
  } finally {
    await client.close();
    rmSync(tmpRoot, { recursive: true, force: true });
  }
};

// ---------------------------------------------------------------------------
// --live（D-18）：真实网络手动开关——不注入桩，key 与代理从当前进程环境透传，
// 只验证启动 / initialize / callTool 成功 / 返回可解析 / 日志写出，不做内容断言
//（真实网络非确定性）；stderr 直通终端便于人工观察。不进自动验证，切换前跑一次。
// ---------------------------------------------------------------------------

/** live 透传的白名单外变量（有则传无则跳过）；TYPESAFE_API_KEY 旧名已不生效。 */
const LIVE_ENV_KEYS = [
  'TYPESAFE_API_KEY',
  'BRAVE_API_KEY',
  'ALL_PROXY',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'NODE_USE_ENV_PROXY',
];

const runLiveMode = async (): Promise<void> => {
  const homeConfig = join(homedir(), '.brave-jev', 'config.json');
  const env: Record<string, string> = {};
  for (const key of LIVE_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined && value !== '') env[key] = value;
  }
  // 真实配置与 log_dir（D-24）：配置文件存在则指向，缺省则不设变量走服务器默认；
  // 生效 log_dir 供"日志文件写出"断言——配置的 log_dir 优先（~ 展开），否则默认
  let logDir = join(homedir(), '.brave-jev', 'logs');
  if (existsSync(homeConfig)) {
    env[JEV_CONFIG_FILE_ENV] = homeConfig;
    try {
      const parsed = JSON.parse(readFileSync(homeConfig, 'utf8')) as { log_dir?: string };
      if (typeof parsed.log_dir === 'string' && parsed.log_dir !== '') {
        logDir = parsed.log_dir.startsWith('~')
          ? join(homedir(), parsed.log_dir.slice(1))
          : parsed.log_dir;
      }
    } catch {
      // 坏配置按服务器默认路径兜底（与 config.ts 的 fail-open 同精神）
    }
  }

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
    assert.ok(tools.some((t) => t.name === toolName), `live: ${toolName} is not listed`);

    const result = (await client.callTool({
      name: toolName,
      arguments: { query: expected.query, intent: expected.intent, ...expected.request },
    })) as { isError?: boolean; content: { type: string; text: string }[] };
    assert.equal(result.isError ?? false, false, 'live: callTool failed');
    assert.equal(result.content[0]?.type, 'text', 'live: content[0] must be a text block');
    try {
      JSON.parse(result.content[0].text);
    } catch (error) {
      throw new Error(`live: content[0] JSON parse failed — ${String(error)}`);
    }

    const lines = await pollForLogLines(logDir, (file) => file === `${todayLocalDate()}.jsonl`);
    assert.ok(
      lines.length >= 1,
      `live: expected at least one record in ${join(logDir, `${todayLocalDate()}.jsonl`)}`
    );
    console.log('smoke live: all assertions passed');
    console.error('*** LIVE 完成：真实网络请求已发生（Brave + Jev）***');
  } finally {
    await client.close();
  }
};

// ---------------------------------------------------------------------------
// 主流程：三模式循环（shadow 与 off 逐字对照）或 --live；汇总行便于 verify grep
// ---------------------------------------------------------------------------

try {
  if (live) {
    await runLiveMode();
  } else {
    const runs = new Map<SmokeMode, ModeResult>();
    const modes: SmokeMode[] = modeFilter ? [modeFilter] : [...MODES];
    for (const m of modes) {
      // 单独 --mode shadow：先静默跑一遍 off 作对照——D-07 逐字断言需要两份
      // 独立 spawn 的结果（dev/compare.ts 的"同时跑一遍 off 作对照"先例）
      if (m === 'shadow' && !runs.has('off')) {
        runs.set('off', await runStubbedMode('off'));
      }
      const run = await runStubbedMode(m);
      runs.set(m, run);
      if (m === 'shadow') {
        const offRun = runs.get('off');
        assert.ok(offRun !== undefined, 'shadow: off baseline missing');
        assert.equal(
          run.statusLine,
          offRun.statusLine,
          `shadow: status line must be verbatim-identical to the off run (D-07) — off=${JSON.stringify(offRun.statusLine)} shadow=${JSON.stringify(run.statusLine)}`
        );
        assert.equal(
          run.jsonText,
          offRun.jsonText,
          'shadow: JSON block must be verbatim-identical to the off run ("shadow 输出与 off 完全相同")'
        );
      }
      console.log(`smoke ${m}: all assertions passed`);
    }
    if (modeFilter === undefined) {
      console.log('smoke all: 3 modes passed');
    }
  }
} catch (error) {
  const where = live ? 'live' : (modeFilter ?? 'all');
  die(`smoke FAILED [${where}]: ${error instanceof Error ? error.message : String(error)}`);
}
