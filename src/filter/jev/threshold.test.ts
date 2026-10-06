/** 临界距离纯判定测试：覆盖验收表、端点与机器尾差、极端阈值与非默认阈值。 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { NEAR_THRESHOLD_MAX_GAP, sourceDropVerdict, snippetDropVerdict } from './threshold.js';

/** 距离断言：允许机器尾差级别的偏差，但不接受业务级舍入。 */
const assertGapCloseTo = (actual: number | undefined, expected: number): void => {
  assert.ok(actual !== undefined, '临界删除必须携带 nearThresholdGap（0 也必须携带）');
  assert.ok(
    Math.abs(actual - expected) <= 8 * Number.EPSILON,
    `gap=${actual} 应为 ${expected}（仅允许机器尾差）`
  );
};

// ---------------------------------------------------------------------------
// 页面方向（T=0.80 默认）：p >= T 原规则删除；T - p <= 0.02 临界删除
// ---------------------------------------------------------------------------

describe('sourceDropVerdict', () => {
  it('keeps pages just outside the gap and drops at the far endpoint (0.78)', () => {
    assert.equal(sourceDropVerdict(0.7799, 0.8).drop, false);
    assert.equal(sourceDropVerdict(0.7799, 0.8).nearThresholdGap, undefined);

    // 0.8 - 0.78 = 0.020000000000000018：端点命中依赖机器尾差容忍
    const endpoint = sourceDropVerdict(0.78, 0.8);
    assert.equal(endpoint.drop, true);
    assertGapCloseTo(endpoint.nearThresholdGap!, 0.02);
    assert.ok(endpoint.nearThresholdGap! <= NEAR_THRESHOLD_MAX_GAP);
  });

  it('drops inside the gap keeping the actual unrounded distance', () => {
    // 0.8 - 0.79 = 0.010000000000000009：保持实际值，不舍入
    const at001 = sourceDropVerdict(0.79, 0.8);
    assert.equal(at001.drop, true);
    assert.equal(at001.nearThresholdGap, 0.8 - 0.79);

    const at0005 = sourceDropVerdict(0.795, 0.8);
    assert.equal(at0005.drop, true);
    assertGapCloseTo(at0005.nearThresholdGap!, 0.005);
  });

  it('deletes by the original rule at or above the threshold without a near marker', () => {
    for (const p of [0.8, 0.81, 1]) {
      const verdict = sourceDropVerdict(p, 0.8);
      assert.equal(verdict.drop, true, `p=${p} 按原规则删除`);
      assert.equal(verdict.nearThresholdGap, undefined, `p=${p} 原判定删除不带临界标记`);
    }
  });

  it('is monotone in the drop direction and deterministic across repeated calls', () => {
    // 固定枚举避开浮点累加踩到端点尾差；端点行为由端点专项用例覆盖
    const probabilities = [0.7, 0.77, 0.7799, 0.785, 0.79, 0.799, 0.82, 0.95];
    for (const p of probabilities) {
      const first = sourceDropVerdict(p, 0.8);
      const second = sourceDropVerdict(p, 0.8);
      assert.deepEqual(first, second);
      assert.equal(first.drop, p >= 0.78, `p=${p} 删除方向应单调`);
    }
  });

  it('disables the near rule at extreme thresholds 0 and 1', () => {
    // T=1：0.99 不达线也不补偿
    assert.deepEqual(sourceDropVerdict(0.99, 1), { drop: false });
    // T=0：任何 [0,1] 概率都按原规则删除，无需临界
    assert.deepEqual(sourceDropVerdict(0, 0), { drop: true });
    assert.deepEqual(sourceDropVerdict(0.5, 0), { drop: true });
  });

  it('computes the gap from the actual configured threshold, not the defaults', () => {
    const below = sourceDropVerdict(0.59, 0.6);
    assert.equal(below.drop, true);
    assertGapCloseTo(below.nearThresholdGap!, 0.01);

    const outside = sourceDropVerdict(0.5799, 0.6);
    assert.deepEqual(outside, { drop: false });
  });
});

// ---------------------------------------------------------------------------
// 片段方向（T=0.25 多片 / T=0.50 单片）：p < T 原规则删除；p - T <= 0.02 临界删除
// ---------------------------------------------------------------------------

