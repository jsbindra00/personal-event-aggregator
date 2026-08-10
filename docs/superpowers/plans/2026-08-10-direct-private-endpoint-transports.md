# Direct Private-Endpoint Transports Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Meetup, Luma, and Eventbrite search through their observed read-only private endpoints by default, with the current browser connectors retained only as source-scoped fallbacks.

**Architecture:** Add a bounded direct-fetch primitive and a streaming connector-fallback wrapper in `connector-common`. Give each source a direct connector that reuses its existing parser and emits the existing `ConnectorMessage` protocol. Production composes direct primary connectors with read-only browser fallbacks; no private request header, cookie, or template is persisted.

**Tech Stack:** Node.js 24 global `fetch`, TypeScript 7, Zod 4, Vitest 4, `parse5`, existing Playwright browser fallbacks.

## Global Constraints

- Direct requests are read-only and use exact method, host, and path allowlists.
- Maximum response body size is `2_000_000` bytes and default request timeout is `20_000` ms.
- Retry only `network` and `rate_limited` failures through the existing bounded retry helper.
- Cookies, authorization values, anti-forgery values, raw request templates, and real captured payloads are never logged, persisted, or committed.
- Direct contract drift falls back to the existing read-only browser connector for Meetup, Luma, or Eventbrite.
- Preserve source isolation, cancellation, date filtering, deduplication, and the existing HTTP/SSE/MCP contracts.

---

### Task 1: Bounded direct HTTP and connector fallback primitives

**Files:**
- Create: `packages/connector-common/src/direct-http.ts`
- Create: `packages/connector-common/src/fallback.ts`
- Modify: `packages/connector-common/src/index.ts`
- Test: `packages/connector-common/test/direct-http.test.ts`
- Test: `packages/connector-common/test/fallback.test.ts`

**Interfaces:**
- Consumes: `ConnectorFailure`, `classifyConnectorError`, `withConnectorRetry`, `EventConnector`, `ConnectorMessage`.
- Produces: `requestBoundedText(input, policy)`, `requestBoundedJson(input, policy)`, `DirectRequestPolicy`, `withConnectorFallback(primary, fallback, shouldFallback)`.

- [ ] **Step 1: Write failing direct-HTTP policy tests**

```ts
const policy = {
  method: "GET" as const,
  allowedHosts: ["api.example.test"],
  allowedPath: (path: string) => path === "/events",
  maxBodyBytes: 32,
  timeoutMs: 50
};

await expect(
  requestBoundedJson(
    { url: "https://api.example.test/events", fetch: fakeFetch({ ok: true, body: "{\"ok\":true}" }) },
    policy,
    new AbortController().signal
  )
).resolves.toEqual({ ok: true });

await expect(
  requestBoundedText(
    { url: "https://evil.test/events", fetch: fakeFetch({ ok: true, body: "x" }) },
    policy,
    new AbortController().signal
  )
).rejects.toThrow(/allowlist/i);

await expect(oversizedRequest).rejects.toMatchObject({ code: "parsing" });
await expect(rateLimitedRequest).rejects.toMatchObject({
  code: "rate_limited",
  retryAfterMs: 2_000
});
```

- [ ] **Step 2: Run the focused tests and confirm failure**

Run: `pnpm --filter @event-agg/connector-common test -- --run test/direct-http.test.ts`

Expected: FAIL because `direct-http.ts` does not exist.

- [ ] **Step 3: Implement the bounded request primitive**

