/**
 * 结构性农场黑名单：模板字符串常量 + 解析器。
 *
 * 只收"结构上就是农场"的站（GitHub issue 镜像、SO 镜像、纯聚合站）；混合平台
 * （note.com、Medium、Substack 之类）**永不入列**——判据是页面粒度，不是域名
 * （PLAN §5）。初始表为空（RESEARCH A14）：入库夹具里没有结构农场，正例靠注入
 * 测试；测试模式期间由 EXT-03 的候选脚本提示、老大手工加入。条目匹配自身与全部子域。
 *
 * 数据表必须是 `.ts` 常量：`tsc` 不拷贝非 `.ts` 资产进 `dist/`；模板字符串满足
 * "文件一行一个 host、`#` 注释"的形式。仓库外黑名单文件的路径由配置文件的
 * `blocklist_file` 给出（EMBED-05；02-FIX 批 B 起环境变量只剩 key 与配置路径两个）。
 * 依据：notes/local-rules-design.md §5、01-RESEARCH.md「规则 4（步 4）」。
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
 * 解析黑名单文本：按行 split，跳过 `#` 注释行与空行，条目去首尾空白、小写、
 * 去 `www.` 前缀后收进 Set。无效行静默丢弃（形态照 rebinding.ts 的 toNormalizedSet）。
 * @returns 规范 host 的集合（新对象）
 * @example parseBlocklist('# c\nWWW.Farm.EXAMPLE\n\n') → Set {'farm.example'}
 */
export function parseBlocklist(text: string): Set<string> {
  const entries = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;

    entries.add(trimmed.toLowerCase().replace(/^www\./, ''));
  }
  return entries;
}

/** 默认黑名单：初始为空集（只有注释与格式示例）。 */
export const DEFAULT_BLOCKLIST: ReadonlySet<string> = parseBlocklist(DEFAULT_BLOCKLIST_TEXT);
