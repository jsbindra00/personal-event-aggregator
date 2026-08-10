# Personal Event Aggregator

A local-first search interface for Meetup, Luma, Eventbrite, and Guild. It accepts a city or street address plus an inclusive date range, ranks results against a saved interest profile, streams events as each source responds, and exposes the same data over HTTP/SSE and MCP.

The source adapters call the websites' read-only first-party private endpoints or rendered page data directly. They do not use official event-platform APIs and never submit credentials through this application. Guild is represented as unavailable because the service closed on 1 October 2024.

Specifically, Meetup uses its anonymous persisted GraphQL location and event queries, Luma uses its public place page plus cursor-paginated discovery JSON, and Eventbrite uses the event-list structured data rendered on its city pages. These are private website contracts rather than supported public APIs, so each source is isolated and reports authentication, rate-limit, network, or contract-drift failures without stopping results from the others. Browser automation is retained only as a source-scoped fallback when one of those private contracts drifts, or when you explicitly choose **Connect**.

## Requirements

- Node.js 24 or newer
- pnpm 11 (the repository pins `pnpm@11.18.0`)
- Google Chrome (only for fallback and explicit source connection)

Install and verify:

```bash
corepack enable
pnpm install
pnpm test
pnpm typecheck
pnpm build
```

## Run the web application

```bash
pnpm dev
```

Open `http://127.0.0.1:5173`. The API listens on `http://127.0.0.1:4317` and Vite proxies `/api` requests to it.

1. Save positive interests, exclusions, and an optional note.
2. Enter a city or full address, choose the first and last calendar dates, and search. Both dates are inclusive in the selected local time zone.
3. Results appear progressively. Each card links to the original event page. A failed or signed-out source remains isolated from the others.
4. Use a source's **Connect** or **Sign in again** action only when a source reports that it needs browser interaction. A dedicated Chrome window opens; sign in on the source website itself.

Browser sessions live in `.data/chrome-profile`; application data lives in `.data/events.sqlite`. Both paths are private, ignored by Git, and created with restrictive filesystem permissions. Override the database path with `EVENT_AGG_DATABASE_PATH`. Override the API bind address with `EVENT_AGG_HOST` and `EVENT_AGG_PORT`.

Direct source searches start together. Operations against the same source are serialized so a rare browser fallback or explicit Connect action cannot collide with another search.

## HTTP and streaming API

The primary endpoints are:

- `GET` / `PUT /api/interests`
- `GET /api/connectors`
- `POST /api/connectors/:source/connect`
- `POST /api/searches`
- `GET /api/searches/:id`
- `GET /api/searches/:id/events`
- `GET /api/searches/:id/stream` (server-sent events)
- `POST /api/searches/:id/cancel`

Example search:

```bash
curl -sS http://127.0.0.1:4317/api/searches \
  -H 'content-type: application/json' \
  --data '{"locationText":"London","startDate":"2026-08-10","endDate":"2026-08-12","timeZone":"Europe/London"}'
```

Use the returned `streamUrl` to consume progressive results, or poll the search resource for a ranked snapshot.

## MCP and chat clients

Run the stdio MCP server directly:

```bash
pnpm --filter @event-agg/mcp start
```

A generic MCP client configuration is:

```json
{
  "mcpServers": {
    "personal-events": {
      "command": "pnpm",
      "args": [
        "--dir",
        "<repository-path>",
        "--filter",
        "@event-agg/mcp",
        "start"
      ]
    }
  }
}
```

Available tools:

- `get_event_interests`
- `set_event_interests`
- `get_event_sources_status`
- `search_events` — waits and returns ranked links
- `start_event_search` — returns a search ID immediately
- `get_event_search_results` — polls a progressive search

The web server and MCP process share the SQLite format and Chrome profile, but only one connector process should own the persistent Chrome profile at a time.

## Live connector checks

Live checks are opt-in because they launch Chrome and read current websites:

```bash
LIVE_CONNECTOR_SMOKE=luma pnpm exec vitest run packages/connector-luma/test/live.smoke.test.ts
LIVE_CONNECTOR_SMOKE=meetup pnpm exec vitest run packages/connector-meetup/test/live.smoke.test.ts
LIVE_CONNECTOR_SMOKE=eventbrite pnpm exec vitest run packages/connector-eventbrite/test/live.smoke.test.ts
LIVE_CONNECTOR_SMOKE=guild pnpm exec vitest run packages/connector-guild/test/live.smoke.test.ts
```

Run one at a time. A source may report `auth_required` or `user_action_required`; use the dedicated Chrome window to resolve it, then retry.

## Repairing a connector

Each adapter has a network-contract note in `docs/connectors`, sanitized fixtures, parser tests, connector tests, a fixture-safety test, and an opt-in live smoke test.

When a website changes:

1. Reproduce the source-only failure and record its safe error code.
2. Inspect first-party browser requests or rendered page state in the dedicated profile. Keep the investigation read-only.
3. Update the relevant network-contract note and parser against the narrowest stable response shape.
4. Save only a minimal, sanitized fixture and run that source's fixture-safety, parser, connector, and live smoke tests.
5. Run the full test, type-check, build, and secret-scan commands before committing.

Never commit browser profiles, HAR files, storage state, cookies, authorization headers, CSRF values, raw network captures, personal email addresses, or unredacted diagnostics. Diagnostic output passes through `redactDiagnostic`, but it is still intended for local troubleshooting rather than source control.
