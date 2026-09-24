/**
 * 无分词器的 token 估算。
 *
 * 公式来自 notes/jev-api.md「发送前的 token 估算」：英文单词算 1 token、每满
 * 6 个字母再加 1；数字每位算 0.5；其余任何字符（含每个 CJK 字符）算 0.9；
 * 空白不计费（词间空白不是模型要读的内容）。该公式已用两份英文夹具的真实
 * `usage.input_tokens` 验证过，比"字符 ÷ 4"准得多。
 *
 * Phase 2 的 32k 保护与 Phase 3 的日志估算复用本函数，不要复制实现。
 *
 * 依据：notes/jev-api.md、01-RESEARCH.md「规则 9（步 9）」。
 */

/** 其余字符（标点、CJK 等）每个的 token 权重。可按影子期实测调整。 */
export const TOKEN_WEIGHT_OTHER = 0.9;

/** 数字每位的 token 权重。可按影子期实测调整。 */
export const TOKEN_WEIGHT_DIGIT = 0.5;

/** 每满这么多字母加 1 个 token（单词本身已有 1 个）。可按影子期实测调整。 */
export const TOKEN_LATIN_PER_EXTRA_CHARS = 6;

/**
 * 估算一段文本的 token 数。返回未取整的浮点和；需要整数口径时由调用方
 * `Math.ceil`（见 budget.ts 的 summarizeOutput，保守方向）。
 * @param text 任意文本；空串返回 0
 * @example estimateTokens('') === 0
 * @example estimateTokens('brave') === 1
 */
export function estimateTokens(_text: string): number {
  throw new Error('not implemented');
}
