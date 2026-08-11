# Eventbrite Recall and Guild.host Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recover missing Birmingham Eventbrite listings through bounded multi-intent discovery and make active `guild.host` events a normal direct source.

**Architecture:** Eventbrite will build an allowlisted list of city discovery URLs, request them sequentially, and stream each unique in-range event while isolating page-level failures. Guild will parse its anonymous upcoming-events connection, paginate with bounded cursors, and retain online events plus physical events within 80 km of the resolved city before emitting the existing `RawSourceEvent` protocol.

**Tech Stack:** Node.js 24 global `fetch`, TypeScript 7, Zod 4, Vitest 4, `parse5`, existing connector-common bounded HTTP/retry helpers, SQLite-backed search history, Ollama `gemma3:4b` relevance evaluation.

## Global Constraints

- Normal searches use direct read-only HTTP and do not launch browser automation.
- Eventbrite requests only `GET https://www.eventbrite.co.uk/d/<country>--<city>/<allowlisted-intent>/`.
- Guild requests only `GET https://guild.host/api/next/events/upcoming` with `first=5` and an optional opaque `after` cursor.
- Each response is capped at `2_000_000` bytes with a default `20_000` ms timeout.
- Cookies, authorization headers, account data, RSVP actions, registrations, ticket purchases, and organizer contact are excluded.
- Date filtering uses the existing half-open UTC interval `[startsAtUtc, endsBeforeUtc)`.
- Eventbrite deduplicates by source event ID, then canonical URL; Guild deduplicates by source event ID, then canonical URL.
- Guild's physical-event radius is `80` km; online and hybrid events remain eligible regardless of venue distance.
- Eventbrite must recover IDs `1991901069720` and `1991901156981` in the live Birmingham acceptance window.

---

### Task 1: Eventbrite multi-intent route contract

**Files:**
- Modify: `packages/connector-eventbrite/src/contract.ts`
- Modify: `packages/connector-eventbrite/src/index.ts`
- Create: `packages/connector-eventbrite/test/contract.test.ts`

**Interfaces:**
- Consumes: `locationText: string` from `ResolvedSearchQuery`.
- Produces: `EventbriteDiscoveryIntent`, `EVENTBRITE_DISCOVERY_INTENTS`, `eventbriteSearchUrls(locationText, intents?)`, and the existing base `eventbriteSearchUrl(locationText)`.

- [ ] **Step 1: Write failing URL-generation tests**

```ts
expect(eventbriteSearchUrls("Birmingham")).toEqual([
  "https://www.eventbrite.co.uk/d/united-kingdom--birmingham/events/",
  "https://www.eventbrite.co.uk/d/united-kingdom--birmingham/ai/",
  "https://www.eventbrite.co.uk/d/united-kingdom--birmingham/machine-learning/",
  "https://www.eventbrite.co.uk/d/united-kingdom--birmingham/startups/",
  "https://www.eventbrite.co.uk/d/united-kingdom--birmingham/technology/",
  "https://www.eventbrite.co.uk/d/united-kingdom--birmingham/software/",
  "https://www.eventbrite.co.uk/d/united-kingdom--birmingham/developer/",
  "https://www.eventbrite.co.uk/d/united-kingdom--birmingham/product-design/",
  "https://www.eventbrite.co.uk/d/united-kingdom--birmingham/hackathon/",
  "https://www.eventbrite.co.uk/d/united-kingdom--birmingham/tech-networking/",
  "https://www.eventbrite.co.uk/d/united-kingdom--birmingham/business-networking/"
]);
expect(eventbriteSearchUrls("Digbeth, Birmingham, B5 6DY", ["events", "startups"]))
  .toEqual([
    "https://www.eventbrite.co.uk/d/united-kingdom--birmingham/events/",
    "https://www.eventbrite.co.uk/d/united-kingdom--birmingham/startups/"
  ]);
expect(eventbriteSearchUrls("Tokyo")).toBeNull();
```

- [ ] **Step 2: Run the focused contract test and confirm failure**

Run: `pnpm exec vitest run packages/connector-eventbrite/test/contract.test.ts`

Expected: FAIL because `eventbriteSearchUrls` and the discovery-intent exports do not exist.

