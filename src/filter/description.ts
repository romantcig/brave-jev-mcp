/**
 * 注册工具时读取仓库外描述覆盖文件；仅覆盖主描述，参数描述由宿主定义。
 * 未配置、读取失败或内容不合法时回落到仓库内的通用英文描述。
 */

import { readFileSync } from 'node:fs';

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
 * 解析工具描述：未配置路径 → fallback；文件读不到、内容为空或超长 → fallback（并
 * 提示一次）；否则返回文件内容（去首尾空白）。
 * @param fallback 仓库内的通用英文描述
 * @param filePath 配置里的覆盖文件路径；未配置传 undefined
 * @returns 非空字符串；未配置路径时逐字等于 fallback
 */
export function resolveToolDescription(fallback: string, filePath?: string): string {
  const path = filePath?.trim();
  if (!path) return fallback;

  try {
    const content = readFileSync(path, 'utf8');

    if (content.length > MAX_DESCRIPTION_LENGTH) {
      warnOnce(
        `Tool description file '${path}' exceeds ${MAX_DESCRIPTION_LENGTH} characters; using the built-in description.`
      );
      return fallback;
    }

    const text = content.trim();
    if (text.length === 0) {
      warnOnce(`Tool description file '${path}' is empty; using the built-in description.`);
      return fallback;
    }

    return text;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    warnOnce(
      `Unable to read tool description file '${path}': ${reason}; using the built-in description.`
    );
    return fallback;
  }
}
