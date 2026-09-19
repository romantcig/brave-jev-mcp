---
last_mapped_commit: a673e70bb9a3ea272d55015a6a732448f703ac98
last_mapped_at: 2026-09-19
---
<!-- refreshed: 2026-09-19 -->

# Architecture

**Analysis Date:** 2026-09-19

## System Overview

```text
┌──────────────────────────────────────────────────────────────────────────┐
│                              MCP Clients                                 │
│     Claude Code / Claude Desktop / VS Code / MCP Inspector / curl        │
└──────────────────┬──────────────────────────────────┬────────────────────┘
                   │ JSON-RPC over stdin/stdout        │ JSON-RPC over Streamable HTTP
                   ▼                                   ▼
┌──────────────────────────────┐     ┌────────────────────────────────────┐
│  stdio transport             │     │  HTTP transport (Express 5)        │
│  `src/protocols/stdio.ts`    │     │  `src/protocols/http.ts`           │
│                              │     │  DNS-rebinding guard middleware    │
│                              │     │  `src/protocols/rebinding.ts`      │
└──────────────┬───────────────┘     └──────────────────┬─────────────────┘
               │ createMcpServer() once                 │ createMcpServer() per session
               ▼                                        ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  MCP server factory  `src/server.ts`                                     │
│  new McpServer → tool.register() for every permitted tool →              │
│  enforce2020Dialect() patches tools/list  `src/jsonSchemaDialect.ts`     │
└──────────────────────────────────┬───────────────────────────────────────┘
                                   │ tool.register(mcpServer)
                                   ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  Tool registry  `src/tools/index.ts`                                     │
│  web · local · videos · images · news · summarizer · llm_context ·       │
│  place_search   (one module each: `src/tools/<name>/index.ts`)           │
│  execute(params): zod parse → API.issueRequest → shape CallToolResult    │
└──────────────────────────────────┬───────────────────────────────────────┘
                                   │ API.issueRequest(endpoint, params, headers)
                                   ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  Brave API client  `src/BraveAPI/index.ts` (+ `src/BraveAPI/types.ts`)   │
│  path map · query-string serialization · auth header · fetch · throw     │
└──────────────────────────────────┬───────────────────────────────────────┘
                                   │ HTTPS GET, X-Subscription-Token header
                                   ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  https://api.search.brave.com/res/v1/{web,images,videos,news,local,      │
│  summarizer,llm/context,local/place_search}                              │
└──────────────────────────────────────────────────────────────────────────┘

Cross-cutting: `src/config.ts` (CLI + env → module singleton `config`),
               `src/utils.ts` (stringify, key-file reader, list/port parsing)
```

## Component Responsibilities

| Component | Responsibility | File |
|-----------|----------------|------|
| CLI entry | Parse config, pick transport, start it, exit on failure | `src/index.ts` |
| Config singleton | Merge CLI flags and env vars, validate, expose mutable `state`, gate tools via `isToolPermittedByUser` | `src/config.ts` |
| MCP server factory | Build a fresh `McpServer`, register permitted tools, patch schema dialect | `src/server.ts` |
| Schema dialect patch | Wrap the SDK `tools/list` handler so advertised schemas are JSON Schema 2020-12 | `src/jsonSchemaDialect.ts` |
| stdio transport | Connect one server to `StdioServerTransport` | `src/protocols/stdio.ts` |
| HTTP transport | Express app on `/mcp`, session map, stateless mode, `/ping` | `src/protocols/http.ts` |
| DNS-rebinding guard | Validate `Origin` (always) and `Host` (opt-in) on `/mcp` | `src/protocols/rebinding.ts` |
| Tool registry | Single object of all tool modules, consumed by server, config, dialect patch | `src/tools/index.ts` |
| Tool modules | Own name, description, annotations, zod input/output schemas, `execute`, `register` | `src/tools/<name>/index.ts` |
| Brave API client | Only outbound HTTP call site; endpoint→path map; param serialization quirks; error throw | `src/BraveAPI/index.ts` |
| Endpoint type map | Compile-time contract endpoint → `{params, response, requestHeaders}` | `src/BraveAPI/types.ts` |
| Utilities | `stringify`, `readBraveApiKeyFromFile`, `parseDelimitedList`, `parsePort`, `isLoopbackHostname` | `src/utils.ts` |
| Test harness | In-memory SDK client + `globalThis.fetch` stub keyed on URL pathname | `src/testUtils/mcpTestHarness.ts` |

