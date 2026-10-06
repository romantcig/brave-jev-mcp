/**
 * 真实 stdio 接入冒烟；默认回放一份日志夹具，核对工具、返回与落盘。
 * 用法：node --import tsx dev/smoke_stdio.ts [--mode off|test|on] [--keep-artifacts] [--live]
 * --live 使用本机配置与密钥调用真实服务，和 --mode 互斥。
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  loadFixture,
  loadRecording,
  assertRecording,
  assertFixtureOutput,
} from '../test-support/log-fixtures.mjs';
import { parseFilterConfigObject } from '../src/filter/config.js';
import { collectJevCandidatesDetailed } from '../src/filter/pipeline.js';
import { buildContextRequest } from '../src/filter/jev/context.js';
import { buildRequest, JEVI_ENDPOINT } from '../src/filter/jev/client.js';
import type { SampleRecord } from '../src/filter/sample.js';
import type { FilterMode, FilterStats, BraveLlmContextResponse } from '../src/filter/types.js';

const args = process.argv.slice(2);
const live = args.includes('--live');
const keepArtifacts = args.includes('--keep-artifacts');
const modeAt = args.indexOf('--mode');
const requestedMode = modeAt >= 0 ? args[modeAt + 1] : undefined;
if (modeAt >= 0) assert.ok(['off', 'test', 'on'].includes(requestedMode ?? ''), '无效 --mode');
assert.ok(!live || modeAt < 0, '--live 与 --mode 互斥');
const fixture = loadFixture('jev-questions');
const repo = fileURLToPath(new URL('../', import.meta.url));
const server = join(repo, 'dist/index.js');
const toolName = 'brave_llm_context';
type LogEntry = FilterStats & { request_id: string; sample?: { path: string; status: string } };

async function readLog(logDir: string): Promise<LogEntry> {
  for (let i = 0; i < 100; i++) {
    const file = readdirSync(logDir).find((name) => name.endsWith('.jsonl'));
    if (file) {
      const text = readFileSync(join(logDir, file), 'utf8');
      if (text.endsWith('\n')) return JSON.parse(text.trim().split('\n').at(-1)!);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('本次搜索没有生成日志');
}

async function run(mode: FilterMode, rawConfig: Record<string, unknown> = {}) {
  if (!live && mode !== 'off') {
    const config = parseFilterConfigObject({ ...fixture.config, mode });
    const candidates = collectJevCandidatesDetailed(fixture.data, fixture.request, config);
    const { state, questions } = buildContextRequest(
      candidates,
      fixture.request.params.query,
      fixture.request.intent,
      fixture.request.retrievalTime
    );
    assertRecording(loadRecording(fixture.id), buildRequest(state, questions, config.jev.model));
  }
  const temp = mkdtempSync(join(tmpdir(), 'jev-smoke-'));
  const configPath = join(temp, 'config.json');
  writeFileSync(
    configPath,
    JSON.stringify({ ...(live ? rawConfig : fixture.config), mode, log_dir: temp })
  );
  const env: Record<string, string> = { JEV_FILTER_CONFIG_FILE: configPath };
  if (live) {
    for (const key of [
      'PATH',
      'SystemRoot',
      'HOME',
      'USERPROFILE',
      'HTTPS_PROXY',
      'HTTP_PROXY',
      'NO_PROXY',
      'https_proxy',
      'http_proxy',
      'no_proxy',
      'NODE_USE_ENV_PROXY',
      'TYPESAFE_API_KEY',
      'BRAVE_API_KEY',
      'BRAVE_SEARCH_API_KEY',
    ]) {
      if (process.env[key]) env[key] = process.env[key]!;
    }
    env.BRAVE_API_KEY ||= env.BRAVE_SEARCH_API_KEY;
  } else {
    Object.assign(env, {
      BRAVE_API_KEY: 'smoke-replay',
      TYPESAFE_API_KEY: 'smoke-replay',
      SMOKE_FIXTURE: fixture.id,
      SMOKE_MODE: mode,
      SMOKE_JEV_ENDPOINT: JEVI_ENDPOINT,
      TZ: 'Asia/Shanghai',
    });
  }
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      ...(live ? [] : ['--import', new URL('./stub_fetch.mjs', import.meta.url).href]),
      server,
      '--transport',
      'stdio',
    ],
    env,
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const client = new Client({ name: 'log-fixture-smoke', version: '1.0.0' });
  try {
    await client.connect(transport);
    const tool = (await client.listTools()).tools.find((item) => item.name === toolName);
    assert.ok(tool, '工具未注册');
    assert.deepEqual(tool.inputSchema.required, mode === 'off' ? ['query'] : ['query', 'intent']);
    assert.equal(tool.outputSchema, undefined);
    const response = await client.callTool({
      name: toolName,
      arguments: {
        ...fixture.request.params,
        ...(mode === 'off' ? {} : { intent: fixture.request.intent }),
      },
    });
    assert.ok(!response.isError, '工具返回错误');
    const content = response.content as { type: string; text?: string }[];
    assert.equal(content[0]?.type, 'text');
    const payload = JSON.parse(content[0].text!) as BraveLlmContextResponse;
    assert.ok(Array.isArray(payload.grounding?.generic));
    assert.equal(response.structuredContent, undefined);
    const log = await readLog(temp);
    assert.equal(log.request.query, fixture.request.params.query);
    assert.equal(log.request.intent, mode === 'off' ? '' : fixture.request.intent);
    assert.doesNotMatch(stderr, /\[smoke-stub-failed\]/);
    if (!live) {
      assert.equal((stderr.match(/\[smoke-brave\]/g) ?? []).length, 1);
      assert.equal((stderr.match(/\[smoke-jev\]/g) ?? []).length, mode === 'off' ? 0 : 1);
    }
    if (mode === 'off') assert.equal(log.jev, null);
    else {
      assert.equal(log.jev?.status, 'ok', '模型链路未成功');
      assert.equal(log.jev.n_requests, 1);
      if (!live) assertFixtureOutput(fixture, payload);
    }
    if (mode === 'test') {
      assert.equal(log.sample?.status, 'saved');
      const sample = JSON.parse(readFileSync(join(temp, log.sample!.path), 'utf8')) as SampleRecord;
      assert.equal(sample.request_id, log.request_id);
      assert.deepEqual(sample.final_return?.payload, payload);
      if (!live) {
        assert.deepEqual(sample.pre_filter, fixture.data);
        const recorded = loadRecording(fixture.id);
        assert.deepEqual(JSON.parse(sample.jev!.requests[0].state!), recorded.request.state);
        assert.deepEqual(sample.jev!.requests[0].questions, recorded.request.questions);
      }
      assert.ok(content.some((item) => item.text?.includes(log.sample!.path)));
    } else {
      assert.equal(log.sample, undefined);
      assert.equal(existsSync(join(temp, 'samples')), false);
    }
    console.log(`smoke ${live ? 'live ' : ''}${mode}: passed`);
    return payload;
  } finally {
    try {
      await client.close();
    } finally {
      if (keepArtifacts) console.error(`[smoke] 保留产物：${temp}`);
      else rmSync(temp, { recursive: true, force: true });
    }
  }
}

if (live) {
  const path = process.env.JEV_FILTER_CONFIG_FILE || join(homedir(), '.brave-jev/config.json');
  const raw = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { mode: 'on' };
  const config = parseFilterConfigObject(raw);
  assert.notEqual(config.mode, 'off', '真实链路冒烟需要 test 或 on 模式');
  assert.ok(process.env.TYPESAFE_API_KEY, '缺少 TYPESAFE_API_KEY');
  assert.ok(process.env.BRAVE_API_KEY || process.env.BRAVE_SEARCH_API_KEY, '缺少 Brave 密钥');
  await run(config.mode, raw);
} else if (requestedMode === 'off') {
  await run('off');
} else {
  if (!requestedMode) await run('off');
  const test = await run('test');
  const on = await run('on');
  assert.deepEqual(test, on, 'test 与 on 返回正文不一致');
}
