import { readFileSync } from "node:fs";

import { connectorFailure } from "@event-agg/connector-common";
import type { ResolvedSearchQuery } from "@event-agg/core";
import type { Page } from "playwright-core";
import { describe, expect, it } from "vitest";

import { createLumaConnector } from "../src/connector.js";

const query: ResolvedSearchQuery = {
  locationText: "London",
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

const fakePage = {
  route: async () => undefined
} as unknown as Page;

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of iterable) values.push(value);
  return values;
}

describe("createLumaConnector", () => {
  it("streams progress, in-range events, and completion in order", async () => {
    const connector = createLumaConnector(
      { pageFor: async () => fakePage },
      {
        maxPages: 1,
        observeJson: async () => [fixture]
      }
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
    expect(messages.at(-1)).toMatchObject({ type: "complete", count: 2 });
  });

  it("maps an authentication failure to auth_required", async () => {
    const connector = createLumaConnector(
      { pageFor: async () => fakePage },
      {
        observeJson: async () => {
          throw connectorFailure("auth_required", "Sign in to Luma");
        }
      }
    );

    const messages = await collect(
      connector.search(query, new AbortController().signal)
    );
    expect(messages).toEqual([
      {
        type: "progress",
        source: "luma",
        phase: "resolving_location",
        resolvedLocation: "London"
      },
      {
        type: "auth_required",
        source: "luma",
        safeMessage: "Sign in to Luma"
      }
    ]);
  });

  it("maps an invalid envelope to failed(contract_drift)", async () => {
    const connector = createLumaConnector(
      { pageFor: async () => fakePage },
      { observeJson: async () => [{ events: [] }] }
    );

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

  it("preserves streamed events but reports failed pagination", async () => {
    let observation = 0;
    const connector = createLumaConnector(
      { pageFor: async () => fakePage },
      {
        maxPages: 2,
        observeJson: async () => {
          observation += 1;
          return observation === 1 ? [fixture] : [];
        },
        scrollForNextPage: async () => undefined
      }
    );

    const messages = await collect(
      connector.search(query, new AbortController().signal)
    );
    expect(messages.map(({ type }) => type)).toEqual([
      "progress",
      "event",
      "event",
      "failed"
    ]);
    expect(messages.at(-1)).toMatchObject({ errorCode: "contract_drift" });
  });
});
