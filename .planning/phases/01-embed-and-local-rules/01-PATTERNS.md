# Phase 1: Embed and Local Rules - Pattern Map

**Mapped:** 2026-09-20
**Files analyzed:** 32（3 个上游触点文件 + 15 个 `src/filter/` 库模块 + 12 个测试文件 + 1 个测试辅助 + 1 组期望数据文件）
**Analogs found:** 31 / 32（exact 17，role-match 10，partial 4，none 1）

> 公开文件约束：本文入库。不含任何 Jev 准确率、概率、延迟、成本数字；不含 key 值、代理地址或仓库外个人路径。所有类比路径均已用 `git ls-files` 核实为跟踪源码，基线 `a75d7ef`（`src/` 与上游逐字节相同）。所有行号以当前 `jev` 分支 HEAD（`e37f55f`）为准。

## 仓库惯例速查（执行者逐条复制）

| 惯例 | 出处 | 执行者要做的 |
|---|---|---|
| ESM，相对导入一律带 `.js` 后缀 | `src/tools/llm_context/index.ts:3,10-11`、`src/config.test.ts:6` | `import { x } from './url.js'`，哪怕源文件是 `.ts`；漏掉在 NodeNext 下运行时报错 |
| 导入顺序：`node:` 内置 → 第三方 → 项目模块（远的在前）→ 同级 | `src/config.test.ts:1-6`、`src/tools/llm_context/index.ts:1-11` | 测试文件严格遵守；库文件同样遵守（库里没有第三方导入） |
| 类型导入：整行用 `import type { X }`，混合时用内联 `{ type X }` | `src/tools/llm_context/index.ts:1,4,9` | 库里 `import type { FilterConfig } from './types.js'` |
| 测试骨架：`import assert from 'node:assert/strict'` + `import { describe, it } from 'node:test'` | `src/utils.test.ts:1-6`（12 份测试文件同形） | 只在需要时追加 `before, after`（资源型）或 `beforeEach, afterEach`（环境重置型） |
| 测试文件与源文件并排，命名 `<module>.test.ts` | `src/utils.test.ts`、`src/protocols/rebinding.test.ts` | `src/filter/url.test.ts` 与 `src/filter/url.ts` 同目录 |
| `describe` 名：纯函数用函数名；工具用导出的 `name` 常量；场景变体加括号后缀 | `src/protocols/rebinding.test.ts:5,32`、`src/tools/llm_context/index.test.ts:6,49` | `describe('canonicalizeUrl', ...)`；`` describe(`${name} (missing intent)`, ...) `` |
| `it` 名：现在时态的行为句 | `src/utils.test.ts:9,16`、`src/tools/llm_context/index.test.ts:27` | `it('drops tracking parameters', ...)` |
| 断言：`assert.equal` 表格式逐输入；`assert.deepEqual` 比整对象；失败时第三参带诊断载荷 | `src/utils.test.ts:9-26`、`src/tools/llm_context/index.test.ts:30`、`src/server.test.ts:26` | 顺序断言用 `assert.deepEqual(xs.map(...), [...])`（`src/tools/local/formatOpeningHours.test.ts:81-92`） |
| 没有 mock 库：`globalThis.fetch` 用赋值替换、闭包保存原值、`before/after` 里装卸 | `src/testUtils/mcpTestHarness.ts:26-46,53-68` | 库测试的"无 fetch 保护"照此写，不引入 `node:test` 的 `mock` |
| 环境变量隔离：模块级 `as const` 名单，`beforeEach` 删、`afterEach` 恢复 | `src/config.test.ts:8-46` | 新变量家族 `JEV_FILTER_*` 在自己的测试文件里建同样的名单 |
| zod 4：`.describe()` 在前、`.optional()` 最后；输出容忍未知字段用 `.loose()` / `z.looseObject()`；仓库里**没有** `.strict()` / `.strictObject()` / `.passthrough()` | `src/tools/llm_context/schemas/input.ts:133-141`、`schemas/output.ts:14-41`、`src/tools/place_search/schemas/output.ts:12` | 输入声明沿用 `z.object`（默认剥离未知键）；不要用 v3 写法（`z.string().url()`、`error.format()`） |
| 纯解析器失败闭合：坏输入返回 `null`，调用方测 `=== null` | `src/utils.ts:58-81`、`src/BraveAPI/index.ts:34-42`、`src/protocols/rebinding.ts:14-25` | URL 解析失败、JSON 解析失败等都走 `try { ... } catch { return <fallback>; }`，未读错误值时用裸 `catch {` |
| 可失败 IO 返回判别联合，不抛 | `src/utils.ts:7-21` | 描述覆盖文件读取 fail-open 回落 fallback，错误值归一化 `error instanceof Error ? error.message : String(error)` |
| 命名：谓词 `is*`；转换 `normalize*/canonicalize*/parse*/format*/to*`；工厂 `create*/build*`；模块级常量 SCREAMING_SNAKE；查找表 camelCase | `src/protocols/rebinding.ts:14,43,65,77,106`、`src/jsonSchemaDialect.ts:14`、`src/BraveAPI/index.ts:5` | `isFeedUrl`、`canonicalizeUrl`、`parseFilterConfig`、`DEFAULT_BLOCKLIST`、`PAYWALL_MARKERS` |
| 函数声明形式：箭头 `const f = (...) => {}` 为主，`function` 也接受，同一文件保持一致 | `src/protocols/rebinding.ts`（全箭头）、`src/utils.ts`（全 `function`） | 库内每个文件二选一并保持一致 |
| 不用 `any`，用 `unknown` 再收窄 | `src/utils.ts:58`、`src/BraveAPI/index.ts:34` | 对夹具 `sources` 元数据等做 `typeof` / `Array.isArray` 收窄 |
| 入参写时复制，永不改调用方对象 | `src/tools/local/index.ts:36` | `applyOverfetch` 返回 `{ ...params, ... }`，倍数为 1 时返回原对象 |
| 库代码零 `console.log`（stdout 是 stdio 协议通道）；操作员提示用 `console.error` | `src/tools/*`、`src/BraveAPI/index.ts`、`src/jsonSchemaDialect.ts` 全无日志；唯一 `console.log` 在 `src/protocols/http.ts:105`（仅 HTTP 传输可达） | `src/filter/` 里禁止 `console.log`；纯度测试可顺带断言 |
| 注释语言：上游 `src/` 英文；fork 新代码注释简体中文，模型或用户会读到的字符串（描述、`.describe()`、错误文本）保持英文 | `.planning/codebase/CONVENTIONS.md`"Comments"节；`dev/*.py` 先例 | 库文件注释中文；`schemas/input.ts` 的 `.describe()` 文本英文 |
| 非显然契约的导出函数写 `/** */`，含 `@returns` 与逐边角 `@example` | `src/protocols/rebinding.ts:27-42` | `canonicalizeUrl`、`isFeedUrl` 按此写 |
| Prettier 3.8.1：`semi`、单引号、2 空格、`trailingComma: es5`、`printWidth: 100`、`arrowParens: always`；范围仅 `src/**/*.ts` | `.prettierrc`、`package.json:32-33` | 提交前 `npm run format:check`；`npm install` 会触发 `prepare` 静默重写 `src/` |
| `tsconfig`：`strict`、`NodeNext`、`rootDir: src`、`include: src/**/*`；测试文件也编进 `dist/` | `tsconfig.json` | 不从 `fixtures/` 做 `import ... with { type: 'json' }`；运行期数据表写成 `.ts` 常量 |
| 多行工具描述：四空格缩进的模板字符串，末尾 `.trim()` | `src/tools/llm_context/index.ts:20-31` | 新英文描述沿用同一形态 |

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `src/tools/llm_context/index.ts`（改） | controller（MCP 工具模块） | request-response | 自身上游版本 + `src/tools/place_search/index.ts:46-48`（无 structuredContent 的返回） | exact |
| `src/tools/llm_context/schemas/input.ts`（改） | model（zod 输入声明） | request-response | 自身上游版本 + `src/tools/place_search/schemas/input.ts:143-156` | exact |
| `src/tools/llm_context/index.test.ts`（改） | test（in-memory MCP 集成） | request-response | 自身上游版本 + `src/server.test.ts:17-53` + `src/tools/local/index.test.ts:63-65` | exact |
| `src/filter/index.ts` | barrel（库公共入口） | — | `src/protocols/index.ts:1-2` | exact |
| `src/filter/types.ts` | model（结构类型） | — | `src/tools/web/types.ts:1-6` + `src/config.ts:19-30` | exact |
| `src/filter/config.ts` | config（纯函数读 env） | transform | `src/utils.ts:58-81`（`parsePort`）+ `src/config.ts:61-65,126-131` | exact |
| `src/filter/pipeline.ts` | service（十步编排） | transform | `src/protocols/rebinding.ts:106-138`（组合纯助手的工厂） | role-match |
| `src/filter/jsonld.ts` | utility（JSON 判定 + 分流） | transform | `src/BraveAPI/index.ts:34-42`（`normalizeGoggle`）+ `src/utils.ts:58-81` | partial |
| `src/filter/url.ts` | utility（URL 规范化归并） | transform | `src/protocols/rebinding.ts:14-25,43-63` | exact |
| `src/filter/tokenize.ts` | utility（分词、实词、shingle） | transform | `src/utils.ts:23-33`（`parseDelimitedList`）+ `src/utils.ts:35-50` | partial |
| `src/filter/prefilter.ts` | utility（片段预筛谓词） | transform | `src/protocols/rebinding.ts:77-98`（`is*` 谓词吃归一化集合） | role-match |
| `src/filter/nonArticle.ts` | utility（feed / 黑名单 / 空来源 / 付费墙） | transform | `src/utils.ts:52-56` + `src/BraveAPI/index.ts:25-32` | exact |
| `src/filter/blocklist.ts` | config（常量 + 解析器） | — | `src/utils.ts:23-33` + `src/protocols/rebinding.ts:65-75` | exact |
| `src/filter/markers.ts` | config（常量表） | — | `src/jsonSchemaDialect.ts:14` + `src/BraveAPI/index.ts:5-15` | exact |
| `src/filter/budget.ts` | utility（裁预算、超量倍数） | transform | `src/tools/local/index.ts:36` + `src/utils.ts:63-68`（范围夹取） | exact |
| `src/filter/tokens.ts` | utility（token 估算） | transform | `src/utils.ts:35-50`（字符级纯计算） | role-match |
| `src/filter/stats.ts` | utility（统计对象构造） | transform | `src/config.ts:32-44`（带默认值的类型化对象字面量） | partial |
| `src/filter/description.ts` | utility（文件读取 fail-open） | file-I/O | `src/utils.ts:7-21`（`readBraveApiKeyFromFile`） | exact |
| `src/filter/config.test.ts` | test（纯函数表格式 + env） | — | `src/utils.test.ts:8-27` + `src/config.test.ts:8-46` | exact |
| `src/filter/url.test.ts`、`tokenize.test.ts`、`jsonld.test.ts`、`prefilter.test.ts`、`nonArticle.test.ts`、`blocklist.test.ts`、`budget.test.ts`、`tokens.test.ts` | test（纯函数单测） | — | `src/protocols/rebinding.test.ts:1-30` + `src/utils.test.ts` | exact |
| `src/filter/pipeline.test.ts` | test（三模式无 fetch） | — | `src/testUtils/mcpTestHarness.ts:26-46`（赋值替换 fetch）+ `src/server.test.ts:8-15`（`before/after`） | role-match |
| `src/filter/pipeline.fixtures.test.ts` | test（夹具驱动、期望文件） | file-I/O | `src/tools/local/formatOpeningHours.test.ts:13-30,81-92` + `src/protocols/stdio.test.ts:11` | partial |
| `src/filter/purity.test.ts` | test（源码扫描） | file-I/O | `src/server.test.ts:38-42`（循环 + 带名字的断言消息） | role-match |
| `src/testUtils/braveFixtures.ts`（或 RESEARCH 建议的 `src/filter/testFixtures.ts`） | test helper（三形状夹具加载器） | file-I/O | `src/testUtils/mcpTestHarness.ts`（共享测试辅助的落点）+ `src/protocols/stdio.test.ts:11` | exact |
| `fixtures/expected/**/*.off.json` | data（手工标注期望） | — | 无（现有测试全部内联载荷，没有任何测试读 `fixtures/`） | none |

