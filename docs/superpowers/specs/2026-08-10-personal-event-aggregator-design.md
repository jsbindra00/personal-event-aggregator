# Personal Event Aggregator — Design Specification

**Date:** 2026-08-10  
**Status:** Approved for implementation planning  
**Audience:** Personal, single-user MVP

## 1. Product summary

Build a local-first application that searches Meetup, Luma, Guild, and Eventbrite through the same interface. The user enters a city or address, an inclusive start date, and an inclusive end date. The application searches all four sources concurrently through authenticated first-party web sessions, normalizes the results, ranks them against a saved interest profile, and streams useful events into one list. Each result links to its canonical source page.

The application also exposes the same capabilities through a local REST API and an MCP server so a chat client can search events and manage the saved interest profile.

No official platform APIs will be used. Connectors will use network requests observed in the platforms' own authenticated web applications, with rendered-page extraction as a fallback.

## 2. Goal and success criterion

The MVP proves value if it repeatedly surfaces several events per week that the user would genuinely consider attending.

Success is measured by relevance and usable coverage, not by collecting the largest possible number of events. A successful search:

- accepts either a city or a full address;
- searches an inclusive date interval;
- begins showing events without waiting for every source;
- clearly reports source progress and source-specific failures;
- ranks events using the user's persistent interests;
- links directly to each original event page; and
- works from both the web interface and MCP/API clients.

## 3. Scope

### In scope

- One local user and one local browser profile.
- Persistent saved interests and exclusions.
- City/address, start-date, and end-date search inputs.
- On-demand searches only.
- Concurrent Meetup, Luma, Guild, and Eventbrite connectors.
- Authenticated, network-first extraction from the platforms' web applications.
- Progressive result streaming.
- Normalization, deduplication, relevance scoring, and deterministic sorting.
- Source health and authentication status.
- Direct links to source event pages.
- Local REST, Server-Sent Events (SSE), and MCP interfaces.
- Redacted connector diagnostics sufficient to repair changed request contracts.

### Explicitly out of scope

- Official platform APIs.
- Multi-user accounts, teams, billing, or cloud hosting.
- Registration or ticket purchasing.
- Calendar synchronization, reminders, shortlists, attendance tracking, or write-back.
- Scheduled/background crawling.
- Messaging event hosts or attendees.
- Circumventing CAPTCHAs, access controls, or anti-bot challenges.
- Persisting raw session cookies, CSRF tokens, authorization headers, or full private responses outside the dedicated browser profile.

## 4. Technical shape

Use a TypeScript workspace with small packages that keep platform-specific instability away from the application core:

- **Web client:** React single-page application for interests, searches, progress, and event results.
- **Local application server:** Node.js HTTP server providing REST and SSE.
- **Search core:** source-neutral orchestration, normalization, deduplication, ranking, and search state.
- **Connector packages:** one package each for Meetup, Luma, Guild, and Eventbrite.
- **Browser host:** Playwright-controlled Chrome with a dedicated persistent profile.
- **Persistence:** SQLite for interests, search metadata, normalized events, and redacted connector health.
- **MCP server:** a thin adapter over the same search and profile services used by HTTP.

The web client, REST API, SSE stream, and MCP tools must not import platform connectors directly. They call application services through source-neutral interfaces.

## 5. Browser and authentication model

The application owns a dedicated Chrome profile stored in a local application-data directory excluded from version control. The profile is separate from the user's everyday Chrome profile.

For each source:

1. The application opens the source login page in the dedicated profile.
2. The user completes login directly in the browser.
3. Chrome retains the resulting cookies and site storage in that profile.
4. The application records only a non-sensitive connection status and last successful check.

Connectors execute same-origin searches within this browser context. They must not export session cookies or persist transient authorization material in SQLite or logs. A connector may inspect necessary DOM state or request metadata at runtime, but sensitive values remain in memory only and are redacted from diagnostics.

If a CAPTCHA, unexpected permission prompt, new terms acceptance, or reauthentication challenge appears, the connector pauses and emits `auth_required` or `user_action_required`. It does not attempt to bypass the challenge.

## 6. Connector discovery and implementation strategy

