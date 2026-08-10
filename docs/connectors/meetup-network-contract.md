# Meetup web-search network contract

Observed on 2026-08-10 from Meetup's normal Find Events page in an isolated Chrome profile. This is the first-party web application's internal request, not Meetup's documented external API. The inspection retained no headers, cookies, tokens, account IDs, attendee data, or real event IDs.

## Search action and location resolution

- Connect URL: `https://www.meetup.com/find/?source=EVENTS`
- Search action: load Find Events, fill the labelled location input, then select the first autocomplete result with the keyboard.
- Observed city input: `London`
- Resolved UI value: `London, GB`
- Observed London coordinates sent by the page: latitude `51.45000076293945`, longitude `-0.23999999463558197`.

The UI exposes a location input labelled `Search for location by city or zip code`. Typing `London` produced first-party `getLocationSearch` suggestions. A later live acceptance run showed that a raw `location=London` URL can retain an unrelated profile location even while displaying the raw query in the URL. The connector therefore selects the first current autocomplete result and waits for the resulting event request. It lets Meetup's current page resolve a city or address; it does not construct coordinates itself.

## Event request

- Method: `POST`
- URL: `https://www.meetup.com/gql2`
- Operation name: `recommendedEventsWithSeries`
- Allowed host: `www.meetup.com`
- Response match: `/gql2` plus the exact GraphQL operation name above.

Observed initial variables:

| Variable | Observed value |
| --- | --- |
| `first` | `12` |
| `lat` | `51.45000076293945` |
| `lon` | `-0.23999999463558197` |
| `startDateRange` | `2026-08-09T18:15:19-04:00[US/Eastern]` |
| `numberOfEventsForSeries` | `5` |
| `seriesStartDate` | `2026-08-09` |
| `sortField` | `RELEVANCE` |
| `doConsolidateEvents` | `true` |
| `doPromotePaypalEvents` | `false` |
| `indexAlias` | JSON-encoded configuration selecting the split offline/online model and wrong-language filtering |
| `dataConfiguration` | JSON-encoded simplified-search configuration including events from the member's chapters |

The UI constructs time-dependent values; the connector does not replay a captured body. It navigates the normal page and observes the request the current web client generates.

The request has a lower-bound `startDateRange` but no end-date variable. Results are relevance-sorted. The connector therefore filters `node.dateTime` against the application's inclusive UTC interval, caps pagination, and stops on an empty cursor or when every event returned by a later page starts at or beyond `endsBeforeUtc`.

## Pagination and response envelope

Scrolling adds `after=<opaque cursor>` to the same operation. The cursor captured during inspection is deliberately not retained. The redacted fixture uses `cursor_fixture_page_2`.

The exact event container is:

`data.result.edges[].node`

Pagination is:

- `data.result.pageInfo.hasNextPage`
- `data.result.pageInfo.endCursor`

An absent `data.result.edges` array is contract drift. An empty array is a valid page.

## Normalization paths

| Normalized field | Meetup path |
| --- | --- |
| source event ID | `node.id` |
| canonical URL | `node.eventUrl` |
| title | `node.title` |
| start | `node.dateTime` |
| description | `node.description` |
| online/offline | `node.eventType` (`ONLINE` or `PHYSICAL`) |
| organizer | `node.group.name` |
| time zone | `node.group.timezone` |
| venue | `node.venue.name` |
| address | `node.venue.address`, `city`, `state`, and `country` |
| image | `node.featuredEventPhoto.highResUrl`, then `displayPhoto.highResUrl` |
| price | `node.feeSettings.currency` and `.amount` when present |

The list operation does not expose an end time or coordinates in the observed node, so those normalized fields remain null.

## Login and read-only behavior

The event operation returned HTTP `200` anonymously; no login-expired event-search response was observed. A GraphQL error with extension code `UNAUTHENTICATED`, or a navigation to Meetup login, is classified defensively as `auth_required`.

During connector-controlled search, the browser allows `GET`, `HEAD`, `OPTIONS`, the observed read-only GraphQL POST operations `getSelf`, `unreadMessages`, `getLocationSearch`, and `recommendedEventsWithSeries`, plus the read-only settings lookup at `/orion/v3/identity/settings`. The first three support the page state required before Meetup issues the event query. Analytics, telemetry, and all other mutation-shaped requests are blocked.
