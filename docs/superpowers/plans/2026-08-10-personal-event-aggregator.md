# Personal Event Aggregator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local, single-user application that searches Meetup, Luma, Guild, and Eventbrite through authenticated browser network requests, progressively ranks the results against saved interests, and exposes the same search through web, REST/SSE, and MCP interfaces.

**Architecture:** A pnpm TypeScript workspace separates the source-neutral core, SQLite persistence, persistent Chrome host, and four platform connectors. All connectors emit one asynchronous message contract into a search orchestrator; the web server and MCP server are adapters over that service. Platform cookies stay exclusively in a dedicated Playwright Chrome profile under `.data/`.

**Tech Stack:** Node.js 24+, pnpm 11+, TypeScript, Zod, `@js-temporal/polyfill`, Vitest, SQLite via `better-sqlite3`, Playwright Core with installed Google Chrome, Fastify, React/Vite, and `@modelcontextprotocol/sdk`.

## Global Constraints

- Personal, single-user, local-first MVP.
- Use no official Meetup, Luma, Guild, or Eventbrite APIs.
- Run searches only when requested; do not add scheduled crawling.
- Accept a city/address plus inclusive start and end dates.
- Stream results without waiting for the slowest source.
- Display only source event links; do not register, purchase, message, shortlist, or write back.
- Keep cookies, CSRF tokens, authorization headers, and raw private responses out of SQLite, source code, fixtures, and logs.
- Bind HTTP and MCP network transports to `127.0.0.1` by default.
- Pause for user action on login, CAPTCHA, new terms, consent, or permission screens; never bypass them.
- Treat each connector as independently fallible and repairable.
- Every production code change follows red-green-refactor and ends with a focused commit.

---

## File map

### Workspace

- `.gitignore` — excludes dependencies, builds, `.data/`, logs, unredacted captures, and environment files.
- `package.json` — root scripts and shared development dependencies.
- `pnpm-workspace.yaml` — declares apps and packages.
- `tsconfig.base.json` — strict shared TypeScript settings.
- `vitest.config.ts` — repository-wide test discovery.

### Applications

- `apps/server/src/app.ts` — Fastify routes and error mapping.
- `apps/server/src/bootstrap.ts` — dependency construction and loopback listener.
- `apps/server/src/sse.ts` — SSE serialization, replay, and disconnect cleanup.
- `apps/web/src/App.tsx` — composition only.
- `apps/web/src/features/interests/*` — profile editor and API calls.
- `apps/web/src/features/search/*` — search form, source status, stream hook, and results.
- `apps/mcp/src/server.ts` — MCP tool declarations and handlers.
- `apps/mcp/src/bootstrap.ts` — stdio startup and shared service construction.

### Source-neutral packages

- `packages/core/src/types.ts` — event, query, source, connector, and stream types.
- `packages/core/src/query.ts` — inclusive date validation and UTC conversion.
- `packages/core/src/normalize.ts` — raw-to-normalized event conversion.
- `packages/core/src/canonical-url.ts` — safe canonical URL handling.
- `packages/core/src/dedupe.ts` — exact and conservative cross-source identity.
- `packages/core/src/rank.ts` — deterministic interest matching and ordering.
- `packages/core/src/async-queue.ts` — cancellable async message queue.
- `packages/core/src/search-service.ts` — concurrent orchestration and snapshots.
- `packages/storage/src/database.ts` — SQLite connection and migrations.
- `packages/storage/src/repositories.ts` — interest, search, event, and connector persistence.
- `packages/browser/src/browser-host.ts` — dedicated persistent Chrome context and source pages.
- `packages/browser/src/observe-json.ts` — bounded JSON-response interception without secret persistence.
- `packages/connector-common/src/index.ts` — browser connector helpers and runtime contract.

### Source connectors

- `packages/connector-luma/src/{contract,parser,connector}.ts`
- `packages/connector-meetup/src/{contract,parser,connector}.ts`
- `packages/connector-eventbrite/src/{contract,parser,connector}.ts`
- `packages/connector-guild/src/{contract,parser,connector}.ts`
- Each connector owns `fixtures/search-page-1.redacted.json`, parser tests, and an opt-in live smoke test.
- `docs/connectors/<source>-network-contract.md` records the redacted, observed web request and pagination behavior.

---

### Task 1: Bootstrap the workspace and define the domain contract

**Files:**
- Create: `.gitignore`
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Create: `vitest.config.ts`
- Create: `packages/core/package.json`
- Create: `packages/core/tsconfig.json`
- Create: `packages/core/src/types.ts`
- Create: `packages/core/src/query.ts`
- Test: `packages/core/test/query.test.ts`

**Interfaces:**
- Consumes: no application code.
- Produces: `EventSource`, `EventSearchQuery`, `ResolvedSearchQuery`, `RawSourceEvent`, `NormalizedEvent`, `ConnectorMessage`, `SearchStreamMessage`, `EventConnector`, and `resolveSearchQuery()`.

- [ ] **Step 1: Create workspace manifests and install the initial toolchain**

```json
{
  "name": "personal-event-aggregator",
  "private": true,
  "packageManager": "pnpm@11.18.0",
  "engines": { "node": ">=24" },
  "scripts": {
    "build": "pnpm -r build",
    "test": "vitest run",
    "typecheck": "pnpm -r typecheck",
    "dev": "pnpm --parallel --filter @event-agg/server --filter @event-agg/web dev"
  }
}
```

Run:

```bash
pnpm add -Dw typescript vitest @types/node tsx
pnpm add --filter @event-agg/core zod @js-temporal/polyfill
```

- [ ] **Step 2: Write failing query-boundary tests**

