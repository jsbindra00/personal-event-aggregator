# Public Vercel Deployment Design

## Goal

Deploy the Personal Event Aggregator as a public web application on Vercel so a visitor can save interests in their browser, search a city or address over an inclusive date range, and receive canonical event links from Meetup, Luma, Guild.host, and Eventbrite.

## Chosen approach

Add a stateless public mode alongside the existing local-first application. A single Vercel Node.js function runs the four direct, read-only connectors and streams the existing search-service messages back over the response body. The browser keeps the interest profile in `localStorage` and includes it in each search request. The hosted function uses the existing conservative lexical relevance evaluator and in-memory no-op persistence for the lifetime of one request.

This is preferred over two alternatives:

- Deploying the existing Fastify server unchanged would make SQLite search state unreliable across serverless instances and would require hosted browser automation and Ollama.
- Moving the connectors into the browser would expose them to cross-origin restrictions and make upstream contract handling less reliable.

## Public and local modes

The existing local mode remains unchanged: Fastify, SQLite, SSE, optional Chrome fallback, MCP, and local `gemma3:4b` through Ollama continue to work from `pnpm dev`.

The Vercel deployment uses public mode:

- The Vite frontend is built as static assets.
- `POST /api/search` is the only hosted application API.
- Interest profiles are stored per browser, not in Vercel or a shared database.
- Only anonymous direct connectors are available. Interactive sign-in and browser fallback are not exposed.
- Relevance uses the strict lexical evaluator. The interface accurately labels this as private browser storage and deterministic hosted filtering; it does not claim that Ollama runs in Vercel.
- MCP remains an installable local capability and is not exposed publicly.

## Request and stream contract

`POST /api/search` accepts:

```json
{
  "query": {
    "locationText": "Birmingham",
    "startDate": "2026-08-17",
    "endDate": "2026-09-16",
    "timeZone": "Europe/London"
  },
  "interests": {
    "positive": ["AI", "software engineering"],
    "excluded": ["crypto sales"],
    "note": "Technical talks and builder socials"
  }
}
```

The request is validated with the existing core schemas plus public limits: at least one positive interest, no more than 30 positive interests, no more than 30 exclusions, no individual entry longer than 120 characters, and a date window no longer than 31 inclusive calendar days.

The response uses newline-delimited JSON. Each line is an existing `SearchStreamMessage`. The function writes an initial message immediately, streams progressive connector and relevance events, and closes after `search.completed`. Invalid input returns JSON with HTTP 400 before streaming begins. Unsupported methods return HTTP 405.

## Runtime composition

The public search runtime creates these dependencies per request:

- Direct Luma connector with bounded pagination and one retry attempt.
- Direct Meetup connector with one retry attempt.
- Direct Eventbrite connector with bounded response bodies, a short timeout, and one retry attempt.
- Direct Guild.host connector with bounded pagination and one retry attempt.
- Existing `createSearchService` for resolution, normalization, deduplication, ranking, source status, and stream messages.
- Existing lexical relevance evaluator.
- No-op `SearchStore` and in-memory relevance cache.

The function uses Node.js 24 and Vercel Fluid Compute with a 300-second maximum duration. Client disconnects cancel the search. Upstream failures remain source-scoped and do not suppress successful results from the other sources.

## Browser adapter

`createPublicEventApi` implements the existing `EventApi` interface:

- `getInterests` and `setInterests` read and write a versioned `localStorage` key.
- Connector status begins as ready for all four direct sources.
- `connectSource` is a safe no-op because hosted mode never opens third-party sessions.
- `startSearch` creates a client search identifier, begins the streaming POST, and returns immediately.
- `openSearchStream` subscribes to the in-browser stream associated with that identifier and replays messages received before subscription.
- `cancelSearch` aborts the request.

The normal HTTP/SSE API remains the default outside a Vercel build. Vite selects public mode through `VITE_PUBLIC_MODE=true` in the Vercel build command.

## User interface

The existing visual design and event cards remain. Hosted mode adds a compact privacy/runtime note: interests stay in this browser, searches use anonymous direct source requests, and hosted ranking uses deterministic filtering. Source connection buttons are hidden in public mode. Search forms default to today and 30 days later to make the public app immediately usable.

## Deployment

The repository root is the Vercel project root. `vercel.json` will:

- enable Fluid Compute;
- build the required workspace packages and Vite application;
- publish `apps/web/dist`;
- route `/api/search` to `api/search.ts`;
- apply a 300-second maximum duration and request cancellation support to the function;
- send basic security headers and prevent caching of API responses.

The first release is deployed as a preview, exercised with a real Birmingham search, then promoted to production. The generated Vercel project URL is the public handoff URL. No custom domain is required for this release.

## Security and abuse boundaries

- No secrets, cookies, credentials, browser profiles, or local databases are deployed.
- The endpoint accepts JSON only, enforces body and field limits, and returns no permissive CORS headers.
- Date range, interest count, pagination, upstream response size, connector retry count, and function duration are bounded.
- Canonical event links are preserved; the application never RSVPs, purchases tickets, or contacts organizers.
- Vercel deployment protection is left at the project default for preview and production is public.

## Testing and acceptance

Automated tests cover public request validation, stream completion, source-scoped failures, local interest persistence, message replay, and cancellation. Existing tests, type-checking, and builds must remain green.

Release acceptance requires:

1. The Vercel build reports Ready.
2. The production page loads without console-breaking errors.
3. Interests persist after a reload in the same browser.
4. A Birmingham search for a 30-day window returns or safely reports completion for all four sources.
5. Returned event cards link directly to canonical source pages.
6. A 390-pixel viewport has no horizontal overflow.

