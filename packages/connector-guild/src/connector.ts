import type {
  ConnectorMessage,
  ConnectorStatus,
  EventConnector,
  ResolvedSearchQuery
} from "@event-agg/core";

import {
  GUILD_UNAVAILABLE_CODE,
  GUILD_UNAVAILABLE_MESSAGE
} from "./contract.js";

export function createGuildConnector(): EventConnector {
  return new UnavailableGuildConnector();
}

class UnavailableGuildConnector implements EventConnector {
  readonly source = "guild" as const;

  async getStatus(): Promise<ConnectorStatus> {
    return {
      source: "guild",
      state: "failed",
      lastSuccessAt: null,
      errorCode: GUILD_UNAVAILABLE_CODE,
      safeMessage: GUILD_UNAVAILABLE_MESSAGE
    };
  }

  async *connect(): AsyncIterable<ConnectorMessage> {
    yield this.unavailable();
  }

  async *search(
    _query: ResolvedSearchQuery,
    signal: AbortSignal
  ): AsyncIterable<ConnectorMessage> {
    yield { type: "progress", source: "guild", phase: "unavailable" };
    if (signal.aborted) return;
    yield this.unavailable();
  }

  private unavailable(): ConnectorMessage {
    return {
      type: "failed",
      source: "guild",
      errorCode: GUILD_UNAVAILABLE_CODE,
      safeMessage: GUILD_UNAVAILABLE_MESSAGE
    };
  }
}
