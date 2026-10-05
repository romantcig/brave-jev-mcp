import assert from 'node:assert/strict';
import { buildRequest, parseJevResponse } from '../src/filter/jev/client.ts';
import { buildContextRequest, projectSourceAnswers } from '../src/filter/jev/context.ts';
import { applySourceVerdicts, applySnippetJudgments } from '../src/filter/jev/verdict.ts';
import { DEFAULT_THRESHOLDS } from '../src/filter/jev/questions.ts';
import { createFilterStats } from '../src/filter/stats.ts';

/**
 * 冻结 state 直达生产解析、投影与裁决；不重复执行本地清洗。
 * expectedOverride 缺省用录制内 expected；传入时用当前规则的预期映射
 * （fixtures/jev-three-in-one-current-expected.json），录制本体保持不变。
 */
export function replayFrozen(recording, expectedOverride) {
  const { state, model } = recording.request;
  const candidates = state.sources.map((source) => ({
    id: source.id,
    url: source.url,
    title: source.title,
    bravePageDate: source.brave_page_date,
    snippets: source.snippets.map((text, index) => ({ key: String(index), text })),
  }));
  const built = buildContextRequest(candidates, state.query, state.intent, state.retrieval_time);
  // 深比较完整请求；criteria 的位掩码顺序单独钉住，不限制无语义的对象属性顺序。
  // 冻结 state 的页面日期允许缺失；生产候选显式记 null。只归一此格式差异，
  // 原始录制保持不变，正文、检索时间、题干和其余字段仍必须逐项相等。
  const expectedState = {
    ...state,
    sources: state.sources.map((source) => ({
      ...source,
      brave_page_date: source.brave_page_date ?? null,
    })),
  };
  assert.deepEqual(buildRequest(built.state, built.questions, model), {
    ...recording.request,
    state: expectedState,
  });
  for (const [key, question] of Object.entries(built.questions)) {
    if (question.type === 'choice')
      assert.deepEqual(
        Object.keys(question.criteria),
        Object.keys(recording.request.questions[key].criteria)
      );
  }
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
    built.entries.map((entry) => {
      const projected = projectSourceAnswers({
        snippetCount: entry.snippet_keys.length,
        groups: entry.snippet_groups,
        answerAt: (key) => parsed.answers[entry.question_keys[key]],
      });
      assert.equal(projected.invalidGroups, undefined, `${entry.source_id} 冻结答案无效`);
      return [
        entry.source_id,
        {
          src: entry.source_id,
          url: state.sources[entry.array_index].url,
          status: 'answered',
          answers: projected.answers,
          snippet_judgments: projected.judgments,
        },
      ];
    })
  );
  stats.jev = { status: 'ok', per_source: [...rows.values()] };
  const groups = new Map(built.entries.map((entry) => [entry.source_id, entry.snippet_groups]));
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