Each source connector is developed from a read-only inspection of its normal website behavior:

1. Use Computer Use with Chrome DevTools to perform an ordinary event search.
2. Identify the first-party fetch, XHR, or GraphQL requests that return event results.
3. Record the request method, URL pattern, non-secret parameters, pagination model, response shape, and fields needed for normalization.
4. Redact cookies, authorization values, account identifiers, and personal response fields from saved fixtures and notes.
5. Reproduce the request from the authenticated page context, or drive the site's search UI while intercepting its structured response.
6. Fall back to rendered event-card extraction only for missing fields or when no stable structured response exists.

No connector may depend on undocumented behavior from another connector. Every connector implements the same contract:

```ts
interface EventConnector {
  readonly source: EventSource;
  getStatus(): Promise<ConnectorStatus>;
  connect(): AsyncIterable<ConnectorMessage>;
  search(query: ConnectorSearchQuery): AsyncIterable<ConnectorMessage>;
}
```

`ConnectorMessage` is one of:

- `progress`: source phase and optional page/count information;
- `event`: a raw source event ready for normalization;
- `auth_required`: the source needs the user to sign in again;
- `rate_limited`: the source temporarily refused further requests;
- `user_action_required`: a CAPTCHA, terms screen, or similar barrier appeared;
- `failed`: a terminal source-specific failure with a redacted diagnostic code;
- `complete`: the source has finished the search.

The connector implementation is network-first. UI-driven extraction is a fallback, not a second independent scraper.

## 7. Search query and location semantics

The source-neutral query is:

```ts
interface EventSearchQuery {
  locationText: string;
  startDate: string;
  endDate: string;
  timeZone: string;
}
```

- `locationText` accepts a city or full address.
- `startDate` and `endDate` are local calendar dates and both are inclusive.
- The server converts the interval to an inclusive-start, exclusive-end UTC range using the user's selected timezone.
- Searches reject an empty location, an invalid timezone, or an end date before the start date.

The MVP deliberately avoids adding a separate geocoding API. Each connector submits `locationText` through the source's normal location search or suggestion flow and records the source-resolved label in progress metadata. This matches what the user would receive from an ordinary search on that platform. Search radii may therefore differ between sources and the UI makes that limitation explicit.

If a source cannot resolve the supplied location, only that connector emits `failed` with the `location_unresolved` code. Other connectors continue normally.

## 8. Search orchestration and streaming

The search service creates a search record, starts the four connectors concurrently, and consumes their asynchronous messages independently. One slow or broken source cannot block another.

The server exposes an SSE stream for each search. Stream messages are:

- `search.started`;
- `source.progress`;
- `source.auth_required`;
- `source.rate_limited`;
- `source.failed`;
- `event.added`;
- `event.updated` when a later duplicate enriches an existing event;
- `source.completed`; and
- `search.completed` when every source is terminal.

The web client merges messages by stable event ID. It displays results immediately, re-sorts them when scores or enriched fields change, and keeps per-source status visible throughout the search.

Cancellation is supported when the user starts a replacement search or explicitly stops the current search. Cancellation closes connector pages and marks unfinished sources as cancelled without deleting already received events.

## 9. Event normalization

All sources map into one event representation:

```ts
interface NormalizedEvent {
  id: string;
  source: EventSource;
  sourceEventId: string | null;
  canonicalUrl: string;
  title: string;
  descriptionText: string | null;
  organizerName: string | null;
  startsAt: string;
  endsAt: string | null;
  timeZone: string | null;
  venueName: string | null;
  addressText: string | null;
  latitude: number | null;
  longitude: number | null;
  isOnline: boolean;
  imageUrl: string | null;
  priceText: string | null;
  tags: string[];
  relevanceScore: number;
  matchedInterests: string[];
  firstSeenAt: string;
}
```

Required fields are `source`, `canonicalUrl`, `title`, and `startsAt`. Events missing any required field are rejected with a redacted parser diagnostic rather than entering the result list.

HTML is converted to safe plain text at the connector boundary. Untrusted source markup is never rendered directly.

## 10. Deduplication

Deduplication occurs in this order:

1. Exact canonical URL after removal of known tracking parameters.
2. Exact source and source event ID.
3. Cross-source fingerprint based on normalized title, start time within a tolerance window, and normalized venue or host.

When duplicates are found, the application retains one display event and stores every canonical source link internally. The preferred display record is the one with the most complete time, location, description, and image data. Because the MVP exposes one link per result, the display event uses the canonical URL from that preferred record.

Fuzzy deduplication must be conservative. Uncertain matches remain separate rather than hiding a legitimate event.

## 11. Interest profile and ranking

The interest profile contains:

- positive interests, each stored as a short phrase;
- excluded topics, also stored as short phrases; and
- an optional free-text note describing the kinds of events the user wants.

The MVP uses a deterministic, local scoring adapter. It tokenizes and normalizes the event title, tags, organizer, and description, then applies:

- strongest weight to phrase matches in the title;
- medium weight to tags and organizer matches;
- lower weight to description matches;
- a strong penalty for excluded-topic matches.

The UI shows the matching interests so ranking is explainable. The scoring service is behind an interface so semantic embeddings or feedback learning can be added later without changing connectors or APIs.

Events with no positive match remain available at the bottom unless an excluded topic matched. This prevents the first version from silently hiding potentially useful events.

## 12. Persistence

SQLite stores:

- `interest_profile` and `interest_terms`;
- `searches` with query, timestamps, and overall status;
- `search_sources` with per-source phase, count, and redacted error code;
- `events` with normalized fields;
- `search_events` linking events to searches with score and rank; and
- `connector_status` with authentication state, last success, and last redacted failure.

Search data is retained locally to support deduplication, debugging, and repeat searches. Raw third-party responses are not stored in production. Development fixtures are deliberately captured, minimized, and redacted.

## 13. HTTP and SSE interfaces

The initial local HTTP surface is:

- `GET /api/interests` — read the saved profile.
- `PUT /api/interests` — replace the saved profile after validation.
- `GET /api/connectors` — source status and whether user action is needed.
- `POST /api/connectors/:source/connect` — open or verify the source in the dedicated browser profile.
- `POST /api/searches` — validate a query, create a search, and return its ID and stream URL.
- `GET /api/searches/:id` — current search state and source summaries.
- `GET /api/searches/:id/events` — current normalized, sorted results.
- `GET /api/searches/:id/stream` — SSE progress and event updates.
- `POST /api/searches/:id/cancel` — cancel unfinished connectors.

The server binds to loopback by default. Browser profile paths, database paths, and sensitive runtime data are not returned by the API.

## 14. MCP interface

The MCP server calls the same application services as HTTP and exposes:

- `get_event_interests`;
- `set_event_interests`;
- `get_event_sources_status`;
- `search_events`, which waits for terminal source states and returns ranked event links plus per-source outcomes;
- `start_event_search`, which starts a search and returns a search ID for clients that cannot wait; and
- `get_event_search_results`, which returns progressive results and source state for a search ID.

MCP progress notifications may be emitted when the client supplies a progress token, but correctness must not depend on client support for them.

All tool descriptions make clear that results come from third-party web pages, freshness is best-effort, and the user must use the canonical link to verify final details.

## 15. Web interface

The web interface has three compact areas:

1. **Interest profile:** editable positive interests, exclusions, and optional note.
2. **Search controls:** location, start date, end date, timezone, and Search/Stop control.
3. **Results:** a progressively updating list with title, date/time, location, source, matched interests, relevance, price text when available, and an `Open event` link.

Source chips show `waiting`, `searching`, `login required`, `rate limited`, `failed`, or `complete`, along with the number of events received. A failed source never replaces results from healthy sources with a global error page.

The application does not include a separate event-details page in the MVP. The source page is the authoritative detail view.

## 16. Error handling and connector repair

Errors are classified, not flattened:

- **Authentication:** login expired or account unavailable.
- **User action:** CAPTCHA, consent, terms, or permission screen.
- **Contract drift:** expected endpoint, field, or pagination structure changed.
- **Rate limiting:** explicit response or throttling behavior.
- **Network:** timeout, DNS, offline state, or browser crash.
- **Parsing:** source response was received but required event fields could not be produced.
- **Validation:** invalid search/profile input.