## Pattern Overview

**Overall:** Layered MCP tool server. Transport → server factory → tool modules → single API client. Each tool is a self-registering module that conforms to one implicit interface.

**Key Characteristics:**

- Every tool module has the same shape: named exports `name`, `annotations`, `description`, `execute`, `register`, plus a default export object that also exposes `inputSchema` and optional `outputSchema` as raw zod shapes (`.shape`). See `src/tools/llm_context/index.ts:62-70`.
- All Brave traffic funnels through one generic function, `issueRequest<T extends keyof Endpoints>` in `src/BraveAPI/index.ts:44`. Tools never build URLs or headers.
- Input validation is done by the MCP SDK against the registered zod `inputSchema` before `execute` runs. Tools receive already-validated arguments.
- Configuration is a module-level mutable singleton (`src/config.ts:32-44`), populated once by `getOptions()` and read lazily at request time.
- A fresh `McpServer` is created per connection (stdio: once; HTTP: per session or per request in stateless mode). Tools are stateless functions.
- Tests run against the real SDK wiring over an in-memory transport with `fetch` stubbed, not against `execute` directly.

## Layers

**Transport layer:**

- Purpose: Accept JSON-RPC from a client and hand it to an `McpServer`.
- Location: `src/protocols/`
- Contains: `stdio.ts` (one server, `StdioServerTransport`), `http.ts` (Express app, `StreamableHTTPServerTransport`, session map), `rebinding.ts` (pure host/origin canonicalization + middleware factory), `index.ts` (re-exports).
- Depends on: `src/server.ts`, `src/config.ts`, `src/utils.ts`
- Used by: `src/index.ts`

**Server assembly layer:**

- Purpose: Turn the tool registry into a configured `McpServer`.
- Location: `src/server.ts`, `src/jsonSchemaDialect.ts`
- Contains: `createMcpServer()` factory; `enforce2020Dialect()` which reaches into SDK internals (`mcpServer.server._requestHandlers`) to wrap the `tools/list` handler.
- Depends on: `src/tools/index.ts`, `src/config.ts`, `package.json` (version), `@modelcontextprotocol/sdk`
- Used by: `src/protocols/*`, `src/testUtils/mcpTestHarness.ts`

**Tool layer:**

- Purpose: One module per MCP tool. Validates/partitions params, calls the API client, shapes the `CallToolResult`.
- Location: `src/tools/<name>/`
- Contains: `index.ts` (tool module), and either `params.ts` + `types.ts` (older style) or `schemas/input.ts` + `schemas/output.ts` (newer zod-everywhere style).
- Depends on: `src/BraveAPI/index.ts`, `src/utils.ts`, `zod`, SDK types
- Used by: `src/tools/index.ts` (registry). `local` additionally imports `web`'s params and `formatWebResults` (`src/tools/local/index.ts:7,10`).

**API client layer:**

- Purpose: Serialize params to Brave's query-string conventions, attach auth, fetch, throw on non-2xx, return parsed JSON typed by endpoint.
- Location: `src/BraveAPI/index.ts`, `src/BraveAPI/types.ts`
- Contains: `typeToPathMap` (`:5-15`), `getDefaultRequestHeaders` (`:17-23`), goggle normalization (`:25-42`), `issueRequest` (`:44-137`).
- Depends on: `src/config.ts` (read lazily), `src/utils.ts`, tool param/response types (type-only imports)
- Used by: every tool module

**Configuration layer:**

- Purpose: Resolve runtime options from CLI flags (commander) with env-var defaults (dotenv loaded at import, `src/config.ts:7`).
- Location: `src/config.ts`
- Contains: `Configuration` type, `state` singleton, `getOptions()`, `isToolPermittedByUser()`.
- Depends on: `src/tools/index.ts` (for tool-name validation), `src/utils.ts`
- Used by: `src/index.ts`, `src/server.ts`, `src/protocols/http.ts`, `src/BraveAPI/index.ts`

## Data Flow

### Primary Request Path: `brave_llm_context` tool call

This is the planned integration point for the fork's filter layer. Every step below is current upstream behavior.

