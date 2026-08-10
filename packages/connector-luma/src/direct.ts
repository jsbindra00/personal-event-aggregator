import {
  ConnectorFailure,
  connectorFailure,
  requestBoundedJson,
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
  LumaLocationError,
  resolveLumaPlace
} from "./location.js";
import { LumaPayloadError, parseLumaSearchPayload } from "./parser.js";

const API_URL = "https://api.luma.com/discover/get-paginated-events";

const API_POLICY: DirectRequestPolicy = {
  method: "GET",
  allowedHosts: ["api.luma.com"],
  allowedPath: (pathname) => pathname === "/discover/get-paginated-events",
  maxBodyBytes: 2_000_000,
  timeoutMs: 20_000
};

export interface DirectLumaOptions {
  fetch?: typeof globalThis.fetch;
  diagnostic?: (value: unknown) => void;
  maxPages?: number;
  pageSize?: number;
  retry?: ConnectorRetryOptions;
}

export function createDirectLumaConnector(
  options: DirectLumaOptions = {}
): EventConnector {
  return new DirectLumaConnector(options);
}

class DirectLumaConnector implements EventConnector {
  readonly source = "luma" as const;

  private readonly fetch: typeof globalThis.fetch;
  private readonly diagnostic: (value: unknown) => void;
  private readonly maxPages: number;
  private readonly pageSize: number;
  private readonly retry: ConnectorRetryOptions;
  private status: ConnectorStatus = {
    source: "luma",
    state: "ready",
    lastSuccessAt: null,
    errorCode: null,
    safeMessage: null
  };

  constructor(options: DirectLumaOptions) {
    this.fetch = options.fetch ?? globalThis.fetch;
    this.diagnostic = options.diagnostic ?? (() => undefined);
    this.maxPages = positiveInteger(options.maxPages ?? 12, "maxPages");
    this.pageSize = positiveInteger(options.pageSize ?? 50, "pageSize");
    this.retry = options.retry ?? {};
  }

  async getStatus(): Promise<ConnectorStatus> {
    return { ...this.status };
  }

  async *connect(): AsyncIterable<ConnectorMessage> {
    this.setStatus("ready");
    yield { type: "progress", source: "luma", phase: "ready" };
    yield { type: "complete", source: "luma", count: 0 };
  }

  async *search(
    query: ResolvedSearchQuery,
    signal: AbortSignal
  ): AsyncIterable<ConnectorMessage> {
    this.setStatus("searching");
    yield {
      type: "progress",
      source: "luma",
      phase: "resolving_location",
      resolvedLocation: query.locationText
    };

    try {
      signal.throwIfAborted();
      const place = await withConnectorRetry(
        () => resolveLumaPlace(query.locationText, this.fetch, signal),
        { ...this.retry, signal }
      );
      if (place === null) {
        throw connectorFailure(
          "user_action_required",
          `Luma does not expose a discovery page for ${query.locationText}`
        );
      }

      const seenEvents = new Set<string>();
      const seenCursors = new Set<string>();
      const startsAt = Date.parse(query.startsAtUtc);
      const endsBefore = Date.parse(query.endsBeforeUtc);
      let cursor: string | null = null;
      let count = 0;

      for (let pageNumber = 1; pageNumber <= this.maxPages; pageNumber += 1) {
        signal.throwIfAborted();
        const payload = await withConnectorRetry(
          () =>
            requestBoundedJson(
              {
                url: pageUrl(place.placeId, this.pageSize, cursor),
                fetch: this.fetch
              },
              API_POLICY,
              signal
            ),
          { ...this.retry, signal }
        );
        const page = parseLumaSearchPayload(payload);
        let latestStart = Number.NEGATIVE_INFINITY;
        for (const event of page.events) {
          const eventStart = Date.parse(event.startsAt);
          latestStart = Math.max(latestStart, eventStart);
          if (eventStart < startsAt || eventStart >= endsBefore) continue;
          const identity = event.sourceEventId ?? event.canonicalUrl;
          if (seenEvents.has(identity)) continue;
          seenEvents.add(identity);
          count += 1;
          yield { type: "event", source: "luma", event };
        }

        const repeated =
          page.nextCursor !== null && seenCursors.has(page.nextCursor);
        if (
          !page.hasMore ||
          page.nextCursor === null ||
          repeated ||
          latestStart >= endsBefore ||
          pageNumber === this.maxPages
        ) {
          break;
        }
        seenCursors.add(page.nextCursor);
        cursor = page.nextCursor;
      }

      this.setStatus("complete", { lastSuccessAt: new Date().toISOString() });
      yield { type: "complete", source: "luma", count };
    } catch (error) {
      if (signal.aborted) return;
      this.diagnostic(
        redactDiagnostic({
          source: "luma",
          transport: "direct",
          event: "connector.error",
          error
        })
      );
      yield this.failureMessage(error);
    }
  }

  private failureMessage(error: unknown): ConnectorMessage {
    if (error instanceof ConnectorFailure) {
      if (error.code === "auth_required") {
        this.setStatus("auth_required", {
          errorCode: error.code,
          safeMessage: error.message
        });
        return { type: "auth_required", source: "luma", safeMessage: error.message };
      }
      if (error.code === "user_action_required") {
        this.setStatus("user_action_required", {
          errorCode: error.code,
          safeMessage: error.message
        });
        return {
          type: "user_action_required",
          source: "luma",
          safeMessage: error.message
        };
      }
      if (error.code === "rate_limited") {
        this.setStatus("rate_limited", {
          errorCode: error.code,
          safeMessage: error.message
        });
        return {
          type: "rate_limited",
          source: "luma",
          ...(error.retryAfterMs === null
            ? {}
            : { retryAfterMs: error.retryAfterMs }),
          safeMessage: error.message
        };
      }
      this.setStatus("failed", {
        errorCode: error.code,
        safeMessage: error.message
      });
      return {
        type: "failed",
        source: "luma",
        errorCode: error.code,
        safeMessage: error.message
      };
    }

    const contractDrift =
      error instanceof LumaPayloadError || error instanceof LumaLocationError;
    const errorCode = contractDrift ? "contract_drift" : "connector_exception";
    const safeMessage = contractDrift
      ? error.message
      : "Luma search failed";
    this.setStatus("failed", { errorCode, safeMessage });
    return { type: "failed", source: "luma", errorCode, safeMessage };
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

function pageUrl(
  placeId: string,
  pageSize: number,
  cursor: string | null
): string {
  const url = new URL(API_URL);
  url.searchParams.set("discover_place_api_id", placeId);
  url.searchParams.set("pagination_limit", String(pageSize));
  if (cursor !== null) url.searchParams.set("pagination_cursor", cursor);
  return url.href;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}
