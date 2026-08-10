import { describe, expect, it } from "vitest";

import {
  areProbableDuplicates,
  eventIdentity,
  mergeDuplicate
} from "../src/dedupe.js";
import { eventFixture } from "./factories.js";

describe("event deduplication", () => {
  it("uses the canonical URL as the strongest exact identity", () => {
    expect(eventIdentity(eventFixture())).toBe("url:https://lu.ma/event-fixture");
  });

  it("matches cross-source events only with title, time, and venue evidence", () => {
    const luma = eventFixture({
      source: "luma",
      title: "AI Builders London",
      startsAt: "2026-08-12T18:00:00.000Z",
      venueName: "The Ministry"
    });
    const meetup = eventFixture({
      id: "meetup-event",
      source: "meetup",
      sourceEventId: "meetup-1",
      canonicalUrl: "https://www.meetup.com/ai/events/meetup-1",
      title: "AI Builders London",
      startsAt: "2026-08-12T18:10:00.000Z",
      venueName: "The Ministry"
    });

    expect(areProbableDuplicates(luma, meetup)).toBe(true);
    expect(
      areProbableDuplicates(luma, {
        ...meetup,
        startsAt: "2026-08-12T18:16:00.000Z"
      })
    ).toBe(false);
  });

  it("keeps the richer record when duplicates merge", () => {
    const sparse = eventFixture({ descriptionText: null, imageUrl: null });
    const rich = eventFixture({
      id: "rich",
      canonicalUrl: "https://lu.ma/rich",
      descriptionText: "Detailed description",
      imageUrl: "https://images.example/rich.jpg"
    });

    expect(mergeDuplicate(sparse, rich)).toMatchObject({
      id: "rich",
      canonicalUrl: "https://lu.ma/rich",
      descriptionText: "Detailed description",
      imageUrl: "https://images.example/rich.jpg"
    });
  });
});

