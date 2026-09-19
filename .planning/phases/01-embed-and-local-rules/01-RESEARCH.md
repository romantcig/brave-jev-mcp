# Phase 1: Embed and Local Rules - Research

**Researched:** 2026-09-20
**Domain:** MCP 工具返回后处理 / 纯 TypeScript 过滤库嵌入 / zod 4 白名单声明 / node:test 夹具驱动测试
**Confidence:** HIGH（嵌入点、夹具形状、SDK 与 zod 行为全部在本会话读源码并用本机探针验证；本地规则的精确化部分为 MEDIUM，见 Assumptions Log）

> 公开文件约束：本文入库。全文不含任何 Jev 准确率、概率、延迟、成本数字（MCA 2.3(f)）；不含 key 值、代理地址、仓库外个人路径，只出现环境变量**名**。引用夹具原文时用随机分隔符包裹，且只选不含厂商性能数字的句子。

## Summary

Phase 1 要做的事只有一个函数和一个新目录：把 `src/tools/llm_context/index.ts` 的 `execute()` 在 zod 校验之后、返回之前接到一个不含 MCP 类型的纯库 `src/filter/`；把工具声明改成补丁脚本那套白名单参数加必填 `intent`；去掉 `outputSchema` 与 `structuredContent`。本地规则层（管道第 1、2、3、4、8、9 步）全部在纯库里实现，`off` 模式下第 5 步不存在、第 6 步无事可做、第 7 步只跑 5-gram 逐字去重。

本会话确认的关键事实：上游 `src/` 与基线 `a75d7ef`（`git merge-base jev upstream/main`）完全相同，`npm run format:check`、`npm run build`、`npm test`（78 个测试）在本机全部通过；MCP SDK 1.30.0 在没有 `outputSchema` 时对 `structuredContent` 完全不校验（服务端与客户端两侧都验证过）；zod 4.3.6 的 `z.object` 默认剥离未知键，所以 `intent` 只要不进 `RequestParamsSchema` 就绝不会转发给 Brave；`.pick()` 加 `.describe()` 能在不改上游 `RequestParamsSchema` 的前提下生成白名单声明，`tools/list` 里 `required` 恰为 `["query","intent"]`。

夹具侧最重要的发现：十份已入库夹具（两份 Jev 发布、六份 Sanity、两份 noise）里没有一对页内片段的 5-gram Jaccard 超过 0.8，笔记里"标题加导语被抽两次"的重复在真实数据里表现为**包含**（短片段几乎整段出现在长片段里），不是高 Jaccard；笔记举例的 mezha 导航块在入库夹具里因为含有文章自己的标题而**不会**被"短且无实词"规则命中；付费墙标记、feed URL、黑名单 host、URL 归并在入库夹具里全部没有正例。所以 RULES-09 的期望文件必须同时覆盖"真实夹具上规则不触发"的断言和用内联合成样本覆盖的正例。

**Primary recommendation:** 按 PLAN §3.1 原地改 `src/tools/llm_context/index.ts` 与 `schemas/input.ts`（外加同目录的 `index.test.ts` 作为这两处改动的测试伴随文件），其余全部放 `src/filter/`；环境变量在 `src/filter/config.ts` 的纯函数 `parseFilterConfig(env)` 里读，由 `execute()` 适配行在调用时传入 `process.env`，不碰 `src/config.ts`。

<user_constraints>
## User Constraints (from PLAN.md — 本阶段无 CONTEXT.md，按编排者指示以 PLAN §3 为架构契约、§5 为锁定决策)

### Locked Decisions

PLAN.md §3.1（对上游的三处改动，逐字）：

1. `execute()` 在 zod 校验之后、返回之前，调用过滤库。过滤库是**不含任何 MCP 类型的纯库**：输入 Brave 响应 JSON、请求参数、intent；输出过滤后 JSON 加一个统计对象。`execute()` 只留几行适配。
2. 参数声明与工具描述在源码里改成现行补丁那套（白名单参数、推荐值），新增必填参数 **`intent`**：模型用一句英文说明想找什么；涉及带版本的产品时点名当前版本及标志性机制（`notes/staleness.md`）。
3. 不声明 outputSchema、不返回 structuredContent。

PLAN.md §3.2（管道，逐字）："顺序固定，任何一步都不重排，幸存内容保持 Brave 原序"；十步为：1 JSON-LD 解析分流 → 2 URL 规范化归并 → 3 片段预筛 → 4 feed URL 规则、结构性农场黑名单 → 5 Jev → 6 来源级裁决 → 7 片段级（低分删；指纹新颖度）→ 8 空来源、一句话来源规则 → 9 裁回预算 → 10 状态行。"`off` 模式跳过第 5 步，第 6 步无事可做，第 7 步的指纹播种按 Brave 序。"

PLAN.md §5 与本阶段直接相关的行（逐字）：

| 决策 | 结论 |
|---|---|
| 挂载点 | A2 源码嵌入；过滤层为纯库，`execute()` 只留适配 |
| 判据 | 页面粒度，不看域名和官方与否 |
| 排序 | Jev 只做门槛，幸存者保持 Brave 原序 |
| 改写稿 | 片段级事实指纹增量新颖度；指纹并集播种顺序按 is_primary 高到低，`off` 模式按 Brave 序；has_original_reasoning 高的来源片段免删 |
| 空来源 / 一句话来源 | 纯代码 |
| 非文章页（含付费墙） | URL 规则 + is_listing / paywalled 两题 + 标记截断只做片段级 |
| 元数据页 | 走片段级评分 0 档到空来源规则；漏了再加一道 noul；不进黑名单 |
| 版本过时 | 模型在 intent 点名版本；stale 与 self_deprecated 两题分开；版本号正则不做；状态行回显依据版本 |
| JSON-LD | 解析分流，不整块删 |
| Brave strict 模式 | 不默认开 |
| 超量抓取 | 默认 1×，倍数留环境变量；>1 时只放大来源数与总 token |
| 过滤后为空 | 返回空，不补回 |
| 状态行 | 一行按原因计数，不列被丢来源 |
| 黑名单 | 仅结构性农场域名，手工加入；混合平台永不入列 |
| intent 参数 | 必填，英文一句话 |
| 发布约束 | 公开文件不含 Jev 性能数字 |
| CJK | 不整体跳过；提高丢弃门槛；中文样本实测 |
| 仓库形态 | 独立"jev 版"，验证后上 GitHub |
| 文档规矩 | 单一归属；决策原地替换并记日志；过程进 history；记忆不做日志 |

其他锁定约束（`.claude/CLAUDE.md`、REQUIREMENTS.md）：对上游只动三处（EMBED-06）；`JEV_FILTER_MODE` 缺省即 `off`（EMBED-02）；sources 表只留 title / hostname / age（EMBED-04）；十步顺序固定（RULES-08）；改 `src/` 前需老大明确授权；一次只开一个智能体。

### Claude's Discretion

PLAN 与笔记没有定死、由计划阶段决定的：纯库目录名与模块拆分；公共入口签名与统计对象字段名；`JEV_FILTER_MODE` 读取入口的落点（前提是不突破三处限制）；期望文件的格式与存放位置；黑名单与标记列表的存储形式（`.txt` 无法进 `dist/`）；仓库外描述覆盖文件的机制；规则的精确化细节（分词、停用词、feed 匹配粒度、重复判定的度量）；测试文件的组织。

### Deferred Ideas (OUT OF SCOPE)

REQUIREMENTS.md v2：EXT-01 Claude Code 函数钩子适配器；EXT-02 写法 B（`context.obsolete` / `context.current`）；EXT-03 黑名单候选提示脚本；EXT-04 元数据页专用 noul。Out of Scope 表：PostToolUse hook 重写结果、继续给 npx 缓存打补丁、独立中间层 MCP 服务器、Goggles 域名规则、改 Claude Code、bx CLI/skill、域名级判据、Jev 重排、补回被丢来源、版本号正则、Jev 跨来源比较、strict 默认开、对外提供 Jev、公开 Jev 数字。不属于 Phase 1 的：Jev 客户端与裁决（Phase 2）、状态行与日志（Phase 3）、`~/.claude.json` 切换（Phase 3）、影子期（Phase 4）。
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| EMBED-01 | 过滤层是不含 MCP 类型的纯库；`execute()` 在 zod 校验后、返回前调用，只留几行适配 | §嵌入点（execute 现状与适配草图）、§纯库布局与入口签名、§纯度断言 |
| EMBED-02 | `JEV_FILTER_MODE` 缺省 off；off 只跑本地规则不调 Jev；shadow / on 同一变量 | §模式处理（`parseFilterConfig`、无 fetch 证明） |
| EMBED-03 | 白名单参数与推荐值、必填 `intent`、描述含版本点名规则 | §工具声明蓝本（补丁白名单逐字、英文描述、zod 写法、覆盖文件机制） |
| EMBED-04 | 不声明 outputSchema、不返回 structuredContent；sources 只留 title / hostname / age；stdio 形状被 Claude Code 接受 | §SDK 行为验证、§sources 精简（补丁的 first-ISO 行为）、§测试客户端 |
| EMBED-06 | 对上游只动三处；`git merge upstream/main` 后构建测试仍过 | §验证配方（merge-base diff 允许清单）、§上游在途分支冲突面 |
| RULES-01 | JSON-LD 分流 | §规则 1（键表、FAQ/QA/HowTo 转换、解析失败保留、夹具正例清单） |
| RULES-02 | URL 规范化归并 | §规则 2（Node URL 行为实测、AMP/跟踪参数表、合并语义） |
| RULES-03 | 片段预筛 | §规则 3（分词、实词集、样板行、逐字重复的度量选择） |
| RULES-04 | feed URL、黑名单 | §规则 4（token 级匹配、黑名单 `.ts` 模块） |
| RULES-05 | 空来源、一句话来源 | §规则 8（与预筛的实词集差异） |
| RULES-06 | 裁回预算、超量倍数 | §规则 9（Brave 默认值、裁法、倍数只放大 urls 与总 token） |
| RULES-07 | 付费墙标记只截断片段 | §规则 7（中英标记表、行锚定匹配、夹具无正例） |
| RULES-08 | 保持 Brave 原序 | §管道编排（索引携带、输出重建）、§测试断言 |
| RULES-09 | 每条规则对真实夹具有手工标注期望文件，逐条断言 | §夹具与期望文件策略（三种夹具形状、文件格式、逐条断言方式、gitignore 边界） |
</phase_requirements>

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| 工具声明（白名单、`intent`、描述） | MCP 工具模块 `src/tools/llm_context/` | 纯库（描述覆盖文件读取的小函数） | 声明是 MCP 契约，只能住在工具模块；覆盖文件读取不含 MCP 类型，可放库里供 `register()` 调用 |
| 输入校验 | MCP SDK（`validateToolInput`）+ 工具模块二次 `parse` | — | SDK 按注册 schema 校验后才调 `execute`；上游用两次 `parse` 拆 params / headers |
| Brave 请求 | `src/BraveAPI/index.ts` | 适配行（超量倍数放大参数） | 上游唯一出站点，不改；倍数放大是对参数对象的纯变换 |
| 响应 zod 校验 | 工具模块（上游已有） | — | 过滤层只接收校验成功的 `data` |
| 本地规则十步 | 纯库 `src/filter/` | — | 不含 MCP 类型，便于换宿主 |
| 环境变量读取 | 纯库 `src/filter/config.ts`（纯函数，调用时传入 `process.env`） | 适配行 | 不能进 `src/config.ts`（第四处改动、上游最常改的文件） |
| sources 精简 | 纯库（管道末尾输出重建） | — | 与补丁 `zcodeRespFilter` 行为一致 |
| 统计对象 | 纯库 | Phase 3 状态行 / 日志 | 状态行与日志从同一对象生成 |
| 夹具与期望文件 | `fixtures/` + `src/filter/*.test.ts` | — | 测试与源并排；夹具在仓库根 |
| MCP 往返验证 | `src/testUtils/mcpTestHarness.ts`（内存传输） | `src/protocols/stdio.test.ts`（真子进程） | 现有 harness 已能做 `tools/list` / `tools/call` |

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `@modelcontextprotocol/sdk` | 1.30.0（精确钉死） | `McpServer.registerTool`、`InMemoryTransport`、`Client` | 上游选定；`package.json:40` `[VERIFIED: package.json:39-45]` |
| `zod` | 4.3.6 | 输入声明（`pick`/`describe`）、响应校验 | 上游选定；`.pick()`、`.describe()`、`z.toJSONSchema` 本机实测 `[VERIFIED: 本会话探针]` |
| `typescript` | 5.9.3 | `tsc` 构建 | `[VERIFIED: package.json:54]` |
| `tsx` | 4.22.4 | `node --import tsx --test` 直接跑 `.ts` | `[VERIFIED: package.json:53]` |
| Node.js | 本机 25.5.0，CI 24.x | `node:test`、`node:assert/strict`、WHATWG `URL`、`fetch` | `[VERIFIED: node --version]` |
| `prettier` | 3.8.1 | `format:check` 门禁，仅 `src/**/*.ts` | `[VERIFIED: package.json:32-33]` |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `ajv` | 8.20.0（dev） | `src/server.test.ts` 校验 2020-12 schema | 已有；改声明后它自动覆盖 `brave_llm_context` 的新 inputSchema |
| `node:fs` / `node:url` | 内置 | 测试里读 `fixtures/`（`readFileSync` + `fileURLToPath(new URL(..., import.meta.url))`） | TESTING.md 规定不用 `import ... with { type: 'json' }`（`rootDir: src` 会让构建失败） |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| 手写 `canonicalizeUrl` | npm `normalize-url` | 新依赖破坏"依赖极简、精确钉版"惯例并增加合并面；WHATWG `URL` 已做 host 小写、默认端口、百分号编码，剩余十几行 |
| 手写 token 估算 | `tiktoken` 类库 | 估算只用于裁预算与 Phase 2 的 32k 保护；笔记已定无分词器公式（`notes/jev-api.md`），一份实现两处用 |
| `node:test` | vitest / jest | 上游选定 `node --test`；换框架等于第四处改动 |

