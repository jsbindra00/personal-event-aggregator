# Public Vercel Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a public Vercel deployment where visitors can store interests locally and stream direct event results from all four sources.

**Architecture:** A Vercel Node.js function composes the existing direct connectors, search service, and lexical evaluator for one stateless request and streams newline-delimited `SearchStreamMessage` values. A browser API adapter keeps interests in local storage and maps the streaming POST back into the web app's existing `EventApi` interface.

**Tech Stack:** TypeScript 7, React 19, Vite 7, Vercel Node.js 24 Functions, pnpm workspaces, Vitest, Zod.

## Global Constraints

- Preserve existing local Fastify, SQLite, Ollama, Chrome fallback, HTTP/SSE, and MCP behavior.
- Hosted mode must use only anonymous direct connectors and the strict lexical evaluator.
- Store public interest profiles only in the visitor's browser.
- Limit public searches to 31 inclusive calendar days and bounded inputs.
- Do not add credentials, hosted account connections, RSVPs, ticket purchases, organizer contact, or permissive CORS.
- Preserve canonical source event URLs.

---

### Task 1: Public search request and runtime

**Files:**
- Create: `apps/server/src/public-search.ts`
- Create: `apps/server/test/public-search.test.ts`

**Interfaces:**
- Produces: `publicSearchRequestSchema`, `createPublicSearchRuntime(options?)`, and `streamPublicSearch(input, signal)`.
- `streamPublicSearch` returns `AsyncIterable<SearchStreamMessage>` and completes after the search service emits `search.completed`.

- [ ] **Step 1: Write failing validation tests** for a valid request, missing positive interests, oversized interest lists, long entries, and a date range over 31 inclusive days.
- [ ] **Step 2: Run `pnpm exec vitest run apps/server/test/public-search.test.ts`** and verify the public runtime exports are missing.
- [ ] **Step 3: Implement the schema and stateless runtime** with direct connectors, lexical relevance, no-op persistence, in-memory relevance cache, and cancellation.
- [ ] **Step 4: Add a connector-injected stream test** proving progressive event and completion messages are emitted while one source failure remains isolated.
- [ ] **Step 5: Run the focused test and commit** with `feat: add stateless public search runtime`.

### Task 2: Vercel streaming function

**Files:**
- Create: `api/search.ts`
- Create: `api/search.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `publicSearchRequestSchema` and `streamPublicSearch`.
- Produces: a Web `POST` handler returning newline-delimited JSON and HTTP 400/405 JSON errors.

- [ ] **Step 1: Write failing handler tests** for method rejection, validation failure, NDJSON headers, an immediate first chunk, and completed output.
- [ ] **Step 2: Run `pnpm exec vitest run api/search.test.ts`** and verify the function is missing.
- [ ] **Step 3: Implement the Web-standard handler** with request-size checks, safe JSON parsing, cancellation propagation, `cache-control: no-store`, and `x-content-type-options: nosniff`.
- [ ] **Step 4: Export `maxDuration = 300`** and add an `@event-agg/server/public-search` package subpath so the function imports a tested runtime boundary.
- [ ] **Step 5: Run focused tests and commit** with `feat: expose public streaming search function`.

### Task 3: Browser-local public API adapter

**Files:**
- Create: `apps/web/src/lib/public-api.ts`
- Create: `apps/web/src/lib/public-api.test.ts`
- Modify: `apps/web/src/lib/api.ts`
- Modify: `apps/web/src/main.tsx`

**Interfaces:**
- Produces: `createPublicEventApi(options?)` implementing `EventApi` and `isPublicMode` on the interface.
- Consumes: NDJSON `SearchStreamMessage` lines from `/api/search`.

- [ ] **Step 1: Write failing tests** for default interests, versioned local persistence, request payloads, buffered message replay, malformed-line failure, and abort-on-cancel.
- [ ] **Step 2: Run the focused test** and verify the adapter is missing.
- [ ] **Step 3: Implement the adapter** with dependency-injected fetch/storage/ID creation, a per-search stream registry, line buffering across chunks, and cleanup.
- [ ] **Step 4: Select the adapter in `main.tsx`** when `import.meta.env.VITE_PUBLIC_MODE === "true"` while preserving `createEventApi()` locally.
- [ ] **Step 5: Run focused web tests and commit** with `feat: add browser-local public event API`.

### Task 4: Public-mode interface behavior

**Files:**
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/App.test.tsx`
- Modify: `apps/web/src/features/search/SearchForm.tsx`
- Modify: `apps/web/src/features/search/SourceStatus.tsx`
- Modify: `apps/web/src/styles.css`
- Modify: `apps/web/test/test-api.ts`

**Interfaces:**
- Consumes: `EventApi.isPublicMode`.
- Produces: public privacy/runtime note, hidden hosted connection actions, and default today-to-plus-30-day dates.

- [ ] **Step 1: Write failing UI tests** for the public note, hidden connection buttons, default 30-day dates, and existing local connection behavior.
- [ ] **Step 2: Run the focused App tests** and verify the public-mode assertions fail.
- [ ] **Step 3: Implement minimal UI changes** and accessible copy without changing event-card behavior.
- [ ] **Step 4: Run focused tests and commit** with `feat: explain hosted search privacy and limits`.

### Task 5: Vercel project configuration and documentation

**Files:**
- Create: `vercel.json`
- Modify: `.gitignore`
- Modify: `README.md`
- Modify: `package.json`

**Interfaces:**
- Produces: `build:vercel` script and a root Vercel project publishing `apps/web/dist` plus `api/search.ts`.

- [ ] **Step 1: Run the missing `pnpm build:vercel` command** and verify the hosted build entrypoint does not exist yet.
- [ ] **Step 2: Avoid a catch-all SPA rewrite** because the app has no client routes and `/api/search` must never be shadowed.
- [ ] **Step 3: Add `build:vercel`, `vercel.json`, `.vercel/` ignore, and public/local deployment documentation.**
- [ ] **Step 4: Run the focused test, `pnpm test`, `pnpm typecheck`, and `pnpm build:vercel`.**
- [ ] **Step 5: Commit** with `build: configure public Vercel deployment`.

### Task 6: Preview, live acceptance, and production release

**Files:**
- Modify only if acceptance finds a defect.

**Interfaces:**
- Produces: a Ready Vercel deployment URL and live search evidence.

- [ ] **Step 1: Run the repository secret scan and confirm no tracked deployment credentials or local data.**
- [ ] **Step 2: Link a new Vercel project non-interactively under the current account and deploy a preview.**
- [ ] **Step 3: Inspect the deployment and function logs until status is Ready.**
- [ ] **Step 4: Verify desktop and 390-pixel rendering, browser-local interest persistence, and a real Birmingham 30-day search through the preview.**
- [ ] **Step 5: Fix any defect with a failing test first, then repeat build and preview verification.**
- [ ] **Step 6: Deploy or promote the verified artifact to production, push `main` to GitHub, and verify the production URL.**
