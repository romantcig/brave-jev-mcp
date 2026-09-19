---
last_mapped_commit: a673e70bb9a3ea272d55015a6a732448f703ac98
last_mapped_at: 2026-09-19
---
# External Integrations

**Analysis Date:** 2026-09-19

## APIs & External Services

**Search (the only runtime integration in `src/`):**

- Brave Search API - Every tool is a thin adapter over one or two Brave REST endpoints. All calls go through a single function, `issueRequest()` in `src/BraveAPI/index.ts`, which builds the URL, maps parameters to query strings, attaches headers, uses native `fetch`, and throws an `Error` on any non-2xx status.
  - Base URL: `https://api.search.brave.com` (hardcoded in `src/BraveAPI/index.ts`).
  - SDK/Client: none. Native `fetch` + `URLSearchParams` + `Headers`. No retry, no timeout, no rate limiting (a `TODO` in `src/BraveAPI/index.ts` notes rate-limit/self-throttling is unimplemented).
  - Auth: `X-Subscription-Token` header, value from `config.braveApiKey` (populated from `BRAVE_API_KEY` / `BRAVE_API_KEY_FILE` / CLI flags in `src/config.ts`).
  - Default headers: `Accept: application/json`, `Accept-Encoding: gzip`.
  - Endpoint map (`typeToPathMap` in `src/BraveAPI/index.ts`), keyed by the `Endpoints` type in `src/BraveAPI/types.ts`:

