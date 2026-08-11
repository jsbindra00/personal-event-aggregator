# Personal Event Aggregator

A local-first search interface for Meetup, Luma, Eventbrite, and Guild. It accepts a city or street address plus an inclusive date range, ranks results against a saved interest profile, streams events as each source responds, and exposes the same data over HTTP/SSE and MCP.

The source adapters call read-only first-party endpoints or rendered page data directly and never submit credentials through this application. Meetup and Luma use private website contracts, Eventbrite uses rendered discovery data, and Guild.host uses its documented anonymous public feed. The Guild.host event service is separate from the unrelated `guild.co` messaging product that closed in 2024.

Specifically, Meetup uses its anonymous persisted GraphQL location and event queries, Luma uses its public place page plus cursor-paginated discovery JSON, Eventbrite merges structured event data from a fixed set of city and technology/social discovery pages, and Guild.host follows its anonymous upcoming-event cursors. Each source is isolated and reports authentication, rate-limit, network, or contract-drift failures without stopping results from the others. Browser automation is retained only as a source-scoped fallback for Meetup, Luma, or Eventbrite contract drift, or when you explicitly choose **Connect** on a source that supports an interactive session.

## Requirements

- Node.js 24 or newer
- pnpm 11 (the repository pins `pnpm@11.18.0`)
- Ollama with `gemma3:4b` (local relevance filtering)
- Google Chrome (only for fallback and explicit source connection)

Install and verify:

```bash
corepack enable
pnpm install
brew install ollama
brew services start ollama
ollama pull gemma3:4b
pnpm model:check
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
3. Results appear progressively after local relevance evaluation. Accepted events enter the main feed, uncertain events stay in the collapsed **Maybe** section, and clearly irrelevant events remain hidden. Each card links to the original event page and explains its relevance briefly.
4. Use a source's **Connect** or **Sign in again** action only when a source reports that it needs browser interaction. A dedicated Chrome window opens; sign in on the source website itself.

Browser sessions live in `.data/chrome-profile`; application data lives in `.data/events.sqlite`. Both paths are private, ignored by Git, and created with restrictive filesystem permissions. Override the database path with `EVENT_AGG_DATABASE_PATH`. Override the API bind address with `EVENT_AGG_HOST` and `EVENT_AGG_PORT`.

Direct source searches start together. Operations against the same source are serialized so a rare browser fallback or explicit Connect action cannot collide with another search.

## Local relevance filtering

The collectors intentionally cast a broad net. Candidate titles, descriptions, organizers, venues, and tags are sent in small batches to `gemma3:4b` through Ollama on loopback only. Nothing is sent to a hosted model. Saved exclusions are applied before inference, and decisions are cached against the event, interest profile, model, and prompt version.

The high-precision policy is:

- **Show:** score at least 70 with confidence at least 0.55
- **Maybe:** score 40–69, or a high score with low confidence
- **Hide:** score below 40 or an explicit excluded-interest match

If Ollama is stopped, the model is missing, it times out, or it returns invalid structured output, the search continues with a conservative text-match fallback and reports that state in the UI/API. Check readiness with `pnpm model:check` or `GET /api/relevance/status`.

Configuration:

- `EVENT_AGG_OLLAMA_URL` — loopback HTTP only; defaults to `http://127.0.0.1:11434`
- `EVENT_AGG_RELEVANCE_MODEL` — defaults to `gemma3:4b`
- `EVENT_AGG_RELEVANCE_TIMEOUT_MS` — defaults to `60000` to allow a cold local model load
- `EVENT_AGG_RELEVANCE_BATCH_SIZE` — defaults to `5` for reliable local latency

## HTTP and streaming API

The primary endpoints are:

- `GET` / `PUT /api/interests`
- `GET /api/connectors`
- `GET /api/relevance/status`
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
Snapshots omit uncertain links by default while returning `maybeCount`. Append `?includeMaybe=true` to the snapshot or events URL to include `maybeEvents`. SSE also emits `relevance.progress`, `relevance.fallback`, and `event.maybe` messages.

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

`search_events` and `get_event_search_results` accept `includeMaybe: true` when a chat client should inspect uncertain links. Outputs include the relevance decision, score, confidence, reason, counts, and safe evaluator status.

The web server and MCP process share the SQLite format and Chrome profile, but only one connector process should own the persistent Chrome profile at a time.

## Live connector checks

Live checks are opt-in because they read current websites. Luma, Meetup, and Eventbrite retain browser-based smoke checks; Guild.host's smoke check is direct and does not launch Chrome:

```bash
LIVE_CONNECTOR_SMOKE=luma pnpm exec vitest run packages/connector-luma/test/live.smoke.test.ts
LIVE_CONNECTOR_SMOKE=meetup pnpm exec vitest run packages/connector-meetup/test/live.smoke.test.ts
LIVE_CONNECTOR_SMOKE=eventbrite pnpm exec vitest run packages/connector-eventbrite/test/live.smoke.test.ts
LIVE_CONNECTOR_SMOKE=guild pnpm exec vitest run packages/connector-guild/test/live.smoke.test.ts
```

Run one at a time. A source may report `auth_required` or `user_action_required`; use the dedicated Chrome window to resolve it, then retry.

To compare each direct connector with its browser implementation using only
aggregate counts and canonical-link overlap, run these sequentially:

```bash
LIVE_DIRECT_PARITY=eventbrite pnpm exec vitest run test/live/direct-parity.test.ts
LIVE_DIRECT_PARITY=luma pnpm exec vitest run test/live/direct-parity.test.ts
LIVE_DIRECT_PARITY=meetup pnpm exec vitest run test/live/direct-parity.test.ts
```

The latest sanitized end-to-end run is recorded in
[`docs/acceptance/2026-08-10-live-search.md`](docs/acceptance/2026-08-10-live-search.md).

## Repairing a connector

Each adapter has a network-contract note in `docs/connectors`, sanitized fixtures, parser tests, connector tests, a fixture-safety test, and an opt-in live smoke test.

When a website changes:

1. Reproduce the source-only failure and record its safe error code.
2. Inspect first-party browser requests or rendered page state in the dedicated profile. Keep the investigation read-only.
3. Update the relevant network-contract note and parser against the narrowest stable response shape.
4. Save only a minimal, sanitized fixture and run that source's fixture-safety, parser, connector, and live smoke tests.
5. Run the full test, type-check, build, and secret-scan commands before committing.

Never commit browser profiles, HAR files, storage state, cookies, authorization headers, CSRF values, raw network captures, personal email addresses, or unredacted diagnostics. Diagnostic output passes through `redactDiagnostic`, but it is still intended for local troubleshooting rather than source control.
