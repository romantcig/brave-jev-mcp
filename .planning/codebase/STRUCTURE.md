---
last_mapped_commit: a673e70bb9a3ea272d55015a6a732448f703ac98
last_mapped_at: 2026-09-19
---
# Codebase Structure

**Analysis Date:** 2026-09-19

## Directory Layout

```
brave-search-mcp-server/
├── src/                          # All TypeScript sources (tsc rootDir)
│   ├── index.ts                  # CLI entry: getOptions() → pick transport → start
│   ├── server.ts                 # createMcpServer(): registers permitted tools, patches dialect
│   ├── config.ts                 # CLI flags + env vars → mutable `state` singleton
│   ├── jsonSchemaDialect.ts      # Wraps tools/list so schemas are JSON Schema 2020-12
│   ├── utils.ts                  # stringify, readBraveApiKeyFromFile, parseDelimitedList, parsePort, isLoopbackHostname
│   ├── BraveAPI/
│   │   ├── index.ts              # issueRequest(): the only outbound HTTP call site
│   │   └── types.ts              # Endpoints map: endpoint id → {params, response, requestHeaders}
│   ├── protocols/
│   │   ├── index.ts              # re-exports stdioServer, httpServer
│   │   ├── stdio.ts              # StdioServerTransport wiring
│   │   ├── http.ts               # Express app, /mcp, /ping, session map, stateless mode
│   │   └── rebinding.ts          # DNS-rebinding guard middleware + host/origin canonicalizers
│   ├── testUtils/
│   │   └── mcpTestHarness.ts     # connectTestClient(), useTestClient(responder)
│   └── tools/
│       ├── index.ts              # Registry: default export object of all tool modules
│       ├── web/                  # brave_web_search        (params.ts + types.ts style)
│       ├── local/                # brave_local_search      (reuses web/params.ts; own params.ts for POI ids)
│       ├── news/                 # brave_news_search       (params.ts + types.ts)
│       ├── videos/               # brave_video_search      (params.ts + types.ts)
│       ├── summarizer/           # brave_summarizer        (params.ts + types.ts)
│       ├── images/               # brave_image_search      (schemas/input|output|response.ts + types.ts)
│       ├── llm_context/          # brave_llm_context       (schemas/input.ts + schemas/output.ts)  ← planned filter seam
│       └── place_search/         # brave_place_search      (schemas/input.ts + schemas/output.ts)
├── dist/                         # tsc output, gitignored, mirrors src/ (index.js is the bin)
├── dev/                          # Fork: Python probe/fixture scripts (not shipped, not built)
│   ├── fetch_fixture.py          # Fetch a real Brave LLM Context response into fixtures/<name>.json
│   └── jev_probe.py              # Run the Jev question set over a fixture; writes fixtures/<name>.jev.json
├── fixtures/                     # Fork: recorded Brave responses and labeled samples
│   ├── jev_release_default.json  # {request, fetched_at, latency_s, response} wrapper around a Brave response
│   ├── jev_release_strict.json   # Same query, context_threshold_mode=strict
│   ├── *.jev.json                # Jev responses per fixture — gitignored, never read/commit
│   ├── sanity/sample*.json       # Six bare Brave responses ({grounding, sources}) on a versioned-product topic
│   └── noise/*.txt               # Hand-collected non-article page samples (paywall, metadata page)
├── notes/                        # Fork: design notes, one topic per file (index in notes/README.md)
│   ├── README.md                 # Index + ownership rules
│   ├── status.md                 # Progress, blockers, todo; read first each session
│   ├── decisions-log.md          # Superseded decisions with reasons
│   ├── brave-llm-context.md      # Brave endpoint facts + upstream server structure
│   ├── local-rules-design.md     # Code-only filter rules (JSON-LD, URL merge, prefilter, budget, status line)
│   ├── dedup-and-rewrite-policy.md
│   ├── non-article-pages.md
│   ├── staleness.md
│   ├── jev-api.md                # Jev request/response shapes for three backends
│   ├── jev-question-writing.md
│   ├── labeling-rubric.md
│   ├── shadow-mode-logging.md    # off/shadow/on modes, fallbacks, JSONL log format
│   ├── history/                  # Dated process records, read-only
│   └── private-*.md              # gitignored; never read or quote
├── secrets/                      # gitignored except *.example
│   └── brave_api_key.txt.example # Template for Docker secrets mount
├── .planning/codebase/           # GSD codebase maps (this document)
├── .github/
│   ├── workflows/ci.yml          # format:check → build → test on Node 24
│   ├── workflows/build-release.yml  # manual: bump, npm publish, Docker Hub + AWS ECR, MCP registry
│   ├── renovate.json
│   └── CODEOWNERS
├── PLAN.md                       # Fork: current-state design; §5 decision table is authoritative
├── README.md                     # Upstream user docs (tools, env vars, install)
├── package.json                  # name @brave/brave-search-mcp-server, type: module, scripts
├── package-lock.json
├── tsconfig.json                 # ES2022 / NodeNext / strict, rootDir src → outDir dist
├── .prettierrc                   # 2-space, single quotes, semi, printWidth 100, trailingComma es5
├── .prettierignore / .gitignore / .dockerignore
├── Dockerfile                    # Two-stage node:alpine build, ENTRYPOINT node dist/index.js
├── docker-compose.yml            # HTTP transport on 8080, env passthrough
├── docker-compose.secrets.example.yml
├── server.json                   # MCP registry manifest (mirrors package version)
├── glama.json                    # glama.ai listing
├── marketplace-revision-release.json  # AWS Marketplace change-set template, rewritten by release workflow
├── CLAUDE.local.md               # Private session instructions, gitignored; never read
└── LICENSE                       # MIT
```