```ts
export interface DirectRequestPolicy {
  method: "GET" | "POST";
  allowedHosts: readonly string[];
  allowedPath(pathname: string): boolean;
  maxBodyBytes: number;
  timeoutMs: number;
}

export interface DirectRequestInput {
  url: string;
  fetch?: typeof globalThis.fetch;
  headers?: Readonly<Record<string, string>>;
  body?: string;
}

export async function requestBoundedText(
  input: DirectRequestInput,
  policy: DirectRequestPolicy,
  signal: AbortSignal
): Promise<string> {
  const url = new URL(input.url);
  if (url.protocol !== "https:" || !policy.allowedHosts.includes(url.hostname)) {
    throw connectorFailure("parsing", "Direct request failed allowlist validation");
  }
  if (!policy.allowedPath(url.pathname)) {
    throw connectorFailure("parsing", "Direct request failed allowlist validation");
  }
  const timeout = AbortSignal.timeout(policy.timeoutMs);
  const combined = AbortSignal.any([signal, timeout]);
  const response = await (input.fetch ?? globalThis.fetch)(url, {
    method: policy.method,
    headers: input.headers,
    body: input.body,
    signal: combined,
    redirect: "error"
  }).catch((error) => {
    throw classifyConnectorError(error);
  });
  if (response.status === 401 || response.status === 403) {
    throw connectorFailure("auth_required", "Sign in to this event source");
  }
  if (response.status === 429) {
    throw connectorFailure("rate_limited", "Event source rate limit reached", {
      retryAfterMs: parseRetryAfter(response.headers.get("retry-after"))
    });
  }
  if (response.status === 408 || response.status >= 500) {
    throw connectorFailure("network", "Event source is temporarily unavailable");
  }
  if (!response.ok || response.body === null) {
    throw connectorFailure("parsing", "Event source returned an invalid response");
  }
  return readLimitedUtf8(response.body, policy.maxBodyBytes);
}

export async function requestBoundedJson(
  input: DirectRequestInput,
  policy: DirectRequestPolicy,
  signal: AbortSignal
): Promise<unknown> {
  const text = await requestBoundedText(input, policy, signal);
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw connectorFailure("parsing", "Event source returned invalid JSON", { cause: error });
  }
}
```

Implement `readLimitedUtf8` with `response.body.getReader()`, incrementing received byte length before concatenation and cancelling the reader on overflow. `parseRetryAfter` accepts delta seconds or an HTTP date and returns a non-negative millisecond delay.

- [ ] **Step 4: Write failing fallback-stream tests**

```ts
const primary = connectorFrom([
  { type: "progress", source: "luma", phase: "direct" },
  { type: "failed", source: "luma", errorCode: "contract_drift", safeMessage: "changed" }
]);
const fallback = connectorFrom([
  { type: "event", source: "luma", event },
  { type: "complete", source: "luma", count: 1 }
]);

expect(await collect(withConnectorFallback(primary, fallback).search(query, signal)))
  .toEqual([
    { type: "progress", source: "luma", phase: "direct" },
    { type: "progress", source: "luma", phase: "browser_fallback" },
    { type: "event", source: "luma", event },
    { type: "complete", source: "luma", count: 1 }
  ]);
```

Also assert that `rate_limited`, `user_action_required`, cancellation, and a successful primary never invoke fallback. Assert `getStatus()` delegates to the primary before a fallback and to the browser connector after the first fallback begins.

- [ ] **Step 5: Implement `withConnectorFallback`**

```ts
export function withConnectorFallback(
  primary: EventConnector,
  fallback: EventConnector,
  shouldFallback = (message: ConnectorMessage) =>
    message.type === "failed" && message.errorCode === "contract_drift"
): EventConnector {
  if (primary.source !== fallback.source) throw new TypeError("Fallback source mismatch");
  let active = primary;
  return {
    source: primary.source,
    getStatus: () => active.getStatus(),
    connect: () => fallback.connect(),
    search: async function* (query, signal) {
      for await (const message of primary.search(query, signal)) {
        if (!shouldFallback(message)) {
          yield message;
          continue;
        }
        active = fallback;
        yield { type: "progress", source: primary.source, phase: "browser_fallback" };
        yield* fallback.search(query, signal);
        return;
      }
    }
  };
}
```

- [ ] **Step 6: Run tests and type checking**