```ts
import { describe, expect, it } from "vitest";
import { resolveSearchQuery } from "../src/query.js";

describe("resolveSearchQuery", () => {
  it("makes both local calendar dates inclusive", () => {
    expect(resolveSearchQuery({
      locationText: "London",
      startDate: "2026-08-10",
      endDate: "2026-08-11",
      timeZone: "Europe/London"
    })).toMatchObject({
      locationText: "London",
      startsAtUtc: "2026-08-09T23:00:00.000Z",
      endsBeforeUtc: "2026-08-11T23:00:00.000Z"
    });
  });

  it("rejects a reversed date interval", () => {
    expect(() => resolveSearchQuery({
      locationText: "London",
      startDate: "2026-08-11",
      endDate: "2026-08-10",
      timeZone: "Europe/London"
    })).toThrow(/end date/i);
  });
});
```

- [ ] **Step 3: Run the focused test and verify the red state**

Run: `pnpm test -- packages/core/test/query.test.ts`

Expected: FAIL because `packages/core/src/query.ts` does not exist.

- [ ] **Step 4: Implement strict types and inclusive-date resolution**

Define the connector contract exactly as:

```ts
export type EventSource = "meetup" | "luma" | "guild" | "eventbrite";

export interface EventConnector {
  readonly source: EventSource;
  getStatus(): Promise<ConnectorStatus>;
  connect(): AsyncIterable<ConnectorMessage>;
  search(query: ResolvedSearchQuery, signal: AbortSignal): AsyncIterable<ConnectorMessage>;
}
```

Define the shared records with these fields and names:

```ts
export type ConnectorState =
  | "disconnected" | "ready" | "searching" | "auth_required"
  | "user_action_required" | "rate_limited" | "failed" | "cancelled" | "complete";

export interface ConnectorStatus {
  source: EventSource;
  state: ConnectorState;
  lastSuccessAt: string | null;
  errorCode: string | null;
  safeMessage: string | null;
}

export interface EventSearchQuery {
  locationText: string;
  startDate: string;
  endDate: string;
  timeZone: string;
}

export interface ResolvedSearchQuery extends EventSearchQuery {
  startsAtUtc: string;
  endsBeforeUtc: string;
}

export interface InterestProfile {
  positive: string[];
  excluded: string[];
  note: string;
}

export interface RawSourceEvent {
  source: EventSource;
  sourceEventId: string | null;
  canonicalUrl: string;
  title: string;
  startsAt: string;
  endsAt?: string | null;
  timeZone?: string | null;
  descriptionHtml?: string | null;
  descriptionText?: string | null;
  organizerName?: string | null;
  venueName?: string | null;
  addressText?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  isOnline?: boolean;
  imageUrl?: string | null;
  priceText?: string | null;
  tags?: string[];
}

export interface NormalizedEvent extends Required<Omit<RawSourceEvent, "descriptionHtml">> {
  id: string;
  relevanceScore: number;
  matchedInterests: string[];
  firstSeenAt: string;
}

export type ConnectorMessage =
  | { type: "progress"; source: EventSource; phase: string; count?: number; resolvedLocation?: string }
  | { type: "event"; source: EventSource; event: RawSourceEvent }
  | { type: "auth_required"; source: EventSource; safeMessage: string }
  | { type: "user_action_required"; source: EventSource; safeMessage: string }
  | { type: "rate_limited"; source: EventSource; retryAfterMs?: number; safeMessage: string }
  | { type: "failed"; source: EventSource; errorCode: string; safeMessage: string }
  | { type: "complete"; source: EventSource; count: number };

export interface SearchStreamMessage {
  sequence: number;
  searchId: string;
  type:
    | "search.started" | "source.progress" | "source.auth_required"
    | "source.user_action_required" | "source.rate_limited" | "source.failed"
    | "event.added" | "event.updated" | "source.completed" | "search.completed";
  source?: EventSource;
  event?: NormalizedEvent;
  status?: ConnectorStatus;
}
```

Import `Temporal` from `@js-temporal/polyfill`. Convert the local start date at `00:00` and the day after the local end date at `00:00` into UTC ISO strings.

- [ ] **Step 5: Run core tests and type checking**

Run: `pnpm test -- packages/core/test/query.test.ts && pnpm --filter @event-agg/core typecheck`

Expected: PASS.

- [ ] **Step 6: Commit the domain foundation**

```bash
git add .gitignore package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json vitest.config.ts packages/core
git commit -m "feat: define event aggregator domain"
```

### Task 2: Normalize, deduplicate, and rank events

**Files:**
- Create: `packages/core/src/canonical-url.ts`
- Create: `packages/core/src/normalize.ts`
- Create: `packages/core/src/dedupe.ts`
- Create: `packages/core/src/rank.ts`
- Modify: `packages/core/src/types.ts`
- Create: `packages/core/src/index.ts`
- Test: `packages/core/test/normalize.test.ts`
- Test: `packages/core/test/dedupe.test.ts`
- Test: `packages/core/test/rank.test.ts`

**Interfaces:**
- Consumes: `RawSourceEvent`, `NormalizedEvent`, `EventSource` from Task 1.
- Produces: `normalizeEvent(raw)`, `canonicalizeEventUrl(url)`, `eventIdentity(event)`, `mergeDuplicate(current, incoming)`, `rankEvent(event, profile)`, and `sortRankedEvents(events)`.

- [ ] **Step 1: Write failing canonicalization and normalization tests**

```ts
expect(canonicalizeEventUrl("https://example.com/e/1?utm_source=x&ref=mail")).toBe("https://example.com/e/1");
expect(() => canonicalizeEventUrl("javascript:alert(1)")).toThrow(/http/i);
expect(normalizeEvent({
  source: "luma",
  sourceEventId: "evt_1",
  canonicalUrl: "https://lu.ma/example",
  title: "  AI Builders  ",
  startsAt: "2026-08-12T18:00:00Z",
  descriptionHtml: "<p>Hello <strong>builders</strong></p>"
})).toMatchObject({ title: "AI Builders", descriptionText: "Hello builders" });
```