## Directory Purposes

**`src/` (root files):**

- Purpose: Process bootstrap, configuration, server assembly, shared helpers.
- Contains: `index.ts`, `server.ts`, `config.ts`, `jsonSchemaDialect.ts`, `utils.ts` and their co-located `*.test.ts`.
- Key files: `src/index.ts` (bin), `src/server.ts` (factory), `src/config.ts` (all options)

**`src/BraveAPI/`:**

- Purpose: The single HTTP client for `api.search.brave.com`.
- Contains: `index.ts` (runtime), `types.ts` (type-only `Endpoints` map).
- Key files: `src/BraveAPI/index.ts:5-15` path map; `:44` `issueRequest`

**`src/protocols/`:**

- Purpose: Transports. One file per transport plus the HTTP security middleware.
- Contains: `stdio.ts`, `http.ts`, `rebinding.ts`, `index.ts`, tests.
- Key files: `src/protocols/http.ts` (`createApp`, `start`), `src/protocols/rebinding.ts` (`createDnsRebindingGuard`)

**`src/tools/<name>/`:**

- Purpose: One directory per MCP tool. Directory name is the tool's snake_case suffix without the `brave_` prefix (`llm_context` ↔ `brave_llm_context`, `place_search` ↔ `brave_place_search`, `images` ↔ `brave_image_search`).
- Contains, older style: `index.ts`, `params.ts` (zod input, default export), `types.ts` (hand-written TS interfaces for the Brave response), `index.test.ts`.
- Contains, newer style: `index.ts`, `schemas/input.ts` (`RequestParamsSchema`, `RequestHeadersSchema`, combined `XInputSchema`), `schemas/output.ts` (zod response schema, also advertised as `outputSchema`), `index.test.ts`. `images/` is a hybrid (`schemas/` plus `types.ts`).
- Key files: `src/tools/index.ts` (registry), `src/tools/llm_context/index.ts` (planned integration point)

**`src/testUtils/`:**

- Purpose: Shared test infrastructure. Compiled into `dist/` as well (tsc includes all of `src/`), but nothing imports it at runtime.
- Key files: `src/testUtils/mcpTestHarness.ts`

**`dist/`:**

- Purpose: Build output. `npm run build` deletes and regenerates it; tests run from source via `tsx` and do not need it. The Docker release image and the `bin` entry point use it.

