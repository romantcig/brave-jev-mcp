/**
 * 阈值附近的本地裁决规则：原判定优先，未命中原删除条件且距离不超过上限时按临界规则删除。
 * 纯常量与纯判定，不依赖 MCP、环境或文件系统；上限是固定常量，不作为可配置项暴露。
 */

/** 临界删除的最大距离（含端点）；没有最小距离或最小加分。 */
export const NEAR_THRESHOLD_MAX_GAP = 0.02;

/**
 * 距离比较的机器尾差容忍：`0.8 - 0.78`、`0.52 - 0.5` 一类双精度减法会得到
 * `0.020000000000000018`，按严格比较会漏过最大距离的端点。
 * 只用于临界距离比较；不作用于任何原判定，也不是业务级容差。
 */
const GAP_COMPARE_SLACK = 8 * Number.EPSILON;

/**
 * 只读运行规则快照：记录该构建的临界距离，供样本 config_snapshot 与 JSONL 记录复用。
 * 本次是否命中由逐项距离标记表示；快照不是可写进配置文件生效的配置组。
 */
export const DECISION_RULES_SNAPSHOT = Object.freeze({
  near_threshold_max_gap: NEAR_THRESHOLD_MAX_GAP,
});

/** 裁决结果：drop 为最终是否删除；nearThresholdGap 仅临界规则删除时携带，0 是合法值。 */
export type DropVerdict = {
  drop: boolean;
  nearThresholdGap?: number;
};

/** 距离上限包含端点：把机器尾差夹回 [0, 上限] 后作为实际补偿距离记录。 */
const clampGap = (gap: number): number => Math.min(gap, NEAR_THRESHOLD_MAX_GAP);

/** 极端阈值（0 或 1）只执行原判定，不启用临界补偿，保留原有极端设置语义。 */
const nearThresholdEnabled = (threshold: number): boolean => threshold > 0 && threshold < 1;

/**
 * 页面方向裁决：`p >= T` 按原规则删除（原因仍为 filler，无临界标记）；否则
 * `T - p` 不超过上限（含端点，比较容忍机器尾差）时临界删除并携带实际距离。
 * p 必须已通过有效性校验；T 为 0 或 1 时只执行原判定。
 */
export function sourceDropVerdict(probability: number, threshold: number): DropVerdict {
  if (probability >= threshold) return { drop: true };
  if (
    nearThresholdEnabled(threshold) &&
    threshold - probability <= NEAR_THRESHOLD_MAX_GAP + GAP_COMPARE_SLACK
  ) {
    return { drop: true, nearThresholdGap: clampGap(threshold - probability) };
  }
  return { drop: false };
}

/**
 * 片段方向裁决：`p < T` 按原规则删除（原因仍为 keep_probability，无临界标记）；
 * 否则 `p - T` 不超过上限（含端点，gap = 0 是合法命中）时临界删除并携带实际距离。
 * T 为 0 或 1 时只执行原判定。
 */
export function snippetDropVerdict(probability: number, threshold: number): DropVerdict {
  if (probability < threshold) return { drop: true };
  if (
    nearThresholdEnabled(threshold) &&
    probability - threshold <= NEAR_THRESHOLD_MAX_GAP + GAP_COMPARE_SLACK
  ) {
    return { drop: true, nearThresholdGap: clampGap(probability - threshold) };
  }
  return { drop: false };
}