- [ ] **Step 2: Write failing dedupe and relevance tests**

```ts
expect(eventIdentity(lumaEvent)).toBe("url:https://lu.ma/example");
expect(areProbableDuplicates(eventbriteEvent, meetupEvent)).toBe(true);
expect(rankEvent(aiEvent, {
  positive: ["artificial intelligence", "founders"],
  excluded: ["crypto trading"],
  note: "technical networking"
}).matchedInterests).toContain("founders");
```

- [ ] **Step 3: Verify all three test files fail**

Run: `pnpm test -- packages/core/test/normalize.test.ts packages/core/test/dedupe.test.ts packages/core/test/rank.test.ts`

Expected: FAIL on missing exports.

- [ ] **Step 4: Implement the minimal deterministic pipeline**

Use these weights in `rank.ts`:

```ts
export const MATCH_WEIGHTS = {
  titlePhrase: 12,
  titleToken: 5,
  tagPhrase: 7,
  organizerPhrase: 5,
  descriptionPhrase: 2,
  exclusion: -100
} as const;
```

Normalize text with Unicode NFKC, lowercase, punctuation-to-space conversion, and whitespace collapse. Strip HTML using a parser, not a regular expression. For cross-source duplicates, require normalized title equality or Jaccard token similarity of at least `0.9`, start times within 15 minutes, and matching normalized venue or organizer. Keep uncertain pairs separate.

- [ ] **Step 5: Run focused tests and core type checking**

Run: `pnpm test -- packages/core/test/normalize.test.ts packages/core/test/dedupe.test.ts packages/core/test/rank.test.ts && pnpm --filter @event-agg/core typecheck`

Expected: PASS.

- [ ] **Step 6: Commit the event pipeline**

```bash
git add packages/core
git commit -m "feat: normalize and rank aggregated events"
```

### Task 3: Add SQLite repositories without storing browser secrets

**Files:**
- Create: `packages/storage/package.json`
- Create: `packages/storage/tsconfig.json`
- Create: `packages/storage/src/database.ts`
- Create: `packages/storage/src/repositories.ts`
- Create: `packages/storage/src/index.ts`
- Test: `packages/storage/test/repositories.test.ts`

**Interfaces:**
- Consumes: core query, event, profile, and connector status types.
- Produces: `openDatabase(path)`, `InterestRepository`, `SearchRepository`, `EventRepository`, and `ConnectorStatusRepository`.

- [ ] **Step 1: Install SQLite dependencies and write a failing repository test**

Run: `pnpm add --filter @event-agg/storage better-sqlite3 && pnpm add -D --filter @event-agg/storage @types/better-sqlite3`

```ts
const db = openDatabase(":memory:");
const repos = createRepositories(db);
repos.interests.replace({ positive: ["AI"], excluded: ["sales pitch"], note: "builders" });
expect(repos.interests.get()).toEqual({ positive: ["AI"], excluded: ["sales pitch"], note: "builders" });
expect(db.prepare("select name from sqlite_master where name = 'raw_responses'").get()).toBeUndefined();
```

- [ ] **Step 2: Run the repository test and verify failure**

Run: `pnpm test -- packages/storage/test/repositories.test.ts`

Expected: FAIL because the storage package is not implemented.

- [ ] **Step 3: Implement migrations and prepared-statement repositories**

Create only these tables: `interest_profile`, `interest_terms`, `searches`, `search_sources`, `events`, `search_events`, and `connector_status`. Store connector failures as `error_code` and `safe_message`; do not add request headers, cookies, response bodies, or token columns.

Use transactions for profile replacement and event upsert/search-link creation. Create the parent `.data/` directory with mode `0700` and the database file with mode `0600`. Enable `journal_mode = WAL`, `foreign_keys = ON`, and a five-second `busy_timeout`.

- [ ] **Step 4: Test persistence and schema safety**

Run: `pnpm test -- packages/storage/test/repositories.test.ts && pnpm --filter @event-agg/storage typecheck`

Expected: PASS.

- [ ] **Step 5: Commit SQLite persistence**

```bash
git add packages/storage pnpm-lock.yaml
git commit -m "feat: persist event searches in sqlite"
```

### Task 4: Orchestrate concurrent connector streams

**Files:**
- Create: `packages/core/src/async-queue.ts`
- Create: `packages/core/src/search-service.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/search-service.test.ts`

**Interfaces:**
- Consumes: `EventConnector`, repositories from Task 3 through a narrow `SearchStore` interface, and Task 2 pipeline functions.
- Produces: `SearchService.start(query)`, `SearchService.subscribe(searchId, afterSequence?)`, `SearchService.snapshot(searchId)`, and `SearchService.cancel(searchId)`.

- [ ] **Step 1: Write a failing progressive-concurrency test**

```ts
const slow = fakeConnector("guild", [eventAfter(50, guildEvent), completeAfter(60)]);
const fast = fakeConnector("luma", [eventAfter(1, lumaEvent), completeAfter(2)]);
const service = createSearchService({ connectors: [slow, fast], store: memoryStore(), interests: profile });
const { searchId } = await service.start(validQuery);
const messages = service.subscribe(searchId);
expect((await next(messages)).type).toBe("search.started");
expect((await nextOfType(messages, "event.added")).event.source).toBe("luma");
```

Add tests proving that a failed Meetup connector does not cancel Eventbrite, duplicates emit `event.updated`, cancellation aborts unfinished connectors, and `search.completed` appears exactly once.

- [ ] **Step 2: Run the orchestrator test and verify failure**

Run: `pnpm test -- packages/core/test/search-service.test.ts`

Expected: FAIL because `SearchService` is missing.

- [ ] **Step 3: Implement `AsyncQueue` and `SearchService`**

