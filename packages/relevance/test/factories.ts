import type {
  InterestProfile,
  NormalizedEvent,
  RelevanceDecision
} from "@event-agg/core";

export const profile: InterestProfile = {
  positive: ["AI engineering", "climate tech"],
  excluded: ["crypto trading"],
  note: "Hands-on technical events with thoughtful people"
};

export function event(
  overrides: Partial<NormalizedEvent> = {}
): NormalizedEvent {
  return {
    id: "luma:event-fixture",
    source: "luma",
    sourceEventId: "event-fixture",
    canonicalUrl: "https://luma.com/event-fixture",
    title: "AI Engineering Workshop",
    startsAt: "2026-08-12T18:00:00.000Z",
    endsAt: "2026-08-12T20:00:00.000Z",
    timeZone: "Europe/London",
    descriptionText: "A practical technical workshop.",
    organizerName: "London Builders",
    venueName: "Fixture Hall",
    addressText: "London",
    latitude: 51.5,
    longitude: -0.12,
    isOnline: false,
    imageUrl: null,
    priceText: "Free",
    tags: ["AI", "engineering"],
    relevanceDecision: "maybe",
    relevanceScore: 0,
    relevanceConfidence: 0,
    relevanceReason: "Awaiting relevance evaluation",
    matchedInterests: [],
    firstSeenAt: "2026-08-10T00:00:00.000Z",
    ...overrides
  };
}

export function decision(
  eventId: string,
  overrides: Partial<RelevanceDecision> = {}
): RelevanceDecision {
  return {
    eventId,
    decision: "show",
    score: 85,
    confidence: 0.9,
    matchedInterests: ["AI engineering"],
    reason: "Strong match for a saved interest",
    ...overrides
  };
}