Connector errors contain a stable internal code, human-readable safe message, source, phase, and timestamp. Logs redact URLs containing tokens, request/response headers, cookies, account IDs, emails, and raw bodies.

Retries are bounded. Network and rate-limit failures may retry with exponential backoff and jitter during the current search. Authentication, user-action, contract-drift, and parsing failures do not loop; they surface immediately.

A connector repair starts by repeating the read-only DevTools inspection and updating only that connector's request and response adapters plus its fixtures.

## 17. Security and privacy

- Bind local services to `127.0.0.1` unless explicitly reconfigured.
- Store the dedicated browser profile and SQLite database with user-only filesystem permissions.
- Exclude browser profiles, databases, logs, fixtures containing private data, and environment files from version control.
- Never place cookies or tokens in source code, configuration files, URLs returned to clients, or logs.
- Sanitize descriptions and treat all platform content as untrusted input.
- Allow only `http` and `https` canonical event links.
- Apply request validation and response size limits.
- Do not automate registration, purchases, messages, CAPTCHA solving, or access-control bypasses.
- Treat platform request contracts as unstable and potentially subject to platform terms.

## 18. Testing strategy

### Unit tests

- Date and timezone boundary conversion, including daylight-saving transitions.
- Location validation.
- URL canonicalization and tracking-parameter removal.
- Source response parsers using minimized, redacted fixtures.
- Normalization and required-field rejection.
- Cross-source deduplication, including conservative non-matches.
- Interest scoring, exclusions, and deterministic ordering.
- Secret redaction.

### Integration tests

- Search orchestration with mocked asynchronous connectors that complete, fail, rate-limit, and require login in different orders.
- SSE reconnection and current-state replay.
- SQLite persistence and cancellation.
- HTTP and MCP adapters returning the same ranked event set.
- Browser-host lifecycle with a temporary profile and local test pages.

### Live smoke tests

Each connector has an opt-in, manually run smoke test against its real website and dedicated authenticated profile. Smoke tests verify that at least one page can be queried and parsed without writing to the platform. They are not part of the default test suite because they are slow, account-dependent, and susceptible to platform changes.

### Acceptance test

With a populated interest profile, run a real search for a city/address and date interval. Confirm that results appear progressively, all terminal source states are visible, returned events are in range, direct links work, and at least several results are plausible events the user would consider attending.

## 19. Observability

Use structured local logs with a generated search ID and connector name. Record phase timings, pages processed, raw event count, normalized count, duplicate count, emitted count, and terminal status. Never log sensitive request material or raw private responses.

The connector-status endpoint and UI expose the last successful live check and last safe error code. This distinguishes an empty search from a broken connector.

## 20. Implementation boundaries and order

The implementation is one end-to-end MVP but should proceed in slices:

1. Domain types, SQLite schema, interest profile, ranking, normalization, and deduplication.
2. Search orchestrator plus mock connectors, SSE, REST, and minimal results UI.
3. Dedicated browser host and connector contract.
4. One live connector completed end to end to validate the network-first strategy.
5. Remaining three connectors, one at a time, using the same fixture and smoke-test discipline.
6. MCP adapter over the proven application services.
7. Security, redaction, failure-state, and acceptance-test hardening.

The first live connector should be whichever source exposes the clearest structured search response during inspection. Connector order is an implementation detail and does not change the public contracts.

## 21. Acceptance criteria

The MVP is complete when:

- the user can save and later edit interests;
- the user can search by city/address and inclusive date range;
- Meetup, Luma, Guild, and Eventbrite searches start concurrently from authenticated browser sessions;
- events stream into a unified list without waiting for the slowest source;
- source failures and login requirements remain isolated and visible;
- events are normalized, conservatively deduplicated, ranked, and explainable;
- every displayed event has a working canonical source link;
- equivalent searches work through REST and MCP;
- secrets and raw private responses are absent from the database and logs;
- unit and integration tests pass; and
- a manual live acceptance search surfaces several plausible events the user would consider attending.
