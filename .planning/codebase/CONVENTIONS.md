---
last_mapped_commit: a673e70bb9a3ea272d55015a6a732448f703ac98
last_mapped_at: 2026-09-19
---
# Coding Conventions

**Analysis Date:** 2026-09-19

## Naming Patterns

**Files:**

- Source files are camelCase: `src/jsonSchemaDialect.ts`, `src/testUtils/mcpTestHarness.ts`, `src/tools/local/formatOpeningHours.test.ts`.
- Tool directories are snake_case and mirror the tool name without the `brave_` prefix: `src/tools/llm_context/` (tool `brave_llm_context`), `src/tools/place_search/` (`brave_place_search`), `src/tools/web/` (`brave_web_search`), `src/tools/local/` (`brave_local_search`).
- Each tool is `src/tools/<tool>/index.ts`. Input parameters live in `params.ts` (legacy layout: web, news, videos, local, summarizer) or in `schemas/input.ts` + `schemas/output.ts` (newer layout: images, llm_context, place_search; images also has `schemas/response.ts`). Hand-written Brave response interfaces live in `types.ts`. Use the `schemas/` layout for new code.
- Tests are `<source>.test.ts` beside the source, or `<function>.test.ts` when a file tests one exported helper (`src/tools/local/formatOpeningHours.test.ts`).
- The only PascalCase directory is `src/BraveAPI/`; do not add more.
- Registry/barrel files are named `index.ts` (`src/tools/index.ts`, `src/protocols/index.ts`).
- Dev tooling is Python under `dev/` (`dev/fetch_fixture.py`, `dev/jev_probe.py`); recorded data is JSON/text under `fixtures/`. Neither is product code.

**Functions:**

- camelCase: `issueRequest`, `formatOpeningHours`, `createDnsRebindingGuard`, `isToolPermittedByUser`.
- Most helpers are `const name = (...) => {}` arrow functions. `function` declarations appear in `src/utils.ts`, `src/config.ts`, `issueRequest` in `src/BraveAPI/index.ts`, and `src/testUtils/mcpTestHarness.ts`. Either is accepted; match the file you are editing.
- Predicates start with `is`/`needs`: `isLoopbackHostname`, `isValidGoggleURL`, `isOriginAllowed`, `needsRetargeting`.
- Converters start with `normalize`/`canonicalize`/`format`/`to`/`parse`: `normalizeHost`, `canonicalizeOrigin`, `formatWebResults`, `toNormalizedSet`, `parsePort`, `parseDelimitedList`.
- Factories start with `create`/`build`: `createMcpServer`, `createApp`, `buildFallbackWebResponse`.
- Tool modules export exactly these names: `name`, `annotations`, `description`, `execute`, `register` (see Module Design).

**Variables:**

- camelCase for locals and parameters: `parsedParams`, `locationIDs`, `restoreFetch`, `urlWithParams`.
- snake_case only when the identifier mirrors a Brave API wire field, so output objects match Brave's JSON: `extra_snippets`, `thumbnail_url`, `page_fetched`, `might_be_offensive`, `web_fallback`.
- SCREAMING_SNAKE for module-level constants: `JSON_SCHEMA_2020_12` (`src/jsonSchemaDialect.ts`), `CONFIG_ENV_VARS` (`src/config.test.ts`), `STARTUP_HOST`, `EXIT_TIMEOUT_MS` (`src/protocols/http.test.ts`). Lookup maps are camelCase: `typeToPathMap`, `schemaShapesByTool`.
- Tool identifiers are `brave_<thing>_search` or `brave_<thing>`: `brave_web_search`, `brave_llm_context`, `brave_summarizer`.
- Environment variables are `BRAVE_MCP_*` for server options and `BRAVE_API_KEY` / `BRAVE_API_KEY_FILE` for credentials (`src/config.ts`). Fork-specific settings planned in `notes/shadow-mode-logging.md` use a `JEV_FILTER_*` prefix.

**Types:**

