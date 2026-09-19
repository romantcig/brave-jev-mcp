---
last_mapped_commit: a673e70bb9a3ea272d55015a6a732448f703ac98
last_mapped_at: 2026-09-19
---
# Technology Stack

**Analysis Date:** 2026-09-19

## Languages

**Primary:**

- TypeScript 5.9.3 - All server code under `src/`. Compiled with `tsc` to `dist/` (ESM, `ES2022` target, `NodeNext` module resolution, `strict: true`). Config: `tsconfig.json`.
- JavaScript (ESM output) - `dist/**/*.js` is the shipped artifact (`package.json` `"type": "module"`, `bin` points at `dist/index.js`). `dist/` is gitignored and rebuilt on `npm run build`.

**Secondary:**

- Python 3 (stdlib only, no `requirements.txt`) - Two dev-only scripts under `dev/`: `dev/fetch_fixture.py` (fetches real Brave LLM Context responses into `fixtures/*.json`) and `dev/jev_probe.py` (runs the Jev question bank against a fixture). Not part of the build or test pipeline.
- YAML - GitHub Actions workflows (`.github/workflows/ci.yml`, `.github/workflows/build-release.yml`) and Compose files (`docker-compose.yml`, `docker-compose.secrets.example.yml`).
- Markdown (Simplified Chinese) - Project planning docs: `PLAN.md`, `notes/*.md`, `notes/history/*.md`.

## Runtime

**Environment:**

- Node.js. CI and release pin `node-version: '24.x'` (`.github/workflows/ci.yml`, `.github/workflows/build-release.yml`). `README.md` states "Node.js 22.x or higher". The code relies on features that require modern Node:
  - Native `fetch` / `Headers` / `Response` (`src/BraveAPI/index.ts`, `src/testUtils/mcpTestHarness.ts`).
  - JSON import attributes: `import pkg from '../package.json' with { type: 'json' }` (`src/server.ts`).
  - `node:test` runner with `--import tsx` (`package.json` `test` script).
  - `@modelcontextprotocol/sdk` declares `engines.node >= 18`, but the items above make 22+ the practical floor.
- Docker image base: `node:alpine` pinned by sha256 digest (floating `alpine` tag, digest-pinned; Renovate bumps it) with `openssl=3.5.8-r0` pinned via `apk` (`Dockerfile`). Runs as `USER node`, `ENV NODE_ENV=production`, `ENTRYPOINT ["node", "dist/index.js"]`.
- No `.nvmrc`, `.node-version`, or `engines` field in `package.json`. Local dev machine at analysis time: Node v25.5.0 / npm 11.8.0.
- Outbound proxying: native `fetch` ignores `HTTP(S)_PROXY` unless `NODE_USE_ENV_PROXY=1` is set (Node 24+). Noted in `notes/brave-llm-context.md`; no proxy handling exists in `src/`.

**Package Manager:**

- npm (CI uses `npm ci`; Docker uses `npm ci --ignore-scripts` then `npm ci --ignore-scripts --omit-dev`).
- Lockfile: present (`package-lock.json`, committed). `.prettierignore` excludes it from formatting.
- `prepare` script runs `npm run format && npm run build` on `npm install` (skipped in Docker via `--ignore-scripts`).

## Frameworks

**Core:**

