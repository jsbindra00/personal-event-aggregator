# Guild.host public events contract

Observed on 2026-08-11 from the active `https://guild.host` service and its published OpenAPI document. This service is separate from the unrelated professional-messaging product formerly hosted at `guild.co`, which closed in 2024.

## Discovery request

- Method: `GET`
- Host: `guild.host`
- Path: `/api/next/events/upcoming`
- Query: `first=5` and optional opaque `after=<endCursor>`
- Authentication: none
- Response: JSON cursor connection `{ edges, pageInfo }`

The endpoint documents anonymous access explicitly. No bearer token, cookie, user session, or browser bootstrap is sent. Authenticated responses can reveal more venue or online-location details, but the personal proof deliberately uses only the anonymous representation.

## Pagination

Events are returned in chronological order. The API caps `first` at five. The connector follows `pageInfo.endCursor` while `hasNextPage` is true and stops when it reaches the query's exclusive end timestamp or exhausts the feed.

A missing cursor while `hasNextPage` is true, a repeated cursor, or reaching the defensive 100-page bound before the requested interval is exhausted is contract drift. Already streamed events remain partial results, while the Guild source reports failure rather than claiming a silently truncated completion.

## Anonymous fields

| Normalized field | Public API path |
| --- | --- |
| source ID | `edges[].node.id` |
| canonical URL | `edges[].node.fullUrl` |
| title | `edges[].node.name` |
| start/end | `edges[].node.startAt` / `endAt` |
| timezone | `edges[].node.timeZone` |
| description | `edges[].node.description` |
| organizer | public Guild or User fields under `edges[].node.owner` |
| coordinates | `venue.address.location.geojson.coordinates` as `[longitude, latitude]` |
| online flag | `edges[].node.hasExternalUrl` |
| image | `edges[].node.generatedSocialCardURL` |

The anonymous contract exposes approximate venue coordinates but intentionally omits venue name, street address, entry instructions, and the external online-room URL. Those normalized fields therefore remain null; the canonical public event link is always retained.

## Location policy

The API feed is global and has no location query. The connector resolves an explicitly supported city name inside the user's city-or-address input, then:

- retains physical events whose approximate coordinates are within 80 km of the city centre;
- retains online and hybrid events regardless of venue distance;
- excludes physical events with no public coordinates; and
- applies the application's existing half-open UTC date interval.

Supported city centres match the Eventbrite connector: London, Manchester, Birmingham, Bristol, Edinburgh, Paris, Berlin, Amsterdam, and Barcelona. Unsupported inputs emit `user_action_required` without making an API request.

## Read-only and failure policy

Only the exact HTTPS host and path above are allowlisted. Responses are capped at 2 MB, time out after 20 seconds by default, honor cancellation, and use bounded retries for network errors or rate limiting. Canonical event URLs must use HTTPS, the exact `guild.host` hostname, and an `/events/<slug>` path. Malformed payloads, unsafe event URLs, invalid timestamps or coordinates, and broken cursor chains are classified as contract drift.

The connector never calls RSVP, ticket, form-submission, membership, organizer, attendee, or account endpoints and never modifies an external Guild.host resource.