1. Client sends `tools/call` with `name: "brave_llm_context"` and a flat `arguments` object that mixes Brave query params (`query`, `count`, `freshness`, ...) and Brave request headers (`x-loc-lat`, `api-version`, ...). The union is declared as `LlmContextInputSchema` (`src/tools/llm_context/schemas/input.ts:277-280`).
2. The SDK validates `arguments` against the registered `inputSchema` (`validateToolInput` in `node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js`) and calls `execute` with the validated object. Registration is at `src/tools/llm_context/index.ts:48-60`.
3. `execute` (`src/tools/llm_context/index.ts:33`) re-parses the same object twice: `RequestParamsSchema.parse(params)` (`:34`, schema at `schemas/input.ts:117`) and `RequestHeadersSchema.parse(params)` (`:35`, schema at `schemas/input.ts:213`). Because plain `z.object` strips unknown keys, this partitions one flat input into query params and HTTP headers. This is the pattern; `place_search` does the same (`src/tools/place_search/index.ts:37-38`).
4. `API.issueRequest<'llmContext'>('llmContext', parsedParams, parsedHeaders)` (`:37` → `src/BraveAPI/index.ts:44`):
   - Path comes from `typeToPathMap.llmContext` = `/res/v1/llm/context` (`src/BraveAPI/index.ts:13`).
   - `query` is renamed to `q`; other scalars are `toString()`-ed (`:103-105`). `goggles` is normalized and appended once per entry (`:92-101`). `undefined`/`null` values are skipped.
   - Default headers `Accept`, `Accept-Encoding: gzip`, `X-Subscription-Token: config.braveApiKey` (`:17-23`) are merged with the per-request header object (`:110-114`).
   - `fetch(urlWithParams, { headers })` (`:116`). Non-2xx → `throw new Error("<status> <statusText>\n<body>")` (`:119-131`). 2xx → `response.json()` returned as `LlmContextSearchApiResponse` (`:134-136`).
5. Back in `execute`, the raw JSON is validated: `LlmContextSearchApiResponseSchema.safeParse(response)` (`:38`, schema at `schemas/output.ts:43-82`). On success `payload = data`: `grounding.generic[]` / `map[]` items are strict objects (unknown keys dropped), `sources` values are `.loose()` (unknown keys kept, `schemas/output.ts:41`). On failure `payload = z.treeifyError(error)` (`:39`).
6. Return `{ content: [{ type: 'text', text: JSON.stringify(payload) }], isError: !success, structuredContent: payload }` (`:41-45`).
7. The SDK's `validateToolOutput` runs: skipped when `isError` is true; otherwise `structuredContent` must be present and must satisfy `outputSchema`, else the SDK throws `McpError(InvalidParams)` which its own catch converts to `{ content: [text], isError: true }` (`createToolError`).

**Seam for post-processing:** between step 5 (validated `data`) and step 6 (return). `PLAN.md` §3.1 specifies that the fork's filter runs here as a pure library (no MCP types), that a required `intent` parameter is added to the input schema, and that `outputSchema` and `structuredContent` are removed together. No filter code exists under `src/` as of this analysis; see `notes/local-rules-design.md` and `notes/shadow-mode-logging.md` for the designed pipeline and modes.

### Other tool shapes (same skeleton, different result shaping)

- **Legacy text-list tools** (`web`, `news`, `videos`, `local`): `issueRequest` → map results through a small formatter → one `TextContent` per result using `stringify` from `src/utils.ts`. No `outputSchema`, no `structuredContent`. Example: `src/tools/news/index.ts:33-53`.
- **Structured tools** (`images`, `place_search`, `llm_context`): build one JSON payload, return it both as a single text block and as `structuredContent`, and declare `outputSchema`. `images` additionally simplifies each result and validates the assembled payload with `OutputSchema.safeParse` (`src/tools/images/index.ts:20-40`).
- **Two-call tools**: `local` calls `web` then `localDescriptions` (`src/tools/local/index.ts:39,64`) and falls back to web results. `summarizer` polls `summarizer` up to N attempts until `status === 'complete'` (`src/tools/summarizer/index.ts:83-108`).

### HTTP session flow

1. `httpServer.start()` (`src/protocols/http.ts:95`) checks `config.ready`, builds the app, `app.listen(config.port, config.host)`.
2. Request hits `/mcp` → `createDnsRebindingGuard` middleware (`:66-72`) → `express.json()` (`:74`) → `app.all('/mcp')` (`:76`).
3. `getTransport(req)` (`:22-61`): reuse transport from the `transports` map when `mcp-session-id` matches; allow a session-less `tools/list` with an ephemeral stateless transport (`:31-39`); otherwise create a new `StreamableHTTPServerTransport` (stateless when `config.stateless`, else with `randomUUID` session ids stored in the map on `onsessioninitialized`) and connect a **new** `createMcpServer()` to it (`:58-59`).
4. `transport.handleRequest(req, res, req.body)`. Uncaught errors → generic JSON-RPC 500 (`:9-15`).