**`dev/`:**

- Purpose: Fork-only Python tooling for collecting fixtures and probing the external classification API. Runs outside the Node toolchain; reads keys from the local environment or `~/.claude.json`, never from the repo.
- Key files: `dev/fetch_fixture.py`, `dev/jev_probe.py` (question set and thresholds are constants at the top of the file)

**`fixtures/`:**

- Purpose: Real Brave LLM Context responses used as test inputs and as review samples for the fork's filter design. Two wrapper shapes exist: top-level fixtures wrap the response in `{request, fetched_at, latency_s, response}`; `sanity/` samples are bare `{grounding, sources}` responses.
- Generated: by `dev/fetch_fixture.py` (Brave) and `dev/jev_probe.py` (`*.jev.json`).
- Committed: `.json` under `fixtures/` and `fixtures/sanity/`, `.txt` under `fixtures/noise/`. `fixtures/*.jev.json` is gitignored.
- Planned additions per `notes/local-rules-design.md`: `fixtures/expected_*.json` hand-labeled expected outputs per rule.

**`notes/`:**

- Purpose: Fork design documentation with a single-owner rule: each topic lives in exactly one note; `PLAN.md` cites notes instead of restating them. Decisions change in `PLAN.md` §5 and the old conclusion moves to `notes/decisions-log.md`. Process records go to `notes/history/` and are read-only.
- Committed: everything except `notes/private-*.md`.

**`secrets/`:**

- Purpose: Local mount point for the Docker secrets override. Only the `.example` template is committed.

**`.github/`:**

- Purpose: Upstream CI (`ci.yml` on push to `main` and PRs) and manual release pipeline (`build-release.yml`: version bump, `server.json` sync, npm publish, multi-arch Docker to Docker Hub and AWS Marketplace ECR, MCP registry publish, AWS Marketplace change set).

## Key File Locations

**Entry Points:**

- `src/index.ts`: CLI main; `dist/index.js` is the published bin.
- `src/server.ts`: `createMcpServer()` factory; `dist/server.js` is the `module` field.
- `src/protocols/stdio.ts`, `src/protocols/http.ts`: transport starters.

**Configuration:**

- `src/config.ts`: every CLI flag and env var (`BRAVE_API_KEY`, `BRAVE_API_KEY_FILE`, `BRAVE_MCP_TRANSPORT`, `BRAVE_MCP_PORT`, `BRAVE_MCP_HOST`, `BRAVE_MCP_LOG_LEVEL`, `BRAVE_MCP_ENABLED_TOOLS`, `BRAVE_MCP_DISABLED_TOOLS`, `BRAVE_MCP_ALLOWED_ORIGINS`, `BRAVE_MCP_ALLOWED_HOSTS`, `BRAVE_MCP_STATELESS`).
- `tsconfig.json`, `.prettierrc`: build and formatting.
- `package.json` scripts: `build`, `test`, `format`, `format:check`, `watch`, `serve:http`, `inspector`, `inspector:http`.
- `Dockerfile`, `docker-compose.yml`, `docker-compose.secrets.example.yml`: container runtime.
- `server.json`: MCP registry manifest; version must track `package.json` (the release workflow does this).

**Core Logic:**

- `src/BraveAPI/index.ts`: request serialization, auth, error throw.
- `src/BraveAPI/types.ts`: endpoint contract; add a key here and in `typeToPathMap` for any new Brave endpoint.
- `src/tools/index.ts`: tool registry; the only place a tool becomes visible to the server, config validation, and dialect patch.
- `src/tools/llm_context/index.ts`: `execute()` at lines 33-46 is the planned filter seam (after `safeParse`, before `return`).
- `src/tools/llm_context/schemas/input.ts`: where the planned required `intent` parameter and any parameter whitelist changes go (`RequestParamsSchema`, line 117).
- `src/tools/llm_context/schemas/output.ts`: response shape validator / advertised `outputSchema` (planned to be dropped together with `structuredContent`).
- `src/jsonSchemaDialect.ts`: keep in mind when changing a tool's default export; it reads `inputSchema`/`outputSchema` `.shape` from there.

