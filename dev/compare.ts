/** 当前日志夹具的离线查看；--local 只输出送模型前的候选，默认回放 on 模式。 */
import assert from 'node:assert/strict';
import {
  loadFixture,
  loadRecording,
  assertRecording,
  assertFixtureOutput,
} from '../test-support/log-fixtures.mjs';
import { parseFilterConfigObject } from '../src/filter/config.js';
import { collectJevCandidatesDetailed, filterLlmContext } from '../src/filter/pipeline.js';
import { buildContextRequest } from '../src/filter/jev/context.js';
import { buildRequest, parseJevResponse } from '../src/filter/jev/client.js';
import type { ClassifyDeps } from '../src/filter/types.js';

const [name, ...args] = process.argv.slice(2);
assert.ok(name, '用法：node --import tsx dev/compare.ts <夹具名称> [--mode off|test|on] [--local]');
const fixture = loadFixture(name);
const modeAt = args.indexOf('--mode');
const mode = modeAt < 0 ? 'on' : args[modeAt + 1];
assert.ok(['off', 'test', 'on'].includes(mode), '无效 --mode');
const config = parseFilterConfigObject({ ...fixture.config, mode });
const candidates = collectJevCandidatesDetailed(fixture.data, fixture.request, config);
if (args.includes('--local')) {
  console.log(JSON.stringify({ request: fixture.request, candidates }, null, 2));
} else {
  let classify: ClassifyDeps['classify'] | undefined;
  if (mode !== 'off' && candidates.length) {
    const recording = loadRecording(name);
    const { state, questions } = buildContextRequest(
      candidates,
      fixture.request.params.query,
      fixture.request.intent,
      fixture.request.retrievalTime
    );
    assertRecording(recording, buildRequest(state, questions, config.jev.model));
    const parsed = parseJevResponse(recording.status, JSON.stringify(recording.body));
    assert.ok(parsed.ok, '录制响应无法解析');
    classify = async () => ({
      status: 'answered',
      model: parsed.model,
      answers: parsed.answers,
      input_tokens: 0,
      usage_complete: false,
    });
  }
  const { result, stats } = await filterLlmContext(fixture.data, fixture.request, config, {
    classify,
  });
  if (mode !== 'off') assertFixtureOutput(fixture, result);
  console.log(
    JSON.stringify(
      {
        fixture: name,
        mode,
        network_calls: 0,
        local: stats.local,
        sources: stats.sources.map((source) => ({
          url: source.url,
          verdict: source.verdict,
          kept: source.snippets.filter((snippet) => snippet.kept).map((snippet) => snippet.index),
        })),
      },
      null,
      2
    )
  );
}