Run: `pnpm --filter @event-agg/connector-common test && pnpm --filter @event-agg/connector-common typecheck`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/connector-common
git commit -m "feat: add bounded direct connector transport"
```

---

### Task 2: Direct Eventbrite discovery connector

**Files:**
- Modify: `packages/connector-eventbrite/package.json`
- Create: `packages/connector-eventbrite/src/direct.ts`
- Modify: `packages/connector-eventbrite/src/parser.ts`
- Modify: `packages/connector-eventbrite/src/index.ts`
- Create: `packages/connector-eventbrite/fixtures/search-page.redacted.html`
- Test: `packages/connector-eventbrite/test/direct.test.ts`
- Modify: `packages/connector-eventbrite/test/fixture-safety.test.ts`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Consumes: `requestBoundedText`, `parseEventbriteSearchPayload`, `eventbriteSearchUrl`.
- Produces: `createDirectEventbriteConnector(options)`, `parseEventbriteSearchHtml(html)`.

- [ ] **Step 1: Add `parse5` and a sanitized HTML fixture**

Run: `pnpm --filter @event-agg/connector-eventbrite add parse5`

The fixture contains one unrelated JSON-LD script and one `ItemList` script with the two existing synthetic events. No cookies, headers, emails, analytics objects, or real identifiers are included.

- [ ] **Step 2: Write failing HTML parsing and direct-search tests**

```ts
it("extracts the Eventbrite ItemList from a server-rendered document", () => {
  const html = readFileSync(fixtureUrl, "utf8");
  expect(parseEventbriteSearchHtml(html)).toMatchObject({
    "@type": "ItemList",
    itemListElement: expect.any(Array)
  });
});

it("searches without opening a browser", async () => {
  const requested: string[] = [];
  const connector = createDirectEventbriteConnector({
    fetch: async (input) => {
      requested.push(String(input));
      return new Response(fixtureHtml, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" }
      });
    }
  });
  const messages = await collect(connector.search(query, signal));
  expect(requested).toEqual([
    "https://www.eventbrite.co.uk/d/united-kingdom--london/events/"
  ]);
  expect(messages.map(({ type }) => type)).toEqual([
    "progress", "event", "event", "complete"
  ]);
});
```

Add tests for an unsupported city, missing ItemList, hostile redirect, over-size body, cancellation, and an out-of-range event.

- [ ] **Step 3: Run the direct tests and confirm failure**

Run: `pnpm --filter @event-agg/connector-eventbrite test -- --run test/direct.test.ts`

Expected: FAIL on missing exports.

- [ ] **Step 4: Implement the HTML parser and direct connector**

```ts
export function parseEventbriteSearchHtml(html: string): unknown {
  const document = parse(html);
  for (const node of walk(document)) {
    if (node.nodeName !== "script") continue;
    if (attribute(node, "type") !== "application/ld+json") continue;
    const candidate = JSON.parse(textContent(node)) as { "@type"?: unknown };
    if (candidate["@type"] === "ItemList") return candidate;
  }
  throw new EventbritePayloadError();
}