### Startup flow

1. `src/index.ts:6` → `getOptions()` parses argv/env, validates, mutates `state`, sets `state.ready = true` (`src/config.ts:187-198`), returns options or `false`.
2. `false` → `console.error('Invalid configuration')`, `process.exit(1)`.
3. `transport === 'http'` → `httpServer.start()`; else `await stdioServer.start()`.

**State Management:**

- No per-request state in tools. Config lives in the `state` singleton exported as default from `src/config.ts`. HTTP sessions live in the module-level `transports` map in `src/protocols/http.ts:17`.

## Key Abstractions

**Tool module contract (implicit interface):**

- Purpose: Uniform unit the registry, server factory, config validator, and dialect patch all iterate over.
- Examples: `src/tools/llm_context/index.ts`, `src/tools/place_search/index.ts`, `src/tools/web/index.ts`
- Pattern: Named exports `name` (`brave_<snake_case>`), `annotations: ToolAnnotations` (always `openWorldHint: true`), `description` (template literal, `.trim()`), `execute(params)`, `register(mcpServer)` calling `mcpServer.registerTool(name, { title: name, description, inputSchema, outputSchema?, annotations }, execute)`. Default export `{ name, description, annotations, inputSchema: <ZodObject>.shape, outputSchema?: <ZodObject>.shape, execute, register }`. The `.shape` on the default export is what `src/jsonSchemaDialect.ts:21-23` uses to re-emit 2020-12 schemas; omit it and that tool silently keeps the SDK's draft-07 output.

**`Endpoints` type map + `typeToPathMap`:**

- Purpose: Adding a Brave endpoint means one entry in each. `issueRequest<T>` is typed end-to-end by `Endpoints[T]['params'|'response'|'requestHeaders']`.
- Examples: `src/BraveAPI/types.ts:24-70`, `src/BraveAPI/index.ts:5-15`
- Pattern: Keys are camelCase endpoint ids (`llmContext`, `placeSearch`, `localPois`); the param/response types are imported type-only from the owning tool directory, so the API layer has no runtime dependency on tools.

**Input schema split (params vs headers):**

- Purpose: One flat MCP input, two Brave destinations.
- Examples: `src/tools/llm_context/schemas/input.ts:117,213,277`, `src/tools/place_search/schemas/input.ts:143,221,247`
- Pattern: `RequestParamsSchema`, `RequestHeadersSchema`, then `XInputSchema = z.object({ ...RequestParamsSchema.shape, ...RequestHeadersSchema.shape })`. Export `z.input<>` for the tool arg type and `z.infer<>` for each half.

**Output schema as both validator and advertisement:**

- Purpose: The same zod object validates the upstream response at runtime (`safeParse`) and is advertised to clients as `outputSchema`.
- Examples: `src/tools/llm_context/schemas/output.ts:43`, `src/tools/place_search/schemas/output.ts` (`z.looseObject` throughout), `src/tools/images/schemas/output.ts:16`
- Pattern: Use `.loose()` / `z.looseObject` where Brave may add fields; strict `z.object` where the shape is contractual.

**Config singleton:**

- Purpose: Single source of runtime options.
- Examples: `src/config.ts:32-44` (defaults), `:187-198` (assignment)
- Pattern: Import `config from '../config.js'` and read `config.<field>` **inside functions at call time** (see Architectural Constraints).

**Test harness:**

- Purpose: Exercise real `registerTool`/`callTool` wiring without network.
- Examples: `src/testUtils/mcpTestHarness.ts:12` (`connectTestClient`), `:53` (`useTestClient(responder)`)
- Pattern: `describe(name, () => { const getClient = useTestClient((url) => url.pathname === '/res/v1/...' ? fixtureObject : undefined); it(..., async () => { const result = await getClient().callTool({ name, arguments }) }) })`. An unmocked pathname throws `Unmocked Brave API request`.

## Entry Points

**CLI binary (`brave-search-mcp-server`):**

- Location: `src/index.ts` → `dist/index.js` (`package.json` `bin`)
- Triggers: `npx @brave/brave-search-mcp-server`, Docker `ENTRYPOINT ["node","dist/index.js"]`, `npm run serve:http`
- Responsibilities: `getOptions()`, choose transport, start.

**stdio server:**

