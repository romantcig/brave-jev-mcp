/**
 * 结构性农场黑名单：模板字符串常量 + 解析器。
 *
 * 【RED 桩】先落签名：parseBlocklist 抛 "not implemented"、DEFAULT_BLOCKLIST 给空集，
 * 让 blocklist.test.ts 能加载并在断言处失败，GREEN 提交再填实。
 *
 * 只收"结构上就是农场"的站（GitHub issue 镜像、SO 镜像、纯聚合站）；混合平台
 * （note.com、Medium、Substack 之类）**永不入列**。初始表为空（RESEARCH A14），
 * 影子期由 EXT-03 的候选脚本提示、老大手工加入。
 * 依据：notes/local-rules-design.md §5、01-RESEARCH.md「规则 4（步 4）」。
 */

export const DEFAULT_BLOCKLIST_TEXT = '';

export function parseBlocklist(_text: string): Set<string> {
  throw new Error('parseBlocklist: not implemented (RED stub)');
}

export const DEFAULT_BLOCKLIST: ReadonlySet<string> = new Set<string>();