## Pattern Assignments

### 触点 1：`src/tools/llm_context/index.ts`（controller, request-response）

**Analog:** 自身上游版本（改动必须是连续小块，便于 `git merge upstream/main` 后重放）；返回形状参照 `src/tools/place_search/index.ts`。

**Imports pattern**（`src/tools/llm_context/index.ts:1-11`，新 import 追加在第 11 行之后，压缩冲突面）：
```ts
import type { TextContent, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import API from '../../BraveAPI/index.js';
import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  RequestParamsSchema,
  RequestHeadersSchema,
  LlmContextInputSchema,
  type LlmContextInput as QueryParams,
} from './schemas/input.js';
import { LlmContextSearchApiResponseSchema } from './schemas/output.js';
```

**Core pattern：`execute` 的"两次 parse 拆分 → 请求 → safeParse → 返回"**（`src/tools/llm_context/index.ts:33-46`，唯一插入点在 `safeParse` 之后、`return` 之前，只在 `success` 分支运行）：
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
- `RequestParamsSchema.parse` 因 `z.object` 默认剥离未知键，`intent` 不进 `RequestParamsSchema` 就不会转发给 Brave；`intent` 只从原始 `params.intent` 取。
- 去 `structuredContent` 后的返回形状照 `src/tools/place_search/index.ts:46-48`：
```ts
  return {
    content: [{ type: 'text', text: JSON.stringify(response) } as TextContent],
    isError: false,
```

**Register / default export pattern**（`src/tools/llm_context/index.ts:48-70`，各删一行 `outputSchema`；`description` 一行改为库函数调用）：
```ts
export const register = (mcpServer: McpServer) => {
  mcpServer.registerTool(
    name,
    {
      title: name,
      description: description,
      inputSchema: LlmContextInputSchema,
      outputSchema: LlmContextSearchApiResponseSchema,   // 删
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
  outputSchema: LlmContextSearchApiResponseSchema.shape, // 删
  execute,
  register,
};
```
- 两处必须同删：`src/jsonSchemaDialect.ts:75-77` 只在默认导出有 `outputSchema` 且 `tools/list` 带它时才重发；`src/server.test.ts:44-51` 只在 `outputSchema` 存在时编译它。删干净后两处自然跳过。
- 方言补丁用**默认导出的 `.shape`** 重生成 `tools/list` 的 inputSchema（`src/jsonSchemaDialect.ts:21-29,71-73`）：
```ts
const schemaShapesByTool = new Map<string, ToolSchemaShapes>(
  Object.values(tools).map((tool) => [tool.name, tool as ToolSchemaShapes])
);

const toJsonSchema2020 = (shape: ZodRawShape, io: 'input' | 'output'): Tool['inputSchema'] =>
  z.toJSONSchema(z.object(shape), {
    target: 'draft-2020-12',
    io,
  }) as unknown as Tool['inputSchema'];
```
  所以参数描述必须在 `schemas/input.ts` 构建 schema 时固定，`register()` 里只能覆盖工具 `description`。

**Description pattern**（`src/tools/llm_context/index.ts:20-31`，四空格缩进模板字符串 + `.trim()`）：
```ts
export const description = `
    Retrieves pre-extracted, relevance-ranked web content using Brave's LLM Context API, ...

    When to use:
        - Grounding answers in fresh, relevant web content (RAG)
        ...
    When relaying results in markdown-supporting environments, cite the source URLs from the "sources" map.
`.trim();
```

**Env 读取时机**（`src/server.ts:1-5`，tools 先于 config 求值，`dotenv.config()` 在 `src/config.ts:7` 才跑）：
```ts
import tools from './tools/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import pkg from '../package.json' with { type: 'json' };
import { isToolPermittedByUser } from './config.js';
import enforce2020Dialect from './jsonSchemaDialect.js';
```
  适配行在 `execute()` 调用时传 `process.env`（或库入口省略 `config` 时自行读），绝不在模块顶层读。

---