Assign a monotonic `sequence` to every stream message. Retain the bounded message history for the life of the process so SSE reconnects can replay messages after `Last-Event-ID`. Run every connector with its own `AbortController`; convert thrown errors into source-scoped `failed` messages; settle the global search only when every source is complete, failed, rate-limited, auth-required, user-action-required, or cancelled.

- [ ] **Step 4: Run the orchestrator suite**

Run: `pnpm test -- packages/core/test/search-service.test.ts && pnpm --filter @event-agg/core typecheck`

Expected: PASS.

- [ ] **Step 5: Commit concurrent orchestration**

```bash
git add packages/core
git commit -m "feat: stream concurrent event searches"
```

### Task 5: Expose REST and SSE on loopback

**Files:**
- Create: `apps/server/package.json`
- Create: `apps/server/tsconfig.json`
- Create: `apps/server/src/app.ts`
- Create: `apps/server/src/sse.ts`
- Create: `apps/server/src/bootstrap.ts`
- Test: `apps/server/test/app.test.ts`
- Test: `apps/server/test/sse.test.ts`

**Interfaces:**
- Consumes: `SearchService` and repositories.
- Produces: `buildApp(dependencies)` and the HTTP routes from the design specification.

- [ ] **Step 1: Install Fastify and write failing route tests**

Run: `pnpm add --filter @event-agg/server fastify zod`

```ts
const app = buildApp(testDependencies());
const response = await app.inject({
  method: "POST",
  url: "/api/searches",
  payload: { locationText: "London", startDate: "2026-08-10", endDate: "2026-08-12", timeZone: "Europe/London" }
});
expect(response.statusCode).toBe(202);
expect(response.json()).toMatchObject({ streamUrl: expect.stringMatching(/\/stream$/) });
```

Test invalid dates as `400`, missing searches as `404`, and cancellation as idempotent.

- [ ] **Step 2: Run server tests and verify failure**

Run: `pnpm test -- apps/server/test/app.test.ts apps/server/test/sse.test.ts`

Expected: FAIL because the server app is missing.

- [ ] **Step 3: Implement routes and SSE framing**

SSE events must include `id: <sequence>`, `event: <message.type>`, and one JSON `data:` line. On connection, replay messages after `Last-Event-ID`, then forward live messages. Stop only the subscription when the HTTP client disconnects; do not cancel the underlying search unless `/cancel` is called.

- [ ] **Step 4: Verify loopback binding and streaming behavior**

Run: `pnpm test -- apps/server/test/app.test.ts apps/server/test/sse.test.ts && pnpm --filter @event-agg/server typecheck`

Expected: PASS, including a test that `bootstrap` defaults to host `127.0.0.1`.

- [ ] **Step 5: Commit the local API**

```bash
git add apps/server pnpm-lock.yaml
git commit -m "feat: expose event search REST and SSE"
```

### Task 6: Build the progressive web interface

**Files:**
- Create: `apps/web/package.json`
- Create: `apps/web/vite.config.ts`
- Create: `apps/web/index.html`
- Create: `apps/web/src/main.tsx`
- Create: `apps/web/src/App.tsx`
- Create: `apps/web/src/styles.css`
- Create: `apps/web/src/lib/api.ts`
- Create: `apps/web/src/features/interests/InterestEditor.tsx`
- Create: `apps/web/src/features/search/SearchForm.tsx`
- Create: `apps/web/src/features/search/useEventSearch.ts`
- Create: `apps/web/src/features/search/SourceStatus.tsx`
- Create: `apps/web/src/features/search/EventResults.tsx`
- Test: `apps/web/src/features/search/useEventSearch.test.tsx`
- Test: `apps/web/src/App.test.tsx`

**Interfaces:**
- Consumes: Task 5 HTTP/SSE JSON shapes.
- Produces: a single-page UI for interests, searches, progressive source state, and canonical links.

- [ ] **Step 1: Install React testing dependencies and write failing UI tests**

Run:

```bash
pnpm add --filter @event-agg/web react react-dom
pnpm add -D --filter @event-agg/web vite @vitejs/plugin-react jsdom @testing-library/react @testing-library/user-event @types/react @types/react-dom
```

```tsx
render(<App api={fakeApiWithStream([
  sourceProgress("luma", "searching"),
  eventAdded({ title: "AI Builders", canonicalUrl: "https://lu.ma/example" }),
  sourceCompleted("luma")
])} />);
await user.type(screen.getByLabelText(/location/i), "London");
await user.click(screen.getByRole("button", { name: /search/i }));
expect(await screen.findByRole("link", { name: /open event/i })).toHaveAttribute("href", "https://lu.ma/example");
```

- [ ] **Step 2: Verify the UI test fails**

Run: `pnpm test -- apps/web/src/App.test.tsx apps/web/src/features/search/useEventSearch.test.tsx`

Expected: FAIL because the web app is absent.

- [ ] **Step 3: Implement the smallest complete interface**

Use native `EventSource` for the stream. Merge `event.added` and `event.updated` by event ID, sort by descending `relevanceScore` then ascending `startsAt`, and render source status independently. Open canonical links with `target="_blank"` and `rel="noreferrer"`. Render descriptions only as text.

- [ ] **Step 4: Run UI tests, type checking, and production build**

Run: `pnpm test -- apps/web/src/App.test.tsx apps/web/src/features/search/useEventSearch.test.tsx && pnpm --filter @event-agg/web typecheck && pnpm --filter @event-agg/web build`

Expected: PASS.

- [ ] **Step 5: Commit the web interface**

```bash
git add apps/web pnpm-lock.yaml
git commit -m "feat: add progressive event search interface"
```

### Task 7: Add the dedicated browser host and connector runtime

**Files:**
- Create: `packages/browser/package.json`
- Create: `packages/browser/src/browser-host.ts`
- Create: `packages/browser/src/observe-json.ts`
- Create: `packages/browser/src/index.ts`
- Create: `packages/connector-common/package.json`
- Create: `packages/connector-common/src/index.ts`
- Create: `packages/connector-common/src/retry.ts`
- Test: `packages/browser/test/browser-host.test.ts`
- Test: `packages/browser/test/observe-json.test.ts`
- Test: `packages/connector-common/test/retry.test.ts`

