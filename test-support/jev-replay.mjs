import assert from 'node:assert/strict';
import { parseJevResponse } from '../src/filter/jev/client.ts';
import { projectSourceAnswers } from '../src/filter/jev/context.ts';
import { applySourceVerdicts, applySnippetJudgments } from '../src/filter/jev/verdict.ts';
import { DEFAULT_THRESHOLDS, snippetGroupsOf } from '../src/filter/jev/questions.ts';
import { createFilterStats } from '../src/filter/stats.ts';

/**
 * 冻结响应验证生产解析、投影与裁决；不构造或派发请求，不转换录制格式。
 * expectedOverride 缺省用录制内 expected；传入时用当前规则的预期映射
 * （fixtures/jev-three-in-one-current-expected.json），录制本体保持不变。
 */
export function replayFrozen(recording, expectedOverride) {
  const { state } = recording.request;
  const parsed = parseJevResponse(recording.status, JSON.stringify(recording.response));
  assert.ok(parsed.ok, '冻结响应必须可解析');
  const table = state.sources.map((source) => ({
    index: Number(source.id.slice(1)),
    url: source.url,
    title: source.title,
    verdict: 'keep',
    snippets: source.snippets.map((text, index) => ({ index, text, kept: true })),
  }));
  const stats = createFilterStats(
    'on',
    { query: state.query, intent: state.intent, max_urls: 20, max_tokens: 20000 },
    { grounding: { generic: [], map: [] }, sources: {} }
  );
  const rows = new Map(
    state.sources.map((source) => {
      const projected = projectSourceAnswers({
        snippetCount: source.snippets.length,
        groups: snippetGroupsOf(source.snippets.length),
        answerAt: (key) => parsed.answers[`${source.id}__${key}`],
      });
      assert.equal(projected.invalidGroups, undefined, `${source.id} 冻结答案无效`);
      return [
        source.id,
        {
          src: source.id,
          url: source.url,
          status: 'answered',
          answers: projected.answers,
          snippet_judgments: projected.judgments,
        },
      ];
    })
  );
  stats.jev = { status: 'ok', per_source: [...rows.values()] };
  const groups = new Map(
    state.sources.map((source) => [source.id, snippetGroupsOf(source.snippets.length)])
  );
  applySourceVerdicts(table, rows, DEFAULT_THRESHOLDS, stats);
  applySnippetJudgments(table, rows, groups, DEFAULT_THRESHOLDS, stats);
  const actual = table.map((source) => ({
    verdict: source.verdict,
    kept: source.snippets.map((snippet) => snippet.kept),
  }));
  assert.deepEqual(
    actual,
    expectedOverride ?? recording.expected,
    '生产逐来源和逐片裁决必须与冻结实验一致'
  );
  return {
    sources: table.length,
    snippets: table.reduce((n, source) => n + source.snippets.length, 0),
    input_tokens: parsed.input_tokens,
    missing_page_dates: state.sources.filter((source) => !Object.hasOwn(source, 'brave_page_date'))
      .length,
  };
}
