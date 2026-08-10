# Eventbrite consumer-search contract

Observed on 2026-08-10 from Eventbrite's consumer London discovery page in isolated Chrome. Inspection stayed on consumer discovery and did not access organizer, attendee, order, ticket-write, or event-management pages.

## Search request

Eventbrite's current consumer search is server-rendered rather than populated by a dedicated search XHR.

- Method: `GET`
- Observed URL: `https://www.eventbrite.co.uk/d/united-kingdom--london/events/`
- Location representation: `/d/<country-slug>--<city-slug>/events/`
- Response content type: HTML document
- Event container: the first `script[type="application/ld+json"]` whose parsed value has `@type: "ItemList"`
- Event path: `itemListElement[].item`
- Observed page size: 40 entries

The personal proof connector maps London or a London address to the observed UK consumer route. It does not guess a non-UK country route. Unsupported locations produce `user_action_required` so another connector can still return partial results.

The consumer page did not send start/end date parameters for an arbitrary interval. The connector filters the embedded `startDate` values against the application's inclusive UTC interval.

## Pagination model

No next cursor or next-page link was exposed in the observed consumer page. Adding `?page=2` and `?page=3` returned the same 40 canonical event URLs, so these are not replayed as pagination. One valid ItemList therefore completes normally; an empty ItemList is a successful zero-result search.

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