describe('snippetDropVerdict', () => {
  it('keeps snippets just outside the gap and drops at the far endpoint (0.27 / 0.52)', () => {
    assert.deepEqual(snippetDropVerdict(0.2701, 0.25), { drop: false });
    assert.deepEqual(snippetDropVerdict(0.5201, 0.5), { drop: false });

    // 0.27 - 0.25 与 0.52 - 0.5 均产生 0.020000000000000018：端点命中依赖尾差容忍
    const groupEndpoint = snippetDropVerdict(0.27, 0.25);
    assert.equal(groupEndpoint.drop, true);
    assertGapCloseTo(groupEndpoint.nearThresholdGap!, 0.02);

    const singleEndpoint = snippetDropVerdict(0.52, 0.5);
    assert.equal(singleEndpoint.drop, true);
    assertGapCloseTo(singleEndpoint.nearThresholdGap!, 0.02);
  });

  it('deletes at the keep threshold itself with gap 0 (exact hit, not strict-less)', () => {
    const atGroupLine = snippetDropVerdict(0.25, 0.25);
    assert.equal(atGroupLine.drop, true);
    assert.ok(atGroupLine.nearThresholdGap !== undefined, 'gap=0 必须保留字段');
    assert.equal(atGroupLine.nearThresholdGap, 0);

    const atSingleLine = snippetDropVerdict(0.5, 0.5);
    assert.equal(atSingleLine.drop, true);
    assert.equal(atSingleLine.nearThresholdGap, 0);
  });

  it('deletes inside the gap keeping the actual unrounded distance', () => {
    const at0005 = snippetDropVerdict(0.255, 0.25);
    assert.equal(at0005.drop, true);
    assertGapCloseTo(at0005.nearThresholdGap!, 0.005);

    const at001 = snippetDropVerdict(0.51, 0.5);
    assert.equal(at001.drop, true);
    assert.equal(at001.nearThresholdGap, 0.51 - 0.5);
  });

  it('deletes by the original rule below the threshold without a near marker', () => {
    for (const [p, t] of [
      [0.24, 0.25],
      [0.1, 0.25],
      [0.49, 0.5],
    ] as const) {
      const verdict = snippetDropVerdict(p, t);
      assert.equal(verdict.drop, true, `p=${p} 按原规则删除`);
      assert.equal(verdict.nearThresholdGap, undefined, `p=${p} 原判定删除不带临界标记`);
    }
  });

  it('is monotone in the drop direction and deterministic across repeated calls', () => {
    // 固定枚举避开浮点累加踩到端点尾差；端点行为由端点专项用例覆盖
    const probabilities = [0.1, 0.24, 0.249, 0.25, 0.255, 0.26, 0.2699, 0.28, 0.9];
    for (const p of probabilities) {
      const first = snippetDropVerdict(p, 0.25);
      const second = snippetDropVerdict(p, 0.25);
      assert.deepEqual(first, second);
      assert.equal(first.drop, p <= 0.2699, `p=${p} 删除方向应单调`);
    }
  });

  it('disables the near rule at extreme thresholds 0 and 1 independently', () => {
    // T=1：p<1 按原规则删除（不带临界标记）；恰好达线（p=1）不因临界规则消失
    assert.deepEqual(snippetDropVerdict(0.99, 1), { drop: true });
    assert.deepEqual(snippetDropVerdict(1, 1), { drop: false });
    // T=0：p < 0 原规则删除（不会出现），p >= 0 原规则保留且不补偿
    assert.deepEqual(snippetDropVerdict(0, 0), { drop: false });
    // 三项分别判断：一项极值不影响其他项的临界判断
    assert.equal(snippetDropVerdict(0.26, 0.25).drop, true);
    assert.equal(sourceDropVerdict(0.79, 0.8).drop, true);
  });

  it('computes the gap from the actual configured threshold, not the defaults', () => {
    const below = snippetDropVerdict(0.34, 0.33);
    assert.equal(below.drop, true);
    assertGapCloseTo(below.nearThresholdGap!, 0.01);

    const outside = snippetDropVerdict(0.3501, 0.33);
    assert.deepEqual(outside, { drop: false });
  });
});