export function createDirectEventbriteConnector(
  options: DirectEventbriteOptions = {}
): EventConnector {
  return new DirectEventbriteConnector(options);
}
```

`DirectEventbriteConnector.search` resolves the existing city URL, calls `requestBoundedText` through `withConnectorRetry`, parses/mapping with existing parser functions, filters against `startsAtUtc`/`endsBeforeUtc`, and uses the same safe terminal messages as the browser connector.

- [ ] **Step 5: Extend fixture safety and run package verification**

Run: `pnpm --filter @event-agg/connector-eventbrite test && pnpm --filter @event-agg/connector-eventbrite typecheck`

Expected: PASS and fixture safety scans both JSON and HTML fixtures.

- [ ] **Step 6: Commit**

```bash
git add packages/connector-eventbrite pnpm-lock.yaml
git commit -m "feat: search Eventbrite through direct discovery pages"
```

---

### Task 3: Direct Luma discovery and cursor pagination

**Files:**
- Modify: `packages/connector-luma/package.json`
- Create: `packages/connector-luma/src/direct.ts`
- Create: `packages/connector-luma/src/location.ts`
- Modify: `packages/connector-luma/src/index.ts`
- Create: `packages/connector-luma/fixtures/discover-page.redacted.html`
- Create: `packages/connector-luma/fixtures/city-page.redacted.html`
- Test: `packages/connector-luma/test/direct.test.ts`
- Test: `packages/connector-luma/test/location.test.ts`
- Modify: `packages/connector-luma/test/fixture-safety.test.ts`
- Modify: `docs/connectors/luma-network-contract.md`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Consumes: `requestBoundedText`, `requestBoundedJson`, `parseLumaSearchPayload`.
- Produces: `resolveLumaPlace(locationText, fetch, signal)`, `createDirectLumaConnector(options)`.

- [ ] **Step 1: Create minimal redacted discovery and city fixtures**

The discovery fixture contains three public city links. The city fixture contains a single `__NEXT_DATA__` object with `pageProps.initialData.kind === "discover-place"` and `data.place.api_id === "discplace_fixture_london"`.

- [ ] **Step 2: Write failing location resolution tests**

```ts
it("resolves an address to the matching city page and public place ID", async () => {
  const fetch = routeFetch({
    "https://luma.com/discover": discoverHtml,
    "https://luma.com/london?k=p": cityHtml
  });
  await expect(resolveLumaPlace("10 Downing Street, London", fetch, signal))
    .resolves.toEqual({
      name: "London",
      cityUrl: "https://luma.com/london?k=p",
      placeId: "discplace_fixture_london"
    });
});
```

Add tests for exact city, accented input normalization, a hostile link host, malformed `__NEXT_DATA__`, no matching city, and abort.

- [ ] **Step 3: Add `parse5` and implement public place resolution**

Run: `pnpm --filter @event-agg/connector-luma add parse5`

```ts
export interface LumaPlace {
  name: string;
  cityUrl: string;
  placeId: string;
}

