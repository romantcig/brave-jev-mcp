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
 * 连续同类字符切分：Latin 词段 → 1 + ⌊字母数 / 6⌋；数字段 → 每位 0.5；
 * 其余非空白段 → 每字符 0.9。空白不属于任何段，自然不计费——词间空白不是
 * 模型要读的内容；不排除时 default 夹具会估出约 12.6k 而误触发裁剪（排除后
 * 约 8.5k，与实测量级一致）。全局 flag 供 matchAll 使用。
 */
const TOKEN_SEGMENT_PATTERN = /[A-Za-z]+|[0-9]+|[^A-Za-z0-9\s]+/g;

/**
 * 估算一段文本的 token 数。返回未取整的浮点和；需要整数口径时由调用方
 * `Math.ceil`（见 budget.ts 的 summarizeOutput，保守方向）。
 * @param text 任意文本；空串返回 0
 * @example estimateTokens('') === 0
 * @example estimateTokens('brave') === 1
 */
export function estimateTokens(text: string): number {
  let total = 0;
  for (const match of text.matchAll(TOKEN_SEGMENT_PATTERN)) {
    const segment = match[0];
    const first = segment[0];
    if ((first >= 'a' && first <= 'z') || (first >= 'A' && first <= 'Z')) {
      // 英文单词 1 token，每满 6 个字母再加 1（notes/jev-api.md）
      total += 1 + Math.floor(segment.length / TOKEN_LATIN_PER_EXTRA_CHARS);
    } else if (first >= '0' && first <= '9') {
      // 数字每位 0.5（notes/jev-api.md）
      total += segment.length * TOKEN_WEIGHT_DIGIT;
    } else {
      // 其余任何符号（含每个 CJK 字符）0.9（notes/jev-api.md；影子期用中文样本再校）
      total += segment.length * TOKEN_WEIGHT_OTHER;
    }
  }
  return total;
}