**Interfaces:**
- Consumes: `EventSource` and `ResolvedSearchQuery`.
- Produces: `BrowserHost.pageFor(source, origin)`, `BrowserHost.closeSource(source)`, `observeJsonResponses(page, policy, action)`, and `ObservedSearchContract`.

- [ ] **Step 1: Install Playwright Core and write failing browser-host tests**

Run: `pnpm add --filter @event-agg/browser playwright-core`

Use a temporary profile and local HTTP fixture server. Assert that two calls for Luma reuse one source page, Guild receives a separate page, and closing a source does not close the browser context.

- [ ] **Step 2: Write a failing bounded-interception test**

```ts
const payloads = await observeJsonResponses(page, {
  allowedHosts: ["127.0.0.1"],
  maxBodyBytes: 1_000_000,
  responseMatches: response => response.url().endsWith("/events.json")
}, () => page.click("#search"));
expect(payloads).toEqual([{ events: [{ title: "Safe fixture" }] }]);
```

Add tests rejecting disallowed hosts, non-JSON content types, oversized bodies, and aborted actions.

- [ ] **Step 3: Write a failing bounded-retry test**

```ts
const calls: string[] = [];
const result = await withConnectorRetry(async attempt => {
  calls.push(`attempt-${attempt}`);
  if (attempt < 3) throw connectorFailure("network", "temporary network failure");
  return "ok";
}, { maxAttempts: 3, baseDelayMs: 500, maxDelayMs: 5_000, jitterRatio: 0.2, sleep: async () => undefined });
expect(result).toBe("ok");
expect(calls).toEqual(["attempt-1", "attempt-2", "attempt-3"]);
```

Add assertions that `auth_required`, `user_action_required`, `contract_drift`, and `parsing` failures make exactly one attempt, while `network` and `rate_limited` failures may retry.

- [ ] **Step 4: Verify the browser and connector-common tests fail**

Run: `pnpm test -- packages/browser/test/browser-host.test.ts packages/browser/test/observe-json.test.ts packages/connector-common/test/retry.test.ts`

Expected: FAIL on missing browser runtime.

- [ ] **Step 5: Implement the persistent host, observed contract, and retry policy**

Launch with:

```ts
chromium.launchPersistentContext(profilePath, {
  channel: "chrome",
  headless: false,
  serviceWorkers: "block"
});
```

Default `profilePath` to `.data/chrome-profile` and create it with mode `0700`. Never call `context.cookies()` from production code. `observeJsonResponses` may parse response bodies in memory and must discard unmatched payloads immediately. Implement three-attempt exponential retry for `network` and `rate_limited` failures with the tested delay values; inject the sleeper and random source so tests remain deterministic.

Define:

```ts
export interface ObservedSearchContract {
  source: EventSource;
  origin: string;
  allowedHosts: readonly string[];
  connectUrl: string;
  performSearch(page: Page, query: ResolvedSearchQuery): Promise<void>;
  responseMatches(response: Response): boolean;
}
```

- [ ] **Step 6: Run browser tests and type checking**

Run: `pnpm test -- packages/browser/test/browser-host.test.ts packages/browser/test/observe-json.test.ts packages/connector-common/test/retry.test.ts && pnpm --filter @event-agg/browser typecheck && pnpm --filter @event-agg/connector-common typecheck`

Expected: PASS.

- [ ] **Step 7: Commit the browser runtime**

```bash
git add packages/browser packages/connector-common pnpm-lock.yaml
git commit -m "feat: add authenticated browser connector host"
```

### Task 8: Inspect and document Luma's web search contract

**Files:**
- Create: `docs/connectors/luma-network-contract.md`
- Create: `packages/connector-luma/fixtures/search-page-1.redacted.json`
- Create: `packages/connector-luma/test/fixture-safety.test.ts`

**Interfaces:**
- Consumes: an authenticated Luma session in the dedicated Chrome profile.
- Produces: a redacted request/response contract and JSON fixture used by Task 9.

- [ ] **Step 1: Perform one ordinary read-only Luma search with Computer Use**

Open Chrome DevTools Network, clear the log, filter to Fetch/XHR, search for events in London across a future two-day interval, and inspect only first-party Luma requests. Record the request method, pathname pattern, query/body fields, response discriminator, pagination cursor, event container path, and authentication failure signal.

- [ ] **Step 2: Create the redacted contract document**

The document must contain exact observed values for method, pathname, location/date field names, pagination, response event path, and required normalized fields. Replace account IDs with `account_redacted`, event IDs with stable fixture values such as `evt_fixture_1`, and remove every cookie/header value.

- [ ] **Step 3: Save one minimized redacted response fixture**

Keep two event records, one pagination value, and only fields needed for normalization. The fixture must remain valid JSON and contain no email address, bearer token, cookie string, CSRF value, or real account identifier.

- [ ] **Step 4: Add and run fixture safety checks**

```ts
const text = readFileSync(new URL("../fixtures/search-page-1.redacted.json", import.meta.url), "utf8");
expect(() => JSON.parse(text)).not.toThrow();
expect(text).not.toMatch(/authorization|set-cookie|csrf|bearer\s|@[a-z0-9.-]+\.[a-z]{2,}/i);
```

