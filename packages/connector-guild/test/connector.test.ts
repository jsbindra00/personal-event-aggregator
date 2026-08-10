import type { ResolvedSearchQuery } from "@event-agg/core";
import { describe, expect, it } from "vitest";

import { createGuildConnector } from "../src/connector.js";

const query: ResolvedSearchQuery = {
  locationText: "London",
  startDate: "2026-08-12",
  endDate: "2026-08-13",
  timeZone: "Europe/London",
  startsAtUtc: "2026-08-11T23:00:00.000Z",
  endsBeforeUtc: "2026-08-13T23:00:00.000Z"
};

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of iterable) values.push(value);
  return values;
}

describe("createGuildConnector", () => {
  it("reports the verified source closure without blocking other sources", async () => {
    const connector = createGuildConnector();
    expect(await connector.getStatus()).toEqual({
      source: "guild",
      state: "failed",
      lastSuccessAt: null,
      errorCode: "source_unavailable",
      safeMessage: "Guild closed on 1 October 2024"
    });

    expect(
      await collect(connector.search(query, new AbortController().signal))
    ).toEqual([
      { type: "progress", source: "guild", phase: "unavailable" },
      {
        type: "failed",
        source: "guild",
        errorCode: "source_unavailable",
        safeMessage: "Guild closed on 1 October 2024"
      }
    ]);
  });

  it("honors cancellation after its progress message", async () => {
    const controller = new AbortController();
    controller.abort();
    const messages = await collect(
      createGuildConnector().search(query, controller.signal)
    );
    expect(messages).toEqual([
      { type: "progress", source: "guild", phase: "unavailable" }
    ]);
  });
});
