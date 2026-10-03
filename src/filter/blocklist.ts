/**
 * 结构性农场黑名单与解析器。整站条目只用于结构性农场，混合平台应限定页面或栏目。
 * 内置数据使用 TS 常量随构建发布，外部列表由配置的 blocklist_file 指定。
 */

/**
 * 默认黑名单文本：一行一个规范 host（小写、可带 `www.` 由解析器剥掉），
 * `#` 起始为注释。**老大手工维护**；加入新条目前先确认它是结构性农场。
 */
export const DEFAULT_BLOCKLIST_TEXT = `
# Structural content farms only: GitHub issue mirrors, Stack Overflow mirrors,
# pure aggregation sites. Mixed platforms (note.com, Medium, Substack, ...) are
# never listed here. One canonical host per line, '#' starts a comment.
# 格式示例：
# example-farm.example
`;

/**
 * 解析每行 host 或 HTTP(S) 页面/栏目 URL；跳过空行、注释及不支持的 URL。
 * 主机转小写并去 www.；URL 路径保留大小写和末尾斜杠的范围含义。
 */
export function parseBlocklist(text: string): Set<string> {
  const entries = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;

    // 完整 URL 是页面/栏目规则；末尾斜杠代表该路径下的栏目，路径保留大小写。
    if (/^https?:\/\//i.test(trimmed)) {
      try {
        const url = new URL(trimmed);
        if (url.username || url.password || url.search || url.hash || url.port) continue;
        url.hostname = url.hostname.toLowerCase().replace(/^www\./, '');
        entries.add(url.href);
      } catch {
        // 错误条目不能扩大屏蔽范围。
      }
      continue;
    }
    entries.add(trimmed.toLowerCase().replace(/^www\./, ''));
  }
  return entries;
}

/** 默认黑名单：初始为空集（只有注释与格式示例）。 */
export const DEFAULT_BLOCKLIST: ReadonlySet<string> = parseBlocklist(DEFAULT_BLOCKLIST_TEXT);