- [ ] **Step 3: Implement supported-city matching and fixed discovery intents**

```ts
export const EVENTBRITE_DISCOVERY_INTENTS = [
  "events", "ai", "machine-learning", "startups", "technology",
  "software", "developer", "product-design", "hackathon",
  "tech-networking", "business-networking"
] as const;
export type EventbriteDiscoveryIntent =
  (typeof EVENTBRITE_DISCOVERY_INTENTS)[number];

export function eventbriteSearchUrls(
  locationText: string,
  intents: readonly EventbriteDiscoveryIntent[] = EVENTBRITE_DISCOVERY_INTENTS
): string[] | null {
  const route = resolveEventbriteCityRoute(locationText);
  if (route === null) return null;
  return intents.map((intent) =>
    `https://www.eventbrite.co.uk/d/${route.country}--${route.city}/${intent}/`
  );
}
```

Resolve a city when its normalized name occurs as a complete word sequence in the input, so both `Birmingham` and a Birmingham street address use the same route. Preserve the existing nine-city map and make `eventbriteSearchUrl` return the first base URL for the browser fallback.

- [ ] **Step 4: Run the contract and browser-connector tests**

Run: `pnpm exec vitest run packages/connector-eventbrite/test/contract.test.ts packages/connector-eventbrite/test/connector.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the route contract**

```bash
git add packages/connector-eventbrite/src/contract.ts packages/connector-eventbrite/src/index.ts packages/connector-eventbrite/test/contract.test.ts
git commit -m "feat: add Eventbrite discovery intent routes"
```

---

### Task 2: Eventbrite direct multi-intent collection

**Files:**
- Modify: `packages/connector-eventbrite/src/direct.ts`
- Modify: `packages/connector-eventbrite/test/direct.test.ts`
- Modify: `docs/connectors/eventbrite-network-contract.md`

**Interfaces:**
- Consumes: `eventbriteSearchUrls`, `EventbriteDiscoveryIntent`, `parseEventbriteSearchHtml`, `parseEventbriteSearchPayload`, and connector-common bounded HTTP/retry helpers.
- Produces: `DirectEventbriteOptions.discoveryIntents?: readonly EventbriteDiscoveryIntent[]` and a direct search stream containing unique events from every successful intent page.

- [ ] **Step 1: Write failing reported-event recall and deduplication tests**

Build synthetic JSON-LD pages in the test with these Eventbrite URLs and IDs:

```ts
const business = eventItem(
  "1991901069720",
  "Business Networking in Birmingham for Professionals, SMEs & Entrepreneurs"
);
const ai = eventItem(
  "1991901156981",
  "Network One: AI & Machine Learning Networking Birmingham Edition"
);
const connector = createDirectEventbriteConnector({
  discoveryIntents: ["events", "startups", "machine-learning"],
  fetch: async (input) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/events/")) return htmlResponse([business]);
    if (path.endsWith("/startups/")) return htmlResponse([business, ai]);
    return htmlResponse([ai]);
  }
});
const events = (await collect(connector.search(birminghamQuery, signal)))
  .filter((message) => message.type === "event");
expect(events.map(({ event }) => event.sourceEventId)).toEqual([
  "1991901069720",
  "1991901156981"
]);
```

Also assert that the three URLs are requested sequentially and the final completion count is `2`.

- [ ] **Step 2: Write failing partial- and total-failure tests**

```ts
expect(await searchWithPages([validPage, invalidPage])).toContainEqual({
  type: "complete", source: "eventbrite", count: 1
});
expect((await searchWithPages([invalidPage, invalidPage])).at(-1)).toEqual({
  type: "failed",
  source: "eventbrite",
  errorCode: "contract_drift",
  safeMessage: "Eventbrite's event response changed"
});
```

The partial-failure test also captures one redacted page diagnostic. Existing one-page behavior tests pass `discoveryIntents: ["events"]` so body-limit, redirect, date, and cancellation assertions stay focused.

- [ ] **Step 3: Run direct Eventbrite tests and confirm failure**

Run: `pnpm exec vitest run packages/connector-eventbrite/test/direct.test.ts`

Expected: FAIL because the connector requests only the base page and has no `discoveryIntents` option.

- [ ] **Step 4: Implement sequential multi-intent streaming**