- PascalCase for all types and interfaces.
- Zod schemas end in `Schema`: `RequestParamsSchema`, `RequestHeadersSchema`, `LlmContextInputSchema`, `LlmContextSearchApiResponseSchema`, `CountryCodesSchema`, `SimplifiedImageResultSchema`. Legacy tools export a bare `params` object (`src/tools/web/params.ts`); do not copy that for new schemas.
- Brave response types end in `ApiResponse`: `WebSearchApiResponse`, `LlmContextSearchApiResponse`, `PlaceSearchApiResponse`.
- Use `interface` for hand-written Brave response shapes (`src/tools/web/types.ts`, `src/tools/local/types.ts`, `src/tools/news/types.ts`), each field with a `/** */` line copied from Brave's docs. Use `type` for zod-inferred types, unions, and local shapes (`Configuration` in `src/config.ts`, `Formatted*Results` in `src/tools/web/types.ts`, `ToolSchemaShapes` in `src/jsonSchemaDialect.ts`).
- Derive types from zod instead of duplicating them: `z.infer<typeof RequestParamsSchema>` for the parsed shape, `z.input<typeof LlmContextInputSchema>` for what the MCP client sends (`LlmContextInput` in `src/tools/llm_context/schemas/input.ts`, `PlaceSearchInput` in `src/tools/place_search/schemas/input.ts`).
- Result unions for fallible utilities: `{ ok: true; key: string } | { ok: false; error: string }` (`ReadBraveApiKeyFromFileResult` in `src/utils.ts`).
- The `Endpoints` map in `src/BraveAPI/types.ts` is the single registry of `{ params, response, requestHeaders }` per Brave endpoint key (`web`, `images`, `llmContext`, `placeSearch`, ...).

## Code Style

**Formatting:**

- Prettier 3.8.1, config in `.prettierrc`: `semi: true`, `singleQuote: true`, `tabWidth: 2`, `trailingComma: "es5"`, `printWidth: 100`, `arrowParens: "always"`, `bracketSpacing: true`, spaces not tabs.
- Scope is `src/**/*.ts` only (`npm run format`, `npm run format:check`). `.prettierignore` excludes `dist/`, `node_modules/`, `*.d.ts`, and lockfiles. Markdown, JSON fixtures, and `dev/*.py` are not formatted by tooling.
- `npm run prepare` runs `format` then `build` on every `npm install`, so local files get rewritten silently. Run `npm run format:check` before committing to match CI.
- Multi-line tool descriptions are template literals indented four spaces with a `When to use:` bullet list, ending in `.trim()` (`src/tools/llm_context/index.ts`, `src/tools/news/index.ts`). Always call `.trim()`; `src/tools/images/index.ts` omits it and is the exception, not the rule.

**Linting:**

- No ESLint or Biome. TypeScript `strict: true` in `tsconfig.json` is the only static check; CI runs `npm run build` (plain `tsc`) as the type-check step.
- `tsconfig.json`: `target: ES2022`, `module: NodeNext`, `moduleResolution: NodeNext`, `esModuleInterop: true`, `resolveJsonModule: true`, `skipLibCheck: true`, `rootDir: src`, `outDir: dist`, `include: ["src/**/*"]`. Test files are compiled into `dist/` as well.
- `any` appears once (`stringify(data: any, ...)` in `src/utils.ts`). Use `unknown` and narrow (`parsePort(value: unknown)` is the model).
- Content items use `type: 'text' as const` or an `as TextContent` cast so the array is assignable to `CallToolResult['content']`.
- Non-null assertions are rare and commented: `transports.get(sessionId)!` after a `has()` check in `src/protocols/http.ts`.

**CI:**

- `.github/workflows/ci.yml` on push to `main` and every pull request: Node 24.x, `npm ci`, `npm run format:check`, `npm run build`, `npm test`. All three checks must pass. Actions are pinned by commit SHA with a version comment.

## Import Organization

**Order:**

