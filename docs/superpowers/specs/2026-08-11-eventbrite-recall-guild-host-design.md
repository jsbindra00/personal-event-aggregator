# Eventbrite Recall and Guild.host Discovery Design

## Goal

Recover relevant Birmingham Eventbrite listings that are absent from the generic city page, and replace the obsolete `guild.co` closure stub with active `guild.host` event discovery. Both sources must collect through bounded read-only HTTP during normal searches and continue to feed the existing deduplication and Gemma relevance pipeline.

## Problem

Eventbrite's server-rendered Birmingham `/events/` page exposes only one curated `ItemList`. It omitted both user-reported listings:

- `Business Networking in Birmingham for Professionals, SMEs & Entrepreneurs` (`1991901069720`)
- `Network One: AI & Machine Learning Networking Birmingham Edition` (`1991901156981`)

Eventbrite's keyword discovery routes expose different curated sets. Live inspection confirmed that `/startups/` contains both missing IDs, while routes such as `/machine-learning/` and `/business-networking/` recover each category independently.

The existing Guild connector targets the discontinued `guild.co` product. The requested `guild.host` is a separate active event-hosting service. It documents an anonymous, read-only, cursor-paginated upcoming-events response at `GET https://guild.host/api/next/events/upcoming`.

## Chosen approach

### Eventbrite

For each supported city, request the base page plus a fixed set of broad technology and social discovery routes:

1. `events`
2. `ai`
3. `machine-learning`
4. `startups`
5. `technology`
6. `software`
7. `developer`
8. `product-design`
9. `hackathon`
10. `tech-networking`
11. `business-networking`

Requests are sequential so events can stream after every page while avoiding an aggressive burst against Eventbrite. Every route remains restricted by exact HTTPS host, path shape, response-size, timeout, retry, and cancellation policies. City matching accepts a supported city name anywhere in a city-or-address input.

Each page's JSON-LD `ItemList` uses the existing parser. Results are filtered to the requested half-open UTC interval and deduplicated across routes by Eventbrite source ID, falling back to canonical URL. A malformed or unavailable route is isolated when at least one route succeeds. If every route fails, the connector emits the appropriate source failure so the existing browser fallback may handle authentication or contract drift.

### Guild.host

Replace the closure connector with a direct connector for `guild.host`. The connector requests `first=5` and follows opaque `after` cursors until one of these conditions is true:

- the ordered feed reaches the query's exclusive end timestamp;
- `hasNextPage` is false;
- the configured page limit is reached; or
- an invalid or repeated cursor proves contract drift.

The anonymous API intentionally omits venue names, street addresses, and online-room URLs, but exposes canonical event links, descriptions, timestamps, ownership, online/venue flags, generated images, and approximate venue coordinates. No account, token, cookie, RSVP, or write endpoint is used.

Physical events are retained when their venue coordinates are within 80 km of a supported city centre. Online or hybrid events are retained regardless of venue distance. The initial supported city map matches the cities already recognized by Eventbrite: London, Manchester, Birmingham, Bristol, Edinburgh, Paris, Berlin, Amsterdam, and Barcelona. A city name may occur within a longer address. Unsupported locations produce a source-scoped `user_action_required` result without making a request.

Guild events map into the existing `RawSourceEvent` interface:

| Field | Guild.host value |
| --- | --- |
| source ID | `node.id` |
| canonical URL | `node.fullUrl` after `guild.host` validation |
| title | `node.name` |
| start/end | `node.startAt` / `node.endAt` |
| timezone | `node.timeZone` |
| description | `node.description` |
| organizer | guild name or public user name from `node.owner` |
| coordinates | GeoJSON `[longitude, latitude]` |
| online | `node.hasExternalUrl` |
| image | `node.generatedSocialCardURL` |

## Streaming and failure behavior

- Eventbrite emits unique in-range events after each discovery page completes.
- Guild emits relevant in-range events after each cursor page completes.
- Normal search never launches a browser for Guild and does not launch one for a supported Eventbrite direct search.
- Eventbrite page-level failures are recorded through redacted diagnostics; successful pages still complete the source.
- All-page Eventbrite drift remains eligible for the existing browser fallback.
- Guild rejects malformed payloads, unsafe URLs, invalid coordinates, and broken cursor chains as `contract_drift`.
- Authentication, rate limits, network errors, timeouts, response-size limits, and cancellation use the existing connector-common behavior.
- Partial results from other sources survive every source-scoped failure.

## Testing

Eventbrite tests will prove:

- the fixed intent URLs are generated for Birmingham city and address inputs;
- both reported Eventbrite IDs are recovered by the multi-intent fixture;
- duplicates across intent pages stream only once;
- one failed route does not discard successful routes;
- all failed routes produce contract drift;
- unsupported locations, body limits, unsafe redirects, date filtering, and cancellation remain correct.

Guild tests will prove:

- strict payload validation and safe `guild.host` URL mapping;
- cursor pagination and chronological end-date stopping;
- Birmingham-distance, online, hybrid, date, and deduplication filters;
- supported city-or-address matching and unsupported-location behavior;
- repeated/missing cursors, transport failures, response bounds, and cancellation;
- production wiring searches all four sources directly without opening browser pages.

Live acceptance will run a Birmingham search for 2026-08-11 through 2026-09-10 and verify that Eventbrite IDs `1991901069720` and `1991901156981` reach persisted candidate history. It will also record Guild's current collected count truthfully, including zero when the live feed has no locally eligible events in that interval.

## Out of scope

- RSVP, registration, ticket purchase, organizer contact, or external-account mutation.
- Authenticated Guild venue/address enrichment.
- Unbounded free-form Eventbrite search terms.
- Browser automation during normal direct collection.
- Changes to relevance thresholds or the saved-interest profile.