**Installation:** 无新依赖。Phase 1 不执行 `npm install <pkg>`。

**Version verification:** 已在本机核对 `node_modules` 实际安装版本与 `package.json` 一致：sdk 1.30.0、zod 4.3.6、tsx 4.22.4、prettier 3.8.1、typescript 5.9.3 `[VERIFIED: node -e require(...)/package.json]`。

## Package Legitimacy Audit

Phase 1 不安装任何外部包，无需运行 legitimacy 检查。

| Package | Registry | Age | Downloads | Source Repo | Verdict | Disposition |
|---------|----------|-----|-----------|-------------|---------|-------------|
| （无新增） | — | — | — | — | — | — |

**Packages removed due to [SLOP] verdict:** none
**Packages flagged as suspicious [SUS]:** none

## 嵌入点：上游现状（问题 1）

### `execute()` 现在长什么样

`[VERIFIED: src/tools/llm_context/index.ts:33-46]`，逐字：

```ts
export const execute = async (params: QueryParams) => {
  const parsedParams = RequestParamsSchema.parse(params);
  const parsedHeaders = RequestHeadersSchema.parse(params);

  const response = await API.issueRequest<'llmContext'>('llmContext', parsedParams, parsedHeaders);
  const { success, data, error } = LlmContextSearchApiResponseSchema.safeParse(response);
  const payload = success ? data : z.treeifyError(error);

  return {
    content: [{ type: 'text', text: JSON.stringify(payload) } as TextContent],
    isError: !success,
    structuredContent: payload,
  };
};
```

- `params` 的类型 `QueryParams` 是 `LlmContextInput = z.input<typeof LlmContextInputSchema>`（`schemas/input.ts:282`），即 SDK 已按注册的 `inputSchema` 校验过的扁平参数对象（query 参数与 `x-loc-*` 等头混在一起）。
- 两次 `parse` 的作用是**拆分**：`z.object` 默认剥离未知键，所以 `RequestParamsSchema.parse` 只剩查询参数，`RequestHeadersSchema.parse` 只剩头。本机探针：`RequestParamsSchema.parse({query,intent,count,'x-loc-city'})` 只保留 `query, count`；`RequestHeadersSchema.parse(...)` 只保留 `x-loc-city` `[VERIFIED: 本会话探针，zod 4.3.6]`。**结论：`intent` 只要不加进 `RequestParamsSchema`，就不会以 `?intent=` 转发给 Brave。**
- 校验成功时 `data` 的类型是 `LlmContextSearchApiResponse`（`schemas/output.ts:84`）；失败时 `payload` 是 `z.treeifyError(error)`，`isError: true`。
- 过滤层的**唯一插入点**是 `safeParse` 之后、`return` 之前，只在 `success` 分支运行。

### 注册与 outputSchema 声明位置

`[VERIFIED: src/tools/llm_context/index.ts:48-70]`，逐字：

```ts
export const register = (mcpServer: McpServer) => {
  mcpServer.registerTool(
    name,
    {
      title: name,
      description: description,
      inputSchema: LlmContextInputSchema,
      outputSchema: LlmContextSearchApiResponseSchema,
      annotations: annotations,
    },
    execute
  );
};

export default {
  name,
  description,
  annotations,
  inputSchema: LlmContextInputSchema.shape,
  outputSchema: LlmContextSearchApiResponseSchema.shape,
  execute,
  register,
};
```

两处都要去掉 `outputSchema`（`register` 的一行、默认导出的一行）。默认导出的 `.shape` 被 `src/jsonSchemaDialect.ts:21-23` 在导入时收进 `schemaShapesByTool`，并在每次 `tools/list` 用 `z.toJSONSchema(z.object(shape), { target: 'draft-2020-12', io })` 重发（`:25-29`, `:71-77`）`[VERIFIED: src/jsonSchemaDialect.ts:21-29,63-81]`。这带来一个硬约束：**tools/list 里最终看到的参数描述来自默认导出 `inputSchema: LlmContextInputSchema.shape` 在导入时的内容**，注册时传给 SDK 的 schema 若与它不同，会被方言补丁用 `.shape` 重生成的版本覆盖。所以白名单与描述文本必须在 `schemas/input.ts` 构建 schema 时就定下，不能延迟到 `register()`。

### 登记链

- `src/tools/index.ts:7,17`：`import LlmContextTool from './llm_context/index.js'` 并放进默认导出对象 `[VERIFIED: src/tools/index.ts:1-19]`。**不需要改。**
- `src/server.ts:23-27`：`for (const tool of Object.values(tools)) { if (!isToolPermittedByUser(tool.name)) continue; tool.register(mcpServer); }` 然后 `enforce2020Dialect(mcpServer)` `[VERIFIED: src/server.ts:23-30]`。**不需要改。**
- `src/config.ts`：读 `BRAVE_*` 环境变量，`dotenv.config()` 在导入时执行（`:7`）`[VERIFIED: src/config.ts:7]`。**不需要改，也不应改**（上游最常改的文件；CONCERNS.md 记录 14 次上游提交）。
- `src/BraveAPI/index.ts:13` `llmContext: '/res/v1/llm/context'`；`:103-105` 把 `query` 改名为 `q`，其余参数 `toString()` 后放进 query string；`:116` 原生 `fetch(urlWithParams, { headers })` `[VERIFIED: src/BraveAPI/index.ts:5-15,103-116]`。测试桩按 pathname 匹配这个路径。
- `src/BraveAPI/types.ts:60-64` `llmContext: { params: LlmQueryParams; response: LlmContextSearchApiResponse; requestHeaders: LlmRequestHeaders }`，类型只从 `schemas/input.ts` 与 `schemas/output.ts` 引 `[VERIFIED: src/BraveAPI/types.ts:16-17,60-64]`。只要不改 `RequestParamsSchema` / `RequestHeadersSchema` 的导出名与形状，这里不受影响。

### SDK 1.30.0 对 outputSchema / structuredContent 的真实行为

服务端 `[VERIFIED: node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js:185-207]`，逐字节选：

```js
async validateToolOutput(tool, result, toolName) {
    if (!tool.outputSchema) {
        return;
    }
    // ...
    if (result.isError) {
        return;
    }
    if (!result.structuredContent) {
        throw new McpError(ErrorCode.InvalidParams, `Output validation error: Tool ${toolName} has an output schema but no structured content was provided`);
    }
```

`tools/list` 只在 `tool.outputSchema` 存在时才发 `outputSchema`（`:88-96`）。客户端 `[VERIFIED: node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js:485-491]`：`const validator = this.getToolOutputValidator(params.name); if (validator) { if (!result.structuredContent && !result.isError) throw ... }`，validator 只在 `tools/list` 带 `outputSchema` 时创建（`:533-536`）。本会话用 SDK 直接建了一个不带 `outputSchema` 的工具并经 `InMemoryTransport` 往返：`tools/list` 无 `outputSchema` 字段，`tools/call` 返回 `{content:[...], isError:false}` 被客户端原样接受，多余入参 `extra: 1` 被剥离，缺 `intent` 时返回 `isError: true` 且文本为 `MCP error -32602: Input validation error: Invalid arguments for tool ...: Invalid input: expected string, received undefined at intent` `[VERIFIED: 本会话探针]`。Context7 官方文档同样说明 `outputSchema` 可选、仅声明时校验 `structuredContent` `[CITED: github.com/modelcontextprotocol/typescript-sdk docs/servers/tools.md]`。

结论：两者一起去掉后，成功与错误两条返回路径都只需 `{ content, isError }`。

### 适配草图（触点 1，尽量少行）

```ts
// src/tools/llm_context/index.ts —— 只改 execute 体内两行加一个 import
import { filterLlmContext } from '../../filter/index.js';
// ...
  const { success, data, error } = LlmContextSearchApiResponseSchema.safeParse(response);
  const payload = success
    ? filterLlmContext(data, { params: parsedParams, intent: params.intent }).result
    : z.treeifyError(error);

  return {
    content: [{ type: 'text', text: JSON.stringify(payload) } as TextContent],
    isError: !success,
  };
```

- Phase 3 加状态行时只需再取 `stats`，仍在同一处。
- 超量倍数 >1 时需要在 `issueRequest` 之前放大参数：`const braveParams = applyOverfetch(parsedParams, config)`（库导出的纯函数，倍数 1 时恒等）。这是同一触点内的一行；`config` 由 `parseFilterConfig(process.env)` 得到，同样是库函数。
- 上游 `execute` 的 import 块结尾处追加一行 import，把冲突面压到最小。

## Brave LLM Context 响应形状（问题 2）

### 三种夹具形状（加载器必须都认）

| 形状 | 文件 | 顶层 | 备注 |
|---|---|---|---|
| wrapped | `fixtures/jev_release_default.json`、`fixtures/jev_release_strict.json` | `{ request, fetched_at, latency_s, response }` | `request` 含 `q, count, maximum_number_of_urls, maximum_number_of_tokens, maximum_number_of_tokens_per_url, freshness`（strict 版多 `context_threshold_mode`）；`response` 为下面的 bare 形状 `[VERIFIED: fixtures/jev_release_default.json:2-12]` |
| bare | `fixtures/sanity/sample1..6_*.json` | `{ grounding: { generic, map }, sources }` | 无 query 记录；query / intent 需在期望文件里手工补 |
| noise | `fixtures/noise/*.txt` | `{ generic: {url,title,snippets}, source: { "<url>": {...} } }` | **`generic` 是单个对象不是数组，键名是 `source` 单数** `[VERIFIED: fixtures/noise/apple_podcasts_metadata.txt:2,11]`；加载器需包成 `{grounding:{generic:[x],map:[]},sources:source}` |

`latency_s` 是 Brave 请求延迟，与 Jev 无关，但期望文件与测试输出都不需要它。

### `response` 的字段（与 `schemas/output.ts` 对照）

`[VERIFIED: src/tools/llm_context/schemas/output.ts:43-82]`：`grounding.generic[]` 每项 `{ url: z.url(), title: z.string(), snippets: z.array(z.string()) }`（严格对象，未知键剥离）；`grounding.poi` 可空可省；`grounding.map[]`；`sources: z.record(z.url(), SourceMetadataSchema)`，`SourceMetadataSchema` 为 `.loose()`，已声明 `title?`, `hostname?`, `age?: string[]`, `site_name?`, `favicon?`, `thumbnail?`（`:14-41`）。`SnippetsSchema` 的描述原文即说明片段"可混有纯文本、markdown 与 JSON 序列化的结构化数据" `[VERIFIED: src/tools/llm_context/schemas/output.ts:8-12]`。

真实夹具里实际出现的字段（本会话遍历十份夹具统计）：

- `generic[]`：只有 `url, title, snippets`；十份夹具里 `map` 全为 `[]`，`poi` 全部缺席。
- `sources[url]`：`title, hostname, age, snippet` 四个键；**`snippet` 是 Brave 给的摘要，与正文重复，输出精简时删掉它是最大的节省**；`age` 是 4 元数组，形如 `DATA_q8Ws2Lmv_START ["Wednesday, September 16, 2026", "2026-09-16", "2 days ago", "2026-09-16T01:35:16Z"] DATA_q8Ws2Lmv_END` `[VERIFIED: fixtures/jev_release_default.json:166-177]`；Sanity 夹具里有的来源 `age: []`（sample1 的 github PR、`.md` 文档页等 4 处）`[VERIFIED: 本会话遍历]`。
- `generic` 与 `sources` 在所有夹具里一一对应（个数相等、URL 全部互见）。
- 数量：default 12 源 76 片段约 30.9k 字符，5 个 JSON 片段（全部可 `JSON.parse`）；strict 12 源 41 片段约 18.0k 字符，4 个 JSON 片段；sample3 有 1 个 JSON 片段（问答页）；apple podcasts 有 1 个（媒体元数据）；其余 Sanity 与 substack 样本没有 JSON 片段。
- JSON-LD 片段的顶层键（去重后全集）：`articleSection, author, citation, dateModified, datePublished, editor, headline, inLanguage, isAccessibleForFree, item, keywords, mainEntity, name, publisher`（Jev 两份），`answerCount, dateCreated, dateModified, name, suggestedAnswer`（sample3），`datePublished, duration, genre, name, offers, partOfSeries, productionCompany`（podcast）。**没有一个片段带 `@context` / `@type`**——Brave 抽取时已剥掉，所以不能靠 `@type` 判 FAQPage，只能靠 `mainEntity[].acceptedAnswer` 这种结构特征。
- 入库夹具里 URL 全部无 `?`、无 `#`、无 AMP 标记、无跟踪参数、无同规范 URL 的重复来源、无 feed 形态 URL；中文片段为 0（笔记提到的 winzheng 中文改写页不在入库夹具里，rubric 里的 12 源与入库夹具差一个：rubric 有 winzheng.com 无 ua.news，夹具反之）`[VERIFIED: 本会话遍历]`。

### 精简后的 sources 形状（EMBED-04）

补丁脚本 `zcodeRespFilter` 的行为（蓝本）：每个来源只留 `title`（若为字符串）、`hostname`（若为字符串）、`age: [首个匹配 `^\d{4}-\d{2}-\d{2}` 的元素]`（没有匹配则省略 `age` 键）；非对象条目跳过；任何异常 fail-open 原样返回 `[VERIFIED: 现行补丁脚本 FILTER_FN_SOURCE 与 _selftest_fixtures]`。对上面的 4 元 `age`，取到的是索引 1 的 `2026-09-16`，**不是字面上的 `age[0]`**（索引 0 是人类可读日期）。REQUIREMENTS 里的 "age[0]" 应按"只留一个 age 元素、取首个 ISO 日期"理解，见 Assumptions A2。

## 纯库布局、入口签名与统计对象（问题 3）

### 目录：`src/filter/`

