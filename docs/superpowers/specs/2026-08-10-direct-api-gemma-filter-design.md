# Direct Private-Endpoint Collection and Local Relevance Filtering

## Goal

Collect a broader set of events from Meetup, Luma, and Eventbrite while showing a high-precision list of events the user is plausibly interested in. Use direct read-only requests to the sites' private first-party endpoints whenever the observed contract is stable. Retain browser automation only for authentication, location/session bootstrap, and contract-drift fallback. Apply a local Gemma-family model before candidates become visible.

Guild remains a truthful unavailable source because the service closed.

## Why the MVP used browser automation

The first implementation optimized for proving the product safely without persisting request credentials or copying brittle internal request templates. The browser supplied current cookies, anti-forgery state, GraphQL documents, place identifiers, and location autocomplete behavior. The connectors then observed only bounded first-party responses.

Now that the read contracts are known, the browser is unnecessary for several normal search paths:

- Eventbrite discovery is an anonymous HTML `GET` whose JSON-LD can be fetched directly.
- Luma discovery is an anonymous JSON `GET` once a public discovery-place identifier has been resolved.
- Meetup event search is a GraphQL `POST`. Its public/anonymous behavior and request document can be replayed directly when accepted; if the request needs changing session or anti-forgery state, the browser can bootstrap the request template in memory and an authenticated request context can replay pagination without UI scrolling.

Private endpoints are unsupported contracts. Direct clients must be rate-limited, narrowly allowlisted, fixture-tested, and able to fall back without hiding partial results.

## Approaches considered

### 1. Direct-first collection plus a local generative classifier — recommended

Use direct HTTP for stable read contracts, browser bootstrap only where needed, and a small instruction-tuned Gemma model to classify batches of candidates. This is fastest, casts the widest net, produces an explanation, and keeps event/profile data local. The main trade-offs are local model setup and several seconds of evaluation latency.

### 2. Keep browser collection and add the local classifier

This is the smallest change and improves relevance, but retains slow page navigation, fragile selectors, browser contention, and unreliable pagination. It does not answer the direct-endpoint concern.

### 3. Direct-first collection plus embeddings only

Embeddings are faster and good for semantic similarity, but a similarity score is weaker at applying nuanced preferences and explicit negative intent. It is a useful later prefilter, not the only decision-maker for the personal proof.

## Architecture

### Source transport boundary

Each connector receives a `SourceTransport` that returns bounded, typed payloads without exposing credentials:

```ts
interface SourceTransport {
  readonly mode: "direct" | "browser_bootstrap";
  search(query: ResolvedSearchQuery, signal: AbortSignal): AsyncIterable<unknown>;
}
```

Connector parsers and normalized event output remain unchanged. Transport selection is source-specific:

- `EventbriteDirectTransport` fetches the allowlisted city discovery document and extracts its `ItemList` JSON-LD. No browser is opened during a supported search.
- `LumaDirectTransport` resolves a public city/place descriptor, calls the allowlisted paginated discovery endpoint directly, follows bounded cursors, and filters dates locally. Location descriptors are cached without cookies or personal identifiers. Browser bootstrap is used only if a location cannot be resolved from public content.
- `MeetupDirectTransport` replays the allowlisted `recommendedEventsWithSeries` GraphQL operation. The direct anonymous contract is attempted first. If Meetup requires current request state, a read-only browser page resolves the location and captures a sanitized request template in memory; pagination is then replayed through the browser context's request client rather than UI scrolling.
- `GuildConnector` continues to report `source_unavailable`.

Direct transports use explicit host/path/method allowlists, response-size limits, abortable timeouts, bounded pagination, backoff for `429`/`5xx`, and the existing redacted diagnostics. Cookies, authorization values, anti-forgery values, raw captures, and request templates are never written to SQLite or logs.

### Relevance boundary

Introduce an asynchronous `EventRelevanceEvaluator` between normalization/deduplication and persistence/emission:

```ts
interface EventRelevanceEvaluator {
  readonly fingerprint: string;
  evaluate(
    events: readonly NormalizedEvent[],
    profile: InterestProfile,
    signal: AbortSignal
  ): Promise<RelevanceDecision[]>;
}

interface RelevanceDecision {
  eventId: string;
  decision: "show" | "maybe" | "hide";
  score: number;
  confidence: number;
  matchedInterests: string[];
  reason: string;
}
```

The production evaluator calls a local Ollama-compatible endpoint. The default proof configuration is `gemma3:4b`, which is small enough for the current 32 GB Apple Silicon machine and supports JSON-schema-constrained output through Ollama. The model name and endpoint are configurable so a newer Gemma instruction-tuned model can replace it without changing the search service.