- Location: `src/protocols/stdio.ts:4`
- Triggers: default transport; MCP hosts spawn the process and speak JSON-RPC on stdin/stdout.
- Responsibilities: one `McpServer` connected to `StdioServerTransport`.

**HTTP server:**

- Location: `src/protocols/http.ts:95` (`start`), `:63` (`createApp`, also used directly by tests)
- Triggers: `--transport http` / `BRAVE_MCP_TRANSPORT=http`; Docker Compose sets this.
- Responsibilities: `/mcp` (all methods) → MCP Streamable HTTP; `/ping` → `{ message: 'pong' }`. Binds `config.host:config.port` (default `127.0.0.1:8080`; Dockerfile overrides host to `0.0.0.0`).

**Library entry (`module` field):**

- Location: `package.json` `"module": "dist/server.js"` → `src/server.ts` default export `createMcpServer()`
- Triggers: programmatic embedding; tests.

**Tool entry points (per tool):**

- Location: `src/tools/<name>/index.ts` `register()`; invoked from `src/server.ts:23-27` only when `isToolPermittedByUser(tool.name)`.

## Architectural Constraints

- **Threading:** Single Node event loop. No worker threads, no child processes in production (`src/protocols/stdio.test.ts` spawns one only for testing). Concurrency inside a request is limited to sequential `await`s; `local` and `summarizer` issue multiple Brave calls serially.
- **Global state:** `state` in `src/config.ts:32` (mutable, exported default, written by `getOptions()` and by tests such as `src/protocols/http.test.ts:59`); `transports` map in `src/protocols/http.ts:17` (grows per session, never evicted, no `onsessionclosed` handler); `schemaShapesByTool` in `src/jsonSchemaDialect.ts:21` (built once at import from the registry); `dotenv.config()` side effect on first import of `src/config.ts:7`.
- **Circular imports:** `src/config.ts` → `src/tools/index.ts` → `src/tools/*/index.ts` → `src/BraveAPI/index.ts` → `src/config.ts`. It works only because `src/BraveAPI/index.ts` reads `config.braveApiKey` inside `getDefaultRequestHeaders()` at call time, never at module top level. Any new module in this cycle must follow the same rule. `src/jsonSchemaDialect.ts` and `src/server.ts` also import the registry but are outside the cycle.
- **outputSchema ⇔ structuredContent coupling (SDK rule):** If a tool declares `outputSchema`, every non-error result must include a matching `structuredContent`, or the SDK converts the call into an `isError` result. Conversely `isError: true` results skip output validation entirely (that is why `llm_context` can return a zod error tree as `structuredContent`). Add or remove both together. Verified in `node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js` (`validateToolOutput`).
- **SDK-internals dependency:** `src/jsonSchemaDialect.ts:53-61` reads the private `_requestHandlers` map. If a future SDK moves it, the patch becomes a no-op by design and `src/server.test.ts` ("advertises valid JSON Schema 2020-12 schemas") is the regression guard.
- **Input arrives pre-validated, then is re-validated:** tools that split params/headers call `.parse()` again on already-validated input; `.parse` throwing here would surface as an SDK-wrapped tool error. Keep `XInputSchema` exactly equal to the union of the two halves so the second parse cannot fail.
- **Build:** `tsc` with `rootDir: src` → `dist/`; `resolveJsonModule` enables `import pkg from '../package.json' with { type: 'json' }` (`src/server.ts:3`). `tsc` copies no non-`.ts` assets, so any data file a runtime module needs must be a `.ts` module or be resolved from a path outside `dist/`.
- **ESM only:** `"type": "module"`, `NodeNext` resolution; all relative imports carry the `.js` extension even in `.ts` sources.
- **Node version:** CI and Docker use Node 24; `fetch`, `Headers`, `Response`, `URL` are the global Web APIs, no HTTP client library.

## Anti-Patterns

### Inconsistent error surfacing across tools

**What happens:** `news`, `videos`, `place_search`, and the API error path of `web` let `issueRequest`'s thrown `Error` propagate, so the client sees the raw Brave status line and body as SDK-wrapped text. `summarizer` swallows everything into a fixed message (`src/tools/summarizer/index.ts:59-65`). `web` returns `isError: true` with "No web results found" for an empty but successful response (`src/tools/web/index.ts:55-63`). `llm_context` and `images` return `isError: true` with a zod error object when the upstream shape is wrong.
**Why it's wrong:** Callers cannot rely on one error shape, and upstream error bodies leak verbatim.
**Do this instead:** For new or modified tools follow `src/tools/llm_context/index.ts:38-45`: validate the upstream payload, return `isError: true` with a structured, JSON-stringified reason for shape problems, and let genuine transport failures propagate (the SDK wraps them). Do not swallow errors into a fixed string.