STRUCTURE.md 建议 `src/filter/` 或 `src/jev/`；选 `src/filter/`，Phase 2 的 Jev 客户端放 `src/filter/jev/`，"filter" 才是这层的本体。所有文件 `.ts`，测试并排。`tsc` 不拷贝非 `.ts` 资产 `[VERIFIED: tsconfig.json include src/**/*，无 assets 配置]`，所以黑名单与标记表都是 `.ts` 模块。

```
src/filter/
├── index.ts              # 唯一公共入口：filterLlmContext()、applyOverfetch()、parseFilterConfig() 的 re-export
├── types.ts              # BraveLlmContextResponse（结构类型，不从 tools/ 引）、FilterRequest、FilterConfig、FilterResult、FilterStats、原因枚举
├── config.ts             # parseFilterConfig(env): 读 JEV_FILTER_MODE、超量倍数；坏值回落默认值
├── pipeline.ts           # 十步编排；持有"工作表"（每源每片段带原始索引与裁决）；off/shadow/on 在 Phase 1 走同一路径
├── jsonld.ts             # 步 1：detect + parse + 分流
├── url.ts                # 步 2：canonicalizeUrl()、mergeByCanonicalUrl()
├── tokenize.ts           # 中英分词、CJK 字符二元、停用词、contentTerms(query, intent)、5-gram shingles
├── prefilter.ts          # 步 3：短且无实词、样板行、页内逐字重复
├── nonArticle.ts         # 步 4：isFeedUrl()、blocklist 匹配；步 8：空来源 / 一句话来源；付费墙截断（标记列表在 markers.ts）
├── blocklist.ts          # 常量：一行一个规范 host 的模板字符串 + parseBlocklist()
├── markers.ts            # 常量：付费墙标记（中英）、样板行前缀
├── budget.ts             # 步 9：按 Brave 序取前 N、从最后来源砍片段；applyOverfetch()
├── tokens.ts             # 无分词器 token 估算（Phase 2 的 32k 保护复用同一函数）
├── stats.ts              # 统计对象的构造与计数
└── *.test.ts             # 每个模块一份；另有 pipeline.fixtures.test.ts 驱动期望文件
```

### 公共入口签名

```ts
export type FilterRequest = {
  query: string;                       // parsedParams.query（已 trim）
  intent: string;                      // 原始 params.intent
  maximum_number_of_urls?: number;     // 模型要的上限；缺省按 Brave 默认 20
  maximum_number_of_tokens?: number;   // 缺省按 Brave 默认 8192
  maximum_number_of_tokens_per_url?: number;
};
export type FilterMode = 'off' | 'shadow' | 'on';
export type FilterConfig = { mode: FilterMode; overfetchFactor: number; blocklist: ReadonlySet<string> };

export function parseFilterConfig(env: Record<string, string | undefined>): FilterConfig;
export function applyOverfetch<T extends { maximum_number_of_urls?: number; maximum_number_of_tokens?: number }>(params: T, config: FilterConfig): T;
export function filterLlmContext(
  data: BraveLlmContextResponse,
  request: { params: FilterRequest; intent: string },
  config?: FilterConfig,           // 省略时 = parseFilterConfig(process.env)，在调用时读，不在导入时读
  deps?: { classify?: unknown }    // Phase 2 注入 Jev 客户端；Phase 1 无
): { result: BraveLlmContextResponse; stats: FilterStats };
```

- `data` 的类型 `BraveLlmContextResponse` 在 `types.ts` 里**按结构重新声明**（`generic[]` 三字段、`sources` 为 `Record<string, { title?: string; hostname?: string; age?: string[]; [k: string]: unknown }>`、`map`/`poi` 透传为 `unknown`），不从 `src/tools/llm_context/schemas/output.ts` 引类型——zod 推导出的 `data` 结构兼容即可赋值，库不依赖宿主目录。
- `result` 与输入同形：`grounding.generic` 只含幸存来源、按 Brave 原序；`sources` 只含幸存 URL 且每条精简为 `{title?, hostname?, age?: [iso]}`；`map` / `poi` 原样透传。过滤后为空就是 `generic: []`、`sources: {}`，`isError` 仍为 false。
- 默认值 20 / 8192 来自 Brave 文档 `[CITED: notes/brave-llm-context.md 参数表，源 api-dashboard.search.brave.com/documentation/services/llm-context]`。

### 统计对象（Phase 3 状态行与日志的共同来源）

`notes/shadow-mode-logging.md` 已定日志记录含 `request / brave / local / jev / output / shadow_diff`，`local` 含 `jsonld_converted, jsonld_dropped, url_merged, snippets_prefiltered, dup_removed, novelty, blocklist_hits`；状态行按原因计数（改写 / 旧版 / 列表 / 付费墙 / 空 / 模板 / 无关 / 黑名单 / Jev 未判定）。Phase 1 必须已经产出下面的形状，Phase 2/3 只填空位：

```ts
export type SourceDropReason =
  | 'feed' | 'blocklist' | 'empty' | 'budget' | 'merged'          // Phase 1 可产生
  | 'off_topic' | 'listing' | 'self_deprecated' | 'stale' | 'filler' | 'rewrite'; // Phase 2
export type SnippetRemovalReason =
  | 'jsonld_meta' | 'nav' | 'boilerplate' | 'dup' | 'paywall_empty' | 'budget' // Phase 1
  | 'score' | 'novelty';                                                     // Phase 2

export type FilterStats = {
  mode: FilterMode;
  request: { query: string; intent: string; max_urls: number; max_tokens: number; per_url_tokens?: number; overfetch_factor: number };
  brave: { n_sources: number; n_snippets: number; chars: number };
  local: {
    jsonld_converted: number; jsonld_dropped: number; jsonld_kept_raw: number;
    url_merged: number; snippets_prefiltered: number; dup_removed: number;
    paywall_truncated: number; feed_hits: number; blocklist_hits: number;
    empty_dropped: number; budget_dropped_sources: number; budget_trimmed_snippets: number;
  };
  sources: Array<{
    index: number; url: string; canonical_url: string; hostname?: string;
    verdict: 'keep' | 'drop'; reason?: SourceDropReason;
    snippets: Array<{ index: number; part?: number; kept: boolean; reason?: SnippetRemovalReason; truncated?: boolean; chars: number }>;
  }>;
  jev: null;          // Phase 2 填 { n_requests, ... per_source }
  output: { n_sources: number; n_snippets: number; chars: number; est_tokens: number; status_line?: string };
  shadow_diff: null;  // Phase 2 填 { would_drop, would_remove_snippets }
};
```

- `sources[]` 与 `snippets[]` 按 Brave 原序、带原始索引；JSON-LD 转出的多段用 `part` 区分（同一 `index` 下 `part: 0..k`）。RULES-09 的逐条断言、Phase 3 的按原因计数、Phase 4 的离线复现都靠这张表。
- 状态行原因名与 PLAN 中文类别的对应：rewrite=改写、stale=旧版、listing=列表、paywall=付费墙、empty=空、filler=模板、off_topic=无关、blocklist=黑名单、jev_undetermined=Jev 未判定；Phase 1 另有 feed、budget、merged。
- 日志隐私（LOG-03）：`stats` 不含片段正文，只含字符数与索引；Phase 3 直接序列化即可。

### 纯度断言（"库代码不引用任何 MCP 类型"）

两道保险，一道在测试里，一道在验证配方里：

```ts
// src/filter/purity.test.ts
const files = readdirSync(dir, { recursive: true }).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
for (const f of files) {
  const src = readFileSync(join(dir, f), 'utf8');
  assert.doesNotMatch(src, /@modelcontextprotocol/, `${f} imports the MCP SDK`);
  assert.doesNotMatch(src, /from '\.\.\/(tools|config|server|BraveAPI|protocols|jsonSchemaDialect)/, `${f} imports a host module`);
}
```

```bash
grep -rl "@modelcontextprotocol" src/filter && echo "FAIL: MCP import in library" || echo "OK: library has no MCP import"
```

## 工具声明蓝本（问题 4，EMBED-03 / EMBED-04）

### 现行补丁脚本的白名单（逐字）

补丁脚本 v4（位置见 `notes/private-local-env.md`，本文不写路径）对编译产物做四处替换：M1 把 `LlmContextInputSchema` 改成 `RequestParamsSchema.pick({...}).shape` 加逐字段 `.describe()`；P3 整段替换 `description`；P1 `return` 块去 `structuredContent`；P2 去 `register` 里的 `outputSchema` 行（默认导出的 `.shape` 不动）。`[VERIFIED: 现行补丁脚本 KEEP_PARAMS / build_input_patches / build_index_patches]`

```py
KEEP_PARAMS = [
    "query", "country", "search_lang", "count",
    "maximum_number_of_urls", "maximum_number_of_tokens",
    "maximum_number_of_tokens_per_url", "freshness", "goggles",
]
```

- 从声明里去掉的上游参数：`spellcheck`, `maximum_number_of_snippets`, `context_threshold_mode`, `maximum_number_of_snippets_per_url`, `enable_local`, `enable_source_metadata`，以及全部 `RequestHeadersSchema` 字段（`x-loc-*`, `api-version`, `accept`, `cache-control`, `user-agent`）`[VERIFIED: src/tools/llm_context/schemas/input.ts:117-275 对照 KEEP_PARAMS]`。
- `country` / `search_lang` 在**声明**里改为 `z.string().optional()` 加示例（不再向模型暴露 38 + 51 个枚举值），**请求路径不变**：`execute` 里的 `RequestParamsSchema.parse` 仍按上游枚举校验，非法代码会抛 ZodError → SDK 包成 `isError` 文本。本机探针：声明 schema 接受 `country: 'ZZ'`，`RequestParamsSchema.parse` 对同值抛 `invalid_value` `[VERIFIED: 本会话探针]`。这是补丁既有行为，沿用。
- 推荐值（补丁描述里的"常规调用建议"，逐字数值）：`count: 10`、`maximum_number_of_urls: 5`、`maximum_number_of_tokens: 4000`、`maximum_number_of_tokens_per_url: 800`（4000 ÷ 5；不设时单个来源会占满整个预算）。补丁的离线探针断言 `required` 恰为 `["query"]`；本阶段变为 `["query", "intent"]`。
- 补丁的 `PARAM_DESCRIPTIONS` 与 `NEW_DESCRIPTION` 是**个人化中文文案**。按 PLAN §3.5"仓库里只放通用英文描述"，本文不把中文全文抄进入库文档，只提炼其结构与规则；中文原文留在补丁脚本与将来的仓库外覆盖文件里。

补丁描述的结构（提炼）：① 一句话说明工具返回预抽取、按相关性排序的片段（正文、表格、代码、结构化数据），够用就直接用，需要完整上下文再读网页；② "常规调用建议显式传入"四个推荐值，并提示 `query` 支持 `site:`；③ 搜索规则六条：先摸底再核验细节、query 只放直接相关关键词、有时效要求用 `freshness` 且不在 query 写年份、默认英文并在需要时用中文关键词、连续两次结果高度重叠即换关键词、一般串行。其中"老大指最近等于一个月内"等属个人约定，只进覆盖文件。

### 在仓库里的通用英文描述（建议文本）

必含句（`notes/staleness.md` 第 13.2 节建议句，逐字，测试用正则 `/name the current version and its defining mechanism/` 断言）：

> If the query concerns a versioned product, name the current version and its defining mechanism in `intent` (e.g. "current Sanity Studio (v6, sanity.config.ts based)").

建议全文（English，`.trim()` 收尾，保持上游"四空格缩进模板字符串"惯例）：

```
Search the web with Brave and return pre-extracted, relevance-ranked content chunks
(prose, tables, code blocks, structured data). Use the returned content directly when
it answers the question; fetch the page only when you need the full context or must verify.

Required: `intent` — one English sentence stating what you want to find. If the query
concerns a versioned product, name the current version and its defining mechanism in
`intent` (e.g. "current Sanity Studio (v6, sanity.config.ts based)").

Recommended values for routine calls (`query` supports site:):
    count: 10
    maximum_number_of_urls: 5
    maximum_number_of_tokens: 4000
    maximum_number_of_tokens_per_url: 800 (= 4000 / 5; without it one source can take the whole budget)

Search rules:
    - Unfamiliar subject: first search the subject name plus the core question for an overview,
      then verify details as needed; do not search for a given detail directly — check whether
      it surfaces naturally in the sources.
    - Keep only keywords directly relevant to the current question in `query`; do not pack
      context and qualifiers into one query.
    - Set `freshness` (pd / pw / pm / py) when recency matters; never hardcode a year in `query`.
    - Two consecutive searches with heavily overlapping results mean the direction is exhausted:
      change the keyword strategy.
    - Search serially; go parallel only when confident of each query.

When relaying results, cite the source URLs from the "sources" map.
```

参数描述（English，替换补丁中文短说明）：

| 参数 | `.describe()` 文本 |
|---|---|
| `query` | Search keywords; supports site:. At most 400 characters and 50 words. |
| `intent` | One English sentence stating what you want to find; name the current version and its defining mechanism when the product is versioned. |
| `country` | Two-letter result region code, e.g. "US"; usually omitted. |
| `search_lang` | Result language code, e.g. "en" or "zh-hans"; usually omitted. |
| `count` | Number of candidate search results; 10 recommended for routine calls. |
| `maximum_number_of_urls` | Upper bound on returned sources; 5 recommended. |
| `maximum_number_of_tokens` | Approximate total token budget for returned content; 4000 recommended. |
| `maximum_number_of_tokens_per_url` | Token cap per source; 800 recommended. |
| `freshness` | Recency filter: pd = 1 day, pw = 7 days, pm = 31 days, py = 365 days, or YYYY-MM-DDtoYYYY-MM-DD. |
| `goggles` | Re-ranking rules: a Goggle URL, rule text, or an array of them. |

### zod 写法（触点 2，`schemas/input.ts:277-280` 那一块整体替换）

上游原文 `[VERIFIED: src/tools/llm_context/schemas/input.ts:277-284]`：

```ts
export const LlmContextInputSchema = z.object({
  ...RequestParamsSchema.shape,
  ...RequestHeadersSchema.shape,
});

export type LlmContextInput = z.input<typeof LlmContextInputSchema>;
```