| Endpoint key | Path | Consumed by tool | Tool file |
|---|---|---|---|
| `web` | `/res/v1/web/search` | `brave_web_search`, `brave_local_search` (first hop) | `src/tools/web/index.ts`, `src/tools/local/index.ts` |
| `localPois` | `/res/v1/local/pois` | (declared, not called by any tool) | - |
| `localDescriptions` | `/res/v1/local/descriptions` | `brave_local_search` (second hop, up to 20 `ids`) | `src/tools/local/index.ts` |
| `news` | `/res/v1/news/search` | `brave_news_search` | `src/tools/news/index.ts` |
| `videos` | `/res/v1/videos/search` | `brave_video_search` | `src/tools/videos/index.ts` |
| `images` | `/res/v1/images/search` | `brave_image_search` | `src/tools/images/index.ts` |
| `summarizer` | `/res/v1/summarizer/search` | `brave_summarizer` (polls until `status === 'complete'`, max 20 attempts, 50 ms backoff on error) | `src/tools/summarizer/index.ts` |
| `llmContext` | `/res/v1/llm/context` | `brave_llm_context` | `src/tools/llm_context/index.ts` |
| `placeSearch` | `/res/v1/local/place_search` | `brave_place_search` | `src/tools/place_search/index.ts` |

  - Parameter quirks handled centrally in `issueRequest()`: `query` is renamed to `q`; `ids` is repeated per value for the two local endpoints; `result_filter` is joined with commas but dropped entirely when `summary: true` (known Brave-side bug, see comment referencing issue #272); `goggles` accepts a string or array, and URL-form goggles must be `https:`.
  - Per-request headers: `llmContext` and `placeSearch` accept typed request headers (`x-loc-*` geolocation, `api-version`, `accept`, `cache-control`, `user-agent`) parsed by `RequestHeadersSchema` in `src/tools/llm_context/schemas/input.ts` and `src/tools/place_search/schemas/input.ts`. They are merged over the defaults in `issueRequest()`.
  - Response handling: `brave_llm_context` and `brave_place_search` validate the Brave response with zod (`LlmContextSearchApiResponseSchema` in `src/tools/llm_context/schemas/output.ts`) and return both `content` (JSON text) and `structuredContent`; on schema mismatch they return `isError: true` with `z.treeifyError()` output. The other tools reshape the raw response into JSON strings via `stringify()` from `src/utils.ts` and do not validate.
  - Plan tiers: `brave_local_search` and `extra_snippets` need Pro; `brave_summarizer` needs Pro AI. The local tool falls back to web results when no `locations` come back (`src/tools/local/index.ts`).
  - Brave API reference docs are linked in schema-file comments (`https://api-dashboard.search.brave.com/api-reference/...`). Keep zod schemas in sync with those pages.

**MCP protocol surface (inbound, this server is the provider):**

- Model Context Protocol via `@modelcontextprotocol/sdk` 1.30.0.
  - stdio transport: `src/protocols/stdio.ts` (default).
  - Streamable HTTP transport: `src/protocols/http.ts`, Express app with `POST/GET/DELETE /mcp` and `/ping`. Sessions keyed by `mcp-session-id` header in an in-memory `Map`; `tools/list` is allowed without a session; `BRAVE_MCP_STATELESS=true` disables session IDs.
  - Advertised capabilities: `logging: {}`, `tools: { listChanged: false }` (`src/server.ts`). No resources, prompts, or sampling.
  - Tool schemas are re-emitted as JSON Schema 2020-12 by `src/jsonSchemaDialect.ts` (SDK emits draft-07 by default).

**Planned, not yet in code (fork branch `jev`):**

- Jev evaluation model by TypeSafe - A classification API (returns typed per-question answers over a JSON "state", no text generation). `PLAN.md` §3 specifies calling it once per source inside `brave_llm_context`'s `execute()` after zod validation and before return, to drop off-topic, listing, self-deprecated, stale, and template-filler sources and low-scoring snippets. Three interchangeable HTTP backends are specified in `notes/jev-api.md`, selected by environment variable:

| Backend | Endpoint | Auth env var (planned / used by `dev/jev_probe.py`) | Protocol note |
|---|---|---|---|
| TypeSafe direct | `POST https://api.typesafe.ai/v1/systemone` | `TYPESAFE_API_KEY` (probe script also accepts `jev_API_KEY`) | Native shape: question type `noul`, answer field `noul` |
| OpenRouter | `POST https://openrouter.ai/api/alpha/decisions` | `OPENROUTER_API_KEY` | Same request/response body as direct; model id `typesafe/jev-1.13` |
| Vercel AI Gateway | `POST https://ai-gateway.vercel.sh/v4/ai/evaluation-model` | `AI_GATEWAY_API_KEY` (probe script also accepts `Vercel_API_KEY`) | Extra `ai-gateway-*` / `ai-model-id` headers; question type `boolean`, answer field `probability`; confidence lives in `providerMetadata` |

  - The only existing client code is Python: `dev/jev_probe.py` (direct or Vercel backend, exponential backoff on 429/529/network errors, thread-pool concurrency, hardcoded loopback HTTP proxy). No TypeScript client exists yet.
  - Planned failure policy (`notes/shadow-mode-logging.md`): per-source failure = keep that source; consecutive-failure circuit breaker that falls back to local rules only; pre-send token estimation with a degradation ladder to avoid the hard request-size limit (oversize requests are rejected with a 422-class error, not truncated); process-level concurrency gate; three modes `off` / `shadow` / `on`.
  - Error codes documented in `notes/jev-api.md`: 401 auth, 422 body validation, 429 rate limit, 529 overload.
  - Contractual note: the public repo must not contain benchmark or performance figures for this service (`PLAN.md` §5 "发布约束"; numbers live only in gitignored `notes/private-*.md`). Do not copy thresholds, latencies, or accuracy observations into committed files.
  - Data flow consequence: in `on`/`shadow` mode, each search query and the fetched page snippets are sent to TypeSafe and to whichever gateway is selected. Acknowledged in `PLAN.md` §6.

## Data Storage

**Databases:**

- None. The server is stateless apart from process memory.

**File Storage:**

- Local filesystem, read-only at runtime: `readBraveApiKeyFromFile()` in `src/utils.ts` reads the path in `BRAVE_API_KEY_FILE` (Docker secret pattern, mounted at `/run/secrets/brave_api_key` by `docker-compose.secrets.example.yml`).
- Dev-only writes: `dev/fetch_fixture.py` writes `fixtures/<name>.json`; `dev/jev_probe.py` writes `fixtures/<name>.jev.json` (gitignored).
- Planned: JSONL per-request filter logs, daily rotation, directory from `JEV_FILTER_LOG_DIR` (default `~/.brave-jev/logs/`), local only, no snippet bodies (`notes/shadow-mode-logging.md`). Planned `blocklist.txt` of structural content-farm hosts (`notes/local-rules-design.md`).

**Caching:**

- None in this codebase. Brave caches server-side; clients can send `cache-control: no-cache` through the `llmContext` / `placeSearch` request-header schemas.
- HTTP transport session objects are cached in an in-memory `Map` (`src/protocols/http.ts`) and never evicted.

## Authentication & Identity

**Auth Provider:**

- Outbound to Brave: static API key in `X-Subscription-Token` (`src/BraveAPI/index.ts`). Key resolution order in `src/config.ts`: `--brave-api-key-file` / `BRAVE_API_KEY_FILE` (wins if set) → `--brave-api-key` / `BRAVE_API_KEY`. Missing key fails startup with exit code 1.
- Inbound (HTTP transport): none. The `/mcp` endpoint is unauthenticated. The only guard is the DNS-rebinding middleware in `src/protocols/rebinding.ts`: any present `Origin` must be loopback or in `BRAVE_MCP_ALLOWED_ORIGINS`; `Host` is validated only when `BRAVE_MCP_ALLOWED_HOSTS` is set. Requests without an `Origin` header pass. Bind to loopback (default) or a trusted network.
- Inbound (stdio): trust is inherited from the spawning MCP client process.
- Planned outbound to Jev backends: bearer token per backend, from the env vars listed above.

## Monitoring & Observability

**Error Tracking:**

- None (no Sentry or similar).

**Logs:**

- `console.error` for configuration errors and unhandled request errors (`src/config.ts`, `src/index.ts`, `src/protocols/http.ts`); `console.log` once on HTTP listen. Nothing is written to stdout in stdio mode except the MCP stream (stdout is the protocol channel, so new code must log to stderr only).
- `BRAVE_MCP_LOG_LEVEL` is validated and stored in `config.loggingLevel` but no code path emits MCP `logging` notifications; the `logging` capability is advertised but unused.
- `/ping` on the HTTP transport returns `{ "message": "pong" }` for liveness checks.
- Planned: JSONL filter logs plus a one-line status suffix appended to `brave_llm_context` results (`notes/shadow-mode-logging.md`, `notes/local-rules-design.md`).

## CI/CD & Deployment

**Hosting:**

- Not hosted by this repo. Distribution channels wired in `.github/workflows/build-release.yml`:
  - npm registry: `@brave/brave-search-mcp-server` (public, OIDC-authenticated publish via `NPM_TOKEN` secret).
  - Docker Hub: `brave/brave-search-mcp-server` tagged with release tag, full SHA, and short SHA (`DOCKERHUB_USERNAME` var, `DOCKERHUB_TOKEN` secret).
  - AWS Marketplace ECR: `brave/brave-search-mcp` in `us-east-1` (OIDC role `MARKETPL_AWS_IAM_ROLE_ARN`, account `MARKETPL_ECR_AWS_ACCOUNT_ID`), then `aws marketplace-catalog start-change-set` using `marketplace-revision-release.json`.
  - MCP Registry: published with `mcp-publisher` (pinned v1.7.9, GitHub OIDC login) using `server.json`.
  - Multi-arch image build: `linux/amd64`, `linux/aarch64` via QEMU + Buildx.
- Documented runtime hosts: Claude Desktop / Claude Code / VS Code / fx (stdio via `npx` or `docker run -i`), Amazon Bedrock AgentCore (HTTP, stateless, `0.0.0.0`).

**CI Pipeline:**

- GitHub Actions `.github/workflows/ci.yml` on push to `main` and all PRs: `npm ci` → `npm run format:check` → `npm run build` (typecheck) → `npm test`, Node 24.x, all actions SHA-pinned.
- Release is manual (`workflow_dispatch`) with optional explicit semver; otherwise bumps patch, commits `package.json` / `package-lock.json` / `server.json`, creates a GitHub Release.
- Renovate: `.github/renovate.json` extends `local>brave/renovate-config`.
- `.github/CODEOWNERS`: `@jonathansampson` owns everything.
- Fork status: the local repo has only the `upstream` remote and no `origin`, so none of these workflows run for branch `jev` until it is pushed somewhere with Actions enabled. The `main`-only push trigger also means CI would need a branch-filter change to cover `jev`.

## Environment Configuration

**Required env vars:**

- `BRAVE_API_KEY` or `BRAVE_API_KEY_FILE` - exactly one is needed.

**Optional env vars (all read in `src/config.ts`):**

- `BRAVE_MCP_TRANSPORT`, `BRAVE_MCP_PORT`, `BRAVE_MCP_HOST`, `BRAVE_MCP_ALLOWED_ORIGINS`, `BRAVE_MCP_ALLOWED_HOSTS`, `BRAVE_MCP_LOG_LEVEL`, `BRAVE_MCP_ENABLED_TOOLS`, `BRAVE_MCP_DISABLED_TOOLS`, `BRAVE_MCP_STATELESS`. Full table with defaults in `STACK.md`.
- `NODE_USE_ENV_PROXY=1` (Node runtime flag) is required for native `fetch` to honor `HTTPS_PROXY` when running behind a proxy (`notes/brave-llm-context.md`).

**Planned env vars (from `PLAN.md` §3.5, `notes/shadow-mode-logging.md`, `notes/local-rules-design.md`; none read by `src/` today):**

- `JEV_FILTER_MODE` - `off` | `shadow` | `on` (phase one default `off`).
- `JEV_FILTER_LOG_DIR` - JSONL log directory.
- `JEV_TIMEOUT_MS` - per-request timeout for the Jev backend.
- `OVERFETCH_FACTOR` - multiplier for `maximum_number_of_urls` / total tokens requested from Brave before filtering (default 1x).
- Backend selection variable plus one of `TYPESAFE_API_KEY` / `OPENROUTER_API_KEY` / `AI_GATEWAY_API_KEY`.
- Threshold overrides for each drop rule (names listed in `notes/shadow-mode-logging.md`; values are deliberately not reproduced here).

**Secrets location:**

- Never committed. `.gitignore` excludes `.env`, `secrets/*` (except `secrets/brave_api_key.txt.example`), `notes/private-*.md`, `fixtures/*.jev.json`, `CLAUDE.local.md`. `.dockerignore` excludes `.env*` and `secrets`.
- Local dev: `.env` (read by `dotenv`) or shell env. `dev/fetch_fixture.py` reads the Brave key from the `brave` MCP server entry in `~/.claude.json`; `dev/jev_probe.py` reads gateway keys from process or Windows user-level environment variables.
- Containers: Docker secret file via `BRAVE_API_KEY_FILE`.
- CI: GitHub Actions secrets (`NPM_TOKEN`, `DOCKERHUB_TOKEN`, `MARKETPL_AWS_IAM_ROLE_ARN`, `MARKETPL_ECR_AWS_ACCOUNT_ID`) and vars (`DOCKERHUB_USERNAME`).
- Machine-specific paths, proxies, and key variable names for this fork are documented in the gitignored `notes/private-local-env.md` (not read for this analysis).

## Webhooks & Callbacks

**Incoming:**

- None. The HTTP transport exposes only `/mcp` (MCP Streamable HTTP) and `/ping`.

**Outgoing:**

- None. All outbound traffic is synchronous request/response to `api.search.brave.com`. The summarizer tool polls rather than receiving callbacks.

## Test Doubles for External Services

- `src/testUtils/mcpTestHarness.ts` replaces `globalThis.fetch` with a pathname-keyed responder so tool tests never hit Brave. Unmocked paths throw `Unmocked Brave API request: <pathname>`.
- `src/protocols/http.test.ts` spins up the real Express app on an ephemeral port and also spawns `dist/index.js` as a child process for port-conflict tests (requires a prior `npm run build`).
- `fixtures/*.json` and `fixtures/sanity/*.json` hold real Brave LLM Context responses (`{ request, fetched_at, latency_s, response }`) captured by `dev/fetch_fixture.py`. `PLAN.md` §4 designates these as replay inputs for the planned filter tests; `fixtures/*.jev.json` (gitignored) are the matching recorded Jev responses.

---

*Integration audit: 2026-09-19*
