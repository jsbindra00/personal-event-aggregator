import type {
  BrowserHost,
  ObservedSearchContract
} from "@event-agg/browser";
import {
  ConnectorFailure,
  classifyConnectorError,
  withConnectorRetry
} from "@event-agg/connector-common";
import { redactDiagnostic } from "@event-agg/core";
import type {
  ConnectorMessage,
  ConnectorStatus,
  EventConnector,
  ResolvedSearchQuery
} from "@event-agg/core";
import type { Page } from "playwright-core";

import {
  enforceReadOnlyEventbritePage,
  eventbriteSearchContract,
  readEventbriteItemList
} from "./contract.js";
import {
  EventbritePayloadError,
  parseEventbriteSearchPayload
} from "./parser.js";

export interface EventbriteBrowserHost {
  pageFor(source: "eventbrite", origin: string): Promise<Page>;
}

export interface EventbriteConnectorOptions {
  contract?: ObservedSearchContract;
  readPayload?: (
    page: Page,
    query: ResolvedSearchQuery,
    contract: ObservedSearchContract
  ) => Promise<unknown>;
  diagnostic?: (value: unknown) => void;
}

export function createEventbriteConnector(
  browserHost: EventbriteBrowserHost | BrowserHost,
  options: EventbriteConnectorOptions = {}
): EventConnector {
  return new EventbriteConnector(browserHost, options);
}

class EventbriteConnector implements EventConnector {
  readonly source = "eventbrite" as const;

  private readonly contract: ObservedSearchContract;
  private readonly readPayload: NonNullable<
    EventbriteConnectorOptions["readPayload"]
  >;
  private readonly diagnostic: (value: unknown) => void;
  private status: ConnectorStatus = {
    source: "eventbrite",
    state: "ready",
    lastSuccessAt: null,
    errorCode: null,
    safeMessage: null
  };

  constructor(
    private readonly browserHost: EventbriteBrowserHost | BrowserHost,
    options: EventbriteConnectorOptions
  ) {
    this.contract = options.contract ?? eventbriteSearchContract;
    this.readPayload = options.readPayload ?? defaultReadPayload;
    this.diagnostic = options.diagnostic ?? (() => undefined);
  }

  async getStatus(): Promise<ConnectorStatus> {
    return { ...this.status };
  }

  async *connect(): AsyncIterable<ConnectorMessage> {
    this.setStatus("ready");
    yield { type: "progress", source: "eventbrite", phase: "ready" };
    yield { type: "complete", source: "eventbrite", count: 0 };
  }

  async *search(
    query: ResolvedSearchQuery,
    signal: AbortSignal
  ): AsyncIterable<ConnectorMessage> {
    this.setStatus("searching");
    yield {
      type: "progress",
      source: "eventbrite",
      phase: "resolving_location",
      resolvedLocation: query.locationText
    };

    try {
      signal.throwIfAborted();
      const page = await this.browserHost.pageFor(
        "eventbrite",
        this.contract.connectUrl
      );
      await enforceReadOnlyEventbritePage(page);
      const payload = await withConnectorRetry(async () => {
        try {
          return await this.readPayload(page, query, this.contract);
        } catch (error) {
          throw classifyConnectorError(error);
        }
      });
      signal.throwIfAborted();
      const events = parseEventbriteSearchPayload(payload);
      let count = 0;
      for (const event of events) {
        const startsAt = Date.parse(event.startsAt);
        if (
          startsAt < Date.parse(query.startsAtUtc) ||
          startsAt >= Date.parse(query.endsBeforeUtc)
        ) {
          continue;
        }
        count += 1;
        yield { type: "event", source: "eventbrite", event };
      }
      this.setStatus("complete", { lastSuccessAt: new Date().toISOString() });
      yield { type: "complete", source: "eventbrite", count };
    } catch (error) {
      if (signal.aborted) return;
      this.diagnostic(
        redactDiagnostic({
          source: "eventbrite",
          event: "connector.error",
          error
        })
      );
      if (error instanceof ConnectorFailure) {
        if (error.code === "auth_required") {
          this.setStatus("auth_required", {
            errorCode: error.code,
            safeMessage: error.message
          });
          yield {
            type: "auth_required",
            source: "eventbrite",
            safeMessage: error.message
          };
          return;
        }
        if (error.code === "user_action_required") {
          this.setStatus("user_action_required", {
            errorCode: error.code,
            safeMessage: error.message
          });
          yield {
            type: "user_action_required",
            source: "eventbrite",
            safeMessage: error.message
          };
          return;
        }
        if (error.code === "rate_limited") {
          this.setStatus("rate_limited", {
            errorCode: error.code,
            safeMessage: error.message
          });
          yield {
            type: "rate_limited",
            source: "eventbrite",
            ...(error.retryAfterMs === null
              ? {}
              : { retryAfterMs: error.retryAfterMs }),
            safeMessage: error.message
          };
          return;
        }
        if (error.code === "network") {
          this.setStatus("failed", {
            errorCode: error.code,
            safeMessage: error.message
          });
          yield {
            type: "failed",
            source: "eventbrite",
            errorCode: error.code,
            safeMessage: error.message
          };
          return;
        }
      }
      const isContractDrift = error instanceof EventbritePayloadError;
      const errorCode = isContractDrift
        ? "contract_drift"
        : "connector_exception";
      const safeMessage = isContractDrift
        ? "Eventbrite's event response changed"
        : "Eventbrite search failed";
      this.setStatus("failed", { errorCode, safeMessage });
      yield { type: "failed", source: "eventbrite", errorCode, safeMessage };
    }
  }

  private setStatus(
    state: ConnectorStatus["state"],
    patch: Partial<Omit<ConnectorStatus, "source" | "state">> = {}
  ): void {
    this.status = {
      ...this.status,
      state,
      errorCode: null,
      safeMessage: null,
      ...patch
    };
  }
}

async function defaultReadPayload(
  page: Page,
  query: ResolvedSearchQuery,
  contract: ObservedSearchContract
): Promise<unknown> {
  await contract.performSearch(page, query);
  return readEventbriteItemList(page);
}