替换为（`RequestParamsSchema`、`RequestHeadersSchema` 与三个导出类型名全部保留，`BraveAPI/types.ts` 与 `execute` 的两次 `parse` 不受影响）：

```ts
const Picked = RequestParamsSchema.pick({
  query: true, country: true, search_lang: true, count: true,
  maximum_number_of_urls: true, maximum_number_of_tokens: true,
  maximum_number_of_tokens_per_url: true, freshness: true, goggles: true,
});

export const LlmContextInputSchema = z.object({
  query: Picked.shape.query.describe('Search keywords; supports site:. At most 400 characters and 50 words.'),
  intent: z.string().trim().min(1).max(500).describe('One English sentence stating what you want to find; ...'),
  country: z.string().describe('Two-letter result region code, e.g. "US"; usually omitted.').optional(),
  search_lang: z.string().describe('Result language code, e.g. "en" or "zh-hans"; usually omitted.').optional(),
  count: Picked.shape.count.describe('Number of candidate search results; 10 recommended for routine calls.'),
  // ... 其余四个 Picked.shape.<key>.describe('...') ，freshness 与 goggles 同理
});
```

本机探针（zod 4.3.6，对已构建的 `dist/.../schemas/input.js` 跑）：`.pick()` 结果的 `.shape.<key>.describe(text)` 返回**新** schema、原字段描述不变；合成后 `z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'input' })` 给出 `required: ["query","intent"]`、`intent` 为 `{type:"string", minLength:1, maxLength:500, description}`、`count` 保留 `integer/minimum 1/maximum 50`、`io:'input'` 模式不发 `additionalProperties` `[VERIFIED: 本会话探针]`。Context7 zod 文档确认 `.pick(mask)`、`.describe()`、`z.object` 默认剥离未知键与 `io: "input"` 语义 `[CITED: github.com/colinhacks/zod packages/docs/content/api.mdx, json-schema.mdx]`。

- `intent` 上限 500 是本研究建议值（一句英文足够），`[ASSUMED]`，见 A5。
- 不用 `z.strictObject`：模型多传字段时默认剥离更稳（本会话探针 `extra: 1` 被剥离而非报错）。
- `.describe()` 后 `.optional()` 最后，沿用 CONVENTIONS。
- `.pick()` 的键必须与 `RequestParamsSchema` 现有键一致，否则 `tsc` 报错——这正好把"上游新增参数默认不暴露"变成编译期契约。

### 仓库外覆盖文件（个人化中文描述）

约束：不加第四处改动；测试不受本机覆盖影响；参数描述在导入时就固定（见"嵌入点"一节的方言补丁分析）。

推荐机制：环境变量 `JEV_FILTER_TOOL_DESCRIPTION_FILE` 指向一个 UTF-8 纯文本文件，只覆盖工具 `description`，不覆盖参数描述。

- 读取函数放库里：`src/filter/description.ts` 导出 `resolveToolDescription(fallback: string, env = process.env): string`——变量未设或文件读不到就返回 `fallback`（fail-open，可用 `console.error` 提示一次；不可 `console.log`）。
- 调用点在 `register()` 里：`description: resolveToolDescription(description)`，与去 `outputSchema` 同属触点 2/3 所在的 `register` 块；模块级 `export const description` 保持通用英文（工具契约要求导出该名字，`src/config.ts` 与测试也只读 `name`）。
- 之所以在 `register()` 而非导入时读：`connectTestClient()` 在 `before` 里才调 `createMcpServer()`，测试可在 `before` 前 `delete process.env.JEV_FILTER_TOOL_DESCRIPTION_FILE` 隔离；而参数描述必须在导入时固定，所以**不**做参数级覆盖（补丁的中文参数短说明就此放弃，代价可接受）。
- 不推荐"固定路径 sidecar"（隐式）与"描述文本直接放环境变量"（多行文本难维护）。
- 变量名与只覆盖主描述都是本研究建议，`[ASSUMED]`，见 A6。

### 补丁脚本的其余行为去向

- sources 精简（P0/P1）→ 库管道末尾的输出重建（见规则 9 之后的"输出重建"）。
- 离线 stdio 探针（`probe_schema`）→ Phase 3 的 TOOLS-02 冒烟脚本可直接移植其请求序列：`initialize` → `notifications/initialized` → `tools/list` → `tools/call` 三次（成功、HTTP 错误、结构错误）。
- 两个 Claude Code hooks（按工具名匹配、只加 `additionalContext`：搜索前提醒"query 是完整 URL 应改用读网页"与"缺少结果限制参数"，搜索后提醒可用读网页工具取正文）与本阶段无关，Phase 3 切换时决定去留。

## 本地规则：算法、常量与坑（问题 5）

以下按管道步号组织。每条先给 `notes/local-rules-design.md` / `notes/non-article-pages.md` 的原规则，再给本研究基于夹具实测的精确化建议，并标出偏离处。所有"夹具上命中什么"都是本会话实际计算的结果。

### 通用：分词与实词集（`tokenize.ts`）

- Latin 词：`/[\p{L}\p{N}]+/gu` 小写；但 `[\p{L}]` 会把整段汉字粘成一个 token（本机探针："内容发布配置怎么做" 成为一个 token）。所以先用 `/\p{Script=Han}+|[\p{L}\p{N}]+/gu` 切，Han 连续段转成**字符二元**（"内容发布" → 内容、容发、发布），单字段保留单字；假名与谚文按同样办法（`\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}`），`[ASSUMED]`，见 A7。
- 实词集 = query 与 intent 的 token 去停用词。停用词初值：英文功能词与搜索套话（the, a, an, of, in, on, for, to, and, or, is, are, was, be, with, by, at, from, as, it, this, that, what, how, why, when, which, who, do, does, can, about, into, than, then, not, no, vs, versus, new, latest, current, best, guide, tutorial, using, use, based）；中文二元停用（怎么、如何、什么、教程、方法、使用、最新、当前）。列表放 `tokenize.ts` 常量，"可增补"。
- 版本类 token（`v6`、`2026`）保留；`sanity.config.ts` 切成 `sanity`、`config`、`ts`。
- 对 default 夹具 query `Jev TypeSafe AI model release` 得到实词 {jev, typesafe, ai, model, release}——`ai`、`model` 很泛，但规则是"含任一实词即算含"，方向保守，符合原则四。

### 规则 1（步 1）：JSON-LD 分流（RULES-01）

原规则（笔记 §1）：片段去空白后以 `{` 或 `[` 开头且能 `JSON.parse` 才算；删除键：author、publisher、editor、sameAs、citation、keywords、articleSection、inLanguage、isAccessibleForFree、datePublished、dateModified、wordCount、timeRequired、interactionStatistic、image、url、@context、@type、name（顶层）、item、mainEntityOfPage、breadcrumb、itemListElement；转正文键：`articleBody`、`description`（长度 > 200）、`headline`（并入标题去重）、FAQPage 的 `mainEntity[].name` + `acceptedAnswer.text`（每对拼成 "Q: … A: …"）、HowTo 的 step text；无 schema.org 键的表格/代码块 JSON 原样保留；解析失败当普通文本。

精确化建议：

1. **判定**：`trim()` 后首字符 `{` 或 `[`，`JSON.parse` 成功且结果是对象或数组；否则原样保留（`jsonld_kept_raw` 不计，这是普通片段）。
2. **正文抽取**（按此顺序拼接，每条成为独立片段，`part` 递增）：`articleBody`；`description` 若长度 > 200；`headline` 若与来源 `title` 归一化后不同（相同则丢，算"并入标题"）；`mainEntity[]` 中每个有 `acceptedAnswer.text` 的项 → `Q: <name>\nA: <text>`；`step[]`（HowTo）的 `text`/`name`；`suggestedAnswer[].text`（QAPage，sample3 的实际形状）与顶层 `acceptedAnswer.text`。数组顶层（`[`…`]`）对每个元素同样处理。
3. **裁决**：抽出 ≥ 1 段正文 → 该 JSON 片段被替换为这些段（`jsonld_converted` +1）；抽不出正文且所有键都在元数据表里 → 整片删除（`jsonld_dropped` +1，片段原因 `jsonld_meta`）；抽不出正文且存在表外键 → **原样保留**（`jsonld_kept_raw` +1，保守）。
4. 元数据表在笔记基础上增补夹具里实际出现的键：`dateCreated, answerCount, duration, genre, offers, partOfSeries, productionCompany`；这样 apple podcasts 的媒体元数据片段会被整片删（其余两段散文留给 Phase 2 的片段评分链），`[ASSUMED]`，见 A8。
5. 嵌套 JSON 键访问用 `Object.hasOwn` 与显式键名，不用 `in`/原型链；`JSON.parse` 本身不会原型污染，但不要把解析结果 spread 到别的对象。

入库夹具上的命中（供期望文件）：

| 夹具 | 来源 | 片段 | 键 | 期望 |
|---|---|---|---|---|
| default / strict | pasqualepillitteri.it | idx 4 / idx 3 | headline（== title）+ 纯元数据 | 整片删（`jsonld_meta`） |
| default / strict | explainx.ai | idx 1 | `mainEntity` 6 对 | 转 6 段 "Q: … A: …" |
| default / strict | explainx.ai | idx 2 | `{name, item}`（面包屑） | 整片删 |
| default / strict | flowtivity.ai | idx 3 / idx 2 | `mainEntity` 5 对 | 转 5 段 |
| default | therundown.ai | idx 5 | headline（== title）+ 元数据含 `citation`、`editor`、`publisher` | 整片删 |
| sample3 | sanity.io/answers | idx 4 | `name, dateCreated, dateModified, answerCount, suggestedAnswer[6]` | 转 6 段答案文本（若不采纳 A8 则原样保留） |
| noise podcast | podcasts.apple.com | idx 2 | 媒体元数据 | 整片删（若不采纳 A8 则原样保留） |

`[VERIFIED: 本会话遍历夹具 JSON 片段]`。没有一个夹具含 `articleBody`、`description`、HowTo `step`，这三条转换靠内联合成样本测试。

### 规则 2（步 2）：URL 规范化归并（RULES-02）

原规则（笔记 §2）：小写 host；去 `www.`；去 AMP 标记（`/amp/`、`amp.` 前缀、`?amp=1`、`.amp`）；去跟踪参数（utm_*、fbclid、gclid、ref、source 等；白名单外的查询参数保留）；去尾斜杠与 `#fragment`；http→https。同一规范 URL 的多条合并，片段拼接，去重。

精确化建议（规范 URL **只当合并键**，输出永远保留 Brave 原始 URL 字符串，`sources` 的键才能继续与 `generic[].url` 对得上）：

```ts
export function canonicalizeUrl(raw: string): string {
  let u: URL;
  try { u = new URL(raw); } catch { return raw; }         // 解析失败：原串作键，不合并
  u.protocol = 'https:';                                    // http→https（默认端口随之消失）
  u.hash = '';
  let host = u.hostname.toLowerCase().replace(/^www\./, '').replace(/^amp\./, '');
  const params = [...u.searchParams].filter(([k]) => !isTrackingParam(k) && !isAmpParam(k));
  params.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  let path = u.pathname.replace(/\/amp(?=\/|$)/g, '').replace(/\.amp$/, '');
  if (path.length > 1) path = path.replace(/\/+$/, '');
  const query = params.map(([k, v]) => `${k}=${v}`).join('&');
  return `${host}${path}${query ? '?' + query : ''}`;      // 不带 scheme，键足够
}
```

- 跟踪参数表初值：`utm_*`（前缀）、`fbclid`、`gclid`、`dclid`、`msclkid`、`yclid`、`twclid`、`igshid`、`mc_cid`、`mc_eid`、`_ga`、`_gl`、`ref`、`ref_src`、`source`、`si`；AMP 参数：`amp`、`amp=1`、`outputType=amp`。`id=5` 这类内容参数**保留**（识别页面）。
- Node WHATWG `URL` 实测：host 自动小写并去默认端口（`HTTP://WWW.Example.com:80/a/b/` → host `www.example.com`、port 空）；IDN 主机变 punycode（`例子.测试` → `xn--fsqu00a.xn--0zwm56d`），作为键无碍；非默认端口保留（`:8080`）；`?amp` 无值时 `searchParams` 键 `amp` 值空串 `[VERIFIED: 本会话探针]`。
- 合并语义：按 Brave 序遍历，首见的规范键持有该来源；后续同键来源的片段**追加**到首见来源（保持各自内部顺序），逐字相等（`trim` 后）的片段去掉；后者的 `sources` 条目丢弃（元数据取首见者），`url_merged` +1，stats 里后者 `verdict: 'drop', reason: 'merged'`。
- 入库夹具里没有任何两条来源规范后相同 `[VERIFIED: 本会话遍历]`，正例靠合成样本（同页 `http://www.x/a/?utm_source=t#x` 与 `https://x/a`）。
- 坑：不要把规范化后的 URL 写回输出（`z.url()` 校验过的原 URL 才是 Brave 给模型引用的）；不要小写 path（大小写敏感）；不要去 `index.html`（笔记未列，保守不做）。

### 规则 3（步 3）：片段预筛（RULES-03）

原规则（笔记 §3）：① 删除同时满足"不含任何 query 实词或 intent 实词"且"长度 < 200 字符"的片段（导航标题）；② 样板文字：以 "Continue after ad"、"Share"、"Release Time:"、"READ MORE"、"Cite this article"、"## Frequently Asked Questions" 这类行开头且不含 query 实词的短片段删除，cookie / newsletter 提示同理，列表可增补；③ 页内重复：同一来源内两片段 5-gram Jaccard > 0.8 只留第一条。

夹具实测（决定期望文件怎么写）：

