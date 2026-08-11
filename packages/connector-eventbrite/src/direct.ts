import {
  ConnectorFailure,
  connectorFailure,
  requestBoundedText,
  withConnectorRetry,
  type ConnectorRetryOptions,
  type DirectRequestPolicy
} from "@event-agg/connector-common";
import { redactDiagnostic } from "@event-agg/core";
import type {
  ConnectorMessage,
  ConnectorStatus,
  EventConnector,
  ResolvedSearchQuery
} from "@event-agg/core";

import {
  EVENTBRITE_DISCOVERY_INTENTS,
  eventbriteSearchUrls,
  type EventbriteDiscoveryIntent
} from "./contract.js";
import {
  EventbritePayloadError,
  parseEventbriteSearchHtml,
  parseEventbriteSearchPayload
} from "./parser.js";

const DEFAULT_MAX_BODY_BYTES = 2_000_000;
const DEFAULT_TIMEOUT_MS = 20_000;

export interface DirectEventbriteOptions {
  fetch?: typeof globalThis.fetch;
  diagnostic?: (value: unknown) => void;
  maxBodyBytes?: number;
  timeoutMs?: number;
  discoveryIntents?: readonly EventbriteDiscoveryIntent[];
  retry?: ConnectorRetryOptions;
}

export function createDirectEventbriteConnector(
  options: DirectEventbriteOptions = {}
): EventConnector {
  return new DirectEventbriteConnector(options);
}

class DirectEventbriteConnector implements EventConnector {
  readonly source = "eventbrite" as const;

  private readonly fetch: typeof globalThis.fetch;
  private readonly diagnostic: (value: unknown) => void;
  private readonly discoveryIntents: readonly EventbriteDiscoveryIntent[];
  private readonly retry: ConnectorRetryOptions;
  private readonly policy: DirectRequestPolicy;
  private status: ConnectorStatus = {
    source: "eventbrite",
    state: "ready",
    lastSuccessAt: null,
    errorCode: null,
    safeMessage: null
  };

  constructor(options: DirectEventbriteOptions) {
    this.fetch = options.fetch ?? globalThis.fetch;
    this.diagnostic = options.diagnostic ?? (() => undefined);
    this.discoveryIntents =
      options.discoveryIntents ?? EVENTBRITE_DISCOVERY_INTENTS;
    this.retry = options.retry ?? {};
    const allowedIntents = new Set<string>(this.discoveryIntents);
    this.policy = {
      method: "GET",
      allowedHosts: ["www.eventbrite.co.uk"],
      allowedPath: (pathname) => {
        const match = pathname.match(/^\/d\/[^/]+--[^/]+\/([^/]+)\/$/);
        return match !== null && allowedIntents.has(match[1]!);
      },
      maxBodyBytes: options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    };
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
      const urls = eventbriteSearchUrls(
        query.locationText,
        this.discoveryIntents
      );
      if (urls === null) {
        throw connectorFailure(
          "user_action_required",
          `Eventbrite needs a supported city for ${query.locationText}`
        );
      }
      const startsAt = Date.parse(query.startsAtUtc);
      const endsBefore = Date.parse(query.endsBeforeUtc);
      const seenEvents = new Set<string>();
      const failures: unknown[] = [];
      let successfulPages = 0;
      let count = 0;

      for (const url of urls) {
        signal.throwIfAborted();
        try {
          const html = await withConnectorRetry(
            () =>
              requestBoundedText(
                { url, fetch: this.fetch },
                this.policy,
                signal
              ),
            { ...this.retry, signal }
          );
          signal.throwIfAborted();
          const events = parseEventbriteSearchPayload(
            parseEventbriteSearchHtml(html)
          );
          successfulPages += 1;
          for (const event of events) {
            const eventStart = Date.parse(event.startsAt);
            if (eventStart < startsAt || eventStart >= endsBefore) continue;
            const identity = event.sourceEventId ?? event.canonicalUrl;
            if (seenEvents.has(identity)) continue;
            seenEvents.add(identity);
            count += 1;
            yield { type: "event", source: "eventbrite", event };
          }
        } catch (error) {
          if (signal.aborted) return;
          failures.push(error);
          this.diagnostic(
            redactDiagnostic({
              source: "eventbrite",
              transport: "direct",
              event: "page.error",
              error
            })
          );
        }
      }

      if (successfulPages === 0) {
        throw representativeFailure(failures);
      }
      this.setStatus("complete", { lastSuccessAt: new Date().toISOString() });
      yield { type: "complete", source: "eventbrite", count };
    } catch (error) {
      if (signal.aborted) return;
      this.diagnostic(
        redactDiagnostic({
          source: "eventbrite",
          transport: "direct",
          event: "connector.error",
          error
        })
      );
      yield* this.failureMessages(error);
    }
  }

  private async *failureMessages(
    error: unknown
  ): AsyncIterable<ConnectorMessage> {
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

    const contractDrift = error instanceof EventbritePayloadError;
    const errorCode = contractDrift ? "contract_drift" : "connector_exception";
    const safeMessage = contractDrift
      ? "Eventbrite's event response changed"
      : "Eventbrite search failed";
    this.setStatus("failed", { errorCode, safeMessage });
    yield { type: "failed", source: "eventbrite", errorCode, safeMessage };
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

function representativeFailure(failures: readonly unknown[]): unknown {
  return (
    failures.find((error) => error instanceof ConnectorFailure) ??
    failures[0] ??
    new EventbritePayloadError()
  );
}