### 触点 2：`src/tools/llm_context/schemas/input.ts`（model, request-response）

**Analog:** 自身上游版本；第二参照 `src/tools/place_search/schemas/input.ts`（同一 `RequestParamsSchema` / `RequestHeadersSchema` / `XInputSchema` 三件套布局）。

**文件头注释**（`src/tools/llm_context/schemas/input.ts:1-6`，保留）：
```ts
import { z } from 'zod';

/**
 * Keep up-to-date with documentation:
 * https://api-dashboard.search.brave.com/api-reference/summarizer/llm_context/get
 */
```

**字段写法：builder 链 → `.describe()` → `.optional()` 最后**（`src/tools/llm_context/schemas/input.ts:117-141`）：
```ts
export const RequestParamsSchema = z.object({
  query: z
    .string()
    .trim()
    .min(1)
    .max(400)
    .refine((str) => str.split(/\s+/).length <= 50, 'Query cannot exceed 50 words')
    .describe(
      "The user's search query term. Query can not be empty. Maximum of 400 characters and 50 words in the query."
    ),
  country: CountryCodesSchema.describe(
    'The search query country, where the results come from. The country string is limited to 2 character country codes of supported countries.'
  ).optional(),
  ...
  count: z
    .number()
    .int()
    .min(1)
    .max(50)
    .describe(
      'The maximum number of search results considered to select the LLM context data. The default is 20 and the maximum is 50.'
    )
    .optional(),
```
- `intent` 沿用 `query` 的链式形态：`z.string().trim().min(1).max(500).describe('...')`，不加 `.optional()`（必填）。
- `.describe()` 文本是模型可见文档，写完整英文句子并说明默认与范围（CONVENTIONS "JSDoc/TSDoc"节）。

**要整体替换的块**（`src/tools/llm_context/schemas/input.ts:277-284`，只动 `LlmContextInputSchema` 的定义，三个类型导出名与 `RequestParamsSchema` / `RequestHeadersSchema` 原样保留，`src/BraveAPI/types.ts` 与 `execute` 的两次 `parse` 不受影响）：
```ts
export const LlmContextInputSchema = z.object({
  ...RequestParamsSchema.shape,
  ...RequestHeadersSchema.shape,
});

export type LlmContextInput = z.input<typeof LlmContextInputSchema>;
export type LlmQueryParams = z.infer<typeof RequestParamsSchema>;
export type LlmRequestHeaders = z.infer<typeof RequestHeadersSchema>;
```
  新写法用 `RequestParamsSchema.pick({...})` 取白名单，再 `Picked.shape.<key>.describe('...')` 逐字段换英文描述（RESEARCH "zod 写法"节给出了完整草图）。`.pick()` 的键必须与上游现有键一致，否则 `tsc` 报错，这正好把"上游新参数默认不暴露"变成编译期契约。

**Strictness 观察**：仓库里没有 `.strict()`、`z.strictObject()`、`.passthrough()`；输入声明全部是默认 `z.object`（剥离未知键），输出容忍未知字段用 `.loose()`（`src/tools/llm_context/schemas/output.ts:14-41`）或 `z.looseObject()`（`src/tools/place_search/schemas/output.ts:12`）。新声明沿用默认 `z.object`，模型多传字段时被剥离而不是报错。

**Upstream 范围值可直接复用**：`maximum_number_of_urls` `.max(50)`（`:143-149`）、`maximum_number_of_tokens` `.min(1024).max(32768)`（`:150-158`）——`applyOverfetch` 的夹取上限就取这两个数。

---

### 触点 2/3 的测试伴随：`src/tools/llm_context/index.test.ts`（test, request-response）

**Analog:** 自身上游版本（结构保留，断言换）；`tools/list` 断言参照 `src/server.test.ts`；文本载荷解析参照 `src/tools/local/index.test.ts`。

**Suite 骨架**（`src/tools/llm_context/index.test.ts:1-8,27-30`，`useTestClient` 在 `describe` 体内调用，responder 按 `url.pathname` 匹配）：
```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { useTestClient } from '../../testUtils/mcpTestHarness.js';
import { name } from './index.js';

describe(name, () => {
  const getClient = useTestClient((url) => {
    if (url.pathname === '/res/v1/llm/context') {
      return { /* 最小合法上游载荷 */ };
    }
  });

  it('returns grounding content for a simple query', async () => {
    const result = await getClient().callTool({ name, arguments: { query: 'brave browser' } });

    assert.equal(result.isError ?? false, false, JSON.stringify(result.content));
```
- 上游第 31-45 行 `assert.deepEqual(result.structuredContent, {...})` 必须换成解析 `content[0].text`；第 28、61 行的 `arguments` 必须加 `intent`（否则 SDK 在 `execute` 之前拒绝）。
- responder 只能看到 `URL`；在里面 `assert.equal(url.searchParams.has('intent'), false)` 即可证明 `intent` 未转发给 Brave；计数 `/res/v1/llm/context` 命中次数证明没有第二个出站调用（`src/testUtils/mcpTestHarness.ts:33-35` 对未模拟 pathname 抛 `Unmocked Brave API request`）。

**文本载荷解析**（`src/tools/local/index.test.ts:63-65`）：
```ts
    const content = result.content as { text: string }[];

    assert.match(content[0].text, /Falling back to general web search/);
```
  本阶段改为 `JSON.parse(content[0].text)` 后对对象断言（sources 三键、`age` 单元素）。

**`tools/list` 断言**（`src/server.test.ts:17-27`，取工具后逐项断言并带 `${tool.name}` 消息）：
```ts
  it('lists every registered tool with a valid input schema', async () => {
    const { tools: listedTools } = await client.listTools();
    ...
    for (const tool of listedTools) {
      assert.ok(tool.inputSchema, `${tool.name} is missing an inputSchema`);
    }
  });
```
  本阶段：`tools.find((t) => t.name === name)` 后断言 `Object.keys(tool.inputSchema.properties)` 等于白名单加 `intent`、`required` 为 `['query', 'intent']`、`tool.outputSchema === undefined`、`description` 匹配 `/name the current version and its defining mechanism/`、`$schema` 仍为 2020-12（方言补丁未失效）。

**场景变体命名**（`src/tools/llm_context/index.test.ts:49`）：
```ts
describe(`${name} (malformed upstream response)`, () => {
```
  缺 `intent` 的拒绝用例可作第三个 `describe` 或同 suite 内的 `it`。

**环境隔离**：经过 `execute()` 的测试要在 `before` 删 `JEV_FILTER_MODE`、`JEV_FILTER_OVERFETCH_FACTOR`、`JEV_FILTER_TOOL_DESCRIPTION_FILE` 并在 `after` 恢复——名单形式照 `src/config.test.ts:8-20`（见 Shared Patterns "环境变量隔离"）。`useTestClient` 只注册 `before/after`，可在同一 `describe` 里再加一对自己的 `before/after`（`node:test` 允许多个钩子，按注册顺序执行）。

---

### `src/filter/index.ts`（barrel）

**Analog:** `src/protocols/index.ts:1-2`
```ts
export { default as stdioServer } from './stdio.js';
export { default as httpServer } from './http.js';
```
- 库入口用具名 re-export：`export { filterLlmContext } from './pipeline.js'; export { parseFilterConfig } from './config.js'; export { applyOverfetch } from './budget.js'; export type { ... } from './types.js';`。
- CONVENTIONS 说"没有其他 barrel，直接导入具体文件"——`src/filter/index.ts` 是有意的例外：它是库对宿主的**唯一**公共面（触点 1 只 import 这一条路径），库内部模块之间仍直接导入具体文件，不经过 `index.ts`（避免循环）。

---

### `src/filter/types.ts`（model）

