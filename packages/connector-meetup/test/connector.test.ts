import { readFileSync } from "node:fs";

import type { ResolvedSearchQuery } from "@event-agg/core";
import type { Page } from "playwright-core";
import { describe, expect, it, vi } from "vitest";

import { createMeetupConnector } from "../src/connector.js";

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
) as {
  data: { result: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; edges: unknown[] } };
};

const fakePage = { route: async () => undefined } as unknown as Page;

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of iterable) values.push(value);
  return values;
}

describe("createMeetupConnector", () => {
  it("streams events and follows one observed cursor page", async () => {
    const scroll = vi.fn(async () => undefined);
    const finalPage = structuredClone(fixture);
    finalPage.data.result.pageInfo = { hasNextPage: false, endCursor: null };
    finalPage.data.result.edges = [];
    let observation = 0;
    const observeJson = vi.fn(async (_page, _policy, action) => {
      observation += 1;
      if (observation === 1) return [fixture];
      await action();
      return [finalPage];
    });
    const connector = createMeetupConnector(
      { pageFor: async () => fakePage },
      { observeJson, scrollForNextPage: scroll, maxPages: 2 }
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
    expect(scroll).toHaveBeenCalledTimes(1);
  });

  it("detects the observed GraphQL login error shape", async () => {
    const connector = createMeetupConnector(
      { pageFor: async () => fakePage },
      {
        observeJson: async () => [
          {
            errors: [
              {
                message: "Login required",
                extensions: { code: "UNAUTHENTICATED" }
              }
            ]
          }
        ]
      }
    );
    const messages = await collect(
      connector.search(query, new AbortController().signal)
    );
    expect(messages.at(-1)).toEqual({
      type: "auth_required",
      source: "meetup",
      safeMessage: "Sign in to Meetup"
    });
  });

  it("stops before opening the browser when already aborted", async () => {
    const pageFor = vi.fn(async () => fakePage);
    const controller = new AbortController();
    controller.abort();
    const connector = createMeetupConnector({ pageFor });

    const messages = await collect(connector.search(query, controller.signal));
    expect(messages.map((message) => message.type)).toEqual(["progress"]);
    expect(pageFor).not.toHaveBeenCalled();
  });

  it("classifies an invalid envelope as contract drift", async () => {
    const connector = createMeetupConnector(
      { pageFor: async () => fakePage },
      { observeJson: async () => [{ data: { unrelated: [] } }] }
    );
    const messages = await collect(
      connector.search(query, new AbortController().signal)
    );
    expect(messages.at(-1)).toEqual({
      type: "failed",
      source: "meetup",
      errorCode: "contract_drift",
      safeMessage: "Meetup's event response changed"
    });
  });
});