1. Node built-ins with the `node:` prefix (`node:assert/strict`, `node:test`, `node:fs`, `node:crypto`, `node:child_process`, `node:url`).
2. Third-party packages (`@modelcontextprotocol/sdk/...`, `zod`, `express`, `commander`, `dotenv`, `ajv`).
3. Project modules, farthest first (`../../BraveAPI/index.js`, `../../utils.js`), then siblings (`./schemas/input.js`, `./types.js`).

The order is convention, not enforced. Tool files sometimes interleave SDK and local imports; test files follow it strictly.

**Rules:**

- ESM only (`"type": "module"` in `package.json`). Every relative import ends in `.js` even though the source is `.ts`: `import API from '../../BraveAPI/index.js'`. Omitting `.js` fails at runtime under NodeNext.
- SDK imports use `.js` subpaths: `@modelcontextprotocol/sdk/server/mcp.js`, `@modelcontextprotocol/sdk/types.js`, `@modelcontextprotocol/sdk/client/index.js`, `@modelcontextprotocol/sdk/inMemory.js`, `@modelcontextprotocol/sdk/server/streamableHttp.js`.
- JSON imports use import attributes: `import pkg from '../package.json' with { type: 'json' }` (`src/server.ts`).
- Type-only imports use `import type { X }` for whole lines or inline `{ type McpServer }` when mixed with values. Both forms are in use; inline `type` is the norm inside tool files.
- Default-import the tool registry and API client: `import tools from './tools/index.js'`, `import API from '../../BraveAPI/index.js'`, `import config from '../config.js'`.
- Do not shadow an imported schema with a parameter. `src/tools/web/index.ts` imports `params` and names the `execute` argument `params` too; newer tools import `RequestParamsSchema` and type the argument as `QueryParams` (`src/tools/llm_context/index.ts`).

**Path Aliases:**

- None. Use relative paths.

## Error Handling

**Patterns:**

- Tool handlers never throw for data problems. They return a `CallToolResult` with `isError: true` and put the diagnostic in both `content` and `structuredContent`:

```ts
// src/tools/llm_context/index.ts
const { success, data, error } = LlmContextSearchApiResponseSchema.safeParse(response);
const payload = success ? data : z.treeifyError(error);

return {
  content: [{ type: 'text', text: JSON.stringify(payload) } as TextContent],
  isError: !success,
  structuredContent: payload,
};
```

- Text-only tools build a mutable response and flip the flag: `src/tools/web/index.ts` pushes `'No web results found'`; `src/tools/summarizer/index.ts` pushes `'Unable to retrieve a Summarizer summary.'` from both the empty-summary branch and the catch-all.
- The Brave client throws on non-2xx. `issueRequest` in `src/BraveAPI/index.ts` builds `Error(`${status} ${statusText}\n${body}`)` with the JSON body pretty-printed via `stringify(body, true)`, falling back to raw text. Tool code does not catch this; the MCP SDK turns a throwing handler into an `isError` result for the client.
- Use bare `catch {` when the error value is unused (`src/BraveAPI/index.ts`, `src/protocols/rebinding.ts`, `src/tools/summarizer/index.ts`). Bind `catch (error)` only when you read it, and normalize with `error instanceof Error ? error.message : String(error)` (`readBraveApiKeyFromFile` in `src/utils.ts`).
- Pure parsers return `null` for invalid input and fail closed: `parsePort` (`src/utils.ts`), `normalizeGoggle` (`src/BraveAPI/index.ts`), `canonicalizeOrigin` and `normalizeHost` (`src/protocols/rebinding.ts`). Callers test `=== null`.
- Fallible IO utilities return a discriminated result instead of throwing: `readBraveApiKeyFromFile` in `src/utils.ts`.
- Configuration validation prints one human sentence with `console.error` and returns `false` (`getOptions` in `src/config.ts`); `src/index.ts` exits with code 1. Bind failures (`EADDRINUSE`) also `console.error` then `process.exit(1)` (`src/protocols/http.ts`).
- HTTP layer: wrap the transport call in `try/catch`, `console.error(error)`, and send a generic JSON-RPC 500 only when `!res.headersSent` (`src/protocols/http.ts`). Rejections use the JSON-RPC shape `{ jsonrpc: '2.0', error: { code: -32600, message }, id: null }` with HTTP 403 (`sendForbidden` in `src/protocols/rebinding.ts`).
- Retry loops swallow per-attempt errors, sleep, decrement, and throw once after exhaustion (`pollForSummary` in `src/tools/summarizer/index.ts`).
- Copy-on-write for incoming params: `params = { ...params, result_filter: [...] }` in `src/tools/local/index.ts`. Never mutate the caller's object.
- Defensive access on optional Brave fields with `?.` and `|| []`: `(web.results || []).map(...)`, `poi.rating?.ratingValue`, `thumbnail?.src`.

