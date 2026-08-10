import { describe, expect, it } from "vitest";

import { resolveSearchQuery } from "../src/query.js";

describe("resolveSearchQuery", () => {
  it("treats both local calendar dates as inclusive", () => {
    expect(
      resolveSearchQuery({
        locationText: "London",
        startDate: "2026-08-10",
        endDate: "2026-08-11",
        timeZone: "Europe/London"
      })
    ).toMatchObject({
      locationText: "London",
      startsAtUtc: "2026-08-09T23:00:00.000Z",
      endsBeforeUtc: "2026-08-11T23:00:00.000Z"
    });
  });

  it("rejects a date interval whose end precedes its start", () => {
    expect(() =>
      resolveSearchQuery({
        locationText: "London",
        startDate: "2026-08-11",
        endDate: "2026-08-10",
        timeZone: "Europe/London"
      })
    ).toThrow(/end date/i);
  });
});