export async function resolveLumaPlace(
  locationText: string,
  fetch: typeof globalThis.fetch,
  signal: AbortSignal
): Promise<LumaPlace | null> {
  const discover = await requestBoundedText(
    { url: "https://luma.com/discover", fetch },
    LUMA_HTML_POLICY,
    signal
  );
  const cityUrl = selectCityLink(discover, locationText);
  if (cityUrl === null) return null;
  const city = await requestBoundedText({ url: cityUrl, fetch }, LUMA_HTML_POLICY, signal);
  return parseDiscoverPlace(city, cityUrl);
}
```

Parse HTML with Luma's direct `parse5` dependency. Read the exact `__NEXT_DATA__` JSON path and validate the `discplace-` prefix without retaining real IDs in fixtures.

- [ ] **Step 4: Write failing cursor pagination tests**

```ts
it("follows direct cursors and stops once events are beyond the end date", async () => {
  const fetch = routeFetch({
    discover: discoverHtml,
    city: cityHtml,
    page1: lumaPage({ has_more: true, next_cursor: "cursor_fixture_2" }),
    page2: lumaPage({ has_more: false, next_cursor: null })
  });
  const connector = createDirectLumaConnector({ fetch, maxPages: 8, pageSize: 50 });
  const messages = await collect(connector.search(query, signal));
  expect(fetch.urls.filter((url) => url.includes("get-paginated-events")))
    .toEqual([
      expect.stringContaining("pagination_limit=50"),
      expect.stringContaining("pagination_cursor=cursor_fixture_2")
    ]);
  expect(messages.at(-1)).toMatchObject({ type: "complete" });
});
```

Add repeated-cursor, max-page, `429`, invalid page, empty page, cancellation, and unsupported-location cases.

- [ ] **Step 5: Implement `DirectLumaConnector`**

Build URLs only through `URL`/`URLSearchParams`:

```ts
const url = new URL("https://api.luma.com/discover/get-paginated-events");
url.searchParams.set("discover_place_api_id", place.placeId);
url.searchParams.set("pagination_limit", String(pageSize));
if (cursor !== null) url.searchParams.set("pagination_cursor", cursor);
```

Use the existing `parseLumaSearchPayload`, identity dedupe, date-window filtering, cursor-repeat protection, and safe terminal messages. Default to `pageSize: 50`, `maxPages: 8`.

- [ ] **Step 6: Verify and document the exact contract**

Run: `pnpm --filter @event-agg/connector-luma test && pnpm --filter @event-agg/connector-luma typecheck`

Expected: PASS.

Update the network-contract document to distinguish direct HTML place resolution, direct JSON pagination, and browser fallback.

- [ ] **Step 7: Commit**

```bash
git add packages/connector-luma docs/connectors/luma-network-contract.md pnpm-lock.yaml
git commit -m "feat: search Luma through direct discovery endpoints"
```

---

### Task 4: Direct Meetup location and event GraphQL

**Files:**
- Create: `packages/connector-meetup/src/direct.ts`
- Create: `packages/connector-meetup/src/location.ts`
- Modify: `packages/connector-meetup/src/index.ts`
- Create: `packages/connector-meetup/fixtures/location-search.redacted.json`
- Test: `packages/connector-meetup/test/direct.test.ts`
- Test: `packages/connector-meetup/test/location.test.ts`
- Modify: `packages/connector-meetup/test/fixture-safety.test.ts`
- Modify: `docs/connectors/meetup-network-contract.md`

**Interfaces:**
- Consumes: `requestBoundedJson`, `parseMeetupSearchPayload`, `meetupPayloadRequiresAuth`.
- Produces: `resolveMeetupLocation(query, fetch, signal)`, `createDirectMeetupConnector(options)`.

**Observed persisted operations:**

```ts
const LOCATION_OPERATION = {
  operationName: "getLocationSearch",
  sha256Hash: "950b939f7033b26849b13e829e04cad7fb6b6e4593e97499fceb3ff21764206d"
};
const EVENTS_OPERATION = {
  operationName: "recommendedEventsWithSeries",
  sha256Hash: "fe189ee9858cbae80c3cb4100ed216f1c60b4f2956d26e27187fb6d0aca23506"
};
```

These persisted-query hashes are public request-contract identifiers, not credentials.

- [ ] **Step 1: Write failing direct location tests**

```ts
it("resolves the first location result matching the requested country/city", async () => {
  const fetch = graphqlFetch(locationFixture);
  await expect(resolveMeetupLocation("London", fetch, signal)).resolves.toMatchObject({
    name: "London, Greater London, England, United Kingdom",
    latitude: 51.52,
    longitude: -0.10,
    timeZone: "Europe/London"
  });
  expect(fetch.body()).toEqual({
    operationName: "getLocationSearch",
    variables: { query: "London", dataConfiguration: "{}" },
    extensions: { persistedQuery: { version: 1, sha256Hash: LOCATION_OPERATION.sha256Hash } }
  });
});
```

Add invalid-envelope, zero-result, hostile endpoint, abort, and full-address tests.

- [ ] **Step 2: Implement direct location resolution**

Validate the envelope with Zod and expose only `name`, `latitude`, `longitude`, and `timeZone`. Prefer a result containing meaningful normalized components from the user input; otherwise use the first result and report its exact `name` in progress.

- [ ] **Step 3: Write failing direct event and pagination tests**

```ts
it("posts the persisted event query and follows the after cursor", async () => {
  const fetch = graphqlSequence([page1Fixture, page2Fixture]);
  const connector = createDirectMeetupConnector({ fetch, pageSize: 50, maxPages: 8 });
  const messages = await collect(connector.search(query, signal));
  expect(fetch.bodies()[0]).toMatchObject({
    operationName: "recommendedEventsWithSeries",
    variables: { first: 50, lat: 51.52, lon: -0.10 }
  });
  expect(fetch.bodies()[1]).toMatchObject({ variables: { after: "cursor_fixture_2" } });
  expect(messages.at(-1)).toMatchObject({ type: "complete" });
});
```

Add tests for an address, repeated cursor, max pages, date cutoff, GraphQL `UNAUTHENTICATED`, persisted-query drift, `429`, cancellation, and no duplicate IDs.

- [ ] **Step 4: Implement the persisted GraphQL client**

```ts
function eventVariables(
  query: ResolvedSearchQuery,
  location: MeetupLocation,
  after: string | null,
  pageSize: number
) {
  return {
    first: pageSize,
    ...(after === null ? {} : { after }),
    lat: location.latitude,
    lon: location.longitude,
    startDateRange: Temporal.Instant.from(query.startsAtUtc)
      .toZonedDateTimeISO(location.timeZone)
      .toString(),
    numberOfEventsForSeries: 5,
    seriesStartDate: query.startDate,
    sortField: "RELEVANCE",
    doConsolidateEvents: true,
    doPromotePaypalEvents: false,
    indexAlias: JSON.stringify(JSON.stringify({
      filterOutWrongLanguage: "true",
      modelVersion: "split_offline_online"
    })),
    dataConfiguration: JSON.stringify({
      isSimplifiedSearchEnabled: true,
      include_events_from_user_chapters: false
    })
  };
}
```

POST only to `https://www.meetup.com/gql2`, with `content-type: application/json`. Use the exact persisted-query operation/hash, existing parser, date filtering, and cursor guards. A GraphQL persisted-query error is `contract_drift`; an authentication error remains `auth_required`.