**Analog:** `src/tools/web/types.ts:1-6`（`type` 别名描述本地形状）+ `src/config.ts:19-30`（配置类型）
```ts
export type FormattedWebResults = {
  url: string;
  title: string;
  description?: string;
  extra_snippets?: string[];
}[];
```
```ts
type Configuration = {
  transport: 'stdio' | 'http';
  port: number;
  ...
};
```
- 用 `type`（zod 推导型、联合、本地形状都用 `type`；`interface` 只用于逐字段抄 Brave 文档的手写响应接口，本库不需要）。
- Brave 线上字段保持 snake_case（`maximum_number_of_urls`、`age`），库内部自己的字段 camelCase（`overfetchFactor`）；统计对象里的计数键 RESEARCH 已定为 snake_case（`jsonld_converted` 等）——因为它们要原样进 JSONL 日志，按"镜像线上字段用 snake_case"的规则处理。
- `BraveLlmContextResponse` 按结构重新声明，**不**从 `src/tools/llm_context/schemas/output.ts` 引 `LlmContextSearchApiResponse`——纯度测试会拦截 `from '../tools/...'`。

---

### `src/filter/config.ts`（config, transform）

**Analog:** `src/utils.ts:58-81`（`parsePort`：纯函数、`unknown` 入参、坏值回落）+ `src/config.ts:61-65,126-131`（env 默认值与白名单校验）

**纯解析器形态**（`src/utils.ts:58-81`）：
```ts
export function parsePort(value: unknown): number | null {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < 1 || value > 65535) {
      return null;
    }
    return value;
  }

  const text = String(value).trim();
  if (!/^\d+$/.test(text)) {
    return null;
  }

  const parsed = Number.parseInt(text, 10);
  if (parsed < 1 || parsed > 65535) {
    return null;
  }

  return parsed;
}
```
  `parseFilterConfig(env)` 与之的差别：坏值不返回 `null` 而是回落默认（`off` / `1`），因为 EMBED-02 要求"未设即 off"，且过滤层永远不能让服务器启动失败。

**env 默认值与白名单校验**（`src/config.ts:61-65,126-131`）：
```ts
    .option(
      '--transport <stdio|http>',
      'transport type',
      process.env.BRAVE_MCP_TRANSPORT ?? 'stdio'
    )
```
```ts
  if (!['stdio', 'http'].includes(options.transport)) {
    console.error(
      `Invalid --transport value: '${options.transport}'. Must be one of: stdio, http.`
    );
    return false;
  }
```
  库版本：`const MODES = new Set(['off', 'shadow', 'on'])`，`MODES.has(raw) ? raw : 'off'`；**不** `console.error`（库零日志），**不**读 `process.env`（入参 `env: Record<string, string | undefined>`，调用方传 `process.env`）。
- **不要**把 `JEV_FILTER_*` 加进 `src/config.ts`：那是第四处改动，且是上游最常改的文件。STRUCTURE.md "Where to Add New Code" 的旧建议（"new env vars go through `src/config.ts`"）被 PLAN §3.1 的三处限制覆盖，以 RESEARCH A3 为准。

**Test analog:** `src/utils.test.ts:8-27`（表格式，显式输入）：
```ts
describe('parsePort', () => {
  it('accepts valid integer ports', () => {
    assert.equal(parsePort(8080), 8080);
    assert.equal(parsePort('8080'), 8080);
    ...
  });

  it('rejects non-numeric and out-of-range values', () => {
    assert.equal(parsePort('abc'), null);
    ...
  });
});
```
  `parseFilterConfig({})`、`{ JEV_FILTER_MODE: 'shadow' }`、`' ON '`、`'banana'`、`{ JEV_FILTER_OVERFETCH_FACTOR: '0.5' }` 逐个 `assert.equal` / `assert.deepEqual`。纯函数测试传显式对象，**不需要**碰 `process.env`。

---

### `src/filter/pipeline.ts`（service, transform）

**Analog:** `src/protocols/rebinding.ts:106-138`（`createDnsRebindingGuard`：入口把注入的集合归一化一次，然后按固定顺序调用私有谓词，每个谓词只回答一个问题）

```ts
export const createDnsRebindingGuard = (options: {
  allowedOrigins: string[];
  allowedHosts: string[];
}): RequestHandler => {
  const allowedOrigins = toNormalizedSet(options.allowedOrigins, canonicalizeOrigin);
  const allowedHosts = toNormalizedSet(options.allowedHosts, normalizeHost);
  const enforceHost = allowedHosts.size > 0;

  return (req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;

    if (origin !== undefined) {
      // Origin may be undefined (non-browser MCP clients omit it), but any
      // present Origin must be validated.
      if (typeof origin !== 'string' || !isOriginAllowed(origin, allowedOrigins)) {
        sendForbidden(res, 'Forbidden: invalid Origin');
        return;
      }
    }

    if (enforceHost) {
      ...
    }

    next();
  };
};
```
- 对应到 `filterLlmContext(data, request, config?, deps?)`：先算一次实词集与配置，再按十步顺序调用各模块的纯函数；每一步只在"工作表"上翻 `kept` / `verdict` / `reason`，**不 `sort`、不 `filter` 出新数组**，最后一次性重建输出（RESEARCH "Pattern 1: 工作表 + 单向标记"）。
- 与 `rebinding.ts` 一样，**可单测的小函数导出**，组合入口是唯一给宿主用的东西（CONVENTIONS "Pure-library modules export named functions and one factory"）。
- 模块私有助手用 `const` 箭头函数、声明在文件里被用之前（`src/protocols/rebinding.ts:5,9,65,77,93`）。
- 防御性访问上游可选字段用 `?.` 与 `|| []`（CONVENTIONS "Error Handling"最后一条）：`(source.snippets || [])`、`sources?.[url]`。

**Test analog（三模式无 fetch）:** `src/filter/pipeline.test.ts` 照 `src/testUtils/mcpTestHarness.ts:26-46` 的"赋值替换 + 闭包保存 + 恢复"写，钩子形式照 `src/server.test.ts:8-15`：
```ts
describe('MCP server <-> SDK Client wiring (in-memory)', () => {
  let client: Client;

  before(async () => {
    client = await connectTestClient();
  });

  after(() => client.close());
```
  RESEARCH "无 fetch 保护（库测试）"给出了改写后的具体代码；`for (const mode of ['off', 'shadow', 'on'] as const)` 循环生成三个 `it` 即可。

---

### `src/filter/url.ts`（utility, transform）

**Analog:** `src/protocols/rebinding.ts:14-25,43-63`（WHATWG `URL` 包在 `try/catch` 里、失败返回哨兵、只用 `URL` 的属性不手写正则拆 URL）

