import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  distanceKilometres,
  parseGuildEventsPage,
  resolveGuildLocation
} from "../src/index.js";

const pageOne = JSON.parse(
  readFileSync(
    new URL("../fixtures/upcoming-page-1.redacted.json", import.meta.url),
    "utf8"
  )
) as unknown;

describe("Guild.host public event parsing", () => {
  it("maps the documented anonymous event fields", () => {
    const page = parseGuildEventsPage(pageOne);

    expect(page.hasNextPage).toBe(true);
    expect(page.endCursor).toBe("fixture-cursor-1");
    expect(page.events).toHaveLength(3);
    expect(page.events[0]).toEqual({
      source: "guild",
      sourceEventId: "fixture-guild-event-1",
      canonicalUrl:
        "https://guild.host/events/birmingham-ai-builders-fixture01",
      title: "Birmingham AI Builders",
      startsAt: "2026-08-12T18:00:00+00:00",
      endsAt: "2026-08-12T20:00:00+00:00",
      timeZone: "Europe/London",
      descriptionText:
        "A synthetic evening for engineers building AI products.",
      organizerName: "Birmingham Builders Guild",
      venueName: null,
      addressText: null,
      latitude: 52.4862,
      longitude: -1.8904,
      isOnline: false,
      imageUrl:
        "https://guild.host/social/event/birmingham-ai-builders-fixture01/card.svg",
      priceText: null,
      tags: []
    });
    expect(page.events[2]).toMatchObject({
      organizerName: "Ada Lovelace",
      latitude: null,
      longitude: null,
      isOnline: true
    });
  });

  it("rejects event URLs outside guild.host", () => {
    const payload = structuredClone(pageOne) as {
      edges: Array<{ node: { fullUrl: string } }>;
    };
    payload.edges[0]!.node.fullUrl = "https://evil.example/events/fixture";

    expect(() => parseGuildEventsPage(payload)).toThrow(
      "Guild.host's event response changed"
    );
  });

  it("rejects malformed envelopes and invalid coordinates", () => {
    expect(() => parseGuildEventsPage({ edges: [] })).toThrow(
      "Guild.host's event response changed"
    );

    const payload = structuredClone(pageOne) as {
      edges: Array<{
        node: {
          venue: {
            address: {
              location: {
                geojson: { coordinates: [number, number] };
              };
            };
          };
        };
      }>;
    };
    payload.edges[0]!.node.venue.address.location.geojson.coordinates = [
      -1.8904,
      95
    ];
    expect(() => parseGuildEventsPage(payload)).toThrow(
      "Guild.host's event response changed"
    );
  });
});

describe("Guild.host location policy", () => {
  it("resolves supported cities inside city and address inputs", () => {
    expect(resolveGuildLocation("Birmingham")).toEqual({
      name: "Birmingham",
      latitude: 52.4862,
      longitude: -1.8904
    });
    expect(resolveGuildLocation("Digbeth, Birmingham, B5 6DY")).toEqual({
      name: "Birmingham",
      latitude: 52.4862,
      longitude: -1.8904
    });
    expect(resolveGuildLocation("Tokyo")).toBeNull();
  });

  it("computes physical distance for the radius filter", () => {
    expect(
      distanceKilometres(
        { latitude: 52.4862, longitude: -1.8904 },
        { latitude: 52.4862, longitude: -1.8904 }
      )
    ).toBe(0);
    expect(
      distanceKilometres(
        { latitude: 52.4862, longitude: -1.8904 },
        { latitude: 53.4808, longitude: -2.2426 }
      )
    ).toBeGreaterThan(80);
  });
});
