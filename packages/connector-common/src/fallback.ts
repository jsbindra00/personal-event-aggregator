import type {
  ConnectorMessage,
  EventConnector
} from "@event-agg/core";

export function withConnectorFallback(
  primary: EventConnector,
  fallback: EventConnector,
  shouldFallback: (message: ConnectorMessage) => boolean = (message) =>
    message.type === "failed" && message.errorCode === "contract_drift"
): EventConnector {
  if (primary.source !== fallback.source) {
    throw new TypeError("Fallback source mismatch");
  }

  let active = primary;
  return {
    source: primary.source,
    getStatus: () => active.getStatus(),
    connect: () => fallback.connect(),
    search: async function* (query, signal) {
      for await (const message of primary.search(query, signal)) {
        if (!shouldFallback(message)) {
          yield message;
          continue;
        }
        active = fallback;
        yield {
          type: "progress",
          source: primary.source,
          phase: "browser_fallback"
        };
        yield* fallback.search(query, signal);
        return;
      }
    }
  };
}