- 规则 ①在 default / strict 夹具上**命中 0 条**：15 条（strict 9 条）短于 200 字符的片段全部含 `jev` 或 `typesafe`。在 Sanity 夹具上只命中 sample4 sanity.io 第 1 条（39 字符，`DATA_x3Ht9Kqa_START On this page / Installation and upgrading DATA_x3Ht9Kqa_END`，无实词）。笔记举例的 mezha 导航块（"Moldova Explains…"）来自更早一次抓取；**入库夹具的 mezha 第 0 条是 357 字符的 8 行导航块，其中一行恰是本文标题**，含实词，规则 ①不删。
- 规则 ②：heise 第 1 条以 `Continue after ad` 开头但 333 字符且含实词；pasqualepillitteri 第 2 条以 `## Frequently Asked Questions (FAQ)` 开头但 315 字符且含实词；kucoin 第 0 条 111 字符含实词，内含 `Release Time:` 与 `Share` 两行但不在行首。按笔记原文（"开头且不含实词的短片段"）三者都**不删**。
- 规则 ③：十份夹具没有任何页内片段对的 5-gram Jaccard > 0.8（最高约 0.37）。"标题加导语被抽两次"在真实数据里是**包含关系**：sample4 agent-skills.md 第 2 条的 5-gram 有 0.88 出现在第 0 条里（Jaccard 仅 0.37）；sample4 sanity.io 第 8 条对第 2 条包含度 0.64；sample5 sanity.io 第 5 条对第 3 条 0.67；sample2 两处约 0.52。ua.news 最后一条 1106 字符是同一标题重复十余次的站内导航列表（自身 5-gram 重复率约 0.30，其他正文片段最高约 0.21），含实词，三条规则都抓不到。`[VERIFIED: 本会话计算]`

精确化建议（偏离处已标）：

1. **样板行剥离**（对笔记 ② 的加强，`[ASSUMED]` A9）：先按行扫描，删除以样板前缀开头的行（前缀表初值：`Continue after ad`、`Share`、`Release Time:`、`READ MORE`、`Cite this article`、`## Frequently Asked Questions`、`Advertisement`、`Sponsored`、`Subscribe to our newsletter`、`Sign up for our newsletter`、`We use cookies`、`This site uses cookies`、`Accept all cookies`、`Skip to content`、`Table of contents`、`On this page`、`Related articles`、`Read next`、`分享`、`广告`、`相关阅读`、`点击查看`、`本站使用 Cookie`），行匹配去掉前导 `#`、`*`、`-` 与空白后再比；剥离后为空 → 删（`boilerplate`）；剥离后只剩来源标题（归一化后相等）→ 删（`boilerplate`）。这样 kucoin 第 0 条剥掉两行只剩标题 → 删；heise 第 1 条保留正文部分；pasqualepillitteri 第 2 条保留问答正文。若老大要求严格按笔记原文，则退回"整片判定"，三者全留——期望文件二选一，见 Open Questions。
2. **短且无实词**：对剥离后的文本，长度 < 200（`String.length`）且不含任一实词 → 删（`nav`）。CJK 门槛留待影子期（A10）。
3. **页内逐字重复**：对每个来源按原序遍历，token 5-gram 集合；与任一**已幸存**片段满足 `jaccard > 0.8` **或** `containment >= 0.8`（`|A∩B| / min(|A|,|B|)`，且较小集合 ≥ 8 个 shingle）→ 删（`dup`），保留先出现者。加入包含度是对笔记 ③ 的偏离（`[ASSUMED]` A11），否则该规则在全部入库夹具上是死代码；用它后 sample4 agent-skills 第 2 条会被删，其余包含度 0.5–0.67 的对保留。
4. **不**加"仅标题行无句子"的导航形状启发式（mezha 第 0 条、sample6 sanity 目录块、github "Choose a tag to compare" 块都会命中）：这类块在 Phase 2 由片段 score 0 档处理；Phase 1 保守留。写进 Open Questions 供老大定。
5. 顺序：先规则 1 转换出的片段也参与 ②③（转换段占原 JSON 片段的位置）。

### 规则 4（步 4）：feed URL 与结构性黑名单（RULES-04）

原规则：URL 含 `rss`、`feed`、`.xml`，或域名以 `feeds.` 开头 → 判 feed，丢来源；`blocklist.txt` 一行一个规范 host，只收结构性农场，混合平台永不入列。

精确化建议：

- **feed 匹配用 token 而不是子串**（`[ASSUMED]` A12）：把 `hostname` 与 `pathname` 按 `/ . - _` 切成 token，任一 token 等于 `rss`、`feed`、`feeds`、`atom`，或路径末段以 `.xml` / `.rss` / `.atom` 结尾，或 `hostname` 以 `feeds.` 开头，或查询参数键 `feed` 存在（WordPress `?feed=rss2`）→ feed。子串匹配会误杀 `feedback`、`newsfeed-article`、`grassroots`（含 `rss`）。
- 黑名单匹配在**规范 host**（小写、去 `www.`）上：条目 `example.com` 命中 `example.com` 与任意 `*.example.com`（结构性农场常按语言分子域），`[ASSUMED]` A13。
- 存储：`src/filter/blocklist.ts` 导出模板字符串常量，一行一个 host，`#` 注释，`parseBlocklist(text): Set<string>` 解析——这满足"文件一行一个"的形式且能进 `dist/`；Phase 2 可加 `JEV_FILTER_BLOCKLIST_FILE` 指向仓库外文件合并（EMBED-05）。
- **初始内容为空（只有注释与格式示例）**：入库夹具 12 + 27 个 host 没有一个符合"结构上就是农场"，rubric 把它们全判为混合平台或原创（`[ASSUMED]` A14）。黑名单的正例测试用注入：`filterLlmContext(data, req, { ...config, blocklist: new Set(['farm.example']) })` 对合成来源断言 `reason: 'blocklist'`。
- 入库夹具里没有 feed 形态 URL `[VERIFIED: 本会话遍历]`；正例用合成 URL（`https://feeds.example.com/rss.xml`、`https://example.com/blog/feed/`、`https://example.com/x?feed=rss2`），反例 `https://example.com/feedback-form`。
- 统计：`feed_hits`、`blocklist_hits`；来源 `reason: 'feed' | 'blocklist'`；`sources` 表同步删条目。

### 规则 7：付费墙标记只截断片段（RULES-07）

原规则（`notes/non-article-pages.md`）：英文 Premium content、Subscriber only、Subscribers only、This post is for paid subscribers、Subscribe to continue reading、Sign in to read、Members only、Continue reading with a subscription；中文 付费会员专享、以下为付费内容、订阅后阅读全文、会员可见、加入会员查看。只做片段级：从标记处截断该片段；不据此判整页。

精确化建议：

- 匹配**行锚定**：标记出现在某一行行首（去掉前导 `#*-` 与空白、忽略大小写）才算（`[ASSUMED]` A15）；FT 样本里 "Premium content" 就是独立标签行。句中出现（例如一篇讨论付费内容的文章）不截断，避免误伤。
- 截断 = 保留标记所在行之前的文本（`trimEnd`）；截断后为空 → 片段删除（`paywall_empty`）；否则片段保留并标 `truncated: true`，`paywall_truncated` +1。这一步在管道里的位置：随步 3 预筛一起做（截断先于长度判断，笔记未定位置，`[ASSUMED]` A16）。
- 入库夹具**零命中**：substack 样本的付费墙表现为一句 `DATA_r5Nv8Bzq_START The paid half turns this into code. DATA_r5Nv8Bzq_END`，不在标记表里，按设计交 Phase 2 的 `paywalled` 题；apple podcasts 无标记 `[VERIFIED: 本会话遍历]`。正例用合成片段（在真实片段末尾拼一行 `Subscribe to continue reading` 加垃圾文本，断言截断点与保留文本）。
- 表放 `markers.ts`，中英两组常量，"老大有新写法随时补"。

### 规则 8（步 8）：空来源与一句话来源（RULES-05）

原规则：片段删光 → 丢来源并同步清理 sources 表；只剩一条短片段的来源，不含 query 实词删、含实词留。

精确化建议：

- "短"沿用 200 字符；"实词"这里**只用 query 实词集，不含 intent**（`[ASSUMED]` A17）。理由：步 3 已用 query ∪ intent 实词过滤过短片段，若本条也用并集，`off` 模式下它永远不会删任何东西；用 query 集才有区分度（只命中 intent 里泛词如 version、current 的孤零零一句会被删）。
- 空来源在 `off` 模式下的来源只有步 1–4 与步 7 的逐字去重（例如 JSON 片段整片删且来源只有这一条片段）；入库夹具里没有来源在 `off` 模式下被删光 `[VERIFIED: 本会话按上述规则推演]`，正例用合成（单片段 JSON 元数据来源；单条短片段只含 intent 词的来源）。
- 统计：`empty_dropped`，来源 `reason: 'empty'`；`sources` 表重建时自然清掉。

### 规则 9（步 9）：裁回预算与超量倍数（RULES-06）

原规则：`maximum_number_of_urls` 与 `maximum_number_of_tokens` 视为输出上限；幸存来源按 Brave 序取前 N；总 token 超预算时从最后一个来源开始砍片段（不砍来源顺序）；倍数默认 1×，环境变量保留；>1 只放大 urls 与总 tokens，不放大 per-url。

精确化建议：

- 上限缺省用 Brave 默认：urls 20、tokens 8192（模型不传时 Brave 也按此返回）`[CITED: notes/brave-llm-context.md]`。
- token 估算用 `tokens.ts` 的无分词器公式（英文词 1，每多 6 个字母加 1；数字每位 0.5；其他符号含每个 CJK 字符 0.9）`[CITED: notes/jev-api.md]`；本会话对 default 夹具按此估算总量约 8.0k，低于其请求预算 9.0k，所以真实夹具在自身请求参数下**不触发**裁剪；测试用更小的预算调用（如 urls 5 / tokens 3000）断言：留前 5 源（Brave 序）、从第 5 源末尾片段开始逐条删直到估算 ≤ 3000、若某源片段删光则该源 `reason: 'budget'` 并继续砍前一源、输出顺序不变。
- 超量倍数：`applyOverfetch(params, config)` 在 `issueRequest` 前把 `maximum_number_of_urls` 与 `maximum_number_of_tokens` 乘以倍数并向下取整，分别夹在 Brave 上限 50 与 32768 内（`schemas/input.ts:143-158` 的 `.max(50)` / `.max(32768)` `[VERIFIED]`），`maximum_number_of_tokens_per_url` 不动；倍数 1 时返回原对象。裁剪一律按**模型原始请求值**。
- 环境变量名：笔记写 `OVERFETCH_FACTOR`，CONVENTIONS 记录 fork 变量统一 `JEV_FILTER_*` 前缀；建议 `JEV_FILTER_OVERFETCH_FACTOR`（一个前缀就能列出全部过滤层变量，测试隔离时好清理），`[ASSUMED]` A18。解析：非数字或 < 1 回落 1（EMBED-05 的"坏值回落默认值"提前适用）。
- 统计：`budget_dropped_sources`、`budget_trimmed_snippets`、`output.est_tokens`。

### 输出重建与顺序保证（RULES-08）

- 管道内部用"工作表"：`{ index, url, canonical, title, meta, snippets: [{ index, part, text, kept, reason, truncated }] , verdict, reason }[]`，来源按 Brave 序、片段按原序；每一步只翻 `kept`/`verdict` 或替换文本，**不重排、不 `sort`**（规范化里的参数排序只作用于键字符串）。
- 最后一步重建：`generic = 工作表.filter(keep).map(s => ({ url: s.url, title: s.title, snippets: s.snippets.filter(kept).map(text) }))`；`sources = Object.fromEntries(幸存源.map(s => [s.url, trimMeta(s.meta)]))`，`trimMeta` 即补丁行为（title / hostname / 首个 ISO age）。
- 测试断言顺序：`assert.deepEqual(result.grounding.generic.map(s => s.url), expected.final.urls)`，以及每源 `snippets` 与期望的保留索引序列一致。
- `sources` 对象键的插入顺序也随幸存序，虽非契约但便于人眼对比。

## 夹具与期望文件策略（问题 6，RULES-09）

### 现有夹具清单

| 夹具 | 形状 | 源 / 片段 | 对 Phase 1 规则的价值 |
|---|---|---|---|
| `fixtures/jev_release_default.json` | wrapped | 12 / 76 | JSON-LD 五种情形；黑金样本（rubric 12 源）；样板行；ua.news 导航列表（Phase 1 抓不到，记为已知） |
| `fixtures/jev_release_strict.json` | wrapped | 12 / 41 | 同查询 strict 版，JSON-LD 四种；验证同一规则在两版上的一致性 |
| `fixtures/sanity/sample1_disable_releases.json` … `sample6_version_6.json` | bare | 5–6 源 / 16–39 片段 | `age: []` 的来源；sample3 的 QAPage JSON；sample4 的短无实词片段与包含式重复；sample4/5 的包含度反例 |
| `fixtures/noise/apple_podcasts_metadata.txt` | noise | 1 / 3 | 媒体元数据 JSON 片段 |
| `fixtures/noise/substack_paywall.txt` | noise | 1 / 9 | 付费墙"无标记"反例 |

全部 10 份已入库（`git ls-files fixtures`），`fixtures/**/*.jev.json` 被忽略（`.gitignore:10`，`git check-ignore` 对顶层与子目录都验证）`[VERIFIED: 本会话 git]`。工作区里的 `*.jev.json` 本研究**未读取**。

### 期望文件格式（建议）

位置 `fixtures/expected/<相对路径去后缀>.off.json`（例如 `fixtures/expected/jev_release_default.off.json`、`fixtures/expected/sanity/sample3_typegen_types.off.json`、`fixtures/expected/noise/apple_podcasts_metadata.off.json`）。`git check-ignore` 确认该路径不被忽略；文件名绝不能以 `.jev.json` 结尾。笔记原本写 `fixtures/expected_<rule>.json`（按规则分文件）；改为按夹具分文件、文件内按规则分节，理由是最终顺序断言只有按夹具才自然，`[ASSUMED]` A19。

