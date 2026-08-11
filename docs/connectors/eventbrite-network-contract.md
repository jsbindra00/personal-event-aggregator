# Eventbrite consumer-search contract

Observed on 2026-08-10 and re-checked on 2026-08-11 from Eventbrite's consumer London and Birmingham discovery pages in isolated Chrome. Inspection stayed on consumer discovery and did not access organizer, attendee, order, ticket-write, or event-management pages.

## Search request

Eventbrite's current consumer search is server-rendered rather than populated by a dedicated search XHR.

- Method: `GET`
- Observed base URL: `https://www.eventbrite.co.uk/d/united-kingdom--birmingham/events/`
- Location representation: `/d/<country-slug>--<city-slug>/<discovery-slug>/`
- Response content type: HTML document
- Event container: the first `script[type="application/ld+json"]` whose parsed value has `@type: "ItemList"`
- Event path: `itemListElement[].item`
- Observed page size: 40 entries

The generic city page is one curated result set, not a comprehensive city index. In Birmingham it omitted two listings reported by the user even though both were live and in range:

- `1991901069720` — Business Networking in Birmingham for Professionals, SMEs & Entrepreneurs
- `1991901156981` — Network One: AI & Machine Learning Networking Birmingham Edition

Keyword routes expose different curated sets. Direct inspection confirmed that `/startups/` contained both reported IDs, `/machine-learning/` contained the AI listing, and `/business-networking/` contained the broader networking listing. The direct connector therefore searches a fixed broad set: `events`, `ai`, `machine-learning`, `startups`, `technology`, `software`, `developer`, `product-design`, `hackathon`, `tech-networking`, and `business-networking`.

The personal proof connector recognizes nine explicit cities and accepts the city name inside a longer address. It never invents a country route from arbitrary input. Unsupported locations produce `user_action_required` so another connector can still return partial results.

The consumer page did not send start/end date parameters for an arbitrary interval. The connector filters the embedded `startDate` values against the application's inclusive UTC interval.

## Multi-intent collection and pagination

No next cursor or next-page link was exposed in the observed consumer pages. Adding `?page=2` and `?page=3` returned the same canonical event URLs, so these are not replayed as pagination.

The connector requests the fixed discovery routes sequentially. This avoids a burst of parallel traffic and lets unique events stream after every page. Events are deduplicated across pages by source event ID, falling back to canonical URL. A valid empty `ItemList` counts as a successful page. A malformed or temporarily unavailable page is isolated when at least one other page succeeds; if every page fails, the source emits the representative failure and remains eligible for the existing browser fallback.

## Optional enrichment traffic

One inspected load made a first-party read-only request to:

`GET /api/v3/destination/events/?event_ids=<comma-separated public event IDs>&expand=...`

It returned `{ pagination, events }`, but later clean profiles did not consistently issue it. The connector does not depend on or replay this request. The server-rendered structured data is the stable observed source.

## Structured event fields

| Normalized field | JSON-LD path |
| --- | --- |
| canonical URL | `item.url` |
| source event ID | trailing numeric ticket ID parsed from `item.url` when present |
| title | `item.name` |
| start | `item.startDate` |
| end | `item.endDate` |
| description | `item.description` |
| image | `item.image` |
| online/offline | `item.eventAttendanceMode` |
| venue | `item.location.name` |
| address | `item.location.address.streetAddress`, `addressLocality`, `addressRegion`, `postalCode`, `addressCountry` |
| coordinates | `item.location.geo.latitude` / `longitude` |

Price and organizer fields were not present in the observed ItemList and remain null. Tracking query parameters on event URLs are removed before deduplication.

## Authentication and read-only policy

The discovery document returned HTTP `200` anonymously. No login-expired search response was observed. Redirecting to a login path is classified defensively as `auth_required`.

During a connector-controlled search only `GET`, `HEAD`, and `OPTIONS` requests are allowed. Eventbrite identity settings, analytics, telemetry, saves, orders, registrations, and every other POST/PUT/PATCH/DELETE are blocked; none are needed to read the server-rendered ItemList.