```ts
const urls = eventbriteSearchUrls(query.locationText, this.discoveryIntents);
if (urls === null) throw connectorFailure(
  "user_action_required",
  `Eventbrite needs a supported city for ${query.locationText}`
);
const seen = new Set<string>();
const failures: unknown[] = [];
let successfulPages = 0;
let count = 0;
for (const url of urls) {
  signal.throwIfAborted();
  try {
    const html = await withConnectorRetry(
      () => requestBoundedText({ url, fetch: this.fetch }, this.policy, signal),
      { ...this.retry, signal }
    );
    const events = parseEventbriteSearchPayload(parseEventbriteSearchHtml(html));
    successfulPages += 1;
    for (const event of events) {
      const identity = event.sourceEventId ?? event.canonicalUrl;
      if (seen.has(identity) || !isInRange(event, query)) continue;
      seen.add(identity);
      count += 1;
      yield { type: "event", source: "eventbrite", event };
    }
  } catch (error) {
    failures.push(error);
    this.diagnostic(redactDiagnostic({
      source: "eventbrite", transport: "direct", event: "page.error", error
    }));
  }
}
if (successfulPages === 0) throw representativeFailure(failures);
```

The direct policy accepts only the eleven exact final path slugs. Add `retry?: ConnectorRetryOptions` to the options so retry behavior remains testable. `representativeFailure` preserves a `ConnectorFailure` when one exists and otherwise returns the first `EventbritePayloadError`.

- [ ] **Step 5: Update the Eventbrite network contract**

Document the eleven observed/selected discovery routes, sequential request behavior, cross-page deduplication, page-level failure isolation, and both live missing IDs. Remove the claim that one `ItemList` is the complete direct discovery input.

- [ ] **Step 6: Run Eventbrite package verification**

Run: `pnpm --filter @event-agg/connector-eventbrite test && pnpm --filter @event-agg/connector-eventbrite typecheck`

Expected: PASS.

- [ ] **Step 7: Commit Eventbrite recall**

```bash
git add packages/connector-eventbrite docs/connectors/eventbrite-network-contract.md
git commit -m "fix: broaden Eventbrite discovery recall"
```

---

### Task 3: Guild.host payload parser and location policy

**Files:**
- Replace: `packages/connector-guild/src/contract.ts`
- Create: `packages/connector-guild/src/parser.ts`
- Modify: `packages/connector-guild/src/index.ts`
- Create: `packages/connector-guild/test/parser.test.ts`
- Create: `packages/connector-guild/fixtures/upcoming-page-1.redacted.json`
- Create: `packages/connector-guild/fixtures/upcoming-page-2.redacted.json`
- Modify: `packages/connector-guild/test/fixture-safety.test.ts`
- Modify: `packages/connector-guild/package.json`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Consumes: the anonymous Guild.host connection envelope.
- Produces: `GUILD_EVENTS_API_URL`, `GUILD_LOCATION_RADIUS_KM`, `resolveGuildLocation(locationText)`, `distanceKilometres(a, b)`, `GuildPayloadError`, and `parseGuildEventsPage(payload)` returning `{ events, hasNextPage, endCursor }`.

- [ ] **Step 1: Add Zod and sanitized cursor fixtures**

Run: `pnpm --filter @event-agg/connector-guild add zod @event-agg/connector-common@workspace:*`

Page one contains a physical Birmingham event, a distant physical event, and an online event. Page two contains a duplicate plus an event whose start is at the query's exclusive end boundary. All IDs, descriptions, cursor strings, and coordinates are synthetic public-event data.

- [ ] **Step 2: Write failing parser and URL-safety tests**

```ts
const page = parseGuildEventsPage(pageOneFixture);
expect(page.hasNextPage).toBe(true);
expect(page.endCursor).toBe("fixture-cursor-1");
expect(page.events[0]).toMatchObject({
  source: "guild",
  canonicalUrl: "https://guild.host/events/birmingham-ai-builders-fixture01",
  title: "Birmingham AI Builders",
  timeZone: "Europe/London",
  latitude: 52.4862,
  longitude: -1.8904,
  isOnline: false
});
expect(() => parseGuildEventsPage(payloadWithUrl("https://evil.test/e")))
  .toThrow(GuildPayloadError);
expect(() => parseGuildEventsPage({ edges: [] }))
  .toThrow(GuildPayloadError);
```