```json
{
  "fixture": "jev_release_default.json",
  "query": "Jev TypeSafe AI model release",
  "intent": "What TypeSafe released with the Jev model and how it works",
  "request": { "maximum_number_of_urls": 12, "maximum_number_of_tokens": 9000, "maximum_number_of_tokens_per_url": 750 },
  "mode": "off",
  "rules": {
    "jsonld":     [ { "url": "https://www.explainx.ai/...", "snippet": 1, "action": "converted", "parts": 6, "first_part_prefix": "Q: What is Jev by TypeSafe AI?" },
                    { "url": "https://www.explainx.ai/...", "snippet": 2, "action": "dropped_meta" } ],
    "url_merge":  [],
    "prefilter":  [ { "url": "https://www.kucoin.com/...", "snippet": 0, "action": "boilerplate" } ],
    "dedup":      [],
    "feed_blocklist": [],
    "paywall":    [],
    "empty_source": [],
    "budget":     { "dropped_sources": 0, "trimmed_snippets": 0 }
  },
  "final": {
    "urls": [ "https://www.theregister.com/...", "..." ],
    "kept_snippets": { "https://www.theregister.com/...": [0,1,2,3,4,5,6,7], "https://www.explainx.ai/...": [0, "1.0", "1.1", "1.2", "1.3", "1.4", "1.5"] },
    "sources_keys": ["title", "hostname", "age"],
    "sources_age": { "https://www.theregister.com/...": ["2026-09-16"] },
    "n_snippets": 82,
    "local": { "jsonld_converted": 2, "jsonld_dropped": 3, "jsonld_kept_raw": 0, "url_merged": 0, "snippets_prefiltered": 0, "dup_removed": 0, "paywall_truncated": 0, "feed_hits": 0, "blocklist_hits": 0, "empty_dropped": 0 }
  }
}
```

- `rules.*` 每一项是一条**手工标注**（标注人按 `notes/labeling-rubric.md` 的问法写 `action`）；`final` 是整体快照。数字示例仅为说明格式，执行时由标注人按实际计算填写。
- 转换出的片段用 `"<原索引>.<part>"` 字符串标识，普通片段用整数索引。
- 只写索引、前缀与计数，不复制片段正文（期望文件保持小、可读、可 review，且不重复入库第三方文本）。
- 对 Sanity 六组 bare 夹具，`query` / `intent` 由标注人根据文件名与内容**重建**（夹具没记录），例如 sample1 `sanity studio disable content releases` + intent 点名 v6 与 `sanity.config.ts`（`[ASSUMED]` A20）。
- 预算：真实夹具用自身请求值时不触发裁剪，期望里 `budget` 全 0；裁剪的正例是另一个 `it`，用同一夹具加小预算，期望直接写在测试里或写成 `<stem>.budget.off.json`。

### 测试怎么逐条断言

`src/filter/pipeline.fixtures.test.ts`：

```ts
const fixtureRoot = fileURLToPath(new URL('../../fixtures/', import.meta.url)); // 从 src/filter/ 出发是两级
for (const expectedPath of listExpectedFiles()) {
  const expected = JSON.parse(readFileSync(expectedPath, 'utf8'));
  describe(`off mode · ${expected.fixture}`, () => {
    const data = loadBraveFixture(join(fixtureRoot, expected.fixture)); // 认 wrapped / bare / noise 三种
    const { result, stats } = filterLlmContext(data, { params: { query: expected.query, ...expected.request }, intent: expected.intent }, offConfig);
    for (const item of expected.rules.jsonld) it(`jsonld · ${host(item.url)} #${item.snippet} ${item.action}`, () => { /* 查 stats.sources[].snippets 对应项 */ });
    // prefilter / dedup / feed_blocklist / paywall / empty_source 同理，每条标注一个 it
    it('keeps Brave order and drops nothing else', () => assert.deepEqual(result.grounding.generic.map((s) => s.url), expected.final.urls));
    it('trims sources to title/hostname/age', () => { for (const meta of Object.values(result.sources)) assert.deepEqual(Object.keys(meta).sort(), expected.final.sources_keys.sort()); });
    it('local counters match', () => assert.deepEqual(stats.local, { ...zeroLocal, ...expected.final.local }));
  });
}
```

- 每条标注一个 `it`，失败信息自带夹具名、host、索引与动作；`--test-name-pattern="explainx"` 可只跑一条。
- 断言比较**解析后的对象**，不比字符串（夹具工作区文件是 CRLF、索引里是 LF：`git ls-files --eol` 显示 `i/lf w/crlf` `[VERIFIED]`）。
- 加载器 `loadBraveFixture`：`'response' in d ? d.response : Array.isArray(d.grounding?.generic) ? d : { grounding: { generic: [d.generic], map: [] }, sources: d.source }`。
- 期望文件与 `.jev.json` 的边界：期望文件里只有 keep/drop、原因、索引、计数，没有任何模型分数（TESTING.md 已明确"标签可以入库，模型分数不行"）。

## 模式处理（问题 7，EMBED-02）

```ts
// src/filter/config.ts
const MODES = new Set(['off', 'shadow', 'on']);
export function parseFilterConfig(env: Record<string, string | undefined>): FilterConfig {
  const rawMode = (env.JEV_FILTER_MODE ?? '').trim().toLowerCase();
  const mode = MODES.has(rawMode) ? (rawMode as FilterMode) : 'off';          // 未设或坏值 → off
  const factor = Number.parseFloat(env.JEV_FILTER_OVERFETCH_FACTOR ?? '');
  const overfetchFactor = Number.isFinite(factor) && factor >= 1 ? factor : 1; // 坏值 → 1
  return { mode, overfetchFactor, blocklist: DEFAULT_BLOCKLIST };
}
```

- 纯函数，测试传显式对象：`parseFilterConfig({})` → `off`；`{ JEV_FILTER_MODE: 'shadow' }` → `shadow`；`' ON '` → `on`；`'banana'` → `off`。
- `execute()` 适配行传 `process.env`（或库入口在 `config` 省略时自行 `parseFilterConfig(process.env)`），**调用时**读——避免导入顺序问题：`src/server.ts` 先 import `./tools/index.js`（第 1 行）再 import `./config.js`（第 4 行），`dotenv.config()` 在工具模块求值之后才运行 `[VERIFIED: src/server.ts:1-5, src/config.ts:7]`。
- Phase 1 里 `shadow` / `on` 与 `off` 走同一条路径，只在 `stats.mode` 记录；Phase 2 通过 `deps.classify` 注入 Jev 客户端后才分叉。
- **证明没有 Jev 请求**，两层：
  1. 库测试：`before(() => { saved = globalThis.fetch; globalThis.fetch = (() => { throw new Error('unexpected fetch'); }) as typeof fetch; })`，`after` 恢复；对同一夹具跑三种 mode，函数是同步的、不 `await` 任何网络，任何 fetch 都会抛。
  2. MCP 往返测试：`useTestClient` 的桩对未模拟的 pathname 抛 `Unmocked Brave API request` `[VERIFIED: src/testUtils/mcpTestHarness.ts:33-35]`，responder 里计数 `/res/v1/llm/context` 命中次数并断言恰为 1、`isError` 为 false。
- 测试隔离：`.env` 会被 `dotenv` 载入每个测试进程（本机当前没有 `.env` `[VERIFIED]`，但不能依赖）；凡是经过 `execute()` 的测试要在 `before` 里 `delete process.env.JEV_FILTER_MODE`、`JEV_FILTER_OVERFETCH_FACTOR`、`JEV_FILTER_TOOL_DESCRIPTION_FILE` 并在 `after` 恢复（沿用 `src/config.test.ts` 的 `CONFIG_ENV_VARS` 模式）。本机 shell 里存在 Jev key 类变量（名见 `dev/jev_probe.py` 与私有笔记），Phase 1 代码不读它们，Phase 2 的隔离清单要加上。

## 验证配方：成功标准 1（问题 8，EMBED-06）

本机状态 `[VERIFIED: 本会话 git]`：远端只有 `upstream`（`brave/brave-search-mcp-server`，已 fetch）；当前分支 `jev`；`git merge-base jev upstream/main` = `a75d7eff34c260c7bba3bdc0163fd6982c34e370` = `upstream/main`（上游是 jev 的祖先，此刻 `git merge upstream/main` 为空操作）；`git diff --stat <base> jev -- src/` 为空（`src/` 与上游逐字节相同）；工作区干净；`origin/*` 引用是克隆残留、无 `origin` 远端。

```bash
BASE=$(git merge-base jev upstream/main)                       # 期望 a75d7eff…
git diff --name-only "$BASE" HEAD -- src/ | grep -v '^src/filter/' | sort
# 允许清单（且只允许这三行）：
#   src/tools/llm_context/index.test.ts
#   src/tools/llm_context/index.ts
#   src/tools/llm_context/schemas/input.ts
git diff "$BASE" HEAD -- src/tools/llm_context/index.ts          # 人工核对：import 一行、execute 体、register 去 outputSchema、默认导出去 outputSchema
git diff "$BASE" HEAD -- src/tools/llm_context/schemas/input.ts  # 人工核对：只有 LlmContextInputSchema 块
git diff --name-only "$BASE" HEAD -- src/ | grep '^src/filter/' | wc -l   # 其余全在纯库目录
grep -rl "@modelcontextprotocol" src/filter && exit 1 || echo "library clean"
npm run format:check && npm run build && npm test               # CI 同序；本机基线三者当前全绿（78 tests / 26 suites）
```

- `index.test.ts` 进入允许清单的理由：上游测试用不带 `intent` 的入参且 `assert.deepEqual(result.structuredContent, …)` `[VERIFIED: src/tools/llm_context/index.test.ts:28-45]`，触点 2、3 落地后它必然失败，改它是这两处改动的**测试伴随**而非第四处功能改动。需要老大认可这一解释（Open Questions Q1）。
- 上游在途分支会碰同一区域：`upstream/chore/bug-hunt-simplification` 含 "refactor(tools): collapse repeated result assembly, unify serialization"、"fix(schemas): advertise additionalProperties as true"、"fix(tools): give title the human-readable name"；`upstream/sampson-deferred-validation` 改 `config.ts` 的 key 校验时机 `[VERIFIED: git log upstream/main..<branch>]`。合并策略：三处改动各自保持为**连续的小块**，冲突时按"重放三处"解决；`src/filter/` 永不冲突。
- 可选的预演：`git checkout -b scratch/merge-test && git merge --no-commit upstream/chore/bug-hunt-simplification`，看冲突只落在 `llm_context/index.ts`，然后 `git merge --abort`。

## 测试客户端：成功标准 2（问题 9）

现有 `src/testUtils/mcpTestHarness.ts` 已足够：`connectTestClient()` 用真实 `createMcpServer()` + `InMemoryTransport.createLinkedPair()` + SDK `Client` `[VERIFIED: src/testUtils/mcpTestHarness.ts:12-20]`；`useTestClient(responder)` 在 `before/after` 里装卸 fetch 桩与客户端 `[VERIFIED: :53-68]`。

```ts
// src/tools/llm_context/index.test.ts（改写后）
describe(name, () => {
  let calls = 0;
  const getClient = useTestClient((url) => {
    if (url.pathname === '/res/v1/llm/context') { calls++; assert.equal(url.searchParams.has('intent'), false); return loadBraveFixture('jev_release_default.json'); }
  });

  it('declares only the whitelist plus required intent, no outputSchema', async () => {
    const { tools } = await getClient().listTools();
    const tool = tools.find((t) => t.name === name)!;
    assert.deepEqual(Object.keys(tool.inputSchema.properties!).sort(), [...WHITELIST, 'intent'].sort());
    assert.deepEqual(tool.inputSchema.required, ['query', 'intent']);
    assert.equal(tool.outputSchema, undefined);
    assert.match(tool.description!, /name the current version and its defining mechanism/);
    assert.equal(tool.inputSchema.$schema, 'https://json-schema.org/draft/2020-12/schema');  // 方言补丁仍生效
  });

  it('returns text only, sources trimmed, no Jev call', async () => {
    const result = await getClient().callTool({ name, arguments: { query: 'Jev TypeSafe AI model release', intent: 'What TypeSafe released with Jev' } });
    assert.equal(result.isError ?? false, false, JSON.stringify(result.content));
    assert.equal(result.structuredContent, undefined);
    const payload = JSON.parse((result.content as { text: string }[])[0].text);
    for (const meta of Object.values(payload.sources) as Record<string, unknown>[]) {
      assert.deepEqual(Object.keys(meta).sort(), ['age', 'hostname', 'title']);
      assert.equal((meta.age as string[]).length, 1);
    }
    assert.equal(calls, 1);
  });

  it('rejects a call without intent before reaching Brave', async () => {
    const result = await getClient().callTool({ name, arguments: { query: 'x' } });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.content), /intent/);
  });
});
```

- `src/server.test.ts` 会自动对新 inputSchema 做 Ajv 2020-12 编译 `[VERIFIED: src/server.test.ts:30-53]`；`src/protocols/stdio.test.ts` 通过真子进程的 `tools/list` 覆盖注册表一致性 `[VERIFIED: src/protocols/stdio.test.ts:46-58]`，两者都不需要改。
- "stdio 下 initialize + tools/call 的返回形状被 Claude Code 内嵌的 MCP SDK 接受"：Claude Code 内嵌的是 SDK 客户端，其 `callTool` 只在 `tools/list` 带 `outputSchema` 时校验 `structuredContent`（上文 client/index.js 引证）；补丁脚本在真实 Claude Code 上已以同样形状运行数周（私有笔记记录）。Phase 3 的 TOOLS-02 冒烟再对真子进程验一次。

## Validation Architecture（问题 10）

> `.planning/config.json` 的 `workflow.nyquist_validation` 为 `false`，按规范省略采样率与 Wave 0 的形式化内容；下表按编排者要求给 planner 的"需求 → 测试文件 → 命令 → 失败样子"映射。

### Test Framework

| Property | Value |
|----------|-------|
| Framework | `node:test` + `node:assert/strict`，经 `tsx` 4.22.4 直跑 `.ts` |
| Config file | 无；唯一配置是 `package.json:34` `"test": "node --import tsx --test \"src/**/*.test.ts\""` `[VERIFIED]` |
| Quick run command | `node --import tsx --test src/filter/<module>.test.ts` |
| Full suite command | `npm test`（本机基线 78 tests / 26 suites，约 4 秒）；CI 同序为 `npm run format:check && npm run build && npm test` |

失败长什么样 `[VERIFIED: 本会话实测]`：`node --test` 有失败时汇总行 `ℹ fail 1`、进程退出码 1、失败用例以 `not ok` 开头并打印 `assert` 的 diff；`tsc` 报 `error TS2322: Type 'string' is not assignable to type 'number'` 类行、退出码 2；`prettier --check` 打印 `[warn] <file>` 与 `Code style issues found in the above file. Run Prettier with --write to fix.`、退出码 1。`--test-name-pattern` 匹配不到任何用例时退出码为 0（不会把"没跑"报成失败，planner 写验证命令时要同时断言输出里有 `ℹ pass N` 且 N > 0）。

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| EMBED-01 | 纯库无 MCP 引用、宿主模块引用；`execute` 只在 success 分支调库 | unit + grep | `node --import tsx --test src/filter/purity.test.ts` | ❌ 新建 |
| EMBED-02 | 未设 → off；shadow/on 可取；三种模式无 fetch | unit | `node --import tsx --test src/filter/config.test.ts src/filter/pipeline.test.ts` | ❌ 新建 |
| EMBED-03 | tools/list 白名单 + intent 必填 + 描述含版本句 | integration（in-memory MCP） | `node --import tsx --test src/tools/llm_context/index.test.ts` | ✅ 改写 |
| EMBED-04 | 无 outputSchema / structuredContent；sources 三键；缺 intent 拒绝 | integration | 同上；另 `src/server.test.ts` 自动覆盖 schema 合法性 | ✅ 改写 / ✅ 已有 |
| EMBED-06 | 上游差异只三文件；构建/测试/格式全绿 | shell | 上节"验证配方" | — |
| RULES-01 | JSON-LD 五种情形 + 合成 articleBody/description/HowTo | unit + fixtures | `node --import tsx --test src/filter/jsonld.test.ts src/filter/pipeline.fixtures.test.ts` | ❌ 新建 |
| RULES-02 | 规范化 16 类边角 + 合成合并 | unit | `node --import tsx --test src/filter/url.test.ts` | ❌ 新建 |
| RULES-03 | 分词/二元/停用词；样板行；短无实词；重复（Jaccard 与包含度） | unit + fixtures | `… src/filter/tokenize.test.ts src/filter/prefilter.test.ts src/filter/pipeline.fixtures.test.ts` | ❌ 新建 |
| RULES-04 | feed token 匹配正反例；黑名单注入 | unit | `… src/filter/nonArticle.test.ts src/filter/blocklist.test.ts` | ❌ 新建 |
| RULES-05 | 空来源与一句话来源（合成） | unit | `… src/filter/nonArticle.test.ts` | ❌ 新建 |
| RULES-06 | 小预算裁剪；倍数放大与夹取 | unit | `… src/filter/budget.test.ts src/filter/tokens.test.ts` | ❌ 新建 |
| RULES-07 | 标记截断（合成）；真实夹具零命中 | unit + fixtures | `… src/filter/nonArticle.test.ts src/filter/pipeline.fixtures.test.ts` | ❌ 新建 |
| RULES-08 | 输出顺序 = Brave 序 | fixtures | `… src/filter/pipeline.fixtures.test.ts`（每份夹具一条 `it`） | ❌ 新建 |
| RULES-09 | 每份夹具的期望文件逐条断言 | fixtures | `… src/filter/pipeline.fixtures.test.ts`；文件 `fixtures/expected/**/*.off.json` | ❌ 新建 |

## Architecture Patterns

### System Architecture Diagram

```text
MCP host (Claude Code)                                  ┌──────────────────────────────┐
  tools/list ─────────────────────────────────────────▶ │ SDK tools/list handler        │
                                                        │ + enforce2020Dialect (.shape) │
  tools/call {query,intent,count,...} ───▶ SDK validateToolInput(LlmContextInputSchema)
                                                │ 校验失败 → isError 文本，execute 不运行
                                                ▼
                       execute(params)  [触点 1，src/tools/llm_context/index.ts]
                                                │ RequestParamsSchema.parse → 查询参数（intent 被剥离）
                                                │ RequestHeadersSchema.parse → {}
                                                │ applyOverfetch(params, config)   ← src/filter（倍数 1 时恒等）
                                                ▼
                       API.issueRequest('llmContext') ──HTTPS──▶ api.search.brave.com/res/v1/llm/context
                                                │ 非 2xx → throw → SDK 包成 isError
                                                ▼
                       LlmContextSearchApiResponseSchema.safeParse
                                                │ 失败 → { content: treeifyError, isError: true }
                                                ▼ 成功 data
      ┌────────────────── src/filter/filterLlmContext(data, {params, intent}, config) ──────────────────┐
      │ 1 jsonld → 2 url merge → 3 prefilter(+paywall 截断) → 4 feed/blocklist → [5 Jev: off 跳过]     │
      │ → [6 无事] → 7 逐字去重(已在 3 做; 指纹新颖度 Phase 2) → 8 empty/one-liner → 9 budget → 输出重建 │
      │ 工作表按 Brave 序、片段带原索引; 每步只翻 kept/verdict; 结束时重建 generic + 精简 sources        │
      └───────────────────────────────┬────────────────────────────────────────────────────────────────┘
                                      ▼ { result, stats }
                       { content: [{ type:'text', text: JSON.stringify(result) }], isError: false }
                                      │ (Phase 3: 末尾追加状态行, 从 stats 生成)
                                      ▼
