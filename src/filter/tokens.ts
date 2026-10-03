/**
 * 无分词器的 token 近似估算，供输出统计、输出预算和本地实验费用预留共用。
 * 该值不是实际用量，生产 Jev 请求不据此预检输入限额。
 */

/** 其余字符（标点、CJK 等）每个的 token 权重。可按测试模式实测调整。 */
export const TOKEN_WEIGHT_OTHER = 0.9;

/** 数字每位的 token 权重。可按测试模式实测调整。 */
export const TOKEN_WEIGHT_DIGIT = 0.5;

/** 每满这么多字母加 1 个 token（单词本身已有 1 个）。可按测试模式实测调整。 */
export const TOKEN_LATIN_PER_EXTRA_CHARS = 6;

/**
 * Latin 词段计 1 + floor(字母数 / 6)，数字每位 0.5，其余非空白字符每个 0.9。
 * 空白不进入此估算；实际用量以服务端回报为准。
 */
const TOKEN_SEGMENT_PATTERN = /[A-Za-z]+|[0-9]+|[^A-Za-z0-9\s]+/g;

/** 返回未取整估算和，空串为 0；需要整数时由调用方统一向上取整。 */
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
      // 其余任何符号（含每个 CJK 字符）0.9（notes/jev-api.md；测试模式用中文样本再校）
      total += segment.length * TOKEN_WEIGHT_OTHER;
    }
  }
  return total;
}
