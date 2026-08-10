import type { NormalizedEvent } from "../src/types.js";

export function eventFixture(
  overrides: Partial<NormalizedEvent> = {}
): NormalizedEvent {
  return {
    id: "event-fixture",
    source: "luma",
    sourceEventId: "source-fixture",
    canonicalUrl: "https://lu.ma/event-fixture",
    title: "AI Builders",
    startsAt: "2026-08-12T18:00:00.000Z",
    endsAt: null,
    timeZone: "Europe/London",
    descriptionText: null,
    organizerName: null,
    venueName: null,
    addressText: null,
    latitude: null,
    longitude: null,
    isOnline: false,
    imageUrl: null,
    priceText: null,
    tags: [],
    relevanceDecision: "maybe",
    relevanceScore: 0,
    relevanceConfidence: 0,
    relevanceReason: "Awaiting relevance evaluation",
    matchedInterests: [],
    firstSeenAt: "2026-08-10T00:00:00.000Z",
    ...overrides
  };
}