- `@modelcontextprotocol/sdk` 1.30.0 - MCP server framework. Used APIs:
  - `McpServer` + `registerTool` (`src/server.ts`, every `src/tools/*/index.ts`)
  - `StdioServerTransport` (`src/protocols/stdio.ts`)
  - `StreamableHTTPServerTransport` (`src/protocols/http.ts`)
  - `InMemoryTransport` + `Client` for tests (`src/testUtils/mcpTestHarness.ts`)
  - `ListToolsRequestSchema`, `LoggingLevelSchema`, `ToolAnnotations`, `TextContent`, `CallToolResult` types
  - SDK-internal `_requestHandlers` map is reached into by `src/jsonSchemaDialect.ts` to re-emit tool schemas as JSON Schema 2020-12 (workaround for SDK issue #2084). This is the one place the code depends on SDK internals.
- `express` 5.2.1 - HTTP transport host. Single app with `/mcp` (all methods) and `/ping` routes (`src/protocols/http.ts`). Note Express 5 (not 4): async handlers propagate rejections automatically.
- `zod` 4.3.6 - Input/output schemas for every tool and Brave API response validation. Uses zod 4 native APIs: `z.toJSONSchema(..., { target: 'draft-2020-12', io })` (`src/jsonSchemaDialect.ts`), `z.url()`, `.loose()`, `z.treeifyError()` (`src/tools/llm_context/`, `src/tools/place_search/`). Do not use zod 3 idioms (`zod-to-json-schema`, `.passthrough()`) in new code.
- `commander` 14.0.3 - CLI flag parsing with env-var defaults (`src/config.ts`). `.allowUnknownOption()` is set.
- `dotenv` 17.3.1 - Loads `.env` at import time of `src/config.ts` (`dotenv.config({ debug: false, quiet: true })`).

**Testing:**

- `node:test` (built-in runner) + `node:assert/strict` - All 17 `*.test.ts` files under `src/`. No Jest/Vitest.
- `tsx` 4.22.4 - TypeScript loader for the test runner: `node --import tsx --test "src/**/*.test.ts"`.
- `ajv` 8.20.0 (`Ajv2020`) - Dev-only; `src/server.test.ts` compiles every advertised tool schema to prove they are valid JSON Schema 2020-12.
- In-process test harness: `src/testUtils/mcpTestHarness.ts` (`useTestClient`, `connectTestClient`) stubs `globalThis.fetch` and connects a real SDK `Client` over `InMemoryTransport`.

**Build/Dev:**

- `typescript` 5.9.3 - `tsc` compile (`npm run build`, `npm run watch`).
- `shx` 0.4.0 - Cross-platform `rm -rf dist` and `chmod +x dist/*.js` in the build script.
- `prettier` 3.8.1 - Formatting (`.prettierrc`: semi, singleQuote, tabWidth 2, trailingComma es5, printWidth 100, arrowParens always). `npm run format:check` gates CI.
- `semver` 7.7.3 - Dev-only; used by `.github/workflows/build-release.yml` to validate explicit release versions. Not imported by `src/`.
- `@modelcontextprotocol/inspector` - Not a dependency; invoked via `npx` in `npm run inspector` / `npm run inspector:http`.
- `@types/node` 24.10.13, `@types/express` 5.0.6 - Type definitions.

## Key Dependencies

**Critical:**

- `@modelcontextprotocol/sdk` 1.30.0 - Everything is built on it. Pinned exactly (no caret). The 2020-12 dialect shim in `src/jsonSchemaDialect.ts` exists because this SDK version hardcodes draft-07; check whether it can be deleted on SDK upgrade (`src/server.test.ts` guards the behavior).
- `zod` 4.3.6 - Schema layer for tool inputs, tool outputs, and Brave response parsing. Peer-dep range of the SDK is `^3.25 || ^4.0`; this repo is on 4.x.
- `express` 5.2.1 - Only needed for `--transport http`; stdio mode never imports the HTTP stack at runtime (though `src/protocols/index.ts` re-exports both).

**Infrastructure:**

- `commander` 14.0.3 - CLI surface; every option has an env-var fallback.
- `dotenv` 17.3.1 - `.env` support for local dev (`npm run serve:http` reads `BRAVE_API_KEY` from `.env`).

**Transitive worth knowing (from the SDK):**

- `hono`, `@hono/node-server`, `express-rate-limit`, `cors`, `jose`, `eventsource`, `ajv`, `zod-to-json-schema` - pulled in by the SDK, not used directly by this repo.

**All versions are pinned exactly** in `package.json` (no `^`/`~`). Renovate (`.github/renovate.json`, extends `local>brave/renovate-config`) manages bumps upstream.

## Configuration

**Environment:**

- All runtime configuration is read once at startup by `getOptions()` in `src/config.ts` and stored in a module-level `state` singleton (default export). Each CLI flag has an env-var default:

| Env var | CLI flag | Default | Purpose |
|---|---|---|---|
| `BRAVE_API_KEY` | `--brave-api-key` | (none, required) | Brave Search API subscription token |
| `BRAVE_API_KEY_FILE` | `--brave-api-key-file` | (none) | Path to a file holding the key; takes precedence over `BRAVE_API_KEY` (Docker secrets) |
| `BRAVE_MCP_TRANSPORT` | `--transport` | `stdio` | `stdio` or `http` |
| `BRAVE_MCP_PORT` | `--port` | `8080` | HTTP listen port |
| `BRAVE_MCP_HOST` | `--host` | `127.0.0.1` | HTTP bind host (`0.0.0.0` in Docker) |
| `BRAVE_MCP_ALLOWED_ORIGINS` | `--allowed-origins` | (empty) | Extra `Origin` values accepted by the DNS-rebinding guard |
| `BRAVE_MCP_ALLOWED_HOSTS` | `--allowed-hosts` | (empty, opt-in) | `Host` allow-list for the DNS-rebinding guard |
| `BRAVE_MCP_LOG_LEVEL` | `--logging-level` | `info` | Validated against MCP `LoggingLevelSchema`; stored but not otherwise consumed |
| `BRAVE_MCP_ENABLED_TOOLS` | `--enabled-tools` | (empty) | Space-separated tool whitelist |
| `BRAVE_MCP_DISABLED_TOOLS` | `--disabled-tools` | (empty) | Space-separated tool blacklist (mutually exclusive with enabled) |
| `BRAVE_MCP_STATELESS` | `--stateless` | `false` | HTTP transport without session IDs (Bedrock AgentCore) |
| `NODE_ENV` | - | `production` in `Dockerfile` only | Not read by `src/` |

- `.env` is loaded by `dotenv` if present (gitignored, not present in this checkout). `.env*` also excluded by `.dockerignore`.
- Validation failures print to `console.error` and return `false`; `src/index.ts` then exits with code 1.
- Tool names valid for enable/disable lists: `brave_web_search`, `brave_local_search`, `brave_video_search`, `brave_image_search`, `brave_news_search`, `brave_summarizer`, `brave_llm_context`, `brave_place_search` (from `src/tools/index.ts`).

**Build:**

- `tsconfig.json` - `rootDir: src`, `outDir: ./dist`, `resolveJsonModule: true` (needed for the `package.json` version import in `src/server.ts`), `include: ["src/**/*"]`. Test files are compiled into `dist/` too (e.g. `dist/config.test.js`); the npm `files` field ships the whole `dist/` directory.
- `.prettierrc`, `.prettierignore` - Formatting.
- `Dockerfile` - Two-stage build (builder compiles, release installs prod deps only).
- `docker-compose.yml` - HTTP mode on port 8080, `cap_drop: all`, `no-new-privileges`, `init: true`.
- `docker-compose.secrets.example.yml` - Optional override mounting `secrets/brave_api_key.txt` at `/run/secrets/brave_api_key`.
- `server.json` - MCP Registry manifest (`io.github.brave/brave-search-mcp-server`, stdio transport, declares `BRAVE_API_KEY` as required secret). Version is rewritten by the release workflow with `jq`.
- `glama.json` - Glama MCP directory maintainer metadata.
- `marketplace-revision-release.json` - AWS Marketplace `StartChangeSet` template, populated by the release workflow.

**Registry / publishing identity:**

- npm: `@brave/brave-search-mcp-server` 2.1.4 (public, `bin: brave-search-mcp-server`).
- Docker Hub: `brave/brave-search-mcp-server`; AWS Marketplace ECR: `brave/brave-search-mcp`.
- MCP Registry: `io.github.brave/brave-search-mcp-server`.

## Platform Requirements

**Development:**

- Node.js 22+ (24.x matches CI), npm, a Brave Search API key (`https://api-dashboard.search.brave.com/app/keys`).
- `npm install` (triggers `prepare` = format + build), `npm test`, `npm run build`.
- Optional: Docker / Docker Compose for container runs; `npx @modelcontextprotocol/inspector` for manual tool inspection.
- Python 3 for `dev/*.py` fixture and probe scripts (stdlib only). Both scripts hardcode a loopback HTTP proxy for outbound requests and read keys from the local environment; see script docstrings.
- Windows dev machine at analysis time (Git Bash / MSYS2). Build scripts use `shx` so they are cross-platform.

**Production:**

- Deployment targets documented and wired in CI: npm package run via `npx`, Docker image (Docker Hub / AWS Marketplace ECR, `linux/amd64` + `linux/aarch64`), Amazon Bedrock AgentCore (HTTP + `BRAVE_MCP_STATELESS=true` + `BRAVE_MCP_HOST=0.0.0.0`), MCP Registry listing.
- Default transport is stdio (spawned by an MCP client such as Claude Desktop / Claude Code / VS Code). HTTP mode binds loopback by default and is unauthenticated; the only protection is the Origin/Host DNS-rebinding guard in `src/protocols/rebinding.ts`.
- Single process, no persistent storage, no database. HTTP sessions are an in-memory `Map` (`src/protocols/http.ts`) and are lost on restart.

## Fork-Specific Additions (branch `jev`)

The fork adds no runtime code yet; `src/` is identical in shape to upstream 2.1.4. Added artifacts are documentation and dev tooling only:

- `PLAN.md` - Current-state design for embedding a result-filtering layer into `brave_llm_context` (see `INTEGRATIONS.md` for the external service involved).
- `notes/` - Topic notes (public) plus `notes/private-*.md` (gitignored; not read for this analysis).
- `dev/fetch_fixture.py`, `dev/jev_probe.py` - Python probes.
- `fixtures/` - Real Brave LLM Context responses (`fixtures/*.json`, `fixtures/sanity/*.json`) and text noise samples (`fixtures/noise/*.txt`). `fixtures/**/*.jev.json` are gitignored classification outputs (not read).
- `.gitignore` additions: `notes/private-*.md`, `fixtures/**/*.jev.json`, `CLAUDE.local.md`, `secrets/*` (except the `.example` file).
- Git remotes: only `upstream` (`brave/brave-search-mcp-server`). There is no `origin`; the fork has not been pushed anywhere, so the GitHub Actions workflows do not run for this branch.

Planned stack additions per `PLAN.md` §3 and §4 (not present in the tree): a pure TypeScript filter library directory with no MCP types, a Jev client module with three selectable HTTP backends, JSONL per-request logging with daily rotation, a CLI fixture-comparison tool, and a new required `intent` parameter on `brave_llm_context`. The plan also calls for removing `outputSchema` / `structuredContent` from that one tool. Per `CLAUDE.local.md` and `notes/status.md`, changes to `src/` require explicit authorization first.

---

*Stack analysis: 2026-09-19*
