---
last_mapped_commit: a673e70bb9a3ea272d55015a6a732448f703ac98
last_mapped_at: 2026-09-19
---
# Testing Patterns

**Analysis Date:** 2026-09-19

## Test Framework

**Runner:**

- Node.js built-in test runner (`node --test`). Node 24.x in CI (`.github/workflows/ci.yml`), Node 25.x on the dev machine. No third-party runner.
- TypeScript runs directly through `tsx` 4.22.4 (`--import tsx`). Tests never execute against `dist/`, and `npm test` needs no prior build.
- Config: none. The only configuration is the `test` script in `package.json`: `node --import tsx --test "src/**/*.test.ts"`. There is no `jest.config.*`, `vitest.config.*`, or `.mocharc`.
- Each test file runs in its own child process (Node's default isolation), so process-global stubs (`globalThis.fetch`, `process.env`, `console.error`) are isolated per file. Tests inside one file run sequentially in declaration order.

**Assertion Library:**

- `node:assert/strict`, imported as `import assert from 'node:assert/strict';` in every test file.
- Methods in use, most to least common: `assert.equal`, `assert.notEqual`, `assert.deepEqual`, `assert.ok`, `assert.match`, `assert.doesNotThrow`, `assert.doesNotMatch`. `assert.rejects` and `assert.throws` are unused so far but are the right choice for a throwing pure function.
- JSON Schema validity is checked with `ajv` 8 (`Ajv2020` from `ajv/dist/2020.js`) in `src/server.test.ts` only. `ajv` and `semver` are the only devDependencies that exist purely for tests/CI.

**Run Commands:**

```bash
npm test                                                                        # All tests (78 tests, 26 suites, a few seconds)
node --import tsx --test src/tools/llm_context/index.test.ts                     # One file
node --import tsx --test --test-name-pattern="malformed" "src/**/*.test.ts"      # Filter by describe/it name
node --import tsx --test --watch "src/**/*.test.ts"                              # Watch mode (not wired into package.json)
node --import tsx --test --experimental-test-coverage "src/**/*.test.ts"         # Coverage (not wired into package.json)
npm run format:check && npm run build && npm test                                # Exactly what CI runs, in order
```

Keep the glob quoted so Node's runner expands it rather than the shell; this matters on Windows.

## Test File Organization

**Location:**

- Co-located. Every `*.test.ts` sits next to the module it tests. There is no `test/` or `__tests__/` directory.
- Shared helpers live in `src/testUtils/` (one file today: `src/testUtils/mcpTestHarness.ts`).
- Recorded API data lives in `fixtures/` at the repo root (see Fixtures and Factories). No existing test reads from `fixtures/`; every suite inlines its mock payloads.

**Naming:**

- `<module>.test.ts` for a module's tests: `src/config.test.ts`, `src/utils.test.ts`, `src/protocols/rebinding.test.ts`, `src/tools/web/index.test.ts`.
- `<function>.test.ts` when one exported helper deserves its own file: `src/tools/local/formatOpeningHours.test.ts` tests `formatOpeningHours` from `src/tools/local/index.ts`.
- Suite names: a tool's top-level `describe` uses the tool's exported `name` constant so the suite id equals the MCP tool id (`describe(name, ...)`). Scenario variants append a parenthesised qualifier: `` describe(`${name} (malformed upstream response)`, ...) ``, `` describe(`${name} (no locations, web fallback available)`, ...) ``. Pure-function suites use the function name: `describe('normalizeHost', ...)`. Transport suites describe the mechanism: `'stdio transport (real child process)'`, `'MCP server <-> SDK Client wiring (in-memory)'`.
- Case names are present-tense sentences describing behaviour: `'returns grounding content for a simple query'`, `'rejects a present but empty Origin header'`, `'falls back to formatted web results'`, `'surfaces the validation failure as an error result'`.

**Structure:**

```
src/
├── config.test.ts                      # CLI/env parsing (getOptions)
├── server.test.ts                      # tools/list wiring + JSON Schema 2020-12 validity
├── utils.test.ts                       # parsePort, isLoopbackHostname, readBraveApiKeyFromFile
├── testUtils/mcpTestHarness.ts         # connectTestClient, useTestClient (shared harness)
├── protocols/
│   ├── http.test.ts                    # Origin/Host guard over a real Express listener; startup failure via child process
│   ├── rebinding.test.ts               # canonicalizeOrigin, normalizeHost (pure)
│   └── stdio.test.ts                   # real CLI spawned over stdio
└── tools/
    ├── <tool>/index.test.ts            # one per tool: images, llm_context, local, news, place_search, summarizer, videos, web
    └── local/formatOpeningHours.test.ts
fixtures/
├── jev_release_default.json            # real brave_llm_context response, wrapped by dev/fetch_fixture.py
├── jev_release_strict.json             # same query with context_threshold_mode=strict
├── sanity/sample1..6_*.json            # bare {grounding, sources} responses
├── noise/*.txt                         # single-source samples (metadata page, paywall preview)
└── *.jev.json                          # recorded Jev classification responses; gitignored, never committed
```

`tsconfig.json` does not exclude test files, so `npm run build` also emits `dist/**/*.test.js` and `dist/testUtils/`. They are inert; `npm test` runs the TypeScript sources.

## Test Structure

**Suite Organization:**

```typescript
// src/tools/llm_context/index.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { useTestClient } from '../../testUtils/mcpTestHarness.js';
import { name } from './index.js';

describe(name, () => {
  const getClient = useTestClient((url) => {
    if (url.pathname === '/res/v1/llm/context') {
      return {
        grounding: {
          generic: [
            {
              url: 'https://search.brave.com/',
              title: 'Brave Search',
              snippets: ['Brave is a privacy-focused browser and search engine.'],
            },
          ],
          map: [],
        },
        sources: {
          'https://search.brave.com/': { title: 'Brave Search' },
        },
      };
    }
  });

  it('returns grounding content for a simple query', async () => {
    const result = await getClient().callTool({ name, arguments: { query: 'brave browser' } });

    assert.equal(result.isError ?? false, false, JSON.stringify(result.content));
    assert.deepEqual(result.structuredContent, {
      /* the exact expected payload, repeated in full */
    });
  });
});

describe(`${name} (malformed upstream response)`, () => {
  const getClient = useTestClient((url) => {
    if (url.pathname === '/res/v1/llm/context') {
      // `sources` is required by the output schema; omitting it simulates
      // an upstream response that fails validation.
      return { grounding: { generic: [], map: [] } };
    }
  });

  it('surfaces the validation failure as an error result', async () => {
    const result = await getClient().callTool({ name, arguments: { query: 'brave browser' } });

    assert.equal(result.isError, true);
    assert.ok(JSON.stringify(result.content).includes('sources'), JSON.stringify(result.content));
  });
});
```

**Patterns:**

- One `describe` per upstream scenario. The responder passed to `useTestClient` is the scenario; add another `describe` instead of branching on test state inside one responder.
- Call `useTestClient(...)` in the `describe` body, never inside `it`, because it registers `before`/`after` hooks on the enclosing suite. When a suite makes no upstream call, use `connectTestClient()` with your own `before`/`after` instead, as `src/server.test.ts` does.
- Setup: `before` + `after` for anything that owns a resource (MCP client, HTTP listener, child process). `beforeEach` + `afterEach` only for per-test environment resets (`src/config.test.ts`). Suite-scoped resources are `let` variables at `describe` scope, assigned in `before`.
- Teardown restores everything it touched: `client.close()` (cascades to the server), `restoreFetch()`, `server.close()` wrapped in a promise, `process.argv`, each `process.env` key, `console.error`, and mutated `config` fields (`config.allowedOrigins = originalAllowedOrigins` in `src/protocols/http.test.ts`).
- Arrange, act, assert separated by blank lines; the act is a single `await`.
- Assertion messages carry the diagnostic payload: third argument `JSON.stringify(result.content)` on the `isError` check, `stderr` on the stdio assertions, `err` on the child-exit assertion. Do this on any assertion that would otherwise fail with only `true !== false`.
- Use `assert.deepEqual` against the full expected object for `structuredContent` (images, llm_context, place_search). Use `assert.ok(Array.isArray(result.content) && result.content.length > 0)` only for text-only tools whose exact serialisation is not the contract (web, news, videos, summarizer). Use `assert.match(content[i].text, /.../)` for text tools when a specific phrase is the contract (`src/tools/local/index.test.ts`).
- Narrow unions before reading fields: `assert.notEqual(options, false); if (options) { assert.equal(options.host, '127.0.0.1'); }` (`src/config.test.ts`), `if (result.ok) { ... }` (`src/utils.test.ts`), `result.content as { text: string }[]` (`src/tools/local/index.test.ts`).
- Nested `describe` groups edge cases: `describe('when data is missing', ...)` inside `describe('formatOpeningHours', ...)`.
- Comments explain what a payload simulates or why an assertion holds, for example the `sources` omission above, or `// Callers normalize (lowercase) before calling, so uppercase is not matched.` in `src/utils.test.ts`.

## Mocking

**Framework:** None. No `node:test` `mock`, no sinon, no jest. The single seam is `globalThis.fetch`, replaced by hand in `src/testUtils/mcpTestHarness.ts`.

**Patterns:**

```typescript
// src/testUtils/mcpTestHarness.ts (abridged)
export async function connectTestClient(): Promise<Client> {
  const mcpServer = createMcpServer(); // the real server factory from src/server.ts
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([mcpServer.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

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

How the stub behaves, and what that implies for new tests:

- The responder receives only the parsed `URL`. It cannot see the HTTP method, request headers, or body. Match on `url.pathname` against the Brave paths in `typeToPathMap` (`src/BraveAPI/index.ts`): `/res/v1/web/search`, `/res/v1/llm/context`, `/res/v1/local/descriptions`, `/res/v1/images/search`, and so on. `url.searchParams` is available when a test must assert what the tool sent upstream (for example that `q` was set or that `intent` was not forwarded to Brave).
- Returning `undefined` makes the stub throw `Unmocked Brave API request: <pathname>`; the tool call then returns `isError: true`, so a forgotten path fails loudly rather than yielding an empty result.
- Every stubbed response is HTTP 200 with a JSON body. The stub cannot produce 4xx/5xx, timeouts, or non-JSON bodies, so the error branch of `issueRequest` is untested today. To cover it, extend `stubFetch` to pass through a returned `Response` instance unchanged (keep the plain-object path) and export it. Do not write a second fetch stub.
- The stub is process-global and safe only because each file is its own process and `before`/`after` bracket every suite. Never install it inside an `it` without restoring.
- Multi-call tools work by answering several pathnames from one responder: `src/tools/local/index.test.ts` answers both `/res/v1/web/search` and `/res/v1/local/descriptions`.
- Process seams are stubbed by assignment with save/restore, not by a library: `process.argv = ['node', 'index.js', '--brave-api-key', 'key', ...]`, `delete process.env[key]`, `console.error = () => {}` (`src/config.test.ts`).
- Module state is mutated directly and restored: `config.allowedOrigins = ['https://allowed.example']` in `before`, original array restored in `after` (`src/protocols/http.test.ts`). `config` is the default export of `src/config.ts`. Mutate it before calling `httpServer.createApp()`; the guard snapshots the lists when the app is built.

**What to Mock:**

- The network edge only. `globalThis.fetch` for Brave, and the same edge for any new outbound client (the planned Jev classification calls), keyed on `url.hostname` plus `url.pathname` so one responder can serve both Brave and the classifier in an integration test.
- Process inputs: `process.argv`, `process.env`, and `console.error` when a code path is expected to log.

**What NOT to Mock:**

- The MCP SDK, `createMcpServer`, tool registration, zod schemas, or `issueRequest`. Tool tests go through the real `registerTool`/`callTool` path over `InMemoryTransport`; that is what catches schema and wiring regressions.
- Time. `pollForSummary` in `src/tools/summarizer/index.ts` sleeps only on failure, and its test returns `status: 'complete'` on the first call. If a retry or back-off path needs testing, make the delay injectable rather than faking timers.
- The filesystem. `src/utils.test.ts` and `src/config.test.ts` write real files under `mkdtempSync(join(tmpdir(), 'brave-api-key-'))` and rely on the OS to clean up.
- Internal pure functions. Test them directly (`src/protocols/rebinding.test.ts`), then test the composed behaviour through the real path (`src/protocols/http.test.ts`).

## Fixtures and Factories

**Test Data:**

```typescript
// src/tools/local/formatOpeningHours.test.ts
const day = (full_name: string, opens: string, closes: string): DayOpeningHours => ({
  abbr_name: full_name.slice(0, 3),
  full_name,
  opens,
  closes,
});

/**

 * Captured from a real `/res/v1/local/pois` response (Zuni Café, San Francisco).
 * Exercises the two properties that matter most in production payloads:
 *   - `current_day` holding two intervals (lunch service and dinner service)
 *   - `days` being an array-of-arrays, where a day may hold multiple intervals
 */
const splitServiceHours: OpeningHours = {
  current_day: [day('Friday', '11:00', '15:00'), day('Friday', '17:00', '21:30')],
  days: [[day('Tuesday', '17:00', '21:30')] /* ... */],
};
```

- Inline literals are the norm. Mock upstream bodies contain only the fields the tool touches, use `https://example.com/...` or `https://search.brave.com/` URLs, and the literal query `'brave browser'`.
- Small factory functions (`day(...)`) replace repeated object literals; there is no factory library.
- Data captured from a real response is typed with the interface it represents (`OpeningHours`) and documented with a `/** Captured from ... */` block naming which properties it exercises.
- Reusable constants are module-level `const`, declared once above the suites and never mutated: `CONFIG_ENV_VARS` (`src/config.test.ts`), `STARTUP_HOST` and `EXIT_TIMEOUT_MS` (`src/protocols/http.test.ts`).

**Location:**

- Inline in each `*.test.ts` today.
- `fixtures/` holds real `brave_llm_context` responses recorded by `dev/fetch_fixture.py`, plus hand-collected noise samples. Two shapes exist, and a loader must accept both:
  - Wrapped (`fixtures/jev_release_default.json`, `fixtures/jev_release_strict.json`): `{ request, fetched_at, latency_s, response }` where `response` is `{ grounding: { generic, map }, sources }`.
  - Bare (`fixtures/sanity/sample1_disable_releases.json` through `sample6_version_6.json`): `{ grounding: { generic, map }, sources }`, the exact `LlmContextSearchApiResponse` shape from `src/tools/llm_context/schemas/output.ts`.
  - `fixtures/noise/*.txt`: one `generic` entry each as JSON text, for non-article-page rules (`notes/non-article-pages.md`).
- `fixtures/*.jev.json` are recorded Jev classification responses written by `dev/jev_probe.py` (the `json.dump` call at the end of that script defines their shape). They are gitignored and absent in CI. Never commit them, never paste their contents into a test file, and never let numeric probabilities from them reach anything committed; the public repository must carry no Jev performance figures (`PLAN.md`, decision table row "发布约束").
- `notes/local-rules-design.md` reserves `fixtures/expected_*.json` for hand-labelled expected outputs per rule, and `notes/labeling-rubric.md` is the rubric for writing them. Labels (keep / drop / snippet-level keep, plus the rubric question that decided it) are fine to commit; model scores are not.

**Loading fixtures from a test (prescribed pattern):**

```typescript
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Resolve relative to the test file, like the entrypoint lookup in src/protocols/stdio.test.ts.
// From src/tools/llm_context/ the repo root is three levels up.
const fixturePath = (rel: string) =>
  fileURLToPath(new URL(`../../../fixtures/${rel}`, import.meta.url));

const loadBraveFixture = (rel: string) => {
  const data = JSON.parse(readFileSync(fixturePath(rel), 'utf8'));
  return 'response' in data ? data.response : data; // wrapped vs bare
};

// Gitignored recordings: skip, never fail, when the file is absent (CI has no .jev.json).
const recording = fixturePath('jev_release_default.jev.json');

it('replays a recorded classification', { skip: !existsSync(recording) }, () => {
  /* ... */
});
```

Use `readFileSync` + `JSON.parse`, not `import ... with { type: 'json' }`: `tsconfig.json` sets `rootDir: src`, so importing a file under `fixtures/` breaks `npm run build`.

## Coverage

**Requirements:** None enforced. No coverage script, threshold, or reporter is configured. CI (`.github/workflows/ci.yml`) runs format check, build, and `npm test` only.

**View Coverage:**

```bash
node --import tsx --test --experimental-test-coverage "src/**/*.test.ts"
```

Node's built-in reporter; not wired into `package.json`.

**Known gaps to keep in mind when touching nearby code:**

- `issueRequest` in `src/BraveAPI/index.ts`: the non-2xx branch, the `result_filter` + `summary` workaround, `goggles` normalisation, and `ids` repetition have no direct test. The harness always answers 200.
- `src/protocols/http.ts`: session handling (`mcp-session-id`, stateless mode, the session-less `tools/list` shortcut) is untested. Only the guard middleware and the bind failure are.
- `src/jsonSchemaDialect.ts` is covered only indirectly by `src/server.test.ts`.
- Input validation failures (a `query` over the length limit, an invalid `freshness`) are not asserted anywhere; the SDK rejects them before `execute` runs.
- `src/tools/llm_context/index.ts`: nothing asserts on the `content[0].text` string, only on `structuredContent`. Once `structuredContent` is removed per `PLAN.md` section 3.1, the tests must switch to parsing `content[0].text`.

## Test Types

**Unit Tests:**

- Pure functions imported directly, table-style `assert.equal` per input: `src/utils.test.ts`, `src/protocols/rebinding.test.ts`, `src/tools/local/formatOpeningHours.test.ts`.
- This is the intended style for the planned filter library, which `PLAN.md` section 3.1 requires to be a pure library with no MCP types: feed a fixture in, compare the returned result and stats objects with `assert.deepEqual`.

**Integration Tests:**

- In-memory MCP round trip per tool: real `McpServer` plus real SDK `Client` over `InMemoryTransport`, Brave stubbed at `fetch`. `src/tools/*/index.test.ts`, `src/server.test.ts`.
- HTTP guard tests: `httpServer.createApp()` listening on port 0, requests via `fetch` for Origin cases and via raw `node:http` (`rawRequest`) for Host cases, because undici refuses to override the `Host` header. `src/protocols/http.test.ts`.
- Config parsing against real argv, env, and temp files: `src/config.test.ts`.

**E2E Tests:**

- Process-level, still under `node --test`; no browser framework.
  - `src/protocols/stdio.test.ts` spawns the real CLI (`process.execPath --import tsx src/index.ts`) through `StdioClientTransport` with `env: { ...getDefaultEnvironment(), BRAVE_API_KEY: 'test-key' }`, pipes stderr for diagnostics, and asserts `tools/list` matches the registry in `src/tools/index.ts`. `tools/list` keeps it hermetic.
  - `src/protocols/http.test.ts` "HTTP transport startup" occupies a port with `net.createServer()`, spawns the CLI with `--transport http --host 127.0.0.1 --port <taken>`, and asserts exit code 1 with `/already in use/` on stderr, under an `EXIT_TIMEOUT_MS` watchdog that kills a hung child.
- Entry point path is resolved with `fileURLToPath(new URL('../index.ts', import.meta.url))`; copy that when a new test needs to spawn the server.
- Every test is hermetic: no real Brave key, no network. The child-process tests set a dummy key only because startup validation in `src/config.ts` requires one.

## Common Patterns

**Async Testing:**

```typescript
// Every it() that touches the client is async and awaits the call.
it('returns web results for a simple query', async () => {
  const result = await getClient().callTool({ name, arguments: { query: 'brave browser' } });
  assert.equal(result.isError ?? false, false, JSON.stringify(result.content));
});

// Callback APIs are promisified inline (src/protocols/http.test.ts).
before(async () => {
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  port = (server.address() as AddressInfo).port;
});

after(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve()))
  );
});

// Child processes get a watchdog so a hang fails instead of stalling the run.
const timer = setTimeout(() => {
  child.kill();
  reject(new Error(`Server did not exit within ${EXIT_TIMEOUT_MS}ms.\n${out}\n${err}`));
}, EXIT_TIMEOUT_MS);
```

**Error Testing:**

```typescript
// Tool-level errors are values, not exceptions: assert on isError and the payload text.
assert.equal(result.isError, true);
assert.ok(
  JSON.stringify(result.content).includes('might_be_offensive'),
  JSON.stringify(result.content)
);

// Result-union helpers: check the discriminant, then narrow.
const result = readBraveApiKeyFromFile('definitely-not-a-real-api-key-file');
assert.equal(result.ok, false);
if (!result.ok) {
  assert.match(result.error, /definitely-not-a-real-api-key-file/);
}

// Validation helpers return a sentinel; assert the exact sentinel.
assert.equal(parsePort('8080abc'), null);
assert.equal(getOptions(), false);

// Protocol errors: assert the exact wire shape.
assert.equal(res.status, 403);
assert.deepEqual(body, {
  jsonrpc: '2.0',
  error: { code: -32600, message: 'Forbidden: invalid Origin' },
  id: null,
});

// Schema validity: compile rather than inspect.
assert.doesNotThrow(() => ajv.compile(tool.inputSchema), `${tool.name} has an invalid inputSchema`);
```

**Environment isolation (`src/config.test.ts`):**

```typescript
const CONFIG_ENV_VARS = ['BRAVE_API_KEY', 'BRAVE_API_KEY_FILE' /* ... */] as const;
const originalArgv = process.argv;
const originalEnv = Object.fromEntries(CONFIG_ENV_VARS.map((key) => [key, process.env[key]]));
const originalConsoleError = console.error;

beforeEach(() => {
  for (const key of CONFIG_ENV_VARS) delete process.env[key];
  console.error = () => {}; // getOptions() logs expected validation failures
});

afterEach(() => {
  process.argv = originalArgv;
  console.error = originalConsoleError;
  for (const key of CONFIG_ENV_VARS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
});
```

`src/config.ts` calls `dotenv.config()` at import time, so a developer's `.env` can leak into a test process; clearing the `BRAVE_*` variables in `beforeEach` is what keeps the suite deterministic. Any new environment variable (the `JEV_FILTER_*` family planned in `notes/shadow-mode-logging.md`) must be added to such a list in its own test file, and its test must not depend on a value set on the developer's machine.

## Adding Tests for New Code

**A new or changed tool (`src/tools/<tool>/index.test.ts`):**

1. Import `assert`, `describe`/`it`, `useTestClient`, and the tool's `name`.
2. Write one `describe(name, ...)` whose responder returns the smallest valid upstream body for the tool's pathname. Assert `isError` is false with the payload as the message, then `assert.deepEqual(result.structuredContent, ...)` for structured tools or a content check for text tools.
3. Write one `` describe(`${name} (malformed upstream response)`, ...) `` that omits a required field and asserts `isError === true` plus the field name inside `result.content`.
4. Add one `describe` per fallback branch, as `src/tools/local/index.test.ts` does for the two no-location cases.
5. If the tool advertises no `outputSchema`, do not assert on `structuredContent`; parse `content[0].text` instead. `src/server.test.ts` still validates the input schema automatically for every registered tool.

**A pure library module (the planned filter pipeline and Jev client functions):**

1. Put `<module>.test.ts` beside the module and import the functions directly; no harness.
2. Drive each rule from a committed fixture (`fixtures/sanity/*.json`, `fixtures/jev_release_*.json`, `fixtures/noise/*.txt`) or a small inline literal, and compare against a hand-labelled expectation with `assert.deepEqual`.
3. Assert ordering explicitly where the design promises it (surviving sources keep Brave order, per `notes/local-rules-design.md`): `assert.deepEqual(result.map((s) => s.url), [...])`, the same way `formatOpeningHours.test.ts` asserts day order.
4. Keep the classifier network out of unit tests. Test the request builder by asserting the built body and headers object, and the response parser by feeding literal answer objects. Gate any test that opens a `.jev.json` recording behind `existsSync` plus `{ skip }` so CI passes without the file.
5. Cover the wiring once: a `useTestClient` responder that answers both `/res/v1/llm/context` and the classification endpoint, asserting the final `content` text and, once it exists, the trailing status line.
6. Run `npm run format:check`, `npm run build`, and `npm test` before committing; CI runs exactly those three in that order.

---

*Testing analysis: 2026-09-19*