- [ ] **Step 5: Verify and update the network contract**

Run: `pnpm --filter @event-agg/connector-meetup test && pnpm --filter @event-agg/connector-meetup typecheck`

Expected: PASS.

Document that both observed operations work anonymously as direct persisted GraphQL calls and record only their public operation names/hashes, never request headers.

- [ ] **Step 6: Commit**

```bash
git add packages/connector-meetup docs/connectors/meetup-network-contract.md
git commit -m "feat: search Meetup through direct GraphQL"
```

---

### Task 5: Production direct-first wiring and browser fallback

**Files:**
- Modify: `apps/server/src/dependencies.ts`
- Modify: `apps/server/test/connectors.test.ts`
- Modify: `README.md`
- Test: `test/e2e/search-flow.test.ts`

**Interfaces:**
- Consumes: all three `createDirect*Connector` functions and `withConnectorFallback`.
- Produces: default direct-first production connectors; browser pages opened only by fallback or explicit Connect.

- [ ] **Step 1: Write failing production wiring tests**

```ts
it("does not open browser pages when all direct sources succeed", async () => {
  const browserHost = new FakeBrowserHost();
  const dependencies = createProductionDependencies({
    databasePath: ":memory:",
    browserHost,
    fetch: directFixtureFetch()
  });
  const { searchId } = await dependencies.searchService.start(query);
  await drain(dependencies.searchService.subscribe(searchId));
  expect(browserHost.opened).toEqual([]);
});

it("opens only the drifting source's browser fallback", async () => {
  const fetch = directFixtureFetch({ meetup: "contract_drift" });
  // Search and drain.
  expect(browserHost.opened.map(({ source }) => source)).toEqual(["meetup"]);
});
```

Also assert explicit `/api/connectors/:source/connect` still opens an interactive page and remains serialized against that source's fallback search.

- [ ] **Step 2: Add injectable direct fetch and compose connectors**

