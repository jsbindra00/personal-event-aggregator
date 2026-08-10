import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  MeetupPayloadError,
  parseMeetupSearchPayload
} from "../src/parser.js";

function loadFixture(): unknown {
  return JSON.parse(
    readFileSync(
      new URL("../fixtures/search-page-1.redacted.json", import.meta.url),
      "utf8"
    )
  ) as unknown;
}

describe("parseMeetupSearchPayload", () => {
  it("maps the observed event edge and cursor paths", () => {
    const page = parseMeetupSearchPayload(loadFixture());

    expect(page.events).toHaveLength(2);
    expect(page.events[0]).toMatchObject({
      source: "meetup",
      sourceEventId: "evt_fixture_1",
      title: "London AI Builders",
      canonicalUrl:
        "https://www.meetup.com/london-builders/events/evt_fixture_1/",
      organizerName: "London Builders",
      venueName: "Fixture Hall",
      isOnline: false
    });
    expect(page.events[1]).toMatchObject({
      sourceEventId: "evt_fixture_2",
      isOnline: true,
      imageUrl: "https://secure.meetupstatic.com/photos/event/fixture-2.jpeg",
      priceText: "GBP 27.00"
    });
    expect(page.hasNextPage).toBe(true);
    expect(page.endCursor).toBe("cursor_fixture_page_2");
  });

  it("classifies a missing exact container as contract drift", () => {
    expect(() => parseMeetupSearchPayload({ data: { events: [] } })).toThrowError(
      MeetupPayloadError
    );
  });
});