- [ ] **Step 3: Write failing city/address and distance tests**

```ts
expect(resolveGuildLocation("Birmingham")).toMatchObject({ name: "Birmingham" });
expect(resolveGuildLocation("Digbeth, Birmingham, B5 6DY"))
  .toMatchObject({ name: "Birmingham" });
expect(resolveGuildLocation("Tokyo")).toBeNull();
expect(distanceKilometres(
  { latitude: 52.4862, longitude: -1.8904 },
  { latitude: 52.4862, longitude: -1.8904 }
)).toBe(0);
```

- [ ] **Step 4: Run parser tests and confirm failure**

Run: `pnpm exec vitest run packages/connector-guild/test/parser.test.ts packages/connector-guild/test/fixture-safety.test.ts`

Expected: FAIL because the Guild.host contract and parser do not exist.

- [ ] **Step 5: Implement strict connection parsing and event mapping**

Use Zod schemas for `edges[].node` and `pageInfo`, permitting a null node but requiring all mapped fields for non-null events. Validate timestamps with `Date.parse`, require `https:` and hostname `guild.host`, require an `/events/` path, validate GeoJSON coordinates as longitude `[-180, 180]` and latitude `[-90, 90]`, and map owner names without using authenticated fields.

```ts
return {
  events: parsed.data.edges.flatMap(({ node }) =>
    node === null ? [] : [mapGuildEvent(node)]
  ),
  hasNextPage: parsed.data.pageInfo.hasNextPage,
  endCursor: parsed.data.pageInfo.endCursor ?? null
};
```

- [ ] **Step 6: Implement supported-city resolution and Haversine distance**

Store the same nine city centres used by Eventbrite. Normalize punctuation and whitespace, match full city word sequences within address input, and compute great-circle distance with earth radius `6_371.0088` km.

- [ ] **Step 7: Run parser tests and typecheck**

Run: `pnpm exec vitest run packages/connector-guild/test/parser.test.ts packages/connector-guild/test/fixture-safety.test.ts && pnpm --filter @event-agg/connector-guild typecheck`

Expected: PASS.

- [ ] **Step 8: Commit the Guild parsing boundary**

```bash
git add packages/connector-guild pnpm-lock.yaml
git commit -m "feat: parse public Guild host events"
```

---

### Task 4: Direct Guild.host cursor connector

**Files:**
- Replace: `packages/connector-guild/src/connector.ts`
- Modify: `packages/connector-guild/src/index.ts`
- Replace: `packages/connector-guild/test/connector.test.ts`
- Replace: `packages/connector-guild/test/live.smoke.test.ts`
- Replace: `docs/connectors/guild-network-contract.md`

**Interfaces:**
- Consumes: `requestBoundedJson`, `withConnectorRetry`, `parseGuildEventsPage`, `resolveGuildLocation`, and `distanceKilometres`.
- Produces: `createGuildConnector(options?: GuildConnectorOptions)` where options include `fetch`, `diagnostic`, `maxPages`, `radiusKm`, `maxBodyBytes`, `timeoutMs`, and `retry`.

- [ ] **Step 1: Write failing pagination and eligibility tests**

```ts
const connector = createGuildConnector({
  fetch: cursorFixtureFetch,
  maxPages: 10,
  radiusKm: 80
});
const messages = await collect(connector.search(
  { ...query, locationText: "Digbeth, Birmingham, B5 6DY" },
  signal
));
expect(requested).toEqual([
  "https://guild.host/api/next/events/upcoming?first=5",
  "https://guild.host/api/next/events/upcoming?first=5&after=fixture-cursor-1"
]);
expect(eventTitles(messages)).toEqual([
  "Birmingham AI Builders",
  "Worldwide Agent Engineering"
]);
expect(messages.at(-1)).toEqual({ type: "complete", source: "guild", count: 2 });
```

The distant physical event is excluded, the online event is retained, the repeated event on page two is deduplicated, and an event at `endsBeforeUtc` is excluded and stops pagination.

- [ ] **Step 2: Write failing status, cursor-drift, unsupported-location, and cancellation tests**