```ts
export interface ProductionDependencyOptions {
  databasePath?: string;
  browserHost?: ServerBrowserHost;
  connectors?: EventConnector[];
  fetch?: typeof globalThis.fetch;
  diagnostic?: (value: unknown) => void;
}

const rawConnectors = options.connectors ?? [
  withConnectorFallback(
    createDirectLumaConnector({ fetch: options.fetch, ...diagnosticOptions }),
    createLumaConnector(browserHost, diagnosticOptions)
  ),
  withConnectorFallback(
    createDirectMeetupConnector({ fetch: options.fetch, ...diagnosticOptions }),
    createMeetupConnector(browserHost, diagnosticOptions)
  ),
  withConnectorFallback(
    createDirectEventbriteConnector({ fetch: options.fetch, ...diagnosticOptions }),
    createEventbriteConnector(browserHost, diagnosticOptions)
  ),
  createGuildConnector()
];
```

Remove the 3-second and 6-second browser-start delays from the default direct path. Retain source serialization around fallback/interactive browser operations.

- [ ] **Step 3: Extend mocked end-to-end coverage**

Use fixture fetch responses, real direct connectors, real storage, Fastify SSE, and MCP. Assert final source status, URLs, range filtering, direct candidate totals, no browser opens, and REST/MCP parity.

- [ ] **Step 4: Verify the complete non-live suite**

Run:

```bash
pnpm test
pnpm typecheck
pnpm build
```

Expected: all non-live tests, type checks, and builds pass.

- [ ] **Step 5: Update operator documentation and commit**

Document direct-first behavior, browser fallback, unsupported private-contract risk, rate limits, and repair steps.

```bash
git add apps/server test/e2e README.md
git commit -m "feat: use direct event transports by default"
```

---

### Task 6: Direct-versus-browser live parity acceptance

**Files:**
- Create: `test/live/direct-parity.test.ts`
- Modify: `tsconfig.test.json`
- Modify: `README.md`

**Interfaces:**
- Consumes: direct and browser connectors for the same source/query.
- Produces: opt-in `LIVE_DIRECT_PARITY=<source>` proof with redacted aggregate output only.

- [ ] **Step 1: Write the opt-in parity harness**

```ts
const live = process.env.LIVE_DIRECT_PARITY === source ? it : it.skip;
live(`compares ${source} direct and browser candidates`, async () => {
  const browser = await collectEvents(
    browserConnector.search(query, AbortSignal.timeout(60_000))
  );
  const direct = await collectEvents(
    directConnector.search(query, AbortSignal.timeout(60_000))
  );
  const overlap = direct.filter((event) =>
    browser.some((other) => other.canonicalUrl === event.canonicalUrl)
  ).length;
  expect(direct.length).toBeGreaterThanOrEqual(browser.length);
  expect(overlap).toBeGreaterThan(0);
});
```

Run sources sequentially rather than sharing one browser profile. Output only counts, status, overlap, and redacted failure codes.

- [ ] **Step 2: Run live direct smoke tests**

Run:

```bash
LIVE_DIRECT_PARITY=eventbrite pnpm exec vitest run test/live/direct-parity.test.ts
LIVE_DIRECT_PARITY=luma pnpm exec vitest run test/live/direct-parity.test.ts
LIVE_DIRECT_PARITY=meetup pnpm exec vitest run test/live/direct-parity.test.ts
```

Expected: each direct connector returns in-range candidates without a browser; parity records explain any changing snapshot rather than exposing raw bodies.

- [ ] **Step 3: Run secret scan and final verification**

```bash
git grep -nEi 'Bearer [A-Za-z0-9._-]+|set-cookie|csrf.{0,20}[=:].{8,}|sid=|session=' -- ':!pnpm-lock.yaml' ':!docs/superpowers'
pnpm test
pnpm typecheck
pnpm build
```

Expected: credential scan produces no credential-bearing value; verification passes.

- [ ] **Step 4: Commit**

```bash
git add test/live tsconfig.test.json README.md
git commit -m "test: verify direct connector parity"
```