```ts
export const canonicalizeOrigin = (value: string): string | null => {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;

  try {
    const origin = new URL(trimmed).origin;
    // URL.origin may be 'null' for opaque origins, e.g. 'blob:'.
    return origin === 'null' ? null : origin;
  } catch {
    return null;
  }
};
```
```ts
export const normalizeHost = (value: string): string | null => {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;

  // A Host header carries only "host[:port]"; any path delimiter is malformed.
  if (trimmed.includes('/') || trimmed.includes('\\')) return null;

  let url: URL;
  try {
    url = new URL(`http://${trimmed}`);
  } catch {
    return null;
  }

  // A Host header carries only "host[:port]"; anything else is malformed.
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    return null;
  }

  return stripBrackets(url.hostname);
};
```
- `canonicalizeUrl(raw)` 的差别：解析失败时返回**原串**而不是 `null`（原串作合并键 → 永远不与别人合并，方向保守）；只改 `protocol` / `hash` / `hostname` / `searchParams` / `pathname`，输出不带 scheme 的键字符串；**输出永远保留 Brave 原始 URL**，规范键只用于合并。
- JSDoc 形态照 `src/protocols/rebinding.ts:27-42`（`@returns` + 逐边角 `@example`），`canonicalizeUrl` 与 `isFeedUrl` 至少各列 AMP、跟踪参数、尾斜杠、`feedback` 反例。

**Test analog:** `src/protocols/rebinding.test.ts:5-30`（每个边角一个 `it`，`assert.equal(fn(input), expected)` 表格式）：
```ts
describe('canonicalizeOrigin', () => {
  it('returns the canonical scheme://host[:port] form', () => {
    assert.equal(canonicalizeOrigin('https://example.com'), 'https://example.com');
    ...
  });

  it('lowercases scheme and host', () => {
    assert.equal(canonicalizeOrigin('HTTPS://Example.COM'), 'https://example.com');
  });

  it('drops the default port for the scheme', () => {
    ...
  });

  it('ignores path, query, and fragment', () => {
    ...
  });

  it('returns null for unparseable values', () => {
    ...
  });
});
```
  RESEARCH 列出的 16 类边角（大小写 host、默认端口、IDN、非默认端口、`?amp` 无值等）逐一成为 `it`；合并语义用合成的两条同页 URL 断言"后者 `verdict: 'drop', reason: 'merged'`、片段追加到首见者、逐字相等片段去掉"。

---

### `src/filter/jsonld.ts`（utility, transform）— partial

**Analog:** `src/BraveAPI/index.ts:34-42`（`normalizeGoggle`：`typeof` 收窄 + 正则判形 + 失败返回 `null`）+ `src/utils.ts:58-81`（`parsePort`：逐层收窄 `unknown`）

```ts
const normalizeGoggle = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (/^https?:\/\//i.test(trimmed)) {
    return isValidGoggleURL(trimmed) ? trimmed : null;
  }
  return trimmed;
};
```
- JSON-LD 判定同形：`trim()` 后首字符 `{` 或 `[` → `try { JSON.parse } catch { return null }` → 结果必须是对象或数组，否则 `null`（"不是 JSON-LD，当普通文本"）。
- 键访问：`Object.hasOwn(obj, 'articleBody')` + 固定键名，不用 `in`、不 spread 解析结果（RESEARCH 安全节）。
- 元数据键表与正文键表写成模块级 `ReadonlySet<string>` 常量（命名形态见 `markers.ts`）。
- **无类比的部分**：递归遍历 `mainEntity[]` / `step[]` / `suggestedAnswer[]` 并拼成 `Q: …\nA: …` 段——仓库里没有树遍历代码，按 RESEARCH "规则 1" 的顺序自行实现。

**Test analog:** `src/tools/local/formatOpeningHours.test.ts:13-30`（真实响应节选作为模块级常量，`/** Captured from ... */` 注释说明它覆盖哪些性质）：
```ts
/**
 * Captured from a real `/res/v1/local/pois` response (Zuni Café, San Francisco).
 * Exercises the two properties that matter most in production payloads:
 *   - `current_day` holding two intervals (lunch service and dinner service)
 *   - `days` being an array-of-arrays, where a day may hold multiple intervals
 */
const splitServiceHours: OpeningHours = {
```
  单元测试里的合成 `articleBody` / `description` / HowTo `step` 样本按此写（内联、只含被测字段、注释说明模拟什么）；真实夹具上的五种情形交给 `pipeline.fixtures.test.ts`。

---

### `src/filter/tokenize.ts`（utility, transform）— partial

**Analog:** `src/utils.ts:23-33`（`parseDelimitedList`：split → map trim → filter 非空）+ `src/utils.ts:35-50`（`isIpv4Loopback`：字符级纯计算，行内注释解释每个检查）

```ts
export function parseDelimitedList(value: string | string[] | undefined | null): string[] {
  if (value == null) return [];

  // Value may be variadic as string[]. Normalize to a single string first.
  const raw = Array.isArray(value) ? value.join(' ') : value;

  return raw
    .split(/[\s,]+/)
    .map((o: string) => o.trim())
    .filter((o: string) => o.length > 0);
}
```
- `tokenize(text)`：`text.toLowerCase().matchAll(/\p{Script=Han}+|[\p{L}\p{N}]+/gu)`，Han 连续段转字符二元；`contentTerms(query, intent)`：tokenize 后 `filter((t) => !STOPWORDS.has(t))`。
- **无类比的部分**：`shingles` / `jaccard` / `containment`——直接用 RESEARCH "Code Examples: 5-gram shingle 与两种相似度"的实现。

**Test analog:** `src/utils.test.ts:29-76`（同一函数按输入类别分多个 `it`，注释解释为何某输入不匹配）：
```ts
  it('rejects non-loopback hostnames and non-normalized input', () => {
    assert.equal(isLoopbackHostname('example.com'), false);
    // Callers normalize (lowercase) before calling, so uppercase is not matched.
    assert.equal(isLoopbackHostname('LOCALHOST'), false);
  });
```
  必有一个 `it` 用中文合成片段证明 Han 段被切成二元而不是粘成一个 token（RESEARCH Pitfall 9）。

---

### `src/filter/prefilter.ts`（utility, transform）

**Analog:** `src/protocols/rebinding.ts:77-98`（`is*` 谓词接收已归一化的集合，先做空值检查，再做一次判定；集合由调用方构造一次、多次复用）

```ts
const isHostAllowed = (hostHeader: string, allowedHosts: Set<string>): boolean => {
  const host = normalizeHost(hostHeader);
  if (host === null) return false;

  return isLoopbackHostname(host) || allowedHosts.has(host);
};
```
- `stripBoilerplateLines(text, prefixes)`、`isShortWithoutTerms(text, terms)`、`isNearDuplicate(shinglesA, shinglesB)` 都按此形态：实词集与样板前缀由 `pipeline.ts` 算一次传进来，谓词本身无状态。
- 行匹配用 `startsWith` / 行级比较，不用无界正则（RESEARCH 安全节 ReDoS 一条）。

**Test analog:** `src/protocols/rebinding.test.ts:32-76`（正例 / 反例 / 边角各一个 `it`）。样板行剥离的三个真实反例（heise、pasqualepillitteri、kucoin）在夹具测试里断言，单元测试用短内联字符串。

---

### `src/filter/nonArticle.ts`（utility, transform）

**Analog:** `src/utils.ts:52-56`（`isLoopbackHostname`：一行注释说明判定范围，谓词组合）+ `src/BraveAPI/index.ts:25-32`（`isValidGoggleURL`：`new URL` 在 `try/catch` 里、只读一个属性）

```ts
// Determines whether a bare hostname refers to the loopback interface: any
// IPv4 127.0.0.0/8 address, the IPv6 loopback (::1), or "localhost".
export function isLoopbackHostname(value: string): boolean {
  return value === 'localhost' || value === '::1' || isIpv4Loopback(value);
}
```
```ts
const isValidGoggleURL = (url: string): boolean => {
  try {
    // Only allow HTTPS URLs
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
};
```
- `isFeedUrl(raw)`：`new URL` 失败返回 `false`（保守：判不出就不是 feed）；hostname 与 pathname 按 `/ . - _` 切 token 后与 `FEED_TOKENS` 集合比，末段后缀与 `feeds.` 前缀单独判；查询参数 `url.searchParams.has('feed')`。
- `isBlocklisted(canonicalHost, blocklist)`：精确命中或 `host.endsWith('.' + entry)`。
- `truncateAtPaywall(text, markers)`：按行扫描，返回 `{ text, truncated }`；`isEmptySource` / `isOneLiner` 只看已幸存片段。

**Test analog:** `src/utils.test.ts:29-76`（正反例分 `it`，尤其 `feedback` / `newsfeed-article` / `grassroots` 三个子串陷阱各一行 `assert.equal(isFeedUrl(...), false)`）。黑名单正例用注入 `new Set(['farm.example'])`，不改默认表。

---

### `src/filter/blocklist.ts` 与 `src/filter/markers.ts`（config 常量）

**Analog（解析器）:** `src/utils.ts:23-33`（`parseDelimitedList`）+ `src/protocols/rebinding.ts:65-75`（`toNormalizedSet`：把字符串数组经归一化函数收进 `Set`，无效项静默丢弃）
```ts
const toNormalizedSet = (
  values: string[],
  normalize: (value: string) => string | null
): Set<string> => {
  const set = new Set<string>();
  for (const value of values) {
    const normalized = normalize(value);
    if (normalized !== null) set.add(normalized);
  }
  return set;
};
```
  `parseBlocklist(text): Set<string>`：按行 split → 去 `#` 注释与空白 → 小写去 `www.` → `Set`。

**Analog（常量形态）:** `src/jsonSchemaDialect.ts:14`（SCREAMING_SNAKE 模块常量 + 出处注释）与 `src/BraveAPI/index.ts:5-15`（camelCase 查找表，`Record` 类型让缺项成编译错误）：
```ts
/**
 * The dialect servers MUST emit by default, per SEP-1613 §5.
 * https://modelcontextprotocol.io/seps/1613-establish-json-schema-2020-12-as-default-dialect-f
 */
const JSON_SCHEMA_2020_12 = 'https://json-schema.org/draft/2020-12/schema';
```
```ts
const typeToPathMap: Record<keyof Endpoints, string> = {
  images: '/res/v1/images/search',
  ...
};
```
- `blocklist.ts`：`export const DEFAULT_BLOCKLIST_TEXT = \`\n# one canonical host per line ...\n\`` + `export const DEFAULT_BLOCKLIST = parseBlocklist(DEFAULT_BLOCKLIST_TEXT)`；初始只有注释与格式示例（RESEARCH A14）。
- `markers.ts`：`PAYWALL_MARKERS_EN`、`PAYWALL_MARKERS_ZH`、`BOILERPLATE_PREFIXES` 三个 `readonly string[]`（`as const`）；中文注释说明"老大有新写法随时补"。
- 数据表必须是 `.ts` 常量：`tsc` 不拷贝 `.txt` / `.json` 进 `dist/`（STRUCTURE.md "Data files the library needs at runtime"）。

---

### `src/filter/budget.ts`（utility, transform）

**Analog:** `src/tools/local/index.ts:36`（入参写时复制）+ `src/utils.ts:63-68`（范围检查）
```ts
  params = { ...params, result_filter: [...(params.result_filter || []), 'web', 'locations'] };
```
- `applyOverfetch(params, config)`：`config.overfetchFactor === 1` 时 `return params`（恒等，保证 diff 里的适配行在默认配置下零行为差异）；否则 `return { ...params, maximum_number_of_urls: Math.min(50, Math.floor(...)), maximum_number_of_tokens: Math.min(32768, Math.floor(...)) }`，只在原值存在时放大，`maximum_number_of_tokens_per_url` 不动。上限 50 / 32768 与 `schemas/input.ts:147,154` 的 `.max()` 同值——注释里写明来源，避免将来两边漂移。
- `trimToBudget(worksheet, request, estimate)`：按 Brave 序取前 N（翻 `verdict`，不切数组），总 token 超预算时从最后一个幸存来源的末尾片段开始翻 `kept: false`；来源片段删光则 `reason: 'budget'` 并继续砍前一源。

**Test analog:** `src/tools/local/formatOpeningHours.test.ts:81-92`（顺序断言）：
```ts
  it('preserves the order in which days are returned by the API', () => {
    const result = formatOpeningHours(splitServiceHours)!;

    assert.deepEqual(Object.keys(result), [
      'today (friday)',
      'tuesday',
      ...
    ]);
  });
```
  裁剪后 `assert.deepEqual(result.grounding.generic.map((s) => s.url), expectedUrls)`；夹取用 `assert.equal(applyOverfetch({ maximum_number_of_urls: 50 }, { ...cfg, overfetchFactor: 2 }).maximum_number_of_urls, 50)`；恒等用 `assert.equal(applyOverfetch(p, cfg), p)`（同一引用）。

---

### `src/filter/tokens.ts`（utility, transform）

**Analog:** `src/utils.ts:35-50`（`isIpv4Loopback`：一个导出前的私有纯计算，行内注释解释每一步的规则）
```ts
function isIpv4Loopback(value: string): boolean {
  // Check complete range of loopback addresses: 127.0.0.0/8
  const parts = value.split('.');
  return (
    parts.length === 4 &&
    parts[0] === '127' &&
    parts.every((part: string) => {
      if (!/^\d+$/.test(part)) return false;
      // Leading zeros are not allowed.
      if (part.length > 1 && part.startsWith('0')) return false;
      ...
    })
  );
}
```
- `estimateTokens(text): number` 按 `notes/jev-api.md` 的无分词器公式实现，每一项权重旁边写中文注释说明来源；Phase 2 的 32k 保护复用同一函数，不要复制。

**Test analog:** `src/utils.test.ts:8-27`（表格式；英文句、数字串、CJK 串、混合串各一行）。

---

### `src/filter/stats.ts`（utility）— partial

**Analog:** `src/config.ts:32-44`（类型化对象字面量给出全部默认值，字段顺序与类型声明一致）
```ts
const state: Configuration & { ready: boolean } = {
  transport: 'stdio',
  port: 8080,
  host: '127.0.0.1',
  braveApiKey: process.env.BRAVE_API_KEY ?? '',
  loggingLevel: 'info',
  ready: false,
  ...
};
```
- `createFilterStats(mode, request, data): FilterStats`：工厂返回**新对象**（不像 `config.ts` 那样做模块级单例——库必须无状态，`stats` 随每次调用产生），`local` 各计数初始化为 0，`jev: null`、`shadow_diff: null`。
- `zeroLocal` 常量导出给夹具测试用 `{ ...zeroLocal, ...expected.final.local }` 合并。
- **无类比的部分**：计数器随管道推进递增——仓库里没有累加器模式，按 RESEARCH "统计对象"的字段表实现即可。

---

### `src/filter/description.ts`（utility, file-I/O）

**Analog:** `src/utils.ts:7-21`（`readBraveApiKeyFromFile`：`readFileSync(path, 'utf8').trim()`、空文件视为失败、`catch (error)` 归一化错误文本）
```ts
type ReadBraveApiKeyFromFileResult = { ok: true; key: string } | { ok: false; error: string };

export function readBraveApiKeyFromFile(filePath: string): ReadBraveApiKeyFromFileResult {
  try {
    const key = readFileSync(filePath, 'utf8').trim();
    if (key.length === 0) {
      return { ok: false, error: `API key file is empty: ${filePath}` };
    }

    return { ok: true, key };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `Unable to read API key file '${filePath}': ${reason}` };
  }
}
```
- `resolveToolDescription(fallback, env = process.env): string`：变量未设 → `fallback`；读到空文件或超长（如 8 KB）→ `fallback`；异常 → `fallback`，可 `console.error` 一句英文提示（**不可** `console.log`）。这是库里唯一允许的 `console.error`，且只在 `register()` 调用时触发一次。
- 调用点在 `register()`：`description: resolveToolDescription(description)`，与去 `outputSchema` 同属触点 1 的 `register` 块；模块级 `export const description` 保持通用英文。

**Test analog:** `src/utils.test.ts:78-113`（真实临时文件，不 mock fs）：
```ts
  it('reads and trims API keys from a file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'brave-api-key-'));
    const filePath = join(dir, 'key.txt');
    writeFileSync(filePath, 'test-api-key\n');

    const result = readBraveApiKeyFromFile(filePath);
    ...
  it('reports missing files with the path and reason', () => {
    const result = readBraveApiKeyFromFile('definitely-not-a-real-api-key-file');
```
  用例：未设变量 → fallback；指向临时文件 → 文件内容；指向不存在路径 → fallback（并把 `console.error` 换成 no-op，照 `src/config.test.ts:31-33`）。

---

### `src/filter/pipeline.fixtures.test.ts` + 夹具加载器（test, file-I/O）— partial

**Analog（路径解析）:** `src/protocols/stdio.test.ts:11`
```ts
const entrypoint = fileURLToPath(new URL('../index.ts', import.meta.url));
```
  从 `src/filter/` 出发到仓库根是**两级**：`new URL('../../fixtures/', import.meta.url)`（TESTING.md 示例是从 `src/tools/llm_context/` 出发的三级，不要照抄）。若加载器放在 `src/testUtils/`，同样是两级。

**Analog（加载器落点）:** `src/testUtils/mcpTestHarness.ts`——共享测试辅助住在 `src/testUtils/`（STRUCTURE.md "Utilities → Test-only helpers: `src/testUtils/`"）。建议命名 `src/testUtils/braveFixtures.ts` 导出 `loadBraveFixture(rel)`，返回类型从 `../filter/types.js` 引 `BraveLlmContextResponse`；这样 `src/filter/` 下只有产品代码与 `.test.ts`，纯度测试的"非测试文件"扫描不需要额外排除项。RESEARCH 提到的 `src/filter/testFixtures.ts` 也可行，但要记得它会被纯度扫描覆盖（它只 import `node:fs` / `node:url`，本身能过）。

**三种夹具形状（本会话核实）：**

| 形状 | 文件 | 顶层键 |
|---|---|---|
| wrapped | `fixtures/jev_release_default.json`、`jev_release_strict.json` | `request, fetched_at, latency_s, response`；`request` 含 `q, count, maximum_number_of_urls, maximum_number_of_tokens, maximum_number_of_tokens_per_url, freshness` |
| bare | `fixtures/sanity/sample1..6_*.json` | `grounding, sources`；`grounding` 含 `generic, map` |
| noise | `fixtures/noise/*.txt` | `generic`（**单个对象**，键 `url, title, snippets`）与 `source`（**单数**） |

  `sources[url]` 实际键为 `title, hostname, age, snippet`，`age` 为 4 元数组（首个 ISO 日期在索引 1）。加载器代码直接用 RESEARCH "Code Examples: 三种夹具的加载器"。

**换行：** `git ls-files --eol` 显示 JSON 夹具 `i/lf w/crlf`、noise `.txt` `i/crlf w/crlf`——只比较 `JSON.parse` 后的对象，不比字符串。

**Analog（真实数据 + 顺序断言）:** `src/tools/local/formatOpeningHours.test.ts:13-30,81-92`（见 `budget.ts` 一节）。

**Analog（"每条标注一个 it"的失败消息形态）:** `src/server.test.ts:38-42`：
```ts
    for (const tool of listedTools) {
      assert.doesNotThrow(
        () => ajv.compile(tool.inputSchema),
        `${tool.name} has an invalid inputSchema`
      );
```
  本阶段把循环提到 `describe` 层：`for (const item of expected.rules.jsonld) it(\`jsonld · ${host(item.url)} #${item.snippet} ${item.action}\`, () => {...})`，`--test-name-pattern="explainx"` 可单跑一条。

- **无类比的部分**：循环生成 `describe` / `it`（仓库里所有测试都是静态声明）。`node:test` 支持在 `describe` 回调里循环调用 `it`，且 `describe` 回调内同步执行 `filterLlmContext` 后把结果闭包给各 `it` 是安全的（同一文件内顺序执行）。注意 `--test-name-pattern` 匹配不到任何用例时退出码为 0，验证命令要同时断言输出里有 `ℹ pass N` 且 N > 0（RESEARCH "Test Framework"）。
- 期望文件路径 `fixtures/expected/<stem>.off.json`：`.gitignore:10` 只忽略 `fixtures/**/*.jev.json`，文件名绝不能以 `.jev.json` 结尾。

---

### `src/filter/purity.test.ts`（test, file-I/O）

**Analog:** `src/server.test.ts:38-42`（遍历 + 带定位信息的断言消息）。用 `readdirSync(dir, { recursive: true })` 列 `src/filter/` 下非 `.test.ts` 文件，对每个文件 `assert.doesNotMatch(src, /@modelcontextprotocol/, \`${f} imports the MCP SDK\`)`、`assert.doesNotMatch(src, /from '\.\.\/(tools|config|server|BraveAPI|protocols|jsonSchemaDialect)/, ...)`、`assert.doesNotMatch(src, /console\.log/, ...)`。目录解析照 `src/protocols/stdio.test.ts:11`（`fileURLToPath(new URL('./', import.meta.url))`）。`assert.doesNotMatch` 在 TESTING.md 列为已用断言方法。

---

## Shared Patterns

### 导入顺序与 `.js` 后缀
**Source:** `src/config.test.ts:1-6`
**Apply to:** 全部新文件
```ts
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { getOptions } from './config.js';
```
`node:` 内置（按字母序）→ 第三方 → 项目模块远者在前 → 同级 `./x.js`。库文件只有 `node:` 内置与同级导入。

### 测试骨架与 `describe` / `it` 用法
**Source:** `src/protocols/rebinding.test.ts:1-10`、`src/tools/local/formatOpeningHours.test.ts:94-103`
**Apply to:** 全部 `src/filter/*.test.ts`
```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { canonicalizeOrigin, normalizeHost } from './rebinding.js';

describe('canonicalizeOrigin', () => {
  it('returns the canonical scheme://host[:port] form', () => {
    assert.equal(canonicalizeOrigin('https://example.com'), 'https://example.com');
```
```ts
  describe('when data is missing', () => {
    it('returns undefined when opening hours are absent', () => {
      assert.equal(formatOpeningHours(undefined), undefined);
    });
```
- 一个函数一个顶层 `describe`；边角用嵌套 `describe('when ...')`；arrange / act / assert 用空行分开；act 是单个调用。
- `before` + `after` 用于拥有资源的 suite（客户端、fetch 桩）；`beforeEach` + `afterEach` 只用于逐用例环境重置。`useTestClient(...)` 只能在 `describe` 体内调用（它注册 `before/after`）。
- 断言需要诊断时带第三参：`assert.equal(result.isError ?? false, false, JSON.stringify(result.content))`（`src/tools/llm_context/index.test.ts:30`）。

### fetch 打桩（没有 mock 库）
**Source:** `src/testUtils/mcpTestHarness.ts:26-46,53-68`
**Apply to:** `src/filter/pipeline.test.ts`（改成抛错版）、`src/tools/llm_context/index.test.ts`（原样经 `useTestClient`）
```ts
function stubFetch(handler: (url: URL) => unknown): () => void {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const body = handler(url);

    if (body === undefined) {
      throw new Error(`Unmocked Brave API request: ${url.pathname}`);
    }

    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  return () => {
    globalThis.fetch = originalFetch;
  };
}
```
```ts
export function useTestClient(responder: (url: URL) => unknown): () => Client {
  let client: Client;
  let restoreFetch: () => void;

  before(async () => {
    restoreFetch = stubFetch(responder);
    client = await connectTestClient();
  });

  after(async () => {
    restoreFetch();
    await client.close();
  });

  return () => client;
}
```
- 赋值替换 + 闭包保存原值 + `as typeof fetch` 断言 + `after` 恢复。每个测试文件是独立子进程，所以全局桩只要在 suite 内装卸就安全。
- responder 只见 `URL`：可用 `url.searchParams` 断言发给 Brave 的参数，看不到方法、头、body。
- 不要写第二个 fetch 桩；若要模拟非 2xx，扩展 `stubFetch` 让它透传 `Response` 实例（TESTING.md 建议），本阶段不需要。

### 环境变量隔离
**Source:** `src/config.test.ts:8-46`
**Apply to:** `src/tools/llm_context/index.test.ts`（经 `execute()` 的路径）；`src/filter/description.test.ts`
```ts
const CONFIG_ENV_VARS = [
  'BRAVE_API_KEY',
  'BRAVE_API_KEY_FILE',
  ...
] as const;

describe('getOptions', () => {
  const originalArgv = process.argv;
  const originalEnv = Object.fromEntries(CONFIG_ENV_VARS.map((key) => [key, process.env[key]]));
  const originalConsoleError = console.error;

  beforeEach(() => {
    for (const key of CONFIG_ENV_VARS) {
      delete process.env[key];
    }
    // getOptions() logs validation failures via console.error; silence it so the
    // expected-failure cases don't add noise to the test output.
    console.error = () => {};
  });

  afterEach(() => {
    process.argv = originalArgv;
    console.error = originalConsoleError;
    for (const key of CONFIG_ENV_VARS) {
      if (originalEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originalEnv[key];
      }
    }
  });
```
本阶段名单：`['JEV_FILTER_MODE', 'JEV_FILTER_OVERFETCH_FACTOR', 'JEV_FILTER_TOOL_DESCRIPTION_FILE'] as const`。`src/config.ts:7` 的 `dotenv.config()` 会把开发机 `.env` 载入每个测试进程，删变量是唯一可靠的隔离手段。纯库测试（`config.test.ts` 等）传显式 `env` 对象，不需要这套。

### zod 4 写法
**Source:** `src/tools/llm_context/schemas/input.ts:133-141`、`schemas/output.ts:14-23,40-41`
**Apply to:** `schemas/input.ts` 的新 `LlmContextInputSchema` 块
```ts
const SourceMetadataSchema = z
  .object({
    title: z.string().optional().describe('The page title for the referenced URL.'),
    hostname: z.string().optional().describe('The hostname extracted from the referenced URL.'),
    age: z
      .array(z.string())
      .optional()
      .describe(
        'Discovery/age information for the source, typically formatted as human-readable, ISO date, and relative-age strings. May be an empty array when unavailable.'
      ),
    ...
  })
  .loose();
```
- 输入侧：默认 `z.object`（剥离未知键）；`.describe()` 后 `.optional()` 最后；不写 `.default()`（Brave 服务端有默认，描述里说明）。
- 输出侧：`.loose()` / `z.looseObject()` 容忍上游新字段。本阶段不改 `schemas/output.ts`。
- v4 API 已在用：`z.url()`、`z.treeifyError()`、`z.toJSONSchema()`、`z.record(z.url(), ...)`；禁止 v3 拼写。
- `RequestParamsSchema.pick({...})` 与 `.shape.<key>.describe()` 均为 v4 支持并已在本机验证（RESEARCH "zod 写法"节）。

### 纯函数失败语义
**Source:** `src/utils.ts:58-81`、`src/BraveAPI/index.ts:34-42`、`src/protocols/rebinding.ts:14-25`、`src/tools/summarizer/index.ts:59`
**Apply to:** `url.ts`、`jsonld.ts`、`nonArticle.ts`、`config.ts`
- 判定型函数（`is*`）坏输入返回 `false`；转换型函数坏输入返回 `null` 或原值（本库按"保守 = 不删"选原值）；配置解析坏值回落默认。
- 未使用错误值时写裸 `catch {`（`src/tools/summarizer/index.ts:59`、`src/protocols/rebinding.ts:22`）；读错误值时 `catch (error)` + `error instanceof Error ? error.message : String(error)`（`src/utils.ts:17-18`）。
- 库函数**永不抛**给宿主：`filterLlmContext` 任何内部异常都不应让 `execute()` 变成 `isError`——但 CONVENTIONS 没有"整体 try/catch 兜底"的先例，是否在管道入口包一层 fail-open 由 planner 决定；补丁脚本的 `zcodeRespFilter` 有此行为（RESEARCH "精简后的 sources 形状"）。

### 命名与文件布局
**Source:** `src/protocols/rebinding.ts`（`canonicalizeOrigin`、`normalizeHost`、`isOriginAllowed`、`toNormalizedSet`、`createDnsRebindingGuard`）、`src/jsonSchemaDialect.ts:14`、`src/BraveAPI/index.ts:5`
**Apply to:** 全部 `src/filter/`
- 目录 `src/filter/` 小写（同 `protocols/`、`tools/`），不新增 PascalCase 目录；文件 camelCase（`nonArticle.ts`），单词小写（`url.ts`、`budget.ts`）。
- 谓词 `is*`，转换 `canonicalize*/normalize*/parse*/estimate*/trim*`，工厂 `create*`，常量 SCREAMING_SNAKE，查找表 camelCase。
- 类型 PascalCase、用 `type`；Brave 线上字段 snake_case 不 camelCase 化。
- 每个 `.ts` 旁边一个同名 `.test.ts`；跨模块的夹具测试单独命名 `pipeline.fixtures.test.ts`（类比 `src/tools/local/formatOpeningHours.test.ts` 以被测对象命名）。

### 注释与语言
**Source:** `src/protocols/rebinding.ts:27-42`（JSDoc）、`src/BraveAPI/index.ts:49`（`// TODO (Name): ...`）、CONVENTIONS "Comments"节
**Apply to:** 全部新代码
```ts
/**
 * Returns the bare, lowercased hostname (port and IPv6 brackets removed), or
 * null when the value is not a clean "host[:port]". ...
 * @returns The canonicalized hostname, or null if the value is not a clean "host[:port]".
 * @example normalizeHost('example.com:8080') === 'example.com'
 * @example normalizeHost('example.com/path') === null
 */
```
- fork 新代码注释用简体中文，解释"为什么"而不是"做什么"；引用规则出处时写笔记文件名（如 `notes/local-rules-design.md` §3）。
- 模型或用户会读到的字符串（`description`、`.describe()`、`console.error` 文本、Phase 3 状态行）保持英文。
- 上游三处触点里的改动，注释跟随所在文件用英文（减少合并噪音）。

### 日志
**Source:** `src/protocols/http.ts:105`（唯一 `console.log`，仅 HTTP 传输可达）；`src/config.ts:112-113`（`console.error` + 返回失败值）
**Apply to:** 全部 `src/filter/`
- 库零 `console.log`；`description.ts` 的 fail-open 提示用 `console.error` 且仅一次；管道本身不写任何日志（Phase 3 的 JSONL 走文件）。

### 格式化、构建与验证门禁
**Source:** `.prettierrc`、`package.json:28-34`、`tsconfig.json`
**Apply to:** 每个计划的验证步骤
```bash
npm run format:check && npm run build && npm test      # CI 同序；本机基线 78 tests / 26 suites 全绿
node --import tsx --test src/filter/url.test.ts         # 单文件
node --import tsx --test --test-name-pattern="explainx" "src/**/*.test.ts"
```
- 引号包住 glob（Windows 上让 Node 自己展开）。
- `npm install` 触发 `prepare`（`format` + `build`）会静默重写 `src/`；提交前跑 `format:check`。
- 失败样子：`node --test` 汇总 `ℹ fail N`、退出码 1；`tsc` 报 `error TSxxxx`、退出码 2；prettier 报 `[warn] <file>`、退出码 1。

### 上游触点的 diff 纪律（EMBED-06）
**Source:** RESEARCH "验证配方"
**Apply to:** 三处触点所在的计划
```bash
BASE=$(git merge-base jev upstream/main)                       # 期望 a75d7eff…
git diff --name-only "$BASE" HEAD -- src/ | grep -v '^src/filter/' | sort
# 只允许：src/tools/llm_context/index.test.ts、src/tools/llm_context/index.ts、src/tools/llm_context/schemas/input.ts
grep -rl "@modelcontextprotocol" src/filter && exit 1 || echo "library clean"
```
若加载器放在 `src/testUtils/`，允许清单需加一行 `src/testUtils/braveFixtures.ts`（新增文件，不与上游冲突）。

## No Analog Found

| File | Role | Data Flow | Reason |
|------|------|-----------|--------|
| `fixtures/expected/**/*.off.json` | data（手工标注期望） | — | 仓库里没有任何测试读取 `fixtures/`，所有现有 suite 内联载荷；格式按 RESEARCH "期望文件格式"节，标注按 `notes/labeling-rubric.md` |

部分无类比（已在对应节标注）：`jsonld.ts` 的树遍历与 Q/A 拼接、`tokenize.ts` 的 shingle / Jaccard / 包含度、`stats.ts` 的累加器、`pipeline.fixtures.test.ts` 的循环生成用例——这四处直接用 RESEARCH "Code Examples" 与"夹具与期望文件策略"里的实现。

## Metadata

**Analog search scope:** `src/`（全部 55 个 `.ts` 文件列目录；精读 `src/tools/llm_context/*`、`src/tools/llm_context/schemas/*`、`src/tools/place_search/schemas/input.ts`、`src/config.ts`、`src/config.test.ts`、`src/utils.ts`、`src/utils.test.ts`、`src/protocols/rebinding.ts`、`src/protocols/rebinding.test.ts`、`src/protocols/stdio.test.ts`、`src/protocols/index.ts`、`src/testUtils/mcpTestHarness.ts`、`src/server.ts`、`src/server.test.ts`、`src/jsonSchemaDialect.ts`、`src/BraveAPI/index.ts`、`src/tools/index.ts`、`src/tools/local/formatOpeningHours.test.ts`；grep `src/tools/local/index.ts`、`src/tools/place_search/index.ts`、`src/tools/summarizer/index.ts`、`src/tools/local/index.test.ts`、`src/tools/web/types.ts`）、`.prettierrc`、`package.json`、`tsconfig.json`、`.gitignore`、`.prettierignore`；`fixtures/` 只读顶层键结构。
**Files scanned:** 24 精读 + 6 grep + 3 夹具形状探针
**Tracked-source gate:** 全部类比路径经 `git ls-files` 确认为跟踪文件；工作区干净，分支 `jev`，HEAD `e37f55f`
**Pattern extraction date:** 2026-09-20
