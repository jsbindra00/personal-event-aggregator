import { describe, expect, it } from "vitest";

import type {
  ConnectorMessage,
  ConnectorStatus,
  EventConnector,
  EventSource,
  RawSourceEvent,
  ResolvedSearchQuery
} from "@event-agg/core";

import {
  createPublicSearchRuntime,
  publicSearchRequestSchema
} from "../src/public-search.js";

const validRequest = {
  query: {
    locationText: "Birmingham",
    startDate: "2026-08-17",
    endDate: "2026-09-16",
    timeZone: "Europe/London"
  },
  interests: {
    positive: ["AI", "software engineering"],
    excluded: ["crypto sales"],
    note: "Technical talks and builder socials"
  }
};

describe("publicSearchRequestSchema", () => {
  it("accepts a 31-day inclusive search with bounded interests", () => {
    const parsed = publicSearchRequestSchema.parse(validRequest);

    expect(parsed).toEqual(validRequest);
  });

  it("rejects a public search without a positive interest", () => {
    const parsed = publicSearchRequestSchema.safeParse({
      ...validRequest,
      interests: { ...validRequest.interests, positive: [] }
    });

    expect(parsed.success).toBe(false);
  });

  it("rejects more than 30 positive interests", () => {
    const parsed = publicSearchRequestSchema.safeParse({
      ...validRequest,
      interests: {
        ...validRequest.interests,
        positive: Array.from({ length: 31 }, (_, index) => `interest ${index}`)
      }
    });

    expect(parsed.success).toBe(false);
  });

  it("rejects an interest longer than 120 characters", () => {
    const parsed = publicSearchRequestSchema.safeParse({
      ...validRequest,
      interests: {
        ...validRequest.interests,
        positive: ["a".repeat(121)]
      }
    });

    expect(parsed.success).toBe(false);
  });

  it("rejects a date range longer than 31 inclusive calendar days", () => {
    const parsed = publicSearchRequestSchema.safeParse({
      ...validRequest,
      query: { ...validRequest.query, endDate: "2026-09-17" }
    });

    expect(parsed.success).toBe(false);
  });
});

describe("createPublicSearchRuntime", () => {
  it("streams a relevant event while isolating another source failure", async () => {
    const runtime = createPublicSearchRuntime({
      connectors: [
        connector("luma", [
          { type: "event", source: "luma", event: aiEvent },
          { type: "complete", source: "luma", count: 1 }
        ]),
        connector("guild", [
          {
            type: "failed",
            source: "guild",
            errorCode: "network",
            safeMessage: "Guild.host is temporarily unavailable"
          }
        ])
      ],
      createId: () => "public-search-1",
      now: () => new Date("2026-08-17T08:00:00.000Z")
    });
    const messages = [];

    for await (const message of runtime.stream(
      validRequest,
      new AbortController().signal
    )) {
      messages.push(message);
    }

    expect(messages.some(({ type }) => type === "event.added")).toBe(true);
    expect(
      messages.some(
        ({ type, source }) => type === "source.failed" && source === "guild"
      )
    ).toBe(true);
    expect(messages.at(-1)?.type).toBe("search.completed");
    const event = messages.find(({ type }) => type === "event.added")?.event;
    expect(event).toMatchObject({
      canonicalUrl: "https://lu.ma/ai-builders",
      relevanceDecision: "show"
    });
  });

  it("omits online events from a city search and reports the filtered count", async () => {
    const runtime = createPublicSearchRuntime({
      connectors: [
        connector("luma", [
          { type: "event", source: "luma", event: aiEvent },
          {
            type: "event",
            source: "luma",
            event: {
              ...aiEvent,
              sourceEventId: "worldwide-ai",
              canonicalUrl: "https://lu.ma/worldwide-ai",
              title: "Worldwide AI livestream",
              addressText: null,
              isOnline: true
            }
          },
          {
            type: "event",
            source: "luma",
            event: {
              ...aiEvent,
              sourceEventId: "mislabelled-online-ai",
              canonicalUrl: "https://lu.ma/mislabelled-online-ai",
              title: "Birmingham AI Online",
              isOnline: false
            }
          },
          { type: "complete", source: "luma", count: 3 }
        ])
      ],
      createId: () => "public-search-2",
      now: () => new Date("2026-08-17T08:00:00.000Z")
    });
    const messages = [];

    for await (const message of runtime.stream(
      validRequest,
      new AbortController().signal
    )) {
      messages.push(message);
    }

    expect(
      messages
        .filter(({ type }) => type === "event.added")
        .map(({ event }) => event?.title)
    ).toEqual(["AI Builders"]);
  });

  it("requires a complete multi-word interest instead of one generic token", async () => {
    const runtime = createPublicSearchRuntime({
      connectors: [
        connector("eventbrite", [
          {
            type: "event",
            source: "eventbrite",
            event: {
              ...aiEvent,
              source: "eventbrite",
              sourceEventId: "product-design-systems",
              canonicalUrl: "https://eventbrite.com/e/product-design-systems",
              title: "Product Design Systems Workshop"
            }
          },
          {
            type: "event",
            source: "eventbrite",
            event: {
              ...aiEvent,
              source: "eventbrite",
              sourceEventId: "tote-bag",
              canonicalUrl: "https://eventbrite.com/e/tote-bag",
              title: "Design your Tote Bag",
              descriptionText: "An arts and crafts workshop"
            }
          },
          { type: "complete", source: "eventbrite", count: 2 }
        ])
      ],
      createId: () => "public-search-3",
      now: () => new Date("2026-08-17T08:00:00.000Z")
    });
    const messages = [];

    for await (const message of runtime.stream(
      {
        ...validRequest,
        interests: {
          positive: ["product design"],
          excluded: [],
          note: ""
        }
      },
      new AbortController().signal
    )) {
      messages.push(message);
    }

    expect(
      messages
        .filter(({ type }) => type === "event.added")
        .map(({ event }) => event?.title)
    ).toEqual(["Product Design Systems Workshop"]);
  });
});

const aiEvent: RawSourceEvent = {
  source: "luma",
  sourceEventId: "ai-builders",
  canonicalUrl: "https://lu.ma/ai-builders",
  title: "AI Builders",
  startsAt: "2026-08-20T18:00:00.000Z",
  descriptionText: "Technical talks for software engineering builders",
  organizerName: "Birmingham AI",
  venueName: "Innovation Birmingham",
  addressText: "Birmingham",
  isOnline: false,
  tags: ["AI", "software engineering"]
};

function connector(
  source: EventSource,
  messages: readonly ConnectorMessage[]
): EventConnector {
  const status: ConnectorStatus = {
    source,
    state: "ready",
    lastSuccessAt: null,
    errorCode: null,
    safeMessage: null
  };
  return {
    source,
    getStatus: async () => status,
    async *connect() {
      yield { type: "complete", source, count: 0 };
    },
    async *search(_query: ResolvedSearchQuery, signal: AbortSignal) {
      for (const message of messages) {
        signal.throwIfAborted();
        yield message;
      }
    }
  };
}