Assert:

```ts
expect(await createGuildConnector().getStatus()).toMatchObject({
  source: "guild", state: "ready", errorCode: null
});
expect(unsupportedMessages.at(-1)).toEqual({
  type: "user_action_required",
  source: "guild",
  safeMessage: "Guild.host needs a supported city for Tokyo"
});
expect(repeatedCursorMessages.at(-1)).toMatchObject({
  type: "failed", source: "guild", errorCode: "contract_drift"
});
expect(cancelledMessages.map(({ type }) => type)).toEqual(["progress"]);
```

Also cover `429`, invalid JSON, oversized response, and a `hasNextPage: true` response with no `endCursor`.

- [ ] **Step 3: Run Guild connector tests and confirm failure**

Run: `pnpm exec vitest run packages/connector-guild/test/connector.test.ts`

Expected: FAIL because the current connector reports the unrelated `guild.co` closure.

- [ ] **Step 4: Implement bounded cursor collection**

```ts
let cursor: string | null = null;
const seenCursors = new Set<string>();
const seenEvents = new Set<string>();
for (let pageNumber = 1; pageNumber <= this.maxPages; pageNumber += 1) {
  const payload = await withConnectorRetry(
    () => requestBoundedJson(
      { url: guildPageUrl(cursor), fetch: this.fetch }, this.policy, signal
    ),
    { ...this.retry, signal }
  );
  const page = parseGuildEventsPage(payload);
  let reachedEnd = false;
  for (const event of page.events) {
    const eventStart = Date.parse(event.startsAt);
    if (eventStart >= Date.parse(query.endsBeforeUtc)) reachedEnd = true;
    if (!isInDateRange(event, query) || !isEligibleForLocation(event, location)) continue;
    const identity = event.sourceEventId ?? event.canonicalUrl;
    if (seenEvents.has(identity)) continue;
    seenEvents.add(identity);
    yield { type: "event", source: "guild", event };
  }
  if (reachedEnd || !page.hasNextPage) break;
  if (page.endCursor === null || seenCursors.has(page.endCursor)) {
    throw new GuildPayloadError();
  }
  seenCursors.add(page.endCursor);
  cursor = page.endCursor;
}
```

If the configured maximum is reached while another page is required before the end timestamp, fail with contract drift after preserving already streamed partial events. Map connector-common failures into the existing status/message protocol and redact diagnostics.

- [ ] **Step 5: Replace the live smoke test and source contract**

The live smoke uses the direct connector, a Birmingham query from the current day through 30 days, and asserts a terminal `complete` or a truthful source-scoped transport failure without starting `BrowserHost`. The contract document records the anonymous endpoint, five-event page cap, cursor semantics, public/omitted fields, location filtering, and the distinction between `guild.host` and closed `guild.co`.

- [ ] **Step 6: Run Guild package verification**

Run: `pnpm --filter @event-agg/connector-guild test && pnpm --filter @event-agg/connector-guild typecheck`

Expected: PASS.

- [ ] **Step 7: Commit the active Guild connector**

```bash
git add packages/connector-guild docs/connectors/guild-network-contract.md
git commit -m "feat: collect events from guild host"
```

---

### Task 5: Production direct-source wiring and integration fixtures

**Files:**
- Modify: `apps/server/src/dependencies.ts`
- Modify: `apps/server/test/connectors.test.ts`
- Modify: `test/helpers/direct-fixture-fetch.ts`
- Modify: `apps/mcp/test/server.test.ts` only if a fixed closure status is asserted.

**Interfaces:**
- Consumes: `createGuildConnector(directOptions)`.
- Produces: a production connector set in which all four sources can complete by direct HTTP and normal searches open no browser page.

- [ ] **Step 1: Write the failing production-wiring assertion**

Change the direct-fixture integration test to expect all four source states to be `complete`, no browser page calls, and the Guild synthetic event in the snapshot:

```ts
expect(browserHost.opened).toEqual([]);
expect(snapshot?.sources.map(({ source, state }) => ({ source, state })))
  .toEqual([
    { source: "luma", state: "complete" },
    { source: "meetup", state: "complete" },
    { source: "eventbrite", state: "complete" },
    { source: "guild", state: "complete" }
  ]);
expect(snapshot?.events.some(({ source }) => source === "guild")).toBe(true);
```