MCP host ◀──────────────────── SDK validateToolOutput: 无 outputSchema → 直接放行
```

### Pattern 1: 工作表 + 单向标记

**What:** 管道内部不产生新数组、不删元素，只在带原始索引的工作表上翻 `kept` / `verdict` / `reason`，最后一次性重建输出。
**When to use:** 所有十步。这样 RULES-08（不重排）由结构保证，RULES-09（逐条断言）与 Phase 3（按原因计数）直接读同一张表。

### Pattern 2: 纯函数 + 显式注入

**What:** `parseFilterConfig(env)`、`canonicalizeUrl(raw)`、`isFeedUrl(url)`、`estimateTokens(text)` 都是无副作用函数；黑名单、标记表、停用词以参数/常量注入而非全局读取；`filterLlmContext` 的 `config` 与 `deps` 可选，省略时才碰 `process.env`。
**When to use:** 与 `src/protocols/rebinding.ts` 一样，导出可单测的小函数和一个组合入口（CONVENTIONS 的"纯库模块"范式）。

### Pattern 3: 触点最小化

**What:** 三处改动各自是连续的小块：`execute` 里两行加一个 import；`schemas/input.ts` 末尾一整块替换；`register` 与默认导出各删一行、`register` 里 `description` 一行改为 `resolveToolDescription(description)`。
**When to use:** 每次 `git merge upstream/main` 之后重放。

### Anti-Patterns to Avoid

- **在 `src/config.ts` 加 `JEV_FILTER_*`：** 第四处改动，且是上游最常改的文件；用 `src/filter/config.ts`。
- **导入时读环境变量：** `server.ts` 先求值 tools 再 config，`dotenv` 尚未运行；且测试无法隔离。
- **在 `register()` 里临时构造 inputSchema：** 方言补丁会用默认导出 `.shape` 重生成 `tools/list` 的 schema，把它盖掉。
- **把规范化 URL 写回输出：** `sources` 键与 `generic[].url` 会对不上，且丢失 Brave 给模型的原始引用。
- **只删 `outputSchema` 不删 `structuredContent`（或反之）：** 前者让 Claude Code 双倍渲染，后者被 SDK 判 InvalidParams。
- **库里 `console.log`：** stdout 是 stdio 协议通道。
- **用 `import x from '../../fixtures/…json' with { type: 'json' }`：** `rootDir: src` 让 `tsc` 失败；用 `readFileSync`。
- **从 `src/tools/llm_context/schemas/output.ts` 往库里引类型：** 反向依赖宿主；库自己声明结构类型。

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| URL 解析、host 小写、默认端口、百分号编码、IDN | 正则拆 URL | WHATWG `URL` + `searchParams` | 本会话 16 个边角实测全部正确；正则版必错在 IDN 与编码 |
| JSON-LD 判定与解析 | 手写括号匹配 | `JSON.parse` 包 `try/catch` | 解析失败即"普通文本"，正是笔记要的语义 |
| 输入声明、必填、描述、JSON Schema | 手写 JSON Schema | zod `.pick()` / `.describe()` / SDK 自动转换 | 方言补丁与 `server.test.ts` 已覆盖 2020-12 合法性 |
| MCP 往返测试 | 自建 JSON-RPC 客户端 | `src/testUtils/mcpTestHarness.ts` | 已有，走真实 `registerTool`/`callTool` |
| token 估算 | 引入分词器 | `tokens.ts` 的笔记公式 | 只用于裁预算与 Phase 2 保护；一份实现两处用 |
| 测试运行与断言 | 第三方框架 | `node:test` + `node:assert/strict` | 上游选定，`--test-name-pattern` 已够用 |
| 期望文件比对 | 自写 diff 报告器 | 每条标注一个 `it` + `assert.deepEqual` | 失败信息自带定位 |

**Key insight:** 这一层的复杂度在**规则语义**（哪条片段该留）而不在基础设施；所有基础设施上游与 Node 都已给全，任何新依赖都只增加合并面。

## Common Pitfalls

### Pitfall 1: 上游 `index.test.ts` 在改声明后必然红

**What goes wrong:** 上游测试不传 `intent` 且断言 `structuredContent`。
**Why it happens:** 触点 2、3 改变了它断言的两件事。
**How to avoid:** 同一提交改写它（见"测试客户端"）；把它列入 EMBED-06 允许清单并向老大说明。
**Warning signs:** `npm test` 报 `brave_llm_context › returns grounding content …` 失败。

### Pitfall 2: 方言补丁覆盖了运行时构造的 schema

**What goes wrong:** 在 `register()` 里改描述或参数，`tools/list` 看不到。
**Why it happens:** `jsonSchemaDialect.ts` 用默认导出的 `.shape` 重生成 inputSchema。
**How to avoid:** 参数级文本在 `schemas/input.ts` 构建时固定；只有工具 `description` 可在 `register()` 里覆盖。
**Warning signs:** 测试里 `tool.inputSchema.properties.count.description` 仍是旧文本。

### Pitfall 3: `intent` 意外转发给 Brave

**What goes wrong:** 有人把 `intent` 加进 `RequestParamsSchema`。
**How to avoid:** `intent` 只在 `LlmContextInputSchema`；测试在 fetch 桩里断言 `url.searchParams.has('intent') === false`。

### Pitfall 4: 环境变量泄漏进测试

**What goes wrong:** 本机 `.env` 或 shell 里的 `JEV_FILTER_MODE` 让测试走 `shadow`/`on`。
**How to avoid:** 库测试传显式 env；经 `execute` 的测试在 `before` 删、`after` 恢复；库在调用时而非导入时读。

### Pitfall 5: 规则在真实夹具上是死代码

**What goes wrong:** Jaccard > 0.8、feed、黑名单、付费墙、URL 合并、裁预算在入库夹具上零命中，测试"全绿"却没验证任何正例。
**How to avoid:** 每条规则至少一个合成正例 + 一个真实夹具反例（"不该删的都还在"）；重复判定加包含度。
**Warning signs:** 期望文件里某条规则的数组全为空且没有对应的合成用例。

### Pitfall 6: 笔记例子与入库夹具不一致

**What goes wrong:** 按笔记写期望（mezha 导航块被删），测试却失败。
**Why it happens:** 笔记引用的是更早一次抓取；入库夹具的 mezha 第 0 条含本文标题。
**How to avoid:** 期望文件以入库夹具实测为准；导航形状启发式作为 Open Question 单独定。

### Pitfall 7: `age` 为空数组、来源缺 title

**What goes wrong:** 精简函数对 `age: []` 产出 `age: [undefined]` 或抛错。
**How to avoid:** 沿用补丁：找不到 ISO 就省略 `age` 键；非字符串 title/hostname 省略；非对象条目跳过。sample1 / 4 / 5 / 6 各有 `age: []` 的来源可作断言。

### Pitfall 8: 子串式 feed 判定误杀

**What goes wrong:** `feedback`、`newsfeed-article`、`grassroots` 被判 feed。
**How to avoid:** token 级匹配（规则 4）。

### Pitfall 9: CJK 被 `[\p{L}]+` 粘成一个 token

**What goes wrong:** 中文片段永远"不含实词"。
**How to avoid:** 先切 Han 连续段再二元；测试用一条中文合成片段。

### Pitfall 10: 路径与换行

**What goes wrong:** 从 `src/filter/` 用 `../../../fixtures/` 找不到文件（TESTING.md 示例是从 `src/tools/llm_context/` 出发的三级）；用字符串比较期望文件因 CRLF 失败。
**How to avoid:** `new URL('../../fixtures/', import.meta.url)`；比较解析后的对象。

### Pitfall 11: `prepare` 脚本在 `npm install` 时改文件

**What goes wrong:** `npm install` 触发 `npm run format && npm run build`，静默重写 `src/`。
**How to avoid:** 提交前跑 `npm run format:check`；不要在 `fixtures/` 放 `.ts`。

### Pitfall 12: 倍数放大越过 Brave 上限

**What goes wrong:** urls 50 × 2 = 100 → Brave 422。
**How to avoid:** `applyOverfetch` 夹在 50 / 32768；测试断言夹取。

## Code Examples

### 三种夹具的加载器（测试用）

```ts
// src/filter/testFixtures.ts（测试辅助，非产品代码；或直接放在 pipeline.fixtures.test.ts 顶部）
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const fixtureRoot = fileURLToPath(new URL('../../fixtures/', import.meta.url));