Run: `pnpm test -- packages/connector-luma/test/fixture-safety.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit only the redacted artifacts**

```bash
git add docs/connectors/luma-network-contract.md packages/connector-luma/fixtures packages/connector-luma/test/fixture-safety.test.ts
git commit -m "docs: record redacted Luma search contract"
```

### Task 9: Implement the Luma connector end to end

**Files:**
- Create: `packages/connector-luma/package.json`
- Create: `packages/connector-luma/src/contract.ts`
- Create: `packages/connector-luma/src/parser.ts`
- Create: `packages/connector-luma/src/connector.ts`
- Create: `packages/connector-luma/src/index.ts`
- Test: `packages/connector-luma/test/parser.test.ts`
- Test: `packages/connector-luma/test/connector.test.ts`
- Test: `packages/connector-luma/test/live.smoke.test.ts`

**Interfaces:**
- Consumes: exact observed fields in `docs/connectors/luma-network-contract.md`, the redacted fixture, `BrowserHost`, and `ObservedSearchContract`.
- Produces: `createLumaConnector(browserHost): EventConnector`.

- [ ] **Step 1: Write failing parser assertions against the captured fixture**

```ts
const events = parseLumaSearchPayload(loadFixture("search-page-1.redacted.json"));
expect(events).toHaveLength(2);
expect(events[0]).toMatchObject({
  source: "luma",
  sourceEventId: "evt_fixture_1"
});
expect(events[0].canonicalUrl).toMatch(/^https:\/\/(lu\.ma|luma\.com)\//);
expect(Number.isNaN(Date.parse(events[0].startsAt))).toBe(false);
```

- [ ] **Step 2: Verify parser failure**

Run: `pnpm test -- packages/connector-luma/test/parser.test.ts`

Expected: FAIL because `parseLumaSearchPayload` is missing.

- [ ] **Step 3: Implement the exact contract and parser**

Encode only the method, path predicate, UI action, response discriminator, pagination, and field paths documented in Task 8. Validate response envelopes with Zod before mapping records to `RawSourceEvent`. Return a parser error code when the event container is absent; do not guess at unrelated arrays.

- [ ] **Step 4: Write and pass connector-stream tests**

Mock `BrowserHost` and `observeJsonResponses`. Assert message order `progress → event* → complete`, `auth_required` for the observed login response, and `failed(contract_drift)` when the parser envelope is invalid.

Run: `pnpm test -- packages/connector-luma/test/parser.test.ts packages/connector-luma/test/connector.test.ts`

Expected: PASS.

- [ ] **Step 5: Add an opt-in read-only live smoke test**

Gate it with `LIVE_CONNECTOR_SMOKE=luma`. Search a future date range, stop after the first valid event or terminal status, and assert that no POST/PUT/PATCH/DELETE request is made except the source's observed read-only search POST if that is how its web application queries.

- [ ] **Step 6: Run package tests and commit**

Run: `pnpm --filter @event-agg/connector-luma test && pnpm --filter @event-agg/connector-luma typecheck`

```bash
git add packages/connector-luma pnpm-lock.yaml
git commit -m "feat: add Luma event connector"
```

### Task 10: Inspect and implement the Meetup connector

**Files:**
- Create: `docs/connectors/meetup-network-contract.md`
- Create: `packages/connector-meetup/package.json`
- Create: `packages/connector-meetup/fixtures/search-page-1.redacted.json`
- Create: `packages/connector-meetup/src/contract.ts`
- Create: `packages/connector-meetup/src/parser.ts`
- Create: `packages/connector-meetup/src/connector.ts`
- Create: `packages/connector-meetup/src/index.ts`
- Test: `packages/connector-meetup/test/fixture-safety.test.ts`
- Test: `packages/connector-meetup/test/parser.test.ts`
- Test: `packages/connector-meetup/test/connector.test.ts`
- Test: `packages/connector-meetup/test/live.smoke.test.ts`

**Interfaces:**
- Consumes: Tasks 1, 2, and 7 contracts.
- Produces: `createMeetupConnector(browserHost): EventConnector`.

- [ ] **Step 1: Inspect one authenticated Meetup search**

With Computer Use and Chrome DevTools, record the exact first-party request used by the normal Meetup search page, including GraphQL operation name when present, variables for location/date/pagination, event list path, and login-expired response. Do not use Meetup's documented external GraphQL API endpoint.

- [ ] **Step 2: Save and validate minimized redacted artifacts**

Keep two events and one pagination cursor in `search-page-1.redacted.json`. Add the same JSON parse and secret-pattern assertions used for Luma, explicitly scanning for `authorization`, `cookie`, `csrf`, `bearer`, and email patterns.

- [ ] **Step 3: Write failing parser and connector tests**

```ts
expect(parseMeetupSearchPayload(fixture)[0]).toMatchObject({
  source: "meetup",
  sourceEventId: expect.any(String),
  title: expect.any(String),
  canonicalUrl: expect.stringMatching(/^https:\/\/www\.meetup\.com\//)
});
```

Assert progressive messages, cursor pagination, login detection, abort behavior, and contract-drift classification.

- [ ] **Step 4: Implement only the observed internal web contract**

Execute the search inside the authenticated Meetup page context, match the documented operation/path, validate the documented envelope with Zod, and map its event records. Keep pagination bounded to the requested date interval and stop when the cursor is empty or every returned start time exceeds `endsBeforeUtc`.

- [ ] **Step 5: Run tests, optionally run the live smoke test, and commit**

Run: `pnpm --filter @event-agg/connector-meetup test && pnpm --filter @event-agg/connector-meetup typecheck`

```bash
git add docs/connectors/meetup-network-contract.md packages/connector-meetup pnpm-lock.yaml
git commit -m "feat: add Meetup event connector"
```

### Task 11: Inspect and implement the Eventbrite connector

**Files:**
- Create: `docs/connectors/eventbrite-network-contract.md`
- Create: `packages/connector-eventbrite/package.json`
- Create: `packages/connector-eventbrite/fixtures/search-page-1.redacted.json`
- Create: `packages/connector-eventbrite/src/contract.ts`
- Create: `packages/connector-eventbrite/src/parser.ts`
- Create: `packages/connector-eventbrite/src/connector.ts`
- Create: `packages/connector-eventbrite/src/index.ts`
- Test: `packages/connector-eventbrite/test/fixture-safety.test.ts`
- Test: `packages/connector-eventbrite/test/parser.test.ts`
- Test: `packages/connector-eventbrite/test/connector.test.ts`
- Test: `packages/connector-eventbrite/test/live.smoke.test.ts`

**Interfaces:**
- Consumes: Tasks 1, 2, and 7 contracts.
- Produces: `createEventbriteConnector(browserHost): EventConnector`.

- [ ] **Step 1: Inspect one normal Eventbrite discovery search**

Use Computer Use and DevTools on the consumer discovery page, not organizer-management pages. Record the internal first-party search request, location/date representation, result container, paging model, price/venue fields, and login-expired response.

- [ ] **Step 2: Save minimized redacted artifacts and add the safety test**

Keep two event records and paging metadata. Remove attendee, order, organizer-account, email, token, cookie, and analytics payload fields. Validate JSON and scan secrets before committing.

- [ ] **Step 3: Write failing parser and connector tests**

```ts
expect(parseEventbriteSearchPayload(fixture)[0]).toMatchObject({
  source: "eventbrite",
  canonicalUrl: expect.stringMatching(/^https:\/\/(www\.)?eventbrite\./),
  startsAt: expect.any(String)
});
```

Assert that duplicate tracking URLs canonicalize to one event, empty pages complete normally, and unexpected envelopes emit `failed(contract_drift)`.

- [ ] **Step 4: Implement the observed consumer-search contract**

Drive or replay the documented request inside the Eventbrite origin. Validate only the consumer event-search envelope. Do not call organization, attendee, order, ticket-write, or event-management endpoints.

- [ ] **Step 5: Run tests, optionally run the live smoke test, and commit**

Run: `pnpm --filter @event-agg/connector-eventbrite test && pnpm --filter @event-agg/connector-eventbrite typecheck`

```bash
git add docs/connectors/eventbrite-network-contract.md packages/connector-eventbrite pnpm-lock.yaml
git commit -m "feat: add Eventbrite event connector"
```

### Task 12: Inspect and implement the Guild connector

**Files:**
- Create: `docs/connectors/guild-network-contract.md`
- Create: `packages/connector-guild/package.json`
- Create: `packages/connector-guild/fixtures/search-page-1.redacted.json`
- Create: `packages/connector-guild/src/contract.ts`
- Create: `packages/connector-guild/src/parser.ts`
- Create: `packages/connector-guild/src/connector.ts`
- Create: `packages/connector-guild/src/index.ts`
- Test: `packages/connector-guild/test/fixture-safety.test.ts`
- Test: `packages/connector-guild/test/parser.test.ts`
- Test: `packages/connector-guild/test/connector.test.ts`
- Test: `packages/connector-guild/test/live.smoke.test.ts`

**Interfaces:**
- Consumes: Tasks 1, 2, and 7 contracts.
- Produces: `createGuildConnector(browserHost): EventConnector`.

- [ ] **Step 1: Inspect the authenticated Guild events view**

Use Computer Use and DevTools to open the normal events area visible to the user's memberships. Record whether events arrive globally or per group, the exact read request(s), group/event paging, date fields, canonical link construction, and signals for inaccessible groups or expired login.

- [ ] **Step 2: Save a privacy-minimized fixture and contract**

Retain only two event records, opaque fixture group IDs, group display names required for organizer context, and paging metadata. Remove member lists, messages, emails, profiles, analytics, and authentication material.

- [ ] **Step 3: Write failing privacy, parser, and connector tests**

```ts
expect(parseGuildSearchPayload(fixture)[0]).toMatchObject({
  source: "guild",
  title: expect.any(String),
  canonicalUrl: expect.stringMatching(/^https:\/\/(app\.)?guild\.co\//)
});
expect(JSON.stringify(parseGuildSearchPayload(fixture))).not.toMatch(/memberEmail|messageBody/);
```

Test multiple group pages, inaccessible group isolation, cancellation, and contract drift.

- [ ] **Step 4: Implement the narrow events-only connector**

Match only the documented events request(s). Never intercept or parse conversation, message, member-directory, or analytics responses. If searches are group-scoped, iterate only groups already visible to the signed-in user and emit progress per group without persisting member data.

- [ ] **Step 5: Run tests, optionally run the live smoke test, and commit**

Run: `pnpm --filter @event-agg/connector-guild test && pnpm --filter @event-agg/connector-guild typecheck`

```bash
git add docs/connectors/guild-network-contract.md packages/connector-guild pnpm-lock.yaml
git commit -m "feat: add Guild event connector"
```

### Task 13: Wire real connectors and connection status into the application

**Files:**
- Create: `apps/server/src/dependencies.ts`
- Modify: `apps/server/src/bootstrap.ts`
- Modify: `apps/server/src/app.ts`
- Modify: `apps/web/src/features/search/SourceStatus.tsx`
- Create: `apps/server/test/connectors.test.ts`

**Interfaces:**
- Consumes: all four `create<Source>Connector()` factories and `BrowserHost`.
- Produces: real `/api/connectors`, `/api/connectors/:source/connect`, and four-source `SearchService` construction.

- [ ] **Step 1: Write failing dependency-wiring tests**

Assert that production dependencies contain exactly `luma`, `meetup`, `eventbrite`, and `guild`; one source's `auth_required` state appears at `/api/connectors` without changing other states; and `/connect` opens only that source's `connectUrl`.

- [ ] **Step 2: Verify wiring tests fail**

Run: `pnpm test -- apps/server/test/connectors.test.ts`

Expected: FAIL because production dependencies still use test doubles.

- [ ] **Step 3: Construct the browser host and connector registry once**

Create one `BrowserHost` per server process and one connector instance per source. Persist only each source's safe state, last successful check, error code, and safe message through `ConnectorStatusRepository`. Register a graceful shutdown hook that cancels active searches, closes source pages, closes the browser context, then closes SQLite.

- [ ] **Step 4: Expose actionable status in the web client**

Render `Connect`, `Sign in again`, or `Open source` only from safe status fields. Clicking `Connect` may open the dedicated browser page but must not accept credentials inside the aggregator UI.

- [ ] **Step 5: Run server and UI regression tests and commit**

Run: `pnpm test -- apps/server/test/connectors.test.ts apps/web/src/App.test.tsx && pnpm typecheck`

```bash
git add apps/server apps/web
git commit -m "feat: wire live event connectors"
```

### Task 14: Add the MCP interface over the shared services

**Files:**
- Create: `apps/mcp/package.json`
- Create: `apps/mcp/tsconfig.json`
- Create: `apps/mcp/src/server.ts`
- Create: `apps/mcp/src/bootstrap.ts`
- Test: `apps/mcp/test/server.test.ts`

**Interfaces:**
- Consumes: `SearchService`, interest repository, connector status service, and core Zod schemas.
- Produces: `get_event_interests`, `set_event_interests`, `get_event_sources_status`, `search_events`, `start_event_search`, and `get_event_search_results` tools.

- [ ] **Step 1: Install the MCP SDK and write failing tool tests**

Run: `pnpm add --filter @event-agg/mcp @modelcontextprotocol/sdk zod`

```ts
const result = await callTool(server, "search_events", {
  locationText: "London",
  startDate: "2026-08-10",
  endDate: "2026-08-12",
  timeZone: "Europe/London"
});
expect(result.structuredContent.events[0]).toMatchObject({
  title: "AI Builders",
  url: "https://lu.ma/example",
  source: "luma"
});
```

Add tests for profile replacement, progressive polling, partial source failure, and progress notifications when a progress token exists.

- [ ] **Step 2: Run MCP tests and verify failure**

Run: `pnpm test -- apps/mcp/test/server.test.ts`

Expected: FAIL because the MCP application is missing.

- [ ] **Step 3: Implement thin MCP handlers**

Handlers validate with the same core schemas as HTTP. `search_events` waits until `search.completed` and returns ranked links plus source outcomes. `start_event_search` returns immediately with `searchId`; `get_event_search_results` returns snapshot events and source states. Do not instantiate connectors inside handlers.

- [ ] **Step 4: Run MCP tests and type checking**

Run: `pnpm test -- apps/mcp/test/server.test.ts && pnpm --filter @event-agg/mcp typecheck`

Expected: PASS.

- [ ] **Step 5: Commit MCP support**

```bash
git add apps/mcp pnpm-lock.yaml
git commit -m "feat: expose event search through MCP"
```

### Task 15: Harden redaction, diagnostics, and end-to-end acceptance

**Files:**
- Create: `packages/core/src/redact.ts`
- Test: `packages/core/test/redact.test.ts`
- Modify: `apps/server/src/bootstrap.ts`
- Create: `test/e2e/search-flow.test.ts`
- Create: `README.md`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: the complete application.
- Produces: `redactDiagnostic(value)`, structured safe logs, full mocked E2E coverage, and operator documentation.

- [ ] **Step 1: Write failing adversarial redaction tests**

```ts
expect(redactDiagnostic({
  authorization: "Bearer secret",
  cookie: "sid=secret",
  url: "https://example.test/search?token=secret&q=events",
  safe: "contract_drift"
})).toEqual({
  authorization: "[REDACTED]",
  cookie: "[REDACTED]",
  url: "https://example.test/search?q=events",
  safe: "contract_drift"
});
```

Include nested arrays, mixed-case keys, CSRF values, email addresses, and circular-object handling.

- [ ] **Step 2: Write a failing complete mocked search-flow test**

Start the real SQLite repository and Fastify app with four asynchronous fake connectors. Save interests, start a London date search, consume SSE, assert progressive event order, one enriched duplicate, isolated Guild failure, final ranked REST snapshot, and equivalent MCP structured content.

- [ ] **Step 3: Verify hardening tests fail**

Run: `pnpm test -- packages/core/test/redact.test.ts test/e2e/search-flow.test.ts`

Expected: FAIL because redaction and the complete harness are missing.

- [ ] **Step 4: Implement safe diagnostics and operating documentation**

Route every connector error and structured log through `redactDiagnostic`. In `README.md`, document Node/pnpm requirements, install/build/test commands, local startup, the `.data/chrome-profile` login flow, interest editing, web search, MCP configuration, opt-in live smoke commands, connector repair workflow, and the prohibition on committing captured secrets.

- [ ] **Step 5: Run the full verification suite**

Run:

```bash
pnpm test
pnpm typecheck
pnpm build
git grep -nEi 'Bearer [A-Za-z0-9._-]+|set-cookie|csrf.{0,20}[=:].{8,}|sid=|session=' -- ':!pnpm-lock.yaml' ':!docs/superpowers'
```

Expected: tests, type checks, and builds pass; the secret scan returns no credential-bearing matches.

- [ ] **Step 6: Run the manual live acceptance search**

Start the server and web client, connect each source in the dedicated Chrome profile, save the real interest profile, and search a future city/address/date interval. Confirm events appear progressively, source failures remain isolated, every displayed date is in range, canonical links open, and several results are plausible events the user would attend.

- [ ] **Step 7: Commit the hardened MVP**

```bash
git add .gitignore README.md packages/core apps/server test
git commit -m "test: harden event aggregator MVP"
```

---

## Completion evidence

Before declaring the implementation complete, record:

- the final `pnpm test`, `pnpm typecheck`, and `pnpm build` outputs;
- per-source live smoke status, including any source awaiting user login or blocked by contract drift;
- a sample search ID with event count by source and duplicate count;
- confirmation that only redacted connector artifacts are tracked by Git; and
- the local web and MCP startup commands from `README.md`.
