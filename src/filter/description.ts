/**
 * 工具描述的仓库外覆盖文件。
 *
 * 仓库里只放通用英文描述（PLAN.md §3.5「发布约束」）；个人化中文描述放在仓库外，
 * 由环境变量 `JEV_FILTER_TOOL_DESCRIPTION_FILE` 指向一个 UTF-8 纯文本文件。
 * 只覆盖工具主描述，不覆盖参数描述——参数描述被方言补丁在导入时固定，见
 * 01-RESEARCH.md「嵌入点」一节。
 *
 * 读取在 `register()` 调用时发生（不在导入时），测试才能在 `before` 里删掉变量隔离。
 * 一切失败都 fail-open 回落 fallback：描述缺失或错误绝不能让服务器起不来。
 */

import { readFileSync } from 'node:fs';

export const TOOL_DESCRIPTION_FILE_ENV = 'JEV_FILTER_TOOL_DESCRIPTION_FILE';

/** 覆盖文件的长度上限（UTF-16 码元数，与库内其余长度判定同一尺度）。 */
const MAX_DESCRIPTION_LENGTH = 8 * 1024;

// 库里唯一允许的模块级可变状态：只提示一次，避免每次 register() 都刷 stderr。
let warned = false;

// 只能用 console.error：stdout 是 stdio 传输的协议通道，绝不能写。
const warnOnce = (message: string): void => {
  if (warned) return;
  warned = true;
  console.error(`[jev-filter] ${message}`);
};

/**
 * 解析工具描述：变量未设 → fallback；文件读不到、内容为空或超长 → fallback（并提示一次）；
 * 否则返回文件内容（去首尾空白）。
 * @param fallback 仓库内的通用英文描述
 * @param env 环境变量映射，默认 `process.env`
 * @returns 非空字符串；未设变量时逐字等于 fallback
 */
export function resolveToolDescription(
  fallback: string,
  env: Record<string, string | undefined> = process.env
): string {
  const filePath = env[TOOL_DESCRIPTION_FILE_ENV]?.trim();
  if (!filePath) return fallback;

  try {
    const content = readFileSync(filePath, 'utf8');

    if (content.length > MAX_DESCRIPTION_LENGTH) {
      warnOnce(
        `Tool description file '${filePath}' exceeds ${MAX_DESCRIPTION_LENGTH} characters; using the built-in description.`
      );
      return fallback;
    }

    const text = content.trim();
    if (text.length === 0) {
      warnOnce(`Tool description file '${filePath}' is empty; using the built-in description.`);
      return fallback;
    }

    return text;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    warnOnce(
      `Unable to read tool description file '${filePath}': ${reason}; using the built-in description.`
    );
    return fallback;
  }
}