The prompt treats event text as untrusted data, includes the saved positive interests, exclusions, and free-form note, and requests only the declared JSON schema at temperature zero. Inputs are bounded per field. The response is schema-validated; missing, duplicate, or unknown event IDs invalidate the batch.

### High-precision policy

- Hard exclusions are applied before model inference.
- Events with model score at least `70`, confidence at least `0.55`, and decision `show` enter the main stream.
- `maybe` decisions from score `40` through `69` are stored and available behind a collapsed **Maybe** control, not mixed into the main list.
- `hide` decisions are counted but not persisted as user-visible search results.
- When the local model is unavailable or a batch fails twice, the search continues with a strict deterministic fallback: only events with a positive lexical match are shown; zero-score events are hidden. A source/model status message explains the fallback.

This policy deliberately prioritizes precision. Thresholds are configuration values, not user-facing controls in the first version.

## Data flow and streaming

1. All source transports begin concurrently and emit broad candidates.
2. The search service normalizes, date-filters, applies hard exclusions, and deduplicates candidates.
3. Candidates enter a relevance buffer. A batch flushes at 10 events or 300 ms, whichever occurs first.
4. The local evaluator returns structured decisions for the batch.
5. `show` events are persisted, ranked by model score with deterministic tie-breakers, and streamed as `event.added` or `event.updated`.
6. `maybe` events are persisted with their decision but do not enter the default visible stream.
7. Search completion waits for source completion and all outstanding relevance batches.

The SSE protocol adds `relevance.progress` and `relevance.fallback` messages. REST and MCP snapshots expose evaluator status and counts. MCP `search_events` returns visible links by default, includes a `maybeCount`, and accepts `includeMaybe: true` when the caller wants borderline links.

## Caching

Add a relevance-decision table keyed by:

- canonical event content hash;
- saved-interest profile hash;
- evaluator fingerprint, including provider, model, prompt version, and thresholds.

Cache hits bypass inference. A changed event description, interest profile, model, prompt, or policy creates a new key. The cache stores public event data hashes and decisions, never model server credentials.

## UI

The search screen continues to stream links. It gains:

- an **Evaluating relevance…** state with accepted/evaluated counters;
- a local-model readiness indicator;
- a collapsed **Maybe (N)** section;
- a small explanation on accepted cards, such as “Strong match: AI engineering and developer tools”;
- a fallback banner when the local model is unavailable.

Zero-score events never appear in the default list.

## Failure behavior

- Direct transport contract drift falls back to the existing read-only browser connector for Meetup, Luma, or Eventbrite.
- Authentication and user-action requirements remain source-scoped.
- Rate limits respect `Retry-After`; searches retain partial results.
- Model timeouts retry once with a smaller batch, then use strict lexical fallback.
- Invalid model JSON is rejected rather than partially trusted.
- Cancellation aborts direct requests, browser work, queued model batches, and Ollama calls.
- A missing local model never prevents search completion.

## Testing

- Contract tests prove direct requests use only allowlisted methods, hosts, paths, bounded bodies, and pagination.
- Fixture tests cover direct Eventbrite HTML, Luma JSON pages, and Meetup GraphQL pages without real identifiers or credentials.
- Transport tests cover `401`, `403`, `429`, `5xx`, timeout, abort, drift, and browser fallback.
- Evaluator tests use a fake Ollama server to verify batching, JSON schema, thresholds, prompt-injection resistance, retry, fallback, and cache keys.
- Search-service tests prove zero-score events are hidden, completion waits for evaluation, partial source results survive, and cancellation drains no late events.
- UI tests cover progress, explanations, model fallback, and the collapsed maybe section.
- A mocked end-to-end test proves HTTP/SSE and MCP return the same accepted links.
- Live acceptance compares direct and existing browser-derived source results for one London interval, then runs a real local model and manually checks the top accepted and hidden samples.

## Acceptance criteria

1. Supported Eventbrite searches make no browser page call.
2. Supported Luma searches use direct pagination after location resolution.
3. Meetup uses direct GraphQL when anonymous replay succeeds and browser bootstrap only as a fallback.
4. Fixture parity is exact, and a paired London live acceptance run shows the direct-first path collecting at least the browser path's total in-range candidate count for the same interval. Any changing event snapshot is compared by canonical-ID overlap and recorded explicitly rather than silently treated as parity.
5. No zero-match event appears in the default list.
6. The configured local Gemma evaluator classifies broad candidates with schema-validated decisions and preserves a usable strict fallback when unavailable.
7. REST, SSE, UI, and MCP agree on accepted results and report evaluator/source degradation truthfully.
8. No browser secret, raw request template, or unredacted diagnostic is persisted or committed.

## Out of scope

- Fine-tuning Gemma.
- Learning from thumbs-up/thumbs-down feedback.
- Hosted model providers.
- Automatic registration, RSVP, ticket purchase, messaging, or write operations on event platforms.
