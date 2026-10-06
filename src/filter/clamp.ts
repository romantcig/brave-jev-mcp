/**
 * 将数值参数抬到下限，并返回调整清单；不依赖 MCP 或 zod 类型。
 * 其余数值合法性由宿主 schema 校验。
 */

import type { FilteredResponse } from './types.js';

/** 工具面下限：数值必须与 schemas/input.ts 的 RequestParamsSchema `.min()` 一致，由 index.test.ts 锁定。 */
export const MINIMUM_VALUES = Object.freeze({
  count: 1,
  maximum_number_of_urls: 1,
  maximum_number_of_tokens: 1024,
  maximum_number_of_tokens_per_url: 512,
} as const);

/** 一次被抬到下限的参数，回传给模型让它知道阈值被调整了。 */
export type RaisedParameter = { parameter: string; requested: number; applied: number };

/**
 * 把低于下限的数值参数抬到下限，返回生效参数与调整清单。
 * 放在 execute() 里而不是做成 zod preprocess：preprocess 发生在 SDK 的共享
 * 校验层内部，钳位只会静默发生，调用侧拿不到"本次调整了什么"的信号。
 * 泛型入参：调用侧传 zod 解析前的工具输入对象，未知键原样保留。
 */
export const applyMinimumValues = <T extends object>(
  params: T
): { adjusted: T; raised: RaisedParameter[] } => {
  const adjusted = { ...(params as Record<string, unknown>) };
  const raised: RaisedParameter[] = [];
  for (const parameter of Object.keys(MINIMUM_VALUES)) {
    const requested = adjusted[parameter];
    const applied = MINIMUM_VALUES[parameter as keyof typeof MINIMUM_VALUES];
    if (typeof requested === 'number' && requested < applied) {
      adjusted[parameter] = applied;
      raised.push({ parameter, requested, applied });
    }
  }
  return { adjusted: adjusted as T, raised };
};

/** 载荷与 Brave 响应同形；只有发生下限钳位时才附加 parameter_adjustments 键。 */
export type WithAdjustments = FilteredResponse & {
  parameter_adjustments?: Record<string, { requested: number; applied: number }>;
};

/** 写时复制附加钳位清单，不改动过滤层返回的对象；未触发时原引用返回。 */
export const withAdjustments = (
  payload: FilteredResponse,
  raised: RaisedParameter[]
): WithAdjustments => {
  if (raised.length === 0) return payload;
  return {
    ...payload,
    parameter_adjustments: Object.fromEntries(
      raised.map(({ parameter, requested, applied }) => [parameter, { requested, applied }])
    ),
  };
};

/** stderr 是诊断通道，不进协议；只在钳位真正发生时输出一行。 */
export const logRaisedToStderr = (raised: RaisedParameter[]): void => {
  if (raised.length === 0) return;
  console.error(
    `[brave_llm_context] raised below-minimum parameters: ${raised
      .map((r) => `${r.parameter} ${r.requested} -> ${r.applied}`)
      .join(', ')}`
  );
};