**Testing:**

- `src/testUtils/mcpTestHarness.ts`: in-memory client and `fetch` stub.
- `src/**/*.test.ts`: co-located tests, run by `node --import tsx --test "src/**/*.test.ts"`.
- `src/server.test.ts`: registry completeness and JSON Schema 2020-12 contract for all tools.
- `src/protocols/stdio.test.ts`: spawns the real CLI via `tsx`.
- `src/protocols/http.test.ts`: real Express listener on an ephemeral port.

**Fork planning:**

- `PLAN.md`: current design; §3.1 lists the three upstream touch points, §3.2 the pipeline order, §5 the decision table.
- `notes/status.md`: what is done and what is blocked.
- `notes/brave-llm-context.md`: upstream server facts the fork relies on.

## Naming Conventions

**Files:**

- Source files: `camelCase.ts` for multi-word modules (`jsonSchemaDialect.ts`, `mcpTestHarness.ts`); single words lowercase (`config.ts`, `utils.ts`, `http.ts`, `rebinding.ts`).
- Tests: co-located `<module>.test.ts`; a focused test on one function may be named after the function (`src/tools/local/formatOpeningHours.test.ts`).
- Tool modules: always `index.ts` inside the tool directory.
- Schema files: `schemas/input.ts`, `schemas/output.ts`, optionally `schemas/response.ts` for shared sub-schemas.
- Fork docs: `kebab-case.md` in `notes/`; history files prefixed `YYYY-MM-DD-`; private files prefixed `private-`.
- Fixtures: `snake_case.json`; Jev companions add the `.jev.json` suffix to the same stem.

**Directories:**

- Tool directories: `snake_case` matching the tool name minus `brave_` and with plural/singular as in the tool (`images`, `videos`, `news`, `llm_context`, `place_search`).
- Top-level source groups: `PascalCase` for `BraveAPI/`, `camelCase` for `testUtils/`, lowercase for `protocols/`, `tools/`.

**Identifiers (observed in `src/`):**

- Tool names: `brave_<snake_case>` string constants exported as `name`.
- Zod schemas: `PascalCase` + `Schema` suffix (`RequestParamsSchema`, `LlmContextSearchApiResponseSchema`); older tools export a lowercase `params` object as default.
- Types: `PascalCase`; response interfaces end in `ApiResponse`; formatted output types start with `Formatted`.
- Endpoint ids in `Endpoints`/`typeToPathMap`: `camelCase` (`llmContext`, `placeSearch`, `localDescriptions`).
- Functions and variables: `camelCase`; module-private helpers are `const` arrow functions declared after `register` in tool files.
- Brave wire fields keep Brave's `snake_case` (`maximum_number_of_urls`, `extra_snippets`); do not camelCase them.

## Where to Add New Code

**New MCP tool:**

- Create `src/tools/<name>/index.ts` following `src/tools/place_search/index.ts` (exports `name`, `annotations`, `description`, `execute`, `register`; default export with `.shape` fields).
- Put input validation in `src/tools/<name>/schemas/input.ts` (split `RequestParamsSchema` / `RequestHeadersSchema` if the endpoint takes headers) and the response validator in `schemas/output.ts`.
- Add the endpoint to `src/BraveAPI/types.ts` (`Endpoints`) and `src/BraveAPI/index.ts` (`typeToPathMap`).
- Register it in `src/tools/index.ts`. That single edit makes it visible to `src/server.ts`, `src/config.ts` tool-name validation, `src/jsonSchemaDialect.ts`, and `src/server.test.ts`.
- Tests: `src/tools/<name>/index.test.ts` using `useTestClient` keyed on the Brave pathname.
- Document it in `README.md` under "Tools".

