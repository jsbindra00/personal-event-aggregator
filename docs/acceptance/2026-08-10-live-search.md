# Live search acceptance — 2026-08-10

This record covers a local production-mode search against the current Meetup,
Luma, and Eventbrite website contracts with `gemma3:4b` running through Ollama
on loopback. Guild was expected to report its October 2024 closure.

## Exact high-precision acceptance

The planned acceptance profile was saved temporarily and the original profile
was restored after the run:

```json
{
  "positive": ["AI", "product design", "startups", "developer tools"],
  "excluded": ["crypto trading"],
  "note": "Technical, practical, founder and builder events"
}
```

- Query: London, 2026-08-10 through 2026-08-31, `Europe/London`
- Completed search ID: `cf4d3725-bb92-4d49-9ed5-e6b5a7b74e07`
- Evaluated: 588
- Show: 44
- Maybe: 216
- Hide: 328
- Evaluator: resilient / `gemma3:4b`
- Evaluator state: complete, with no fallback message
- Eventbrite: complete, 24 candidates
- Luma: complete, 43 candidates
- Meetup: complete, 521 candidates
- Guild: expected `source_unavailable`, 0 candidates
- Browser fallback: not reported and no interactive browser window opened

Ten canonical accepted links from the completed run:

- [Exclusive AI, Cybersecurity, Cloud & Emerging Technologies at Vonage](https://www.meetup.com/london-networking-for-startups-professionals/events/315698185/)
- [An AI x Design Evening](https://luma.com/1hpoa92v)
- [AI, Fintech, Digital | Tech Innovators Business Networking Event](https://www.meetup.com/i-wanted-to-do-that-this-weekend-j/events/315410260/)
- [Explore Income Opportunities with AI](https://www.meetup.com/digital-wealth-masters-london/events/315932952/)
- [Learn 10 Easy Income Ideas using AI](https://www.meetup.com/how-to-be-successful-online/events/315991272/)
- [How I Use A.I & ChatGPT To Build a Digital Income](https://www.meetup.com/meetup-group-fyjyfbhq/events/315604149/)
- [The AI Business System Built For You](https://www.meetup.com/meetup-group-toppigfa/events/315943895/)
- [Why am I completely done with LLMs in the enterprise](https://www.meetup.com/amstelveen-ai-and-society-meetup-group/events/315818958/)
- [Explore Income Opportunities with AI](https://www.meetup.com/digital-wealth-masters-london/events/315932966/)
- [React App Development with AI (Vibe Coding)](https://www.meetup.com/zero2hero/events/315273425/)

Ten obvious general-entertainment Hide titles were inspected against the final
persisted Show list; all ten were absent from Show:

- `*100 FREE TICKETS!* BIG Summer Singles Party @ The Devonshire Terrace`
- `Epic Ealing Summer Pub Crawl`
- `FRIDAY 20s-30s SOCIAL | Pimlico`
- `5/7-a-Side Football`
- `Global Language Exchange + Social`
- `PICNIC - Part 3!`
- `LOVE MUSIC? Dance Anthems To Make Floor Burn Till 5AM: @Iconic KOKO`
- `80s/90s Boat Party Aboard The Tattershall Castle`
- `AMAPIANOLAND - LDNs Biggest AMAPIANO & AFROBEATS End of Summer Day Party`
- `Clapham Common Pub Crawl - Music Later`

The exact run required two passes: the first harness cap stopped cleanly after
460 uncached local-model decisions, and the completed continuation reused those
cached decisions before evaluating the remaining tail. This is useful product
evidence as well as acceptance evidence: a 21-day London search over every raw
Meetup candidate is too slow for an uncached interactive request with a local
4B model, even though streaming and cache reuse work correctly.

Manual review also found some visible false positives or weak matches, notably
generic AI-income sessions and startup-branded social/networking events. The
current gate is substantially better than raw source results, but the next
precision improvement should incorporate the profile note more strongly or add
negative preferences for pitches, passive-income sessions, and social-only
networking.

## Direct-versus-browser live parity

The opt-in parity harness ran each source sequentially using a temporary
headless browser profile. It logs aggregate counts and canonical overlap only.

- Eventbrite: browser 26, direct 26, overlap 26; both complete
- Luma: browser 25, direct 50, overlap 25; both complete
- Meetup: browser 12, direct 50, overlap 11; both complete

All three parity assertions passed: direct count was at least browser count and
canonical overlap was non-zero.

## Completed bounded search

- Query: London, 2026-08-12 through 2026-08-12, `Europe/London`
- Search ID: `92561d8f-ca21-499d-a09b-f8b7b7aa0f6f`
- Final state: complete
- Candidates: 32
- Show: 2
- Maybe: 9
- Hide: 21
- Evaluator: resilient / `gemma3:4b`
- Evaluator state: complete, with no fallback message
- Sources: Luma complete, Meetup complete, Eventbrite complete, Guild failed
  with the expected `source_unavailable` closure message

The two visible links were:

- [An AI x Design Evening](https://luma.com/1hpoa92v)
- [Does AI Belong In The Creator Economy?](https://luma.com/mzl14nsb)

This run demonstrated immediate search creation, progressive count changes,
source isolation, a complete model-backed relevance pass, and final source
outcomes.

## Wider streaming search

A London search for 2026-08-10 through 2026-08-13 intentionally exercised the
broader collection set. It streamed 89 decisions before a 10-minute acceptance
harness cap cancelled the still-running search cleanly:

- Show: 9
- Maybe: 35
- Hide: 45

Visible links streamed before cancellation included:

- [An AI x Design Evening](https://luma.com/1hpoa92v)
- [Does AI Belong In The Creator Economy?](https://luma.com/mzl14nsb)
- [Unblock: Challenges in AI for Science Salon](https://luma.com/pillarvc-z5p8)
- [Exclusive AI, Cybersecurity, Cloud & Emerging Technologies at Vonage](https://www.meetup.com/london-networking-for-startups-professionals/events/315698185/)
- [A Smarter Way to Build an Online Business with AI](https://www.meetup.com/digital-wealth-masters-london/events/315809443/)
- [Why Your AI Agent Will Fail In Production](https://www.meetup.com/beginners-machine-learning-london/events/315791742/)
- [Tech Startups Networking Event: Connecting Founders and Service Providers](https://www.meetup.com/thebusinessminds/events/315584636/)
- [Tech Startups Networking Event: Founders, CTOs & Technical Partners in London](https://www.meetup.com/thebusinessminds/events/315584655/)
- [Building Your Online Presence - An AI & Chat GPT Approach](https://www.meetup.com/over-40s-passive-income-club/events/315585583/)

The large run confirms that collection is intentionally broader than the main
feed: 80 of 89 processed candidates stayed out of Show. It also exposes the
current performance constraint. An uncached local Gemma pass can take minutes
over a large city/date range; decisions stream per batch and repeat searches
reuse the content/profile/model cache.

## Automated gate run before acceptance

- 43 test files passed; 4 opt-in live files skipped
- 207 tests passed; 4 skipped
- All workspace type checks passed
- All workspace production builds passed
- `git diff --check` passed
