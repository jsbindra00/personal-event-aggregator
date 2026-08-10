import { readFileSync } from "node:fs";

import type { ConnectorMessage, ResolvedSearchQuery } from "@event-agg/core";
import { describe, expect, it } from "vitest";

import { createDirectLumaConnector } from "../src/index.js";

const discoverHtml = readFileSync(
  new URL("../fixtures/discover-page.redacted.html", import.meta.url),
  "utf8"
);
const cityHtml = readFileSync(
  new URL("../fixtures/city-page.redacted.html", import.meta.url),
  "utf8"
);
const pageOne = JSON.parse(
  readFileSync(
    new URL("../fixtures/search-page-1.redacted.json", import.meta.url),
    "utf8"
  )
) as LumaPage;

const query: ResolvedSearchQuery = {
  locationText: "10 Downing Street, London",
  startDate: "2026-08-12",
  endDate: "2026-08-13",
  timeZone: "Europe/London",
  startsAtUtc: "2026-08-11T23:00:00.000Z",
  endsBeforeUtc: "2026-08-13T23:00:00.000Z"
};

describe("direct Luma discovery", () => {
  it("follows the private JSON cursor and streams unique in-range events", async () => {
    const requested: string[] = [];
    const connector = createDirectLumaConnector({
      fetch: routeFetch(requested, [
        pageOne,
        {
          entries: [structuredClone(pageOne.entries[0]!)],
          has_more: false,
          next_cursor: null
        }
      ]),
      pageSize: 50,
      maxPages: 8
    });

    const messages = await collect(
      connector.search(query, new AbortController().signal)
    );

    expect(requested).toEqual([
      "https://luma.com/discover",
      "https://luma.com/london?k=p",
      "https://api.luma.com/discover/get-paginated-events?discover_place_api_id=discplace-fixture-london&pagination_limit=50",
      "https://api.luma.com/discover/get-paginated-events?discover_place_api_id=discplace-fixture-london&pagination_limit=50&pagination_cursor=cursor_fixture_page_2"
    ]);
    expect(messages.map(({ type }) => type)).toEqual([
      "progress",
      "event",
      "event",
      "complete"
    ]);
    expect(messages.at(-1)).toMatchObject({ count: 2 });
  });

  it("stops when a cursor repeats", async () => {
    const requested: string[] = [];
    const repeated = {
      entries: [],
      has_more: true,
      next_cursor: "cursor_fixture_page_2"
    };
    const connector = createDirectLumaConnector({
      fetch: routeFetch(requested, [pageOne, repeated]),
      maxPages: 8
    });

    await collect(connector.search(query, new AbortController().signal));

    expect(requested.filter((url) => url.includes("api.luma.com"))).toHaveLength(2);
  });

  it("honors the configured maximum page count", async () => {
    const requested: string[] = [];
    const connector = createDirectLumaConnector({
      fetch: routeFetch(requested, [pageOne]),
      maxPages: 1
    });

    await collect(connector.search(query, new AbortController().signal));

    expect(requested.filter((url) => url.includes("api.luma.com"))).toHaveLength(1);
  });

  it("stops paging once a page has moved beyond the requested range", async () => {
    const requested: string[] = [];
    const futurePage = structuredClone(pageOne) as LumaPage & {
      entries: Array<{ event: { start_at: string; end_at: string } }>;
    };
    for (const entry of futurePage.entries) {
      entry.event.start_at = "2026-08-20T18:00:00.000Z";
      entry.event.end_at = "2026-08-20T20:00:00.000Z";
    }
    const connector = createDirectLumaConnector({
      fetch: routeFetch(requested, [futurePage, pageOne]),
      maxPages: 8
    });

    const messages = await collect(
      connector.search(query, new AbortController().signal)
    );

    expect(requested.filter((url) => url.includes("api.luma.com"))).toHaveLength(1);
    expect(messages.at(-1)).toMatchObject({ count: 0 });
  });

  it("reports rate limiting without exposing a response body", async () => {
    const connector = createDirectLumaConnector({
      fetch: routeFetch([], [], 429),
      retry: { maxAttempts: 1 }
    });

    const messages = await collect(
      connector.search(query, new AbortController().signal)
    );

    expect(messages.at(-1)).toMatchObject({
      type: "rate_limited",
      source: "luma",
      safeMessage: "Event source rate limit reached"
    });
  });

  it("reports contract drift for an unexpected API envelope", async () => {
    const connector = createDirectLumaConnector({
      fetch: routeFetch([], [{ events: [] } as unknown as LumaPage])
    });

    const messages = await collect(
      connector.search(query, new AbortController().signal)
    );

    expect(messages.at(-1)).toEqual({
      type: "failed",
      source: "luma",
      errorCode: "contract_drift",
      safeMessage: "Luma's event response changed"
    });
  });

  it("does not request a page after cancellation", async () => {
    let requested = false;
    const connector = createDirectLumaConnector({
      fetch: async () => {
        requested = true;
        return new Response(discoverHtml);
      }
    });
    const controller = new AbortController();
    controller.abort();

    const messages = await collect(connector.search(query, controller.signal));

    expect(requested).toBe(false);
    expect(messages.map(({ type }) => type)).toEqual(["progress"]);
  });
});

interface LumaPage {
  entries: unknown[];
  has_more: boolean;
  next_cursor: string | null;
}

function routeFetch(
  requested: string[],
  pages: LumaPage[],
  apiStatus = 200
): typeof globalThis.fetch {
  let pageIndex = 0;
  return async (input) => {
    const url = String(input);
    requested.push(url);
    if (url === "https://luma.com/discover") return new Response(discoverHtml);
    if (url === "https://luma.com/london?k=p") return new Response(cityHtml);
    return new Response(JSON.stringify(pages[pageIndex++] ?? {}), {
      status: apiStatus,
      ...(apiStatus === 429 ? { headers: { "retry-after": "1" } } : {})
    });
  };
}

async function collect(
  iterable: AsyncIterable<ConnectorMessage>
): Promise<ConnectorMessage[]> {
  const messages: ConnectorMessage[] = [];
  for await (const message of iterable) messages.push(message);
  return messages;
}
