# Guild source status

Observed on 2026-08-10 by opening the former normal web-app URL `https://guild.co/app` in isolated Chrome.

## Current result

The URL resolves to `https://guild.co/` and the official page states that Guild:

- was a mobile-first messaging platform for professional communities;
- went live in 2019; and
- closed on 1 October 2024.

There is no login screen, group membership view, events area, or events request to inspect. The only first-party application request observed was the public closure document and its static page assets.

## Connector behavior

The connector does not invent a historical API contract, fabricate an event fixture, ask for credentials, or inspect messages/member data. It reports:

- state: `failed`
- error code: `source_unavailable`
- safe message: `Guild closed on 1 October 2024`

This is emitted as a normal per-source partial failure, so Luma, Meetup, and Eventbrite results continue streaming and the overall search completes.

## Re-evaluation

If `guild.co/app` becomes an events-capable service again, replace this closure connector only after a fresh events-only network inspection. Never infer a request contract from the former product's blog screenshots or third-party archives.
