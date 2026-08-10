# Luma discovery network contract

Observed on 2026-08-10 from Luma's public London discovery page. The observation was read-only, limited to first-party page and JSON traffic, and performed without exporting cookies or request headers. Production now calls this public discovery contract directly; the browser implementation is retained only as a contract-drift fallback.

## Search action

- Connect URL: `https://luma.com/london?k=p`
- Location discovery: `GET https://luma.com/discover`, select an exact allowlisted `luma.com/<city>?k=p` link, then read `props.pageProps.initialData.data.place.api_id` from the city page's `__NEXT_DATA__` script.
- Search request: `GET https://api.luma.com/discover/get-paginated-events`
- Allowed response host: `api.luma.com`
- Response match: pathname equals `/discover/get-paginated-events`, method is `GET`, status is `200`, and the content type is JSON.

The initial request query fields observed for London were:

| Field | Observed value | Meaning |
| --- | --- | --- |
| `discover_place_api_id` | `discplace-QCcNk3HXowOR97j` | Luma's public London place identifier, resolved by the city route |
| `pagination_limit` | `25` | requested page size |

Later pages add `pagination_cursor=<opaque value>`. The cursor captured during inspection contained a real event identifier, so it is deliberately not stored. Fixtures use `cursor_fixture_page_2`.

The UI request has no start-date or end-date field. The connector must stop paging once results move beyond the requested inclusive end date and filter `event.start_at` against the resolved UTC interval locally. Location is represented by the city route plus `discover_place_api_id`; individual venue/address data comes from each result's `event.geo_address_info`. When an input address cannot be mapped safely to a Luma city route, the connector must report a user-action/unsupported-location state rather than invent an identifier.

## Response envelope and pagination

The response discriminator is the exact envelope:

- `entries`: event-entry array
- `has_more`: boolean
- `next_cursor`: string when another page exists

The next request sends `next_cursor` back as `pagination_cursor`. An absent `entries` array is contract drift; an empty array is a valid page.

## Fields used for normalization

Only these observed response paths are required:

| Normalized field | Luma path |
| --- | --- |
| source event ID | `entries[].event.api_id` |
| canonical URL | `https://luma.com/` + `entries[].event.url` |
| title | `entries[].event.name` |
| start | `entries[].event.start_at` |
| end | `entries[].event.end_at` |
| time zone | `entries[].event.timezone` |
| online/offline | `entries[].event.location_type` |
| address | `entries[].event.geo_address_info.full_address`, falling back to `short_address`, `city_state`, or `city` |
| coordinates | `entries[].event.coordinate.latitude` / `.longitude` |
| organizer | `entries[].calendar.name` |
| image | `entries[].event.cover_url` |
| price | `entries[].ticket_info.is_free` or `entries[].ticket_info.price` |

The list payload does not contain a full event description. Initial streaming therefore emits list-level data only; optional detail enrichment may update an event later.

## Authentication signal

Public discovery returned HTTP `200` in an anonymous Chrome context, while the page separately displayed a Sign In link. No authentication failure was observed and sign-in is not required for this contract. A future `401` or `403` response would be classified as `auth_required` by HTTP semantics, but that is a defensive inference rather than an observed Luma response.

## Safety notes

- No request cookie, response cookie, authorization, anti-forgery, or other header value is recorded.
- No account, user, host, guest, or real event identifier is retained.
- The fixture keeps two synthetic/redacted entries, one redacted cursor, and only normalization fields.