### Retry loop without backoff on non-complete responses

**What happens:** `pollForSummary` (`src/tools/summarizer/index.ts:83-108`) sleeps only inside `catch`; a successful response whose `status !== 'complete'` loops again immediately.
**Why it's wrong:** Burns the attempt budget and Brave quota in a tight loop.
**Do this instead:** Sleep on every non-complete iteration, not only on thrown errors.

### Hand-rolled repetitive content assembly

**What happens:** `src/tools/web/index.ts:65-107` repeats the same `for … response.content.push({ type: 'text', text: stringify(entry) })` block five times (the file's own TODO acknowledges it).
**Why it's wrong:** Each new result type copies the block again; easy to diverge.
**Do this instead:** Build an array of formatted entries and map once into `TextContent`, as `src/tools/news/index.ts:36-52` does.

### Writing to `config` outside `getOptions()`

**What happens:** Tests assign `config.allowedOrigins = [...]` directly (`src/protocols/http.test.ts:59`).
**Why it's wrong:** Acceptable only in tests with restore in `after`. In production code it would bypass validation and the `ready` flag.
**Do this instead:** Add new options to the `Configuration` type, the `state` defaults, the commander `.option()` list, the validation block, and the final `state.x = …` assignment in `src/config.ts`, all in one change.

## Error Handling

**Strategy:** Fail fast at startup; per-call errors become `CallToolResult { isError: true }` through either the tool or the SDK.

**Patterns:**

- Startup: `getOptions()` prints a specific message with `console.error` and returns `false`; `src/index.ts:8-11` exits 1. HTTP `listen` errors (e.g. `EADDRINUSE`) exit 1 with a friendly message (`src/protocols/http.ts:108-113`).
- API layer: non-2xx → `throw new Error(...)` with status and JSON-pretty body (`src/BraveAPI/index.ts:119-131`). There is no retry, rate-limit, or timeout logic (TODO at `:49`).
- Tool layer: throw-through (most tools), or `isError: true` with a payload (`llm_context`, `images`, `web` empty case), or caught-and-fixed-message (`summarizer`).
- SDK layer: any exception from `execute` or from output validation → `{ content: [{ type: 'text', text: message }], isError: true }`.
- HTTP layer: exceptions in `/mcp` handling → JSON-RPC `-32603` with HTTP 500 if headers not yet sent (`src/protocols/http.ts:80-85`); rebinding rejections → HTTP 403 with JSON-RPC `-32600` (`src/protocols/rebinding.ts:5-7`).
- Result type pattern for utilities: `{ ok: true, key } | { ok: false, error }` (`src/utils.ts:7-21`).

## Cross-Cutting Concerns

**Logging:** `console.error` for failures, one `console.log` on HTTP listen. The server advertises the `logging` capability (`src/server.ts:16`) and validates `--logging-level`, but `config.loggingLevel` is never read after assignment and no code calls `sendLoggingMessage`. On stdio, stdout is the protocol channel, so any new diagnostics must go to `console.error` or a file.

**Validation:** zod 4 everywhere. Input: SDK validates against the registered `inputSchema`; tools that split params/headers re-parse. Output: `safeParse` in `llm_context` and `images`; SDK-side validation of `structuredContent` for all three tools with `outputSchema`. Config: hand-written checks in `getOptions()` plus `LoggingLevelSchema` from the SDK. Host/Origin: URL-based canonicalization in `src/protocols/rebinding.ts` that fails closed (`null` → reject).

**Authentication:** Outbound only. The Brave key comes from `--brave-api-key`, `BRAVE_API_KEY`, `--brave-api-key-file`, or `BRAVE_API_KEY_FILE` (file wins) and is sent as `X-Subscription-Token`. The HTTP `/mcp` endpoint itself has no authentication; the DNS-rebinding guard and the default loopback bind are the only protections. Docker Compose can mount the key as a secret file (`docker-compose.secrets.example.yml`).

**Schema advertisement:** `src/jsonSchemaDialect.ts` guarantees JSON Schema 2020-12 on the wire; `src/server.test.ts` compiles every advertised schema with Ajv 2020 as the contract test.

---

*Architecture analysis: 2026-09-19*
