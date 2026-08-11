import { readFileSync } from "node:fs";

import type { ConnectorMessage, ResolvedSearchQuery } from "@event-agg/core";
import { describe, expect, it } from "vitest";

import {
  createDirectEventbriteConnector,
  parseEventbriteSearchHtml
} from "../src/index.js";

const fixtureHtml = readFileSync(
  new URL("../fixtures/search-page.redacted.html", import.meta.url),
  "utf8"
);

const query: ResolvedSearchQuery = {
  locationText: "221B Baker Street, London",
  startDate: "2026-08-12",
  endDate: "2026-08-13",
  timeZone: "Europe/London",
  startsAtUtc: "2026-08-11T23:00:00.000Z",
  endsBeforeUtc: "2026-08-13T23:00:00.000Z"
};

const birminghamQuery: ResolvedSearchQuery = {
  locationText: "Digbeth, Birmingham, B5 6DY",
  startDate: "2026-08-11",
  endDate: "2026-08-13",
  timeZone: "Europe/London",
  startsAtUtc: "2026-08-10T23:00:00.000Z",
  endsBeforeUtc: "2026-08-13T23:00:00.000Z"
};

describe("direct Eventbrite discovery", () => {
  it("extracts the ItemList from server-rendered HTML", () => {
    expect(parseEventbriteSearchHtml(fixtureHtml)).toMatchObject({
      "@type": "ItemList",
      itemListElement: expect.any(Array)
    });
  });

  it("streams in-range events from one direct page request", async () => {
    const requested: string[] = [];
    const connector = createDirectEventbriteConnector({
      discoveryIntents: ["events"],
      fetch: async (input) => {
        requested.push(String(input));
        return new Response(fixtureHtml, {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" }
        });
      }
    });

    const messages = await collect(
      connector.search(query, new AbortController().signal)
    );

    expect(requested).toEqual([
      "https://www.eventbrite.co.uk/d/united-kingdom--london/events/"
    ]);
    expect(messages.map(({ type }) => type)).toEqual([
      "progress",
      "event",
      "event",
      "complete"
    ]);
  });

  it("requires user action for an unsupported city without making a request", async () => {
    let requested = false;
    const connector = createDirectEventbriteConnector({
      discoveryIntents: ["events"],
      fetch: async () => {
        requested = true;
        return new Response(fixtureHtml);
      }
    });

    const messages = await collect(
      connector.search(
        { ...query, locationText: "Tokyo" },
        new AbortController().signal
      )
    );

    expect(requested).toBe(false);
    expect(messages.at(-1)).toEqual({
      type: "user_action_required",
      source: "eventbrite",
      safeMessage: "Eventbrite needs a supported city for Tokyo"
    });
  });

  it("reports contract drift when the ItemList is missing", async () => {
    const connector = createDirectEventbriteConnector({
      discoveryIntents: ["events"],
      fetch: async () =>
        new Response("<html><body>No structured events</body></html>")
    });

    const messages = await collect(
      connector.search(query, new AbortController().signal)
    );

    expect(messages.at(-1)).toEqual({
      type: "failed",
      source: "eventbrite",
      errorCode: "contract_drift",
      safeMessage: "Eventbrite's event response changed"
    });
  });

  it("rejects a redirect response instead of following a new host", async () => {
    const connector = createDirectEventbriteConnector({
      discoveryIntents: ["events"],
      fetch: async () => Response.redirect("https://evil.example/events", 302)
    });

    const messages = await collect(
      connector.search(query, new AbortController().signal)
    );

    expect(messages.at(-1)).toMatchObject({
      type: "failed",
      source: "eventbrite",
      errorCode: "parsing"
    });
  });

  it("rejects an oversized discovery page", async () => {
    const connector = createDirectEventbriteConnector({
      discoveryIntents: ["events"],
      maxBodyBytes: 64,
      fetch: async () => new Response(fixtureHtml)
    });

    const messages = await collect(
      connector.search(query, new AbortController().signal)
    );

    expect(messages.at(-1)).toMatchObject({
      type: "failed",
      source: "eventbrite",
      errorCode: "parsing"
    });
  });

  it("filters events outside the requested date range", async () => {
    const connector = createDirectEventbriteConnector({
      discoveryIntents: ["events"],
      fetch: async () => new Response(fixtureHtml)
    });

    const messages = await collect(
      connector.search(
        {
          ...query,
          startDate: "2026-08-10",
          endDate: "2026-08-10",
          startsAtUtc: "2026-08-09T23:00:00.000Z",
          endsBeforeUtc: "2026-08-10T23:00:00.000Z"
        },
        new AbortController().signal
      )
    );

    expect(messages.map(({ type }) => type)).toEqual(["progress", "complete"]);
    expect(messages.at(-1)).toMatchObject({ count: 0 });
  });

  it("does not request the page after cancellation", async () => {
    let requested = false;
    const connector = createDirectEventbriteConnector({
      discoveryIntents: ["events"],
      fetch: async () => {
        requested = true;
        return new Response(fixtureHtml);
      }
    });
    const controller = new AbortController();
    controller.abort();

    const messages = await collect(connector.search(query, controller.signal));

    expect(requested).toBe(false);
    expect(messages.map(({ type }) => type)).toEqual(["progress"]);
  });

  it("recovers the two reported Birmingham events across intent pages without duplicates", async () => {
    const requested: string[] = [];
    const business = eventItem(
      "1991901069720",
      "Business Networking in Birmingham for Professionals, SMEs & Entrepreneurs"
    );
    const ai = eventItem(
      "1991901156981",
      "Network One: AI & Machine Learning Networking Birmingham Edition"
    );
    const connector = createDirectEventbriteConnector({
      discoveryIntents: ["events", "startups", "machine-learning"],
      fetch: async (input) => {
        const url = String(input);
        requested.push(url);
        const pathname = new URL(url).pathname;
        if (pathname.endsWith("/events/")) {
          return htmlResponse([business]);
        }
        if (pathname.endsWith("/startups/")) {
          return htmlResponse([business, ai]);
        }
        return htmlResponse([ai]);
      }
    });

    const messages = await collect(
      connector.search(birminghamQuery, new AbortController().signal)
    );

    expect(requested).toEqual([
      "https://www.eventbrite.co.uk/d/united-kingdom--birmingham/events/",
      "https://www.eventbrite.co.uk/d/united-kingdom--birmingham/startups/",
      "https://www.eventbrite.co.uk/d/united-kingdom--birmingham/machine-learning/"
    ]);
    expect(
      messages
        .filter((message) => message.type === "event")
        .map(({ event }) => event.sourceEventId)
    ).toEqual(["1991901069720", "1991901156981"]);
    expect(messages.at(-1)).toEqual({
      type: "complete",
      source: "eventbrite",
      count: 2
    });
  });

  it("keeps successful intent pages when another page drifts", async () => {
    const diagnostics: unknown[] = [];
    const connector = createDirectEventbriteConnector({
      discoveryIntents: ["events", "startups"],
      diagnostic: (value) => diagnostics.push(value),
      fetch: async (input) =>
        new URL(String(input)).pathname.endsWith("/events/")
          ? new Response("<html><body>No ItemList</body></html>")
          : htmlResponse([
              eventItem(
                "1991901156981",
                "Network One: AI & Machine Learning Networking Birmingham Edition"
              )
            ])
    });

    const messages = await collect(
      connector.search(birminghamQuery, new AbortController().signal)
    );

    expect(messages.map(({ type }) => type)).toEqual([
      "progress",
      "event",
      "complete"
    ]);
    expect(messages.at(-1)).toMatchObject({ count: 1 });
    expect(diagnostics).toHaveLength(1);
  });

  it("reports contract drift only after every intent page drifts", async () => {
    const requested: string[] = [];
    const connector = createDirectEventbriteConnector({
      discoveryIntents: ["events", "startups"],
      fetch: async (input) => {
        requested.push(String(input));
        return new Response("<html><body>No ItemList</body></html>");
      }
    });

    const messages = await collect(
      connector.search(birminghamQuery, new AbortController().signal)
    );

    expect(requested).toHaveLength(2);
    expect(messages.at(-1)).toEqual({
      type: "failed",
      source: "eventbrite",
      errorCode: "contract_drift",
      safeMessage: "Eventbrite's event response changed"
    });
  });
});

function eventItem(sourceEventId: string, name: string): object {
  return {
    position: 1,
    "@type": "ListItem",
    item: {
      "@type": "Event",
      name,
      startDate: "2026-08-12T19:00:00+01:00",
      endDate: "2026-08-12T22:00:00+01:00",
      description: "A synthetic Birmingham discovery result.",
      url: `https://www.eventbrite.co.uk/e/fixture-tickets-${sourceEventId}`,
      eventAttendanceMode: "https://schema.org/OfflineEventAttendanceMode",
      location: {
        name: "The Lost & Found Birmingham",
        address: {
          addressLocality: "Birmingham",
          addressRegion: "West Midlands",
          addressCountry: "GB"
        }
      }
    }
  };
}

function htmlResponse(items: object[]): Response {
  const payload = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "ItemList",
    itemListElement: items
  });
  return new Response(
    `<!doctype html><html><head><script type="application/ld+json">${payload}</script></head></html>`,
    { headers: { "content-type": "text/html; charset=utf-8" } }
  );
}

async function collect(
  iterable: AsyncIterable<ConnectorMessage>
): Promise<ConnectorMessage[]> {
  const messages: ConnectorMessage[] = [];
  for await (const message of iterable) messages.push(message);
  return messages;
}