- [ ] **Step 2: Run the server integration test and confirm failure**

Run: `pnpm exec vitest run apps/server/test/connectors.test.ts`

Expected: FAIL because Guild is still constructed as an unavailable connector.

- [ ] **Step 3: Wire shared direct options into Guild and update fixtures**

```ts
const connectUrls: Record<EventSource, string | null> = {
  luma: lumaSearchContract.connectUrl,
  meetup: meetupSearchContract.connectUrl,
  eventbrite: eventbriteSearchContract.connectUrl,
  guild: null
};

// In the production connector array:
createGuildConnector(directOptions)
```

Update `withInteractiveConnection` so a `null` connect URL delegates directly to `connector.connect()` without opening or closing a browser page. Add a test proving `POST /api/connectors/guild/connect` opens no browser. Add the Guild fixture response to `createDirectFixtureFetch`. Eventbrite intent URLs all return the sanitized Eventbrite fixture, allowing cross-route deduplication to prove the event count does not inflate.

- [ ] **Step 4: Run integration, MCP, and end-to-end tests**

Run: `pnpm exec vitest run apps/server/test/connectors.test.ts apps/mcp/test/server.test.ts test/e2e/search-flow.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit production wiring**

```bash
git add apps/server apps/mcp/test/server.test.ts test/helpers/direct-fixture-fetch.ts
git commit -m "feat: enable Guild host in production searches"
```

---

### Task 6: Live Birmingham acceptance and repository verification

**Files:**
- Create: `docs/acceptance/2026-08-11-eventbrite-guild-live-search.md`

**Interfaces:**
- Consumes: the running local server/API, saved interests, SQLite search history, Ollama, Eventbrite direct discovery, and Guild direct discovery.
- Produces: evidence for Eventbrite recall, Guild completion/count, no-browser normal operation, relevance completion, and preserved canonical links.

- [ ] **Step 1: Run static verification before live traffic**

Run:

```bash
pnpm test
pnpm typecheck
pnpm build
```

Expected: every command exits `0`.

- [ ] **Step 2: Confirm the local Gemma model and launch the app**

Run:

```bash
pnpm model:check
pnpm --filter @event-agg/server dev
```

Expected: `gemma3:4b` is ready and the server listens on its configured local port.

- [ ] **Step 3: Run the Birmingham 30-day API search to terminal completion**

Submit `locationText=Birmingham`, `startDate=2026-08-11`, `endDate=2026-09-10`, and `timeZone=Europe/London` through the existing search endpoint. Drain the SSE stream until `search.completed`; do not stop at source completion while relevance is still evaluating.

- [ ] **Step 4: Prove both missing Eventbrite candidates were collected**

Inspect the authoritative SQLite event/search history and assert canonical Eventbrite source IDs:

```text
1991901069720
1991901156981
```

Record each title, canonical URL, start time, relevance decision, and whether it appears under Show, Maybe, or Hidden. Candidate collection is the recall acceptance criterion; Gemma may legitimately classify either event outside Show.

- [ ] **Step 5: Record Guild and browser-fallback evidence**

Record Guild's collected count and terminal state for the same interval. Record the streamed source phases and server diagnostics proving no `browser_fallback` phase occurred for Eventbrite or Guild. A zero Guild count is acceptable only when the connector reaches `complete` after exhausting the relevant cursor window.

- [ ] **Step 6: Write the live acceptance report**

Document exact search ID, interval, counts, the two Eventbrite evidence rows, Guild status/count, any transport degradation, relevance status, and direct event links in `docs/acceptance/2026-08-11-eventbrite-guild-live-search.md`.

- [ ] **Step 7: Run final verification and inspect the diff**

Run:

```bash
pnpm test
pnpm typecheck
pnpm build
git diff --check
git status --short
```

Expected: all checks exit `0`; only intended acceptance documentation is uncommitted.

- [ ] **Step 8: Commit and push the verified result**

```bash
git add docs/acceptance/2026-08-11-eventbrite-guild-live-search.md
git commit -m "test: verify Birmingham event discovery recall"
git push origin main
```

Expected: the private repository's `origin/main` contains every implementation and acceptance commit.
