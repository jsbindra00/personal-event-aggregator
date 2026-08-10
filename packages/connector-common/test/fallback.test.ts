import { describe, expect, it } from "vitest";

import type {
  ConnectorMessage,
  ConnectorStatus,
  EventConnector,
  ResolvedSearchQuery
} from "@event-agg/core";

import { withConnectorFallback } from "../src/index.js";

const query: ResolvedSearchQuery = {
  locationText: "London",
  startDate: "2026-08-10",
  endDate: "2026-08-11",
  timeZone: "Europe/London",
  startsAtUtc: "2026-08-09T23:00:00.000Z",
  endsBeforeUtc: "2026-08-11T23:00:00.000Z"
};

const signal = new AbortController().signal;

describe("connector fallback", () => {
  it("switches from contract drift to the browser stream without exposing the failure", async () => {
    const primary = connectorFrom(
      [
        { type: "progress", source: "luma", phase: "direct" },
        {
          type: "failed",
          source: "luma",
          errorCode: "contract_drift",
          safeMessage: "changed"
        }
      ],
      "ready"
    );
    const fallback = connectorFrom(
      [
        { type: "progress", source: "luma", phase: "browser" },
        { type: "complete", source: "luma", count: 0 }
      ],
      "user_action_required"
    );
    const connector = withConnectorFallback(primary, fallback);

    expect((await connector.getStatus()).state).toBe("ready");
    await expect(collect(connector.search(query, signal))).resolves.toEqual([
      { type: "progress", source: "luma", phase: "direct" },
      { type: "progress", source: "luma", phase: "browser_fallback" },
      { type: "progress", source: "luma", phase: "browser" },
      { type: "complete", source: "luma", count: 0 }
    ]);
    expect((await connector.getStatus()).state).toBe("user_action_required");
  });

  it.each(["rate_limited", "user_action_required"] as const)(
    "does not fall back for %s",
    async (messageType) => {
      let fallbackSearches = 0;
      const primaryMessage: ConnectorMessage =
        messageType === "rate_limited"
          ? {
              type: "rate_limited",
              source: "luma",
              retryAfterMs: 1_000,
              safeMessage: "slow"
            }
          : {
              type: "user_action_required",
              source: "luma",
              safeMessage: "act"
            };
      const primary = connectorFrom([primaryMessage], "rate_limited");
      const fallback = connectorFrom([], "ready", () => {
        fallbackSearches += 1;
      });

      await expect(
        collect(withConnectorFallback(primary, fallback).search(query, signal))
      ).resolves.toEqual([primaryMessage]);
      expect(fallbackSearches).toBe(0);
    }
  );
});

function connectorFrom(
  messages: readonly ConnectorMessage[],
  state: ConnectorStatus["state"],
  onSearch: () => void = () => undefined
): EventConnector {
  return {
    source: "luma",
    async getStatus() {
      return {
        source: "luma",
        state,
        lastSuccessAt: null,
        errorCode: null,
        safeMessage: null
      };
    },
    async *connect() {
      yield { type: "complete", source: "luma", count: 0 };
    },
    async *search() {
      onSearch();
      yield* messages;
    }
  };
}

async function collect(
  iterable: AsyncIterable<ConnectorMessage>
): Promise<ConnectorMessage[]> {
  const messages: ConnectorMessage[] = [];
  for await (const message of iterable) messages.push(message);
  return messages;
}
