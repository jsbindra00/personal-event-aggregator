import { describe, expect, it } from "vitest";

import { rankEvent, sortRankedEvents } from "../src/rank.js";
import { eventFixture } from "./factories.js";

const profile = {
  positive: ["artificial intelligence", "founders"],
  excluded: ["crypto trading"],
  note: "technical networking"
};

describe("rankEvent", () => {
  it("explains positive title and description matches", () => {
    const ranked = rankEvent(
      eventFixture({
        title: "Founders building artificial intelligence products",
        descriptionText: "Technical networking for product builders"
      }),
      profile
    );

    expect(ranked.relevanceScore).toBeGreaterThan(20);
    expect(ranked.matchedInterests).toEqual([
      "artificial intelligence",
      "founders"
    ]);
  });

  it("strongly penalizes an excluded phrase", () => {
    expect(
      rankEvent(eventFixture({ title: "Crypto trading for founders" }), profile)
        .relevanceScore
    ).toBeLessThan(0);
  });
});

describe("sortRankedEvents", () => {
  it("sorts by descending score and then ascending start time", () => {
    const events = [
      eventFixture({ id: "later", relevanceScore: 10, startsAt: "2026-08-12T19:00:00.000Z" }),
      eventFixture({ id: "lower", relevanceScore: 2 }),
      eventFixture({ id: "earlier", relevanceScore: 10, startsAt: "2026-08-12T17:00:00.000Z" })
    ];

    expect(sortRankedEvents(events).map((event) => event.id)).toEqual([
      "earlier",
      "later",
      "lower"
    ]);
  });
});
