# Brave LLM Context API 与上游服务器事实（2026-09-19）

来源：api-dashboard.search.brave.com/documentation/services/llm-context、上游源码 2.1.4、本机实测。

## 端点与参数

`GET https://api.search.brave.com/res/v1/llm/context`，头 `X-Subscription-Token`。

| 参数 | 默认 | 范围 | 说明 |
|---|---|---|---|
| q | 必填 | 1–600 字符，≤75 词 | MCP 声明的 400/50 更严 |
| count | 20 | 1–50 | 参与选片段的搜索结果数 |
| maximum_number_of_urls | 20 | 1–50 | 返回来源数 |
| maximum_number_of_tokens | 8192 | 1024–32768 | 总 token 预算（近似），**硬约束** |
| maximum_number_of_tokens_per_url | 4096 | 512–8192 | 单来源上限 |
| maximum_number_of_snippets / _per_url | 50 / 50 | 1–256 / 1–100 | 预算允许更多时不起作用 |
| context_threshold_mode | 未设=API 自校准 | strict / balanced / lenient / disabled | 相关性门槛；strict = 精度优先 |
| freshness | — | pd/pw/pm/py 或日期区间 | |
| goggles | — | URL 或内联规则 | 域名级重排，本项目不用 |
| enable_source_metadata | false | | sources 里加 site_name/favicon/thumbnail/description |
| safesearch、enable_local、spellcheck、country、search_lang | | | |

头 `Api-Version: 2026-02-06` 可钉 2026-07-31 之前的旧内容抽取管线。

## 响应形状

```json
{"grounding":{"generic":[{"url":"...","title":"...","snippets":["..."]}],"map":[]},
 "sources":{"<url>":{"title":"...","hostname":"...","age":["..."]}}}
```

- 片段可能是纯文本，也可能是 JSON 序列化的结构化数据（表格、schema.org、代码块），官方要求后处理两种都处理。
- 来源顺序即 Brave 相关性排序，含时效和站点权重信号。
- 实测：JSON-LD 块约占返回体积四分之一；FAQPage 的 acceptedAnswer 和 articleBody 是正文本身，不能整块删；作者/出版方/sameAs/citation 是纯噪音。

## 计费

按请求计费（$5/千次），多要来源和 token 不加钱。

## 上游 MCP 服务器（brave/brave-search-mcp-server 2.1.4，MIT）

- Node ESM + TypeScript，`tsc` 构建，测试 `node --import tsx --test`。依赖 @modelcontextprotocol/sdk、zod、commander、dotenv、express。
- `src/tools/llm_context/index.ts` 的 `execute()`：解析参数 → `API.issueRequest('llmContext')` → zod 校验 → 返回 `content`（JSON 字符串）+ `structuredContent`。过滤层插在校验之后、返回之前。
- `src/tools/llm_context/schemas/input.ts` 已声明 context_threshold_mode、enable_source_metadata、maximum_number_of_snippets(_per_url)、spellcheck 等全部参数；现行补丁只是把它们从工具声明里去掉。
- `src/BraveAPI/index.ts` 用原生 fetch；Node 25 + `NODE_USE_ENV_PROXY=1` 走代理。
- 注册时若声明 outputSchema 又不返回 structuredContent，Claude Code 内嵌的 MCP SDK 会报 InvalidRequest；两者要一起去掉。
- Claude Code 会把 content 与 structuredContent 渲染两遍，去掉 structuredContent 省一半。

## 本机现状

见 notes/private-local-env.md（不入库）。