export function loadBraveFixture(rel: string): BraveLlmContextResponse {
  const d = JSON.parse(readFileSync(fixtureRoot + rel, 'utf8'));
  if ('response' in d) return d.response;                                   // wrapped
  if (Array.isArray(d.grounding?.generic)) return d;                        // bare
  return { grounding: { generic: [d.generic], map: [] }, sources: d.source ?? d.sources ?? {} }; // noise
}
```

### 5-gram shingle 与两种相似度

```ts
export function shingles(tokens: string[], n = 5): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + n <= tokens.length; i++) out.add(tokens.slice(i, i + n).join(' '));
  return out;
}
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}
export function containment(a: Set<string>, b: Set<string>): number {
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  if (small.size === 0) return 0;
  let inter = 0;
  for (const x of small) if (big.has(x)) inter++;
  return inter / small.size;
}
```

### 精简 sources（补丁行为的 TypeScript 版）

```ts
const ISO_DATE = /^\d{4}-\d{2}-\d{2}/;
export function trimSourceMeta(meta: unknown): Record<string, unknown> {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return {};
  const m = meta as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if (typeof m.title === 'string') out.title = m.title;
  if (typeof m.hostname === 'string') out.hostname = m.hostname;
  const iso = Array.isArray(m.age) ? m.age.find((a) => typeof a === 'string' && ISO_DATE.test(a)) : undefined;
  if (iso !== undefined) out.age = [iso];
  return out;
}
```

### 无 fetch 保护（库测试）

```ts
let savedFetch: typeof fetch;
before(() => { savedFetch = globalThis.fetch; globalThis.fetch = (() => { throw new Error('unexpected fetch'); }) as typeof fetch; });
after(() => { globalThis.fetch = savedFetch; });
for (const mode of ['off', 'shadow', 'on'] as const) {
  it(`mode=${mode} performs no network call and records the mode`, () => {
    const { stats } = filterLlmContext(data, req, { ...offConfig, mode });
    assert.equal(stats.mode, mode);
    assert.equal(stats.jev, null);
  });
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| 给 npx 缓存里的 `dist/*.js` 打补丁（补丁脚本 v4） | 源码嵌入 + `git merge upstream/main` | PLAN v3，2026-09-19 | 补丁脚本退役（Phase 3），其白名单、描述、sources 精简、探针序列成为蓝本 |
| 返回 `content` + `structuredContent` 并声明 `outputSchema` | 只返回 `content` 文本 | 本阶段 | Claude Code 不再双倍渲染；SDK 跳过输出校验 |
| 全量 27 个参数暴露给模型 | 9 个白名单参数 + 必填 `intent` | 本阶段 | 声明体积下降；`intent` 供 Phase 2 的相关性与版本核对 |
| zod v3 写法（`.passthrough()`、`error.format()`、`zod-to-json-schema`） | zod 4（`.loose()`、`z.treeifyError`、`z.toJSONSchema`） | 上游 2.1.x | 新代码不得混用 v3 写法 |

**Deprecated/outdated:**
- `dev/jev_probe.py` 的 v2 题库与裁决逻辑（CONCERNS.md）：与 Phase 1 无关，但其 `state` 形状 `{query,intent,source:{id,url,title,snippets[]}}` 是 Phase 2 的契约。
- 笔记 `local-rules-design.md` 的 mezha 导航例子对应旧抓取，见 Pitfall 6。

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `src/tools/llm_context/index.test.ts` 的改写算触点 2/3 的测试伴随，不算第四处改动 | 验证配方 | 若老大不认可，需删除上游测试文件并在 `src/filter/` 下新建等价测试（删除同样出现在 diff 里） |
| A2 | EMBED-04 的 "age[0]" 应按补丁行为理解为"首个 ISO 日期元素，无则省略" | Brave 形状 | 若坚持字面 `age[0]`，输出的是人类可读日期串，测试期望要改 |
| A3 | 环境变量在 `src/filter/config.ts` 的纯函数里读、由适配行传入 `process.env`，不进 `src/config.ts` | 模式处理 | 若要求走 `config.ts`，EMBED-06 三处限制被突破 |
| A4 | 目录名 `src/filter/`、模块拆分、统计对象字段名 | 纯库布局 | 只影响命名，不影响行为；Phase 2/3 以此为契约 |
| A5 | `intent` 长度上限 500 | zod 写法 | 过短会拒绝长句；可放宽 |
| A6 | 覆盖文件机制：`JEV_FILTER_TOOL_DESCRIPTION_FILE` 指向纯文本，只覆盖工具描述，不覆盖参数描述 | 覆盖文件 | 若老大要参数级中文说明，需改为导入时读 JSON 文件并接受"测试无法隔离本机覆盖"或增加显式关闭开关 |
| A7 | CJK 分词覆盖 Han + 假名 + 谚文，均按字符二元 | 分词 | 只影响日韩来源的实词判定 |
| A8 | 元数据键表增补 `dateCreated, answerCount, duration, genre, offers, partOfSeries, productionCompany`；正文键增补 `suggestedAnswer[].text` 与顶层 `acceptedAnswer.text` | 规则 1 | 不采纳则 sample3 与 podcast 的 JSON 片段"原样保留"，期望文件相应改 |
| A9 | 样板文字改为**行级剥离**后再判长度与实词 | 规则 3 | 不采纳则 heise / pasqualepillitteri / kucoin 三条按笔记原文全部保留 |
| A10 | "短"阈值 200 字符对 CJK 暂不调整 | 规则 3 | 影子期用中文样本再定 |
| A11 | 逐字重复判定 = Jaccard > 0.8 **或** 包含度 ≥ 0.8（小集合 ≥ 8 shingle） | 规则 3 | 不采纳则该规则在全部入库夹具上零命中 |
| A12 | feed 判定用 token 匹配而非子串 | 规则 4 | 子串会误杀 `feedback` 类 URL |
| A13 | 黑名单条目同时命中其子域 | 规则 4 | 只影响将来手工加入的条目 |
| A14 | 初始黑名单为空 | 规则 4 | 与页面粒度原则一致；正例靠注入测试 |
| A15 | 付费墙标记只在行首匹配 | 规则 7 | 若标记出现在句中会漏截断（保守方向） |
| A16 | 付费墙截断与步 3 预筛同时进行 | 规则 7 | 笔记未定位置；只影响统计口径 |
| A17 | 一句话来源规则只看 **query** 实词，不看 intent | 规则 8 | 若按并集，该规则在 off 模式下永不生效 |
| A18 | 超量倍数变量名 `JEV_FILTER_OVERFETCH_FACTOR`（笔记写 `OVERFETCH_FACTOR`） | 规则 9 | 只需改一个常量与私有笔记 |
| A19 | 期望文件按夹具分文件、文件内按规则分节，路径 `fixtures/expected/**/*.off.json` | 期望文件 | 笔记原写法是按规则分文件；形式差异 |
| A20 | Sanity 六组夹具的 query / intent 由标注人按文件名与内容重建 | 期望文件 | 重建偏差只影响预筛实词集；这六组主要验证 age 空数组、QAPage、包含式重复 |

## Open Questions

1. **上游测试文件算不算第四处改动？**（A1）
   - What we know: 它断言的恰是要去掉的两样东西，不改必红。
   - What's unclear: 老大对"三处"的口径是"三个功能改动"还是"三个文件"。
   - Recommendation: 计划里把它写进允许清单并在执行前一句话确认。

2. **导航形状启发式要不要进 Phase 1？**
   - What we know: mezha 第 0 条、sample6 目录块、github 比较页块都是"只有标题行没有句子"的导航块；Phase 1 三条预筛规则都抓不到；Phase 2 的片段 score 0 档设计上负责它们。
   - What's unclear: 老大是否愿意在无 Jev 的 `off` 模式先按结构删。
   - Recommendation: Phase 1 不做（保守），期望文件标"kept"，把候选规则记进 `notes/local-rules-design.md` 的待定项。

3. **样板文字按行剥离还是按片段整判？**（A9）
   - Recommendation: 行剥离；若老大要求按笔记原文，期望文件里三条相应改为 kept。

4. **中文覆盖描述是否需要参数级说明？**（A6）
   - Recommendation: 只覆盖主描述，参数说明用英文通用版。

5. **黑名单初始条目**（A14）
   - Recommendation: 空表起步，影子期由 EXT-03 候选脚本补。

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | 构建、测试、运行 | ✓ | 25.5.0（CI 24.x） | — |
| npm | 脚本 | ✓ | 11.8.0 | — |
| `node_modules`（sdk / zod / tsx / prettier / typescript / shx / ajv） | 全部 | ✓ | 与 `package.json` 一致 | — |
| git + `upstream` 远端已 fetch | EMBED-06 验证 | ✓ | git 2.55；merge-base `a75d7ef` | — |
| Python 3 | 仅 `dev/*.py`（本阶段不需要） | ✓ | 3.13 | — |
| `.env` 文件 | 无 | 不存在 | — | — |
| 代理（`NODE_USE_ENV_PROXY=1` + `HTTP(S)_PROXY`/`NO_PROXY` 已在 shell 里设） | 仅真实 Brave 调用（Phase 3 冒烟） | ✓（只列变量名） | — | 测试全部打桩，不需要网络 |
| Docker | 无 | 未检查 | — | 不需要 |

**Missing dependencies with no fallback:** 无。
**Missing dependencies with fallback:** 无。
**基线检查（本会话）：** `npm run format:check` 通过；`npm run build` 通过（`dist/` 已生成）；`npm test` 78 通过 0 失败。改 `src/` 的授权尚未取得，本研究未改任何 `src/` 文件。

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | no | 出站 Brave key 由上游 `config.ts` 处理，本阶段不新增凭据 |
| V3 Session Management | no | — |
| V4 Access Control | no | — |
| V5 Input Validation | yes | zod 4 声明（SDK 校验）+ 上游二次 `parse`；库对 `data` 做防御性访问（`Array.isArray`、`typeof`、`Object.hasOwn`） |
| V6 Cryptography | no | — |
| V8 Data Protection | yes | `stats` 不含片段正文；库不写日志；覆盖文件只读、fail-open |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| 网页片段里的注入文本（"ignore previous instructions" 等）随结果送给模型 | Tampering | 过滤层只做删减与结构转换，永不把片段内容拼进描述、状态行或日志字段名；状态行（Phase 3）只由计数生成 |
| JSON-LD 键名为 `__proto__` / `constructor` | Tampering | `JSON.parse` 不污染原型，但库访问用 `Object.hasOwn` 与固定键名，不 spread 解析结果 |
| 超长片段上的正则回溯（ReDoS） | DoS | 样板行与付费墙标记用 `startsWith` / 行级比较，不用无界正则；shingle 计算 O(n) |
| 环境变量指向恶意文件（描述覆盖） | Tampering | 只读 UTF-8 文本、长度上限（如 8 KB）、失败回落默认；变量由本机所有者设置 |
| stdout 污染破坏 stdio 协议 | DoS | 库零日志；测试断言库源码无 `console.log` |
| 秘密进入日志或错误文本 | Information Disclosure | 本阶段不新增出站调用；Phase 2 的 Jev 错误路径要脱敏 `Authorization` |

## Sources

### Primary (HIGH confidence)

- 本仓库源码（本会话逐文件 Read）：`src/tools/llm_context/index.ts`、`schemas/input.ts`、`schemas/output.ts`、`index.test.ts`、`src/tools/index.ts`、`src/server.ts`、`src/config.ts`、`src/BraveAPI/index.ts`、`src/BraveAPI/types.ts`、`src/testUtils/mcpTestHarness.ts`、`src/utils.ts`、`src/jsonSchemaDialect.ts`、`src/server.test.ts`、`src/protocols/stdio.test.ts`、`package.json`、`tsconfig.json`、`.prettierrc`、`.gitignore`。
- 已安装 SDK 源码：`node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js`（`validateToolInput` / `validateToolOutput` / tools/list 组装）、`client/index.js`（`callTool` 校验）。
- 本机探针（zod 4.3.6、SDK 1.30.0、Node 25.5.0）：`pick`/`describe`/`toJSONSchema`/剥离行为；无 outputSchema 的工具 in-memory 往返；WHATWG URL 16 个边角；十份夹具的形状、JSON-LD 键、短片段、样板行、5-gram Jaccard 与包含度、token 估算。
- 项目文档：`PLAN.md`、`.planning/REQUIREMENTS.md`、`ROADMAP.md`、`STATE.md`、`PROJECT.md`、`.planning/codebase/*.md`、`notes/*.md`（公开笔记）、现行补丁脚本（只提取白名单、结构与行为，未复制中文全文）。

### Secondary (MEDIUM confidence)

- Context7 `/modelcontextprotocol/typescript-sdk`：`registerTool` 配置项与 `outputSchema` 可选性（与本机源码一致）。
- Context7 `/colinhacks/zod`：`z.object` 默认剥离、`.pick()`、`.describe()`、`z.toJSONSchema` 的 `io: "input"`（与本机探针一致）。
- Context7 `/nodejs/node` `doc/api/test.md`：`it()` 的 `skip`/`todo` 选项、钩子、`--test-name-pattern` 语义。
- `notes/brave-llm-context.md` 转述的 Brave 文档默认值（urls 20、tokens 8192）。

### Tertiary (LOW confidence)

- 无。本研究未使用网页搜索。

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — 无新依赖，版本全部本机核对。
- Architecture（嵌入点、SDK 行为、zod 行为、纯库布局）: HIGH — 源码与探针双重验证。
- 本地规则精确化: MEDIUM — 算法方向来自笔记，命中数据来自夹具实测，但若干精确化（A8–A17）是本研究的判断，需老大或计划阶段确认。
- Pitfalls: HIGH — 每条都对应本会话观察到的具体事实。

**Research date:** 2026-09-20
**Valid until:** 2026-10-20（上游若合并 `chore/bug-hunt-simplification` 或 SDK 升级需重验嵌入点与方言补丁）
