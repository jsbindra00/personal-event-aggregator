import { describe, expect, it } from "vitest";

import { canonicalizeEventUrl } from "../src/canonical-url.js";
import { normalizeEvent } from "../src/normalize.js";

describe("canonicalizeEventUrl", () => {
  it("removes tracking parameters while preserving event parameters", () => {
    expect(
      canonicalizeEventUrl(
        "https://example.com/e/1?ticket=general&utm_source=email&ref=newsletter#details"
      )
    ).toBe("https://example.com/e/1?ticket=general");
  });

  it("rejects non-HTTP links", () => {
    expect(() => canonicalizeEventUrl("javascript:alert(1)")).toThrow(/http/i);
  });
});

describe("normalizeEvent", () => {
  it("normalizes required fields and converts HTML to plain text", () => {
    expect(
      normalizeEvent(
        {
          source: "luma",
          sourceEventId: "evt_1",
          canonicalUrl: "https://lu.ma/example?utm_medium=email",
          title: "  AI Builders  ",
          startsAt: "2026-08-12T18:00:00Z",
          descriptionHtml: "<p>Hello <strong>builders</strong></p>"
        },
        { now: () => new Date("2026-08-10T00:00:00.000Z") }
      )
    ).toMatchObject({
      canonicalUrl: "https://lu.ma/example",
      title: "AI Builders",
      descriptionText: "Hello builders",
      endsAt: null,
      tags: [],
      firstSeenAt: "2026-08-10T00:00:00.000Z"
    });
  });

  it("rejects an event with an invalid start timestamp", () => {
    expect(() =>
      normalizeEvent({
        source: "meetup",
        sourceEventId: "evt_2",
        canonicalUrl: "https://www.meetup.com/example/events/evt_2",
        title: "Builders",
        startsAt: "not-a-time"
      })
    ).toThrow(/start/i);
  });
});

