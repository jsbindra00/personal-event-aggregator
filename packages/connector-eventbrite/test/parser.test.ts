import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  EventbritePayloadError,
  parseEventbriteSearchPayload
} from "../src/parser.js";

function loadFixture(): unknown {
  return JSON.parse(
    readFileSync(
      new URL("../fixtures/search-page-1.redacted.json", import.meta.url),
      "utf8"
    )
  ) as unknown;
}

describe("parseEventbriteSearchPayload", () => {
  it("maps the observed ItemList", () => {
    const events = parseEventbriteSearchPayload(loadFixture());

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      source: "eventbrite",
      sourceEventId: "100000000001",
      canonicalUrl:
        "https://www.eventbrite.co.uk/e/ai-product-builders-london-tickets-100000000001",
      startsAt: "2026-08-12T18:00:00+01:00",
      venueName: "Fixture Hall",
      isOnline: false
    });
    expect(events[1]).toMatchObject({
      sourceEventId: "100000000002",
      isOnline: true,
      addressText: null
    });
  });

  it("canonicalizes duplicate tracking URLs into one event", () => {
    const fixture = loadFixture() as {
      itemListElement: Array<{ item: { url: string } }>;
    };
    fixture.itemListElement = [
      fixture.itemListElement[0]!,
      structuredClone(fixture.itemListElement[0]!)
    ];
    fixture.itemListElement[1]!.item.url += "&utm_campaign=duplicate";

    expect(parseEventbriteSearchPayload(fixture)).toHaveLength(1);
  });

  it("accepts an empty ItemList", () => {
    expect(
      parseEventbriteSearchPayload({
        "@context": "https://schema.org",
        "@type": "ItemList",
        itemListElement: []
      })
    ).toEqual([]);
  });

  it("classifies an unexpected envelope as contract drift", () => {
    expect(() => parseEventbriteSearchPayload({ events: [] })).toThrowError(
      EventbritePayloadError
    );
  });

  it("rejects lookalike Eventbrite domains", () => {
    const fixture = loadFixture() as {
      itemListElement: Array<{ item: { url: string } }>;
    };
    fixture.itemListElement[0]!.item.url =
      "https://eventbrite.evil.com/e/fake-tickets-123";

    expect(() => parseEventbriteSearchPayload(fixture)).toThrowError(
      EventbritePayloadError
    );
  });
});
