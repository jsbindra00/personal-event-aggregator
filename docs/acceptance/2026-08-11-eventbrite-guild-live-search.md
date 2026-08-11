# Birmingham Eventbrite and Guild.host live acceptance — 2026-08-11

## Run

- Search ID: `8a175de5-05bf-4692-af6f-1094ee55ffed`
- Location: Birmingham
- Inclusive dates: 2026-08-11 through 2026-09-10
- Time zone: Europe/London
- Started: 2026-08-11T08:14:35Z
- Completed: 2026-08-11T08:20:06Z
- Relevance evaluator: local Ollama `gemma3:4b`
- Browser fallback: not used

The API stream reached `search.completed`; source completion was not treated as model completion. Gemma evaluated all 424 collected candidates.

## Counts

| Source | Collected | Show | Maybe | Hidden | Terminal state |
| --- | ---: | ---: | ---: | ---: | --- |
| Eventbrite | 106 | 10 | 32 | 64 | complete |
| Guild.host | 17 | 1 | 9 | 7 | complete |
| Meetup | 301 | 25 | 127 | 149 | complete |
| Luma | 0 | 0 | 0 | 0 | user_action_required |
| **Total** | **424** | **36** | **168** | **220** | complete with one source-scoped degradation |

Luma's safe message was `Luma does not expose a discovery page for Birmingham`. This did not stop any other source.

## Reported Eventbrite regressions

The direct connector was run independently against the same query and emitted both exact source IDs. The application source count also includes those candidates before relevance filtering.

| Source ID | Event | Direct collection | Final relevance | Canonical link |
| --- | --- | --- | --- | --- |
| `1991901156981` | Network One: AI & Machine Learning Networking Birmingham Edition | emitted | Show — 98, confidence 0.95 | https://www.eventbrite.co.uk/e/network-one-ai-machine-learning-networking-birmingham-edition-tickets-1991901156981 |
| `1991901069720` | Business Networking in Birmingham for Professionals, SMEs & Entrepreneurs | emitted | Hidden by policy — Gemma returned Maybe at 30, confidence 0.20; the configured Maybe floor is 40 | https://www.eventbrite.co.uk/e/business-networking-in-birmingham-for-professionals-smes-entrepreneurs-tickets-1991901069720 |

This separates the original recall bug from intended relevance behavior: Eventbrite now collects both listings. The AI-specific event appears in the main results. The general SME networking event does not appear because the existing high-precision relevance policy suppresses its below-threshold model decision, not because Eventbrite missed it.

Eventbrite's discovery `ItemList` currently exposes `2026-08-12` for both listings without a clock time. The connector preserves that source value; the canonical event pages remain the authoritative link for the displayed 19:00 start time.

## Guild.host evidence

Guild.host exhausted the relevant public cursor window and completed with 17 eligible candidates. Ten survived the relevance gate: one Show and nine Maybe. The strongest result was:

- [Building With AI Without Creating Technical Debt](https://guild.host/events/building-with-ai-without-5un3v8) — 2026-08-13T17:00:00Z — Show 90, confidence 0.90.

Guild used only `GET https://guild.host/api/next/events/upcoming` with `first=5` and opaque continuation cursors. No account, browser, RSVP, ticket, organizer, or attendee operation was used.

## Transport evidence

- Eventbrite finished after merging the fixed direct discovery routes and deduplicating by source ID/canonical URL.
- Three individual Eventbrite discovery routes returned no usable `ItemList` during this live run and were isolated as page-level contract drift. Other routes continued, including the routes containing both reported IDs.
- Guild.host and Meetup completed through direct transports.
- No `browser_fallback` phase appeared in the SSE stream.
- No external account or event resource was modified.
