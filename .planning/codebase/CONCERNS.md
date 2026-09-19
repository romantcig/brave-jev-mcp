---
last_mapped_commit: a673e70bb9a3ea272d55015a6a732448f703ac98
last_mapped_at: 2026-09-19
---
# Codebase Concerns

**Analysis Date:** 2026-09-19

Scope note: this is a fork of `brave/brave-search-mcp-server` (branch `jev`, base `main` = upstream v2.1.4 at `a75d7ef`). No filter code exists in `src/` yet; the fork so far adds only `PLAN.md`, `notes/`, `fixtures/`, `dev/`, and `.gitignore` lines. Concerns below cover (a) upstream code as it stands and (b) what the planned Jev filter layer will collide with. Per the project's contractual rule, this document contains no accuracy, probability, or latency figures about Jev.

## Tech Debt

**Upstream merge surface of the planned filter (highest-impact item for this fork):**

- Issue: `PLAN.md` §3.1 plans three in-place edits to upstream files: the body of `execute()` in `src/tools/llm_context/index.ts`, the parameter whitelist and description in `src/tools/llm_context/schemas/input.ts` and `index.ts`, and removal of `outputSchema` / `structuredContent`. All three land in the same small files that upstream keeps touching (`#333` rewrote `index.test.ts`, `#335` touched every tool's schema wiring). Stale upstream branch refs still present locally (`origin/sampson-deferred-validation`, `origin/chore/bug-hunt-simplification`, `origin/feat/answers-endpoint`, `origin/summarizer-to-answers`) show more restructuring is in flight, including one that changes exactly when parameters are validated inside `execute()`.
- Files: `src/tools/llm_context/index.ts`, `src/tools/llm_context/schemas/input.ts`, `src/tools/llm_context/index.test.ts`, `src/tools/index.ts`, `src/config.ts`
- Impact: every `git merge upstream/main` will conflict in the filter's insertion point; conflicts in `config.ts` (14 upstream commits, the most-churned non-type file) if Jev env vars are added there.
- Fix approach: keep upstream files byte-identical and wrap instead of edit. A fork-owned module (for example `src/tools/llm_context/filtered.ts`) can import upstream's `execute`, `name`, `annotations` from `./index.js`, call upstream `execute(params)`, take `result.structuredContent` (which is the zod-validated `data` on success), run the pure filter library on it, and return `{ content: [text], isError }` with no `structuredContent`. The exposed input schema is built with `RequestParamsSchema.pick({...})` / `RequestHeadersSchema.pick({...})` plus the new required `intent` field, so `schemas/input.ts` is never edited and upstream's new parameters stay hidden until deliberately picked. The only upstream line that changes is the import in `src/tools/index.ts`. Note that upstream `execute()` runs `RequestParamsSchema.parse(params)`, which strips unknown keys, so `intent` is dropped before reaching Brave automatically; strip it explicitly anyway. This deviates from the wording of `PLAN.md` §3.1 ("execute() 只留几行适配") and is the owner's call; either way, Jev configuration should live in its own module that reads `process.env` directly rather than extending the `Configuration` type and commander options in `src/config.ts`.
- Contract to preserve: the default export shape `{ name, description, annotations, inputSchema: <ZodRawShape>, execute, register }` is consumed by `src/config.ts` (tool-name validation), `src/server.ts` (registration), `src/jsonSchemaDialect.ts` (reads `inputSchema` / `outputSchema` shapes), `src/server.test.ts`, and `src/protocols/stdio.test.ts`. `jsonSchemaDialect.ts` already tolerates a missing `outputSchema`, so dropping it is safe.

**Dead `--logging-level` option and unused logging capability:**

- Issue: `src/config.ts` parses and validates `--logging-level` / `BRAVE_MCP_LOG_LEVEL` into `state.loggingLevel`, and `src/server.ts` advertises `capabilities.logging`, but nothing reads `loggingLevel` and no `sendLoggingMessage` call exists anywhere in `src/`.
- Files: `src/config.ts`, `src/server.ts`
- Impact: users set a level that changes nothing; the README documents a no-op. For the fork, the planned status line and JSONL logs should not be routed through this option without first wiring it up.
- Fix approach: either implement MCP logging notifications gated on `state.loggingLevel`, or leave it alone (it is upstream's) and give the filter its own `JEV_FILTER_LOG_DIR` style variables as `notes/shadow-mode-logging.md` already plans.

**Mutable config singleton mutated by tests:**

- Issue: `src/config.ts` exports a module-level `state` object; `getOptions()` re-parses `process.argv` on every call and writes into it. `src/protocols/http.test.ts` mutates `config.allowedOrigins` / `config.allowedHosts` directly and restores them in `after()`.
- Files: `src/config.ts`, `src/protocols/http.test.ts`, `src/BraveAPI/index.ts` (reads `config.braveApiKey` per request)
- Impact: test order and parallelism are constrained; any new config (Jev mode, thresholds) added to this singleton inherits the same coupling. `dotenv.config()` also runs at import time, so a developer's local `.env` is loaded into every test process.
- Fix approach: keep filter configuration in a separate module with a pure `parseFilterConfig(env)` function that tests call with explicit input, and never read env at import time.

**`src/jsonSchemaDialect.ts` depends on SDK private internals:**

- Issue: reaches into `mcpServer.server._requestHandlers` (a private `Map` on the SDK's `Protocol` class) to wrap the `tools/list` handler and re-emit schemas as JSON Schema 2020-12 because the SDK hardcodes draft-07. If the private field moves, the wrapper silently does nothing.
- Files: `src/jsonSchemaDialect.ts`, `src/server.test.ts` (the only regression guard)
- Impact: an SDK bump can silently revert schemas to draft-07 for 2020-12-only clients. The conversion also runs on every `tools/list` call with no memoization.
- Fix approach: upstream intends to delete this once SDK PR #2085 lands; the fork should not touch the file and should re-run `npm test` after every SDK bump.

**`src/BraveAPI/index.ts` is a monolith with acknowledged TODOs:**

- Issue: one `issueRequest()` handles URL building, per-endpoint special cases (`ids` repeated params for local endpoints, `result_filter` skipped when `summary` is true, `goggles` normalization), header assembly, and error formatting. Three upstream `TODO (Sampson)` comments cover rate limiting / multi-key support, moving param construction to modules, and proper error handling. There is no request timeout, no `AbortSignal`, and no retry on 429.
- Files: `src/BraveAPI/index.ts`
- Impact: a hung Brave request hangs the tool call indefinitely; special-case serialization is untested (see Test Coverage Gaps).
- Fix approach: do not refactor in the fork (merge cost). The Jev client should be written separately with its own timeout, retry, and concurrency control rather than reusing this function.

**Inconsistent request-header typing:**

- Issue: `src/BraveAPI/types.ts` types `requestHeaders` as the DOM `Headers` class for most endpoints but as zod-inferred plain objects for `llmContext` and `placeSearch`. `issueRequest()` iterates with `Object.entries()`, which yields nothing for a real `Headers` instance, so the `Headers` typing is misleading.
- Files: `src/BraveAPI/types.ts`, `src/BraveAPI/index.ts`
- Impact: low; only a type-level trap for anyone adding headers to the older tools.

**Compiled tests ship in the package and image:**

- Issue: `tsconfig.json` includes `src/**/*`, so `dist/` contains every `*.test.js` plus `dist/testUtils/`; `package.json` `files: ["dist"]` and the Dockerfile copy `dist/` wholesale.
- Files: `tsconfig.json`, `package.json`, `Dockerfile`
- Impact: package bloat and test-only imports (`node:test`, `ajv`) present in production artifacts. Cosmetic.

**Probe script encodes retired decision logic:**

- Issue: `dev/jev_probe.py` carries the v2 question set and a verdict function that drops sources on a "rewrite" rule which `notes/decisions-log.md` (v3, 2026-09-19) explicitly retired; it lacks the v3 questions listed in `notes/jev-question-writing.md` (listing, self-deprecated, stale, paywalled). Threshold constants are duplicated between the script and `notes/shadow-mode-logging.md`, and a third copy will appear in TypeScript.
- Files: `dev/jev_probe.py`, `notes/shadow-mode-logging.md`, `notes/jev-question-writing.md`
- Impact: re-running the probe produces verdicts that contradict the current plan; three sources of truth for thresholds will drift.
- Fix approach: make the TypeScript constants module the single source (PLAN §4.1 step 6 plans a CLI compare tool that can replace the probe), or have the probe load questions and thresholds from a JSON file that the TypeScript code also reads.

**Dev scripts are tied to one machine:**

- Issue: `dev/fetch_fixture.py` reads the Brave key out of `~/.claude.json`; `dev/jev_probe.py` falls back to reading a user-level Windows environment variable via `pwsh`; both hardcode a local HTTP proxy address. `notes/jev-api.md` links to a script under a personal temp directory.
- Files: `dev/fetch_fixture.py`, `dev/jev_probe.py`, `notes/jev-api.md`
- Impact: scripts fail for anyone else and expose the owner's local setup in a public repo (no secret values, but paths and proxy conventions).
- Fix approach: read keys and proxy from named env vars only; document them in `notes/README.md`; move the personal script reference into `notes/private-local-env.md`.

**Git remote hygiene:**

- Issue: `upstream` is configured but has never been fetched (no `refs/remotes/upstream/*`), while `refs/remotes/origin/*` (including `origin/HEAD`) linger from a remote that no longer exists in `.git/config`. `main` still equals the old `origin/main`.
- Files: `.git/config`, `.git/refs/remotes/`
- Impact: the merge workflow in `PLAN.md` §3.5 has never been exercised; stale `origin/*` refs will confuse `git log --remotes` and tooling.
- Fix approach: `git fetch upstream`, delete the stale refs (`git branch -dr origin/<name>` for each, or `git update-ref -d refs/remotes/origin/HEAD`), and do one trial `git merge upstream/main` on a scratch branch before Phase 1 begins.

**Upstream identity baked into metadata:**

- Issue: `package.json` (`name`, `mcpName`, `bin`, `homepage`, `bugs`, `repository`, `author`), `server.json` (`io.github.brave/...`), `.github/CODEOWNERS` (`@jonathansampson`), `glama.json` (maintainers), `.github/renovate.json` (`local>brave/renovate-config`, a preset that only resolves inside the Brave org), and `marketplace-revision-release.json` (AWS Marketplace listing) all describe the upstream project.
- Files: `package.json`, `server.json`, `.github/CODEOWNERS`, `glama.json`, `.github/renovate.json`, `marketplace-revision-release.json`
- Impact: the fork cannot publish under the `@brave` scope; CODEOWNERS would request reviews from an upstream maintainer if branch protection is enabled; Renovate would error. Deleting these files causes merge conflicts each time upstream edits them (Renovate bumps `build-release.yml` action pins often).
- Fix approach: rename only what the fork must own (`name`, `bin`, `mcpName`, `repository`, `homepage`, `bugs`) and leave the rest untouched; disable Renovate and Actions at the GitHub repository settings level rather than deleting files.

**README drift inherited from upstream:**

- Issue: `README.md` states `BRAVE_MCP_STATELESS` defaults to `"true"` while `src/config.ts` defaults it to `false`; the Claude Desktop NPX example passes `--transport http` to a client that speaks stdio. Nothing in the README describes the fork (the `intent` parameter, the third-party data flow, or Jev env vars).
- Files: `README.md`, `src/config.ts`
- Impact: misconfiguration by users; missing disclosure once the fork is public (see Security Considerations).

## Known Bugs

**Summarizer polls the billable endpoint in a tight loop:**

- Symptoms: when the Summarizer API answers with a non-`complete` status, `pollForSummary()` immediately issues the next request; the sleep only happens inside the `catch` branch, so the configured poll interval never applies to the normal "still generating" path. Up to the full attempt budget of requests can fire back-to-back.
- Files: `src/tools/summarizer/index.ts`
- Trigger: call `brave_summarizer` with a key whose summary is still generating.
- Workaround: none in config. Fix is to sleep after every non-complete iteration, and to stop retrying on non-retryable HTTP errors (the `catch` currently swallows 401/403/422 and retries them too).

**HTTP session map never shrinks:**

- Symptoms: in stateful HTTP mode every initialized session is stored in the module-level `transports` map in `src/protocols/http.ts`; no `onclose` handler or DELETE path removes entries, so memory grows with session count for the life of the process.
- Files: `src/protocols/http.ts`
- Trigger: long-running HTTP deployment with many clients or reconnecting clients.
- Workaround: run with `BRAVE_MCP_STATELESS=true`, which creates a throwaway transport per request instead.

**Unknown session id creates a throwaway server instead of a 404:**

- Symptoms: a request carrying an `mcp-session-id` that is not in the map falls through to the "new session" branch, so a fresh `McpServer` and transport are built and the SDK rejects the non-initialize request as "server not initialized" (HTTP 400) rather than the 404 that lets clients detect expiry and re-initialize.
- Files: `src/protocols/http.ts`
- Trigger: restart the server while a client holds a session id.
- Workaround: clients must treat 400 as "re-initialize".

**`--logging-level` is accepted but has no effect:** see Tech Debt. Files: `src/config.ts`.

**`.gitignore` missed `.jev.json` files in fixture subdirectories (fork-introduced, FIXED 2026-09-19):**

- Symptoms: `dev/jev_probe.py` writes its raw Jev output next to the input fixture (`fixture.with_suffix('.jev.json')`). The ignore rule is `fixtures/*.jev.json`, which does not match `fixtures/sanity/*.jev.json` or `fixtures/noise/*.jev.json` (verified with `git check-ignore`). Those outputs contain per-source probabilities and per-request latency, exactly the data the contract forbids publishing.
- Files: `.gitignore`, `dev/jev_probe.py`
- Trigger: run the probe on any fixture under `fixtures/sanity/`, then `git add -A`.
- Status: fixed in commit a673e70; the rule is now `fixtures/**/*.jev.json` (verified with `git check-ignore`). Kept here so the planner does not re-derive the task.

## Security Considerations

**Unauthenticated HTTP transport:**

- Risk: `/mcp` and `/ping` have no authentication. `Dockerfile` and `docker-compose.yml` set `BRAVE_MCP_HOST=0.0.0.0`. Anyone who can reach the port can spend the Brave API quota, and once the filter exists, the Jev quota as well.
- Files: `src/protocols/http.ts`, `src/protocols/rebinding.ts`, `Dockerfile`, `docker-compose.yml`
- Current mitigation: loopback bind by default; DNS-rebinding guard validates `Origin` always and `Host` when `BRAVE_MCP_ALLOWED_HOSTS` is set; README warns the endpoint is unauthenticated.
- Recommendations: keep stdio as the fork's deployment mode (PLAN §4.1 step 8 already targets `node dist/index.js` over stdio); if HTTP is ever exposed, put it behind an authenticating proxy and set both allow-lists.

**API key handling (Brave today, Jev tomorrow):**

- Risk: keys reach the process via `BRAVE_API_KEY`, `BRAVE_API_KEY_FILE`, CLI flags, or `.env` (loaded by `dotenv` at import in `src/config.ts`). The key is sent only as `X-Subscription-Token` in `src/BraveAPI/index.ts` and is never logged. The fork will add at least one more secret (TypeSafe key, optionally OpenRouter or Vercel gateway keys).
- Files: `src/config.ts`, `src/utils.ts` (`readBraveApiKeyFromFile`), `src/BraveAPI/index.ts`, `.gitignore`, `.dockerignore`, `secrets/brave_api_key.txt.example`, `docker-compose.secrets.example.yml`
- Current mitigation: `.gitignore` ignores `.env`, `secrets/*` (except the example), `notes/private-*.md`, `CLAUDE.local.md`; `.dockerignore` excludes `.env*` and `secrets`; only example files are tracked (verified with `git ls-files`); no key-like strings found in tracked non-source files.
- Recommendations: give Jev keys the same `_FILE` variant for Docker-secret parity; add their names (not values) to the `environment:` passthrough list in `docker-compose.yml`; ensure the JSONL log writer and the status line never include request headers; make the filter's config reader ignore `.env`-sourced Jev keys during `npm test` (see Test Coverage Gaps: a local `.env` with a live key and `JEV_FILTER_MODE=on` could make real, billable calls from tests).

**Third-party data flow introduced by the fork:**

- Risk: the filter will send the search query, the `intent` sentence, and page snippets to TypeSafe and, depending on backend, through the Vercel or OpenRouter gateway. This is a new data recipient compared with upstream and must be disclosed to anyone who installs the fork.
- Files: `PLAN.md` §6 ("已知并接受"), `notes/jev-api.md`, `README.md` (no disclosure yet)
- Current mitigation: acknowledged by the owner; logs are planned to stay local and to omit snippet bodies.
- Recommendations: add a README section describing the data flow, the env var that turns it off (`JEV_FILTER_MODE=off`), and the zero-data-retention options per backend.

**Publishing exposure of contractual restriction (MCA 2.3(f)):**

- Risk: the repo's rule is that no Jev performance figure appears in public files. A count-only scan found quantitative lines in `PLAN.md`, `notes/jev-api.md`, `notes/shadow-mode-logging.md` (threshold constants for the fork's own code), `notes/decisions-log.md`, `notes/jev-question-writing.md`, and all three `notes/history/*.md` files. Most are the fork's own tuning constants or officially published limits, but the history files were written before the v3 restructuring moved figures to private notes. Separately, `fixtures/jev_release_default.json` and `fixtures/jev_release_strict.json` are captured Brave responses about the Jev launch; `notes/labeling-rubric.md` describes one captured source as a self-made table of vendor-promoted figures and several as press articles, so the fixtures republish third-party performance claims verbatim.
- Files: `notes/history/2026-09-19-sample-review.md`, `notes/history/2026-09-19-investigation.md`, `notes/history/2026-09-19-lessons-fast-jev-compaction.md`, `notes/jev-api.md`, `fixtures/jev_release_default.json`, `fixtures/jev_release_strict.json`, `.planning/codebase/*.md` (untracked, not ignored, will be committed by the orchestrator)
- Current mitigation: `notes/status.md` already lists "grep before pushing" as a todo; `.jev.json` outputs are ignored at the top fixture level.
- Recommendations: run the audit before the first push and decide explicitly whether third-party claims quoted inside fixtures fall under the restriction; the safe default is to move the two Jev-launch fixtures under an ignored path or scrub the numeric snippets. Also note the fixtures and `fixtures/noise/substack_paywall.txt` reproduce copyrighted article text and a paid-subscriber preview, a redistribution question independent of the MCA.

**Release workflow is dangerous in a fork:**

- Risk: `.github/workflows/build-release.yml` is `workflow_dispatch` with `contents: write`. Its step order is: bump version, commit and push `package.json` / `package-lock.json` / `server.json`, create a GitHub release, then publish to npm, Docker Hub, AWS Marketplace ECR, and the MCP Registry using org secrets the fork does not have. An accidental dispatch would push a version-bump commit and create a public release on the fork before failing at `npm publish`.
- Files: `.github/workflows/build-release.yml`, `.github/workflows/ci.yml`
- Current mitigation: none in the repo; it only runs on manual dispatch.
- Recommendations: add a one-line job guard `if: github.repository == 'brave/brave-search-mcp-server'` (minimal merge conflict surface) or disable the workflow in repository settings. Also extend `ci.yml` `on.push.branches` to include `jev`; today pushes to the fork branch get no CI at all.

**Error passthrough to the model:**

- Risk: `src/BraveAPI/index.ts` throws the full Brave error body, which the SDK returns to the model as tool error text; `src/protocols/http.ts` logs whole error objects to stderr.
- Files: `src/BraveAPI/index.ts`, `src/protocols/http.ts`
- Current mitigation: the subscription token is never part of these messages.
- Recommendations: when the Jev client is added, ensure its error path redacts `Authorization` headers and gateway account identifiers before surfacing errors.

## Performance Bottlenecks

**Duplicate payload on structured tools:**

- Problem: `brave_llm_context` and `brave_place_search` return the full JSON both as `content[0].text` and as `structuredContent`; `notes/brave-llm-context.md` records that Claude Code renders both, doubling context consumption.
- Files: `src/tools/llm_context/index.ts`, `src/tools/place_search/index.ts`
- Cause: SDK `outputSchema` registration requires `structuredContent` on every non-error result (`validateToolOutput` in the SDK throws otherwise).
- Improvement path: the fork's plan to drop `outputSchema` and `structuredContent` for `brave_llm_context` resolves this; the SDK skips output validation when no `outputSchema` is registered, so both must go together.

**No outbound timeout:**

- Problem: `fetch()` in `src/BraveAPI/index.ts` has no `AbortSignal`; a stalled Brave response blocks the tool call until the client gives up.
- Files: `src/BraveAPI/index.ts`
- Cause: upstream TODO.
- Improvement path: leave upstream alone; the Jev client must have its own timeout, and the filter must bound total added latency (the planned circuit breaker and per-request timeout in `notes/shadow-mode-logging.md` are unimplemented).

**Summarizer hot loop:** see Known Bugs. Files: `src/tools/summarizer/index.ts`.

**Per-request server construction on HTTP:**

- Problem: stateless mode and the session-less `tools/list` shortcut build a new `McpServer` (registering all tools and wrapping `tools/list`) for every request, and `enforce2020Dialect` re-converts every tool schema on each `tools/list` call.
- Files: `src/protocols/http.ts`, `src/jsonSchemaDialect.ts`
- Cause: no caching; design favors isolation.
- Improvement path: memoize converted schemas keyed by tool name; only matters under HTTP load.

**Planned Jev fan-out multiplies outbound calls per search:**

- Problem: the design issues one Jev request per surviving source after the Brave call returns, so per-search latency is Brave plus the slowest Jev batch, and request volume scales with `maximum_number_of_urls`.
- Files: `PLAN.md` §3.2 and §3.4, `notes/shadow-mode-logging.md`
- Cause: single-source state per request (deliberate, for answer quality).
- Improvement path: the plan's process-level concurrency gate, skip-when-no-candidates rule, token pre-estimation with degradation ladder, and circuit breaker must exist before `JEV_FILTER_MODE=on` is used; `off` and `shadow` modes should be the defaults until then.

## Fragile Areas

**`src/tools/llm_context/` (the fork's insertion point):**

- Files: `src/tools/llm_context/index.ts`, `src/tools/llm_context/schemas/input.ts`, `src/tools/llm_context/schemas/output.ts`, `src/tools/llm_context/index.test.ts`
- Why fragile: (1) `LlmContextSearchApiResponseSchema` is strict on value types (`z.url()` for every `grounding.generic[].url` and every key of `sources`), so one malformed URL from Brave fails the entire response and the model receives a zod error tree with `isError: true` and no content; unknown keys are silently stripped (zod v4 default), so new Brave fields vanish without warning. (2) `execute()` re-parses the SDK-validated arguments through two separate schemas to split query params from headers; any new input field must be added to one of them or it is dropped. (3) The local query limits are tighter than the Brave documentation's (see `notes/brave-llm-context.md`). (4) `index.test.ts` asserts `structuredContent` deep-equality, so it will fail the moment the fork removes structured output.
- Safe modification: wrap rather than edit (see Tech Debt); run the filter on the validated `data` object typed as `LlmContextSearchApiResponse` from `schemas/output.ts`; replace `index.test.ts` with a fork-owned test file only if the upstream one is deleted in the same commit (keeps the conflict to a deletion).
- Test coverage: one happy path and one malformed-response case; no header forwarding, no parameter serialization, no fixture-driven tests.

**`src/jsonSchemaDialect.ts`:**

- Files: `src/jsonSchemaDialect.ts`, `src/server.test.ts`
- Why fragile: private SDK field access; silent no-op if it disappears.
- Safe modification: none needed; re-run `npm test` after SDK bumps and watch `advertises valid JSON Schema 2020-12 schemas`.
- Test coverage: Ajv compile check only; no test that the wrapper actually engaged.

**`src/config.ts`:**

- Files: `src/config.ts`, `src/config.test.ts`
- Why fragile: singleton state plus `process.argv` parsing with `allowUnknownOption()`; `dotenv` at import; commander default values computed from env at module load.
- Safe modification: do not add Jev options here; keep them in a separate module.
- Test coverage: good for parsing; nothing for how other modules observe `state` changes.

**`src/protocols/http.ts`:**

- Files: `src/protocols/http.ts`
- Why fragile: session map lifecycle (see Known Bugs), special-cased session-less `tools/list`, transport creation logic branches on `config.stateless`.
- Safe modification: only through tests in `src/protocols/http.test.ts`, which cover Origin/Host guards and port conflicts but not session lifecycle.
- Test coverage: no stateful session create/reuse/close test.

**`src/BraveAPI/index.ts` parameter serialization:**

- Files: `src/BraveAPI/index.ts`
- Why fragile: three endpoint-specific branches (`ids`, `result_filter` + `summary`, `goggles`) and a generic `value.toString()` fallback that would comma-join any future array-typed parameter silently.
- Safe modification: avoid; add tests before touching.
- Test coverage: none (all tool tests stub `fetch` by pathname and never inspect the query string).

**`src/testUtils/mcpTestHarness.ts`:**

- Files: `src/testUtils/mcpTestHarness.ts`
- Why fragile: replaces `globalThis.fetch` and routes only on `url.pathname`; any unrecognized path throws `Unmocked Brave API request`. A Jev client built on global `fetch` will hit this in every `brave_llm_context` test unless each responder also answers the Jev path, and a client using a custom dispatcher would bypass the stub entirely and reach the network.
- Safe modification: extend the responder to key on host plus path, or inject the fetch function into the Jev client so tests pass a fake without touching globals.
- Test coverage: the harness itself is untested.

**`Dockerfile` pins:**

- Files: `Dockerfile`
- Why fragile: `node:alpine` is pinned by digest and `openssl` by exact apk version; Alpine rotates package versions, which already forced upstream commit `a75d7ef`. Without Renovate in the fork these pins rot and the image build fails.
- Safe modification: merge upstream regularly, or drop the openssl pin in the fork.

## Scaling Limits

**Stateful HTTP sessions:**

- Current capacity: unbounded map of `StreamableHTTPServerTransport` plus one `McpServer` each in `src/protocols/http.ts`.
- Limit: process memory; no eviction, no idle timeout.
- Scaling path: prune on transport close, or run stateless behind a load balancer.

**Brave API rate limits:**

- Current capacity: one subscription token, no client-side throttling (`src/BraveAPI/index.ts` TODO).
- Limit: Brave's plan-level rate limit surfaces as a raw `429` error string to the model.
- Scaling path: upstream's planned multi-key / self-throttling logic; not a fork priority.

**Jev requests per search (planned):**

- Current capacity: not implemented; design is one request per surviving source, gated by a process-level concurrency limit.
- Limit: the provider's per-request token ceiling (rejects rather than truncates) and per-minute request limits documented in `notes/jev-api.md`; the free gateway tier rate-limits aggressively per `notes/status.md`.
- Scaling path: token pre-estimation with the degradation ladder, skip-when-empty, and the circuit breaker in `notes/shadow-mode-logging.md`.

## Dependencies at Risk

**`@modelcontextprotocol/sdk` 1.30.0 (exact pin):**

- Risk: `src/jsonSchemaDialect.ts` depends on a private field; the draft-07 workaround is meant to be deleted after SDK PR #2085. The SDK's `outputSchema` enforcement shapes how tools must return results.
- Impact: bumps can silently change advertised schemas or break registration.
- Migration plan: bump only with `npm test` green; delete the dialect shim when the SDK emits 2020-12 natively.

**`zod` 4.3.6 (exact pin) alongside the SDK's own zod dependency:**

- Risk: the SDK converts zod schemas to JSON Schema via its compat layer; a zod major mismatch between the app and the SDK breaks `registerTool`.
- Impact: startup failure or invalid schemas.
- Migration plan: keep zod within the SDK's peer range; treat both pins as a pair.

**Node version drift:**

- Risk: no `engines` field in `package.json`; README says Node 22+, CI uses 24, the local machine runs 25. Native `fetch` proxy behavior (`NODE_USE_ENV_PROXY`, which `notes/brave-llm-context.md` relies on for the local proxy) differs across these versions.
- Impact: works-on-my-machine proxy behavior; untested runtime combinations.
- Migration plan: add `engines` in the fork if publishing; document the proxy env var in the README.

**Docker base image and `openssl` pins:** see Fragile Areas. Files: `Dockerfile`. Without Renovate the fork must bump these by hand.

**Loss of Renovate in the fork:**

- Risk: every dependency and GitHub Action is exact-pinned (versions and commit SHAs) on the assumption Renovate keeps them fresh; `.github/renovate.json` cannot resolve its preset outside the Brave org.
- Impact: security patches (upstream recently bumped `fast-uri`, `qs`, and a transitive `hono`) stop arriving unless upstream is merged regularly.
- Migration plan: schedule `git merge upstream/main` as part of the fork's routine; optionally enable Dependabot on the fork.

**Python dev scripts:**

- Risk: stdlib only, but `dev/jev_probe.py` shells out to `pwsh` on one code path and both scripts hardcode a proxy.
- Impact: non-Windows contributors cannot run them as-is.
- Migration plan: env-var-only configuration, or retire them once the TypeScript CLI compare tool exists.

## Missing Critical Features

**Filter library and Jev client (Phase 1 deliverables, nothing exists yet):**

- Problem: no pure filter module, no Jev client with the three backend adapters, no `intent` parameter, no `JEV_FILTER_MODE` / log-dir / threshold configuration, no status line, no JSONL logger, no token estimator, no circuit breaker, no `blocklist.txt`, no `fixtures/expected_*.json`, and no CLI compare tool. Directories named in `PLAN.md` §3.5 (`legacy/`, `reference/`) do not exist and `reference/` is not yet in `.gitignore`.
- Blocks: everything in `PLAN.md` §4; `notes/status.md` records that code changes await the owner's authorization.

**Runtime description override mechanism:**

- Problem: `PLAN.md` §3.5 wants personalized Chinese tool descriptions loaded from a file outside the repo, but no override loading exists; descriptions are string constants in each `src/tools/*/index.ts`.
- Blocks: shipping generic English descriptions in the repo while using Chinese ones locally.

**Docker-secret parity for Jev keys:**

- Problem: only `BRAVE_API_KEY_FILE` has a file-based variant (`src/utils.ts` `readBraveApiKeyFromFile`); `docker-compose.yml` passes through only Brave variables.
- Blocks: running the fork in the documented Compose-secrets setup.

**Fork disclosure in README and CI for the `jev` branch:**

- Problem: `README.md` has no fork section; `ci.yml` never runs for `jev`.
- Blocks: safe publication.

## Test Coverage Gaps

**Brave request serialization:**

- What's not tested: query-string construction in `issueRequest()` (`q` renaming, `ids` repetition, `result_filter` omission when `summary` is true, `goggles` HTTPS-only normalization, header overrides), error-body formatting.
- Files: `src/BraveAPI/index.ts`
- Risk: silent regressions in what Brave receives; the fork's `intent` field being forwarded by accident would go unnoticed.
- Priority: High (write these before wrapping `execute()`).

**`brave_llm_context` behavior beyond the happy path:**

- What's not tested: `x-loc-*` and `api-version` header forwarding, input validation failures (query length, enum values), `poi` and `map` variants, `enable_source_metadata` shapes, `.loose()` passthrough of unknown source fields.
- Files: `src/tools/llm_context/index.test.ts`, `src/tools/llm_context/schemas/output.ts`
- Risk: schema strictness failures on real responses surface only in production.
- Priority: High for the fork (the filter consumes exactly this shape).

**Fixtures are not wired to any test:**

- What's not tested: nothing under `fixtures/` is loaded by `npm test`; `fixtures/sanity/*.json` and the noise samples exist only for manual probing.
- Files: `fixtures/`, `dev/jev_probe.py`
- Risk: the local-rules layer will be built without executable expectations; `notes/local-rules-design.md` calls for hand-labeled `expected_*.json` that do not exist yet.
- Priority: High (Phase 1 step 3 depends on it).

**Tool enable/disable and registration:**

- What's not tested: `isToolPermittedByUser()` interplay with `createMcpServer()` (only `getOptions()` validation is covered).
- Files: `src/server.ts`, `src/config.ts`
- Risk: a whitelist bug would hide or expose tools silently.
- Priority: Medium.

**HTTP session lifecycle:**

- What's not tested: stateful session creation, reuse by `mcp-session-id`, unknown-id handling, DELETE, and map cleanup.
- Files: `src/protocols/http.ts`, `src/protocols/http.test.ts`
- Risk: the leak and the 400-vs-404 behavior above are unguarded.
- Priority: Medium (low for a stdio-only fork).

**Summarizer polling:**

- What's not tested: pending-status loop timing, retry on non-retryable errors, attempt exhaustion.
- Files: `src/tools/summarizer/index.ts`, `src/tools/summarizer/index.test.ts`
- Risk: the hot-loop bug has no failing test.
- Priority: Medium.

**2020-12 dialect wrapper engagement:**

- What's not tested: that `enforce2020Dialect()` actually found and wrapped the handler (a silent no-op passes `server.test.ts` only if the SDK already emits 2020-12).
- Files: `src/jsonSchemaDialect.ts`, `src/server.test.ts`
- Risk: false green after an SDK bump.
- Priority: Low.

**Test isolation from a local `.env`:**

- What's not tested: that tests cannot reach real APIs. Today the fetch stub throws on unmocked paths, but `dotenv` loads `.env` into every test process and only `src/config.test.ts` scrubs Brave variables. Future Jev variables (mode, keys, backend) would be inherited.
- Files: `src/config.ts`, `src/testUtils/mcpTestHarness.ts`, `src/config.test.ts`
- Risk: a test run spending real Jev quota or leaking fixture content to the provider from CI.
- Priority: High once the Jev client exists (default the filter to `off` when `NODE_ENV=test` or when no explicit mode is set in tests).

---

*Concerns audit: 2026-09-19*