**Post-processing / filtering of `brave_llm_context` results (the fork's planned work):**

- Pure library, no MCP or zod-SDK types: a new directory under `src/` (for example `src/filter/` or `src/jev/`), exporting a function that takes the validated Brave response, the parsed request params, and `intent`, and returns `{ result, stats }` (shape per `notes/shadow-mode-logging.md`).
- Adapter: a few lines in `src/tools/llm_context/index.ts` `execute()` between the `safeParse` and the `return`.
- Schema changes: `src/tools/llm_context/schemas/input.ts` (`intent`, parameter whitelist, description text in `index.ts`).
- Configuration: new env vars go through `src/config.ts` (`Configuration` type, `state` defaults, commander option, validation, final assignment) so `config.<field>` is the only read path; do not read `process.env` inside the filter.
- Outbound calls to the classification API: keep them in the library's own client module, mirroring `src/BraveAPI/index.ts`'s pattern (one `fetch` site, headers built from `config` at call time). Keys must come from env/config, never from files in the repo.
- Data files the library needs at runtime (block lists, marker lists): write them as `.ts` modules exporting constants. `tsc` does not copy `.txt`/`.json` into `dist/`.
- Tests: co-located `*.test.ts` next to the library files; feed them the committed fixtures under `fixtures/` (the `{…, response}` wrapper or the bare `sanity/` shape) and, when the Jev layer is under test, replay recorded `*.jev.json` files without committing them.
- Logging: never `console.log` (stdout is the stdio protocol channel). Use `console.error` or the planned JSONL file logger.

**New transport or HTTP middleware:**

- `src/protocols/<name>.ts`, re-export from `src/protocols/index.ts`, wire the selection in `src/index.ts`, and add the option to `src/config.ts`.

**New Brave endpoint used by an existing tool:**

- `src/BraveAPI/types.ts` + `src/BraveAPI/index.ts` `typeToPathMap`; params type lives with the tool that owns it (`params.ts` or `schemas/input.ts`).

**Utilities:**

- Shared helpers: `src/utils.ts` (pure functions, tested in `src/utils.test.ts`).
- Test-only helpers: `src/testUtils/`.

**Fixtures and dev scripts (fork workflow):**

- New recorded Brave responses: `fixtures/<name>.json` via `dev/fetch_fixture.py`.
- New labeled expectations: `fixtures/expected_<rule>.json` (planned convention).
- New probe or analysis scripts: `dev/`, Python, standalone, keys from environment only.

**Design decisions:**

- Change `PLAN.md` §5 in place and append the superseded row to `notes/decisions-log.md`. Topic details go to the owning note in `notes/`, never duplicated in `PLAN.md`.

## Special Directories

**`dist/`:**

- Purpose: Compiled JavaScript, one `.js` per `.ts` including tests and `testUtils`.
- Generated: Yes (`npm run build`, also `npm run prepare` on install from git).
- Committed: No (`.gitignore`).

**`node_modules/`:**

- Purpose: Dependencies (`npm ci` in CI and Docker).
- Generated: Yes.
- Committed: No.

**`fixtures/`:**

- Purpose: Recorded Brave responses and noise samples for the fork.
- Generated: Partly (scripts in `dev/`); `noise/*.txt` are hand-collected.
- Committed: Yes, except `*.jev.json`.

**`secrets/`:**

- Purpose: Docker secrets mount; local key file.
- Generated: No (user copies the example).
- Committed: Only `brave_api_key.txt.example`.

**`notes/private-*.md`, `CLAUDE.local.md`, `.env`:**

- Purpose: Local environment, private evidence, private session instructions.
- Generated: No.
- Committed: No. Do not read or quote.

**`.planning/`:**

- Purpose: GSD planning artifacts including `codebase/` maps.
- Generated: By GSD commands.
- Committed: Not currently tracked (directory appeared with this mapping; not in `.gitignore`, so it will show as untracked).

**Planned but absent (per `PLAN.md` §3.5):** `legacy/` (retired patch scripts), `reference/` (copies of external docs, to be gitignored). Neither exists yet; nothing in `.gitignore` covers `reference/` today.

---

*Structure analysis: 2026-09-19*