## Logging

**Framework:** `console` only. No logger dependency. `src/server.ts` declares the `logging: {}` capability but nothing calls `sendLoggingMessage`.

**Patterns:**

- `console.error` for operator-facing failures: invalid config (`src/config.ts`, `src/index.ts`), unhandled HTTP errors and bind failures (`src/protocols/http.ts`).
- `console.log` exactly once, the `Server is running on http://...` line, reachable only under `--transport http`.
- Never write to stdout from code reachable under the stdio transport. stdout is the JSON-RPC channel and a stray `console.log` corrupts it. Tool modules, `src/BraveAPI/index.ts`, `src/server.ts`, and `src/jsonSchemaDialect.ts` contain zero logging for this reason.
- Tests silence expected noise by assigning `console.error = () => {}` in `beforeEach` and restoring the original in `afterEach` (`src/config.test.ts`).
- New per-request diagnostics (the filter layer's JSONL log described in `notes/shadow-mode-logging.md`) must go to files under a configurable directory, never to stdout or stderr.

## Comments

**When to Comment:**

- Explain why, not what. Models: the `result_filter` / `summary` workaround block in `src/BraveAPI/index.ts` (links the GitHub issue), the SDK-internals guard in `src/jsonSchemaDialect.ts` ("if a future version moves it, leave its output alone rather than failing to start - server.test.ts catches regressions"), the `current_day` note in `formatOpeningHours` (`src/tools/local/index.ts`).
- Link the upstream issue or spec clause when working around a bug or implementing a spec: `SEP-1613` and `typescript-sdk/issues/2084` in `src/jsonSchemaDialect.ts`, `brave-search-mcp-server/issues/272` in `src/BraveAPI/index.ts`.
- Mark shortcuts as `// TODO (Name): ...`. Five exist, in `src/BraveAPI/index.ts`, `src/tools/local/index.ts`, and `src/tools/web/index.ts`.
- Section comments inside long functions are short imperative labels: `// Determine URL, and setup parameters`, `// Issue Request`, `// Handle Error`, `// Return Response` (`issueRequest`).
- Language: upstream `src/` comments and strings are English. `dev/*.py`, `PLAN.md`, and `notes/` are Simplified Chinese. Rule for new fork code (project owner's standing instruction, matching the `dev/` precedent): comments in Simplified Chinese; anything a model or end user reads stays English, which covers tool `description`, zod `.describe()` text, error messages, and the planned status line (`PLAN.md` section 3.5 mandates English descriptions in-repo).

**JSDoc/TSDoc:**

- `/** */` on exported helpers whose contract is non-obvious, with `@returns` and one `@example` per edge case: `normalizeHost` in `src/protocols/rebinding.ts`.
- `/** */` on every field of hand-written Brave interfaces in `types.ts` files, text copied from Brave's API docs.
- Schema files open with `/** Keep up-to-date with documentation: <url> */` pointing at the Brave API reference (`src/tools/llm_context/schemas/input.ts`, `src/tools/llm_context/schemas/output.ts`, `src/tools/place_search/schemas/input.ts`, `src/tools/images/schemas/response.ts`).
- Test data captured from real responses gets a `/** Captured from a real ... response */` block naming which properties matter (`src/tools/local/formatOpeningHours.test.ts`).
- Zod `.describe()` strings are the model-facing documentation for every input field and are mandatory. Write full sentences that state defaults and ranges, for example `'The maximum number of search results considered to select the LLM context data. The default is 20 and the maximum is 50.'` in `src/tools/llm_context/schemas/input.ts`.

## Function Design

**Size:** Small and single-purpose. Tool `execute` functions run 10 to 70 lines: parse input, call `API.issueRequest`, validate or format, return. Formatting is split into `format*` helpers that are exported when they need direct tests (`formatWebResults` in `src/tools/web/index.ts`, `formatOpeningHours` in `src/tools/local/index.ts`).

**Parameters:**

- One `params` object typed with the zod-inferred type: `export const execute = async (params: QueryParams) => { ... }`.
- Options objects for multi-value configuration: `createDnsRebindingGuard({ allowedOrigins, allowedHosts })` in `src/protocols/rebinding.ts`.
- Default parameters for tunables: `pollForSummary(params, pollInterval = 50, attempts = 20)`.
- Generic endpoint selection with an explicit type argument at call sites: `API.issueRequest<'llmContext'>('llmContext', parsedParams, parsedHeaders)`. The signature `issueRequest<T extends keyof Endpoints>(endpoint: T, parameters: Endpoints[T]['params'], requestHeaders?: Endpoints[T]['requestHeaders']): Promise<Endpoints[T]['response']>` ties everything to `src/BraveAPI/types.ts`.

**Return Values:**

- Explicit return types on exported utilities: `(): Promise<Client>`, `(value: string): string | null`, `(): Configuration | false`, `(): RequestHandler`.
- `execute` return types are inferred but must be assignable to `CallToolResult`. Structured tools return `{ content, isError, structuredContent }`; text tools return `{ content }` or `{ content, isError }`.
- Pure functions are the default. Module-level mutable state exists only in `src/config.ts` (`state`, the default export) and `src/protocols/http.ts` (`transports` session map). Tools are stateless.

**Input validation split (newer tools):**

- Define `RequestParamsSchema` (query string fields) and `RequestHeadersSchema` (`x-loc-*`, `api-version`, `accept`, `cache-control`, `user-agent`), merge them into `XInputSchema = z.object({ ...RequestParamsSchema.shape, ...RequestHeadersSchema.shape })` for registration, then re-parse each separately inside `execute`. Zod objects strip unknown keys by default, so `RequestParamsSchema.parse(params)` yields only query params and `RequestHeadersSchema.parse(params)` only headers (`src/tools/llm_context/index.ts`, `src/tools/place_search/index.ts`). Reuse this split when adding fields such as the planned `intent` parameter.
- The `query` field pattern: `z.string().trim().min(1).max(400).refine((str) => str.split(/\s+/).length <= 50, 'Query cannot exceed 50 words').describe(...)`.
- Field order inside a schema: builder chain, then `.describe()`, then `.optional()` last. Legacy tools put `.default()` before `.describe()`; newer tools omit `.default()` and state the default in the description because Brave applies defaults server-side.
- Output schemas that must tolerate extra upstream fields use `.loose()` / `z.looseObject()` (`SourceMetadataSchema` in `src/tools/llm_context/schemas/output.ts`, every object in `src/tools/place_search/schemas/output.ts`).
- Zod v4 APIs are in use (`zod` 4.3.6 pinned): `z.url()`, `z.int()`, `z.iso.datetime()`, `z.looseObject()`, `.loose()`, `z.treeifyError()`, `z.toJSONSchema()`, `z.record(z.url(), ...)`. Do not use v3 spellings such as `z.string().url()` or `error.format()`.

## Module Design

**Exports:**

- Every tool module `src/tools/<tool>/index.ts` follows one contract:

```ts
export const name = 'brave_llm_context';

export const annotations: ToolAnnotations = { title: 'Brave LLM Context', openWorldHint: true };

export const description = `
    ... "When to use:" bullets ...
`.trim();

export const execute = async (params: QueryParams) => { /* parse -> request -> validate -> return */ };

export const register = (mcpServer: McpServer) => {
  mcpServer.registerTool(
    name,
    {
      title: name,
      description: description,
      inputSchema: LlmContextInputSchema,          // zod object
      outputSchema: LlmContextSearchApiResponseSchema, // optional zod object
      annotations: annotations,
    },
    execute
  );
};

export default {
  name,
  description,
  annotations,
  inputSchema: LlmContextInputSchema.shape,             // ZodRawShape
  outputSchema: LlmContextSearchApiResponseSchema.shape, // optional ZodRawShape
  execute,
  register,
};
```

  `register` passes zod objects to the SDK; the default export carries `.shape`. `src/jsonSchemaDialect.ts` reads the shapes from the default export to re-emit JSON Schema 2020-12, and `src/server.test.ts` validates the result, so the two must describe the same schema. If a tool stops advertising an `outputSchema` (as `PLAN.md` section 3.1 plans for `brave_llm_context`), remove it from both `register` and the default export and stop returning `structuredContent`; declaring one without the other makes SDK clients reject the response.
- Registering a tool means adding it to the default-export map in `src/tools/index.ts` (keys are PascalCase: `WebSearchTool`, `LlmContextTool`). `src/server.ts` iterates that map and honors `--enabled-tools` / `--disabled-tools` through `isToolPermittedByUser`; `src/config.ts` validates tool names against the same map.
- Adding a Brave endpoint means extending both `Endpoints` in `src/BraveAPI/types.ts` and `typeToPathMap` in `src/BraveAPI/index.ts`; the `Record<keyof Endpoints, string>` type makes a missing path a compile error.
- Default exports for "the thing this module is": `createMcpServer` (`src/server.ts`), `state` (`src/config.ts`), `{ issueRequest }` (`src/BraveAPI/index.ts`), `{ start }` (`src/protocols/stdio.ts`), `{ start, createApp }` (`src/protocols/http.ts`), `enforce2020Dialect` (`src/jsonSchemaDialect.ts`). Named exports for utilities, schemas, and types.
- Pure-library modules export named functions and one factory, with unit-testable pieces exported even when only the factory is used in production: `src/protocols/rebinding.ts` exports `canonicalizeOrigin`, `normalizeHost`, `createDnsRebindingGuard`. The planned filter library ("pure library with no MCP types", `PLAN.md` section 3.1) should be shaped like this file, with `execute` in `src/tools/llm_context/index.ts` reduced to a few adapter lines.

**Barrel Files:**

- `src/tools/index.ts` is the tool registry (default export object).
- `src/protocols/index.ts` re-exports `stdioServer` and `httpServer`.
- No other barrels; import concrete files directly.

**Dependencies:**

- Exact versions in `package.json` (no `^` or `~`); Renovate (`.github/renovate.json`, `local>brave/renovate-config`) proposes bumps. Pin new dependencies the same way.
- Runtime dependencies are minimal: `@modelcontextprotocol/sdk`, `zod`, `commander`, `dotenv`, `express`. Prefer Node built-ins (`fetch`, `node:crypto`, `node:fs`, `URL`, `URLSearchParams`) over adding packages. The Brave client uses global `fetch` with a `Headers` object, no HTTP library.
- Secrets never enter source or fixtures. The API key is read from `BRAVE_API_KEY`, `--brave-api-key`, or a key file; `secrets/brave_api_key.txt.example` shows the file form. `.gitignore` excludes `.env`, `secrets/*`, `notes/private-*.md`, `fixtures/*.jev.json`, and `CLAUDE.local.md`.

**Commit messages:**

- Conventional prefixes: `feat:`, `fix:`, `chore:`, `docs:`, `test:`, `ci:`, with optional scope such as `fix(docker): ...`. Lowercase imperative subject. Fork commits on branch `jev` so far are all `docs:`.

---

*Convention analysis: 2026-09-19*
