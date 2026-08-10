import { readFileSync } from "node:fs";

import type { ResolvedSearchQuery } from "@event-agg/core";
import type { Page } from "playwright-core";
import { describe, expect, it, vi } from "vitest";

import { createEventbriteConnector } from "../src/connector.js";

const query: ResolvedSearchQuery = {
  locationText: "221B Baker Street, London",
  startDate: "2026-08-12",
  endDate: "2026-08-13",
  timeZone: "Europe/London",
  startsAtUtc: "2026-08-11T23:00:00.000Z",
  endsBeforeUtc: "2026-08-13T23:00:00.000Z"
};

const fixture = JSON.parse(
  readFileSync(
    new URL("../fixtures/search-page-1.redacted.json", import.meta.url),
    "utf8"
  )
) as unknown;

const fakePage = { route: async () => undefined } as unknown as Page;

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of iterable) values.push(value);
  return values;
}

describe("createEventbriteConnector", () => {
  it("streams in-range structured events and completes", async () => {
    const connector = createEventbriteConnector(
      { pageFor: async () => fakePage },
      { readPayload: async () => fixture }
    );
    const messages = await collect(
      connector.search(query, new AbortController().signal)
    );
    expect(messages.map((message) => message.type)).toEqual([
      "progress",
      "event",
      "event",
      "complete"
    ]);
  });

  it("completes normally for an empty ItemList", async () => {
    const connector = createEventbriteConnector(
      { pageFor: async () => fakePage },
      {
        readPayload: async () => ({
          "@context": "https://schema.org",
          "@type": "ItemList",
          itemListElement: []
        })
      }
    );
    const messages = await collect(
      connector.search(query, new AbortController().signal)
    );
    expect(messages.at(-1)).toEqual({
      type: "complete",
      source: "eventbrite",
      count: 0
    });
  });

  it("emits contract drift for an unexpected envelope", async () => {
    const connector = createEventbriteConnector(
      { pageFor: async () => fakePage },
      { readPayload: async () => ({ events: [] }) }
    );
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

  it("does not open a page after cancellation", async () => {
    const pageFor = vi.fn(async () => fakePage);
    const controller = new AbortController();
    controller.abort();
    const connector = createEventbriteConnector({ pageFor });
    const messages = await collect(connector.search(query, controller.signal));
    expect(messages.map((message) => message.type)).toEqual(["progress"]);
    expect(pageFor).not.toHaveBeenCalled();
  });
});
