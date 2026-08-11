import { readFileSync } from "node:fs";

import type {
  ConnectorMessage,
  ResolvedSearchQuery
} from "@event-agg/core";
import { describe, expect, it } from "vitest";

import { createGuildConnector } from "../src/connector.js";

const pages = [
  "../fixtures/upcoming-page-1.redacted.json",
  "../fixtures/upcoming-page-2.redacted.json"
].map((path) =>
  JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"))
);

const query: ResolvedSearchQuery = {
  locationText: "Digbeth, Birmingham, B5 6DY",
  startDate: "2026-08-11",
  endDate: "2026-08-13",
  timeZone: "Europe/London",
  startsAtUtc: "2026-08-10T23:00:00.000Z",
  endsBeforeUtc: "2026-08-13T23:00:00.000Z"
};

describe("createGuildConnector", () => {
  it("paginates and streams local or online events exactly once", async () => {
    const requested: string[] = [];
    const connector = createGuildConnector({
      fetch: async (input) => {
        const url = String(input);
        requested.push(url);
        return Response.json(url.includes("after=") ? pages[1] : pages[0]);
      }
    });

    expect(await connector.getStatus()).toEqual({
      source: "guild",
      state: "ready",
      lastSuccessAt: null,
      errorCode: null,
      safeMessage: null
    });

    const messages = await collect(
      connector.search(query, new AbortController().signal)
    );

    expect(requested).toEqual([
      "https://guild.host/api/next/events/upcoming?first=5",
      "https://guild.host/api/next/events/upcoming?first=5&after=fixture-cursor-1"
    ]);
    expect(eventTitles(messages)).toEqual([
      "Birmingham AI Builders",
      "Worldwide Agent Engineering"
    ]);
    expect(messages.at(-1)).toEqual({
      type: "complete",
      source: "guild",
      count: 2
    });
    expect(await connector.getStatus()).toMatchObject({
      source: "guild",
      state: "complete",
      errorCode: null,
      safeMessage: null,
      lastSuccessAt: expect.any(String)
    });
  });

  it("requires a supported city before making a request", async () => {
    let requested = false;
    const connector = createGuildConnector({
      fetch: async () => {
        requested = true;
        return Response.json(pages[0]);
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
      source: "guild",
      safeMessage: "Guild.host needs a supported city for Tokyo"
    });
  });

  it("reports contract drift for a missing continuation cursor", async () => {
    const payload = structuredClone(pages[0]) as {
      pageInfo: { endCursor: string | null };
    };
    payload.pageInfo.endCursor = null;
    const connector = createGuildConnector({
      fetch: async () => Response.json(payload)
    });

    const messages = await collect(
      connector.search(query, new AbortController().signal)
    );

    expect(messages.at(-1)).toEqual({
      type: "failed",
      source: "guild",
      errorCode: "contract_drift",
      safeMessage: "Guild.host's event response changed"
    });
  });

  it("reports contract drift for a repeated continuation cursor", async () => {
    const connector = createGuildConnector({
      fetch: async () => Response.json(pages[0]),
      maxPages: 3
    });

    const messages = await collect(
      connector.search(query, new AbortController().signal)
    );

    expect(messages.at(-1)).toMatchObject({
      type: "failed",
      source: "guild",
      errorCode: "contract_drift"
    });
  });

  it("does not silently truncate at the configured page limit", async () => {
    const connector = createGuildConnector({
      fetch: async () => Response.json(pages[0]),
      maxPages: 1
    });

    const messages = await collect(
      connector.search(query, new AbortController().signal)
    );

    expect(messages.at(-1)).toMatchObject({
      type: "failed",
      source: "guild",
      errorCode: "contract_drift"
    });
  });

  it("maps rate limiting without retry delays in the test", async () => {
    const connector = createGuildConnector({
      retry: { maxAttempts: 1 },
      fetch: async () =>
        new Response("limited", {
          status: 429,
          headers: { "retry-after": "2" }
        })
    });

    const messages = await collect(
      connector.search(query, new AbortController().signal)
    );

    expect(messages.at(-1)).toEqual({
      type: "rate_limited",
      source: "guild",
      retryAfterMs: 2_000,
      safeMessage: "Event source rate limit reached"
    });
  });

  it("rejects invalid JSON and oversized responses", async () => {
    const invalid = createGuildConnector({
      fetch: async () => new Response("not json")
    });
    const oversized = createGuildConnector({
      maxBodyBytes: 16,
      fetch: async () => Response.json(pages[0])
    });

    expect(
      (await collect(invalid.search(query, new AbortController().signal))).at(
        -1
      )
    ).toMatchObject({ type: "failed", source: "guild", errorCode: "parsing" });
    expect(
      (
        await collect(
          oversized.search(query, new AbortController().signal)
        )
      ).at(-1)
    ).toMatchObject({ type: "failed", source: "guild", errorCode: "parsing" });
  });

  it("does not request the feed after cancellation", async () => {
    let requested = false;
    const connector = createGuildConnector({
      fetch: async () => {
        requested = true;
        return Response.json(pages[0]);
      }
    });
    const controller = new AbortController();
    controller.abort();

    const messages = await collect(connector.search(query, controller.signal));

    expect(requested).toBe(false);
    expect(messages.map(({ type }) => type)).toEqual(["progress"]);
  });
});

function eventTitles(messages: readonly ConnectorMessage[]): string[] {
  return messages.flatMap((message) =>
    message.type === "event" ? [message.event.title] : []
  );
}

async function collect(
  iterable: AsyncIterable<ConnectorMessage>
): Promise<ConnectorMessage[]> {
  const messages: ConnectorMessage[] = [];
  for await (const message of iterable) messages.push(message);
  return messages;
}
