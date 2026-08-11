import {
  ConnectorFailure,
  connectorFailure,
  requestBoundedJson,
  withConnectorRetry,
  type ConnectorRetryOptions,
  type DirectRequestPolicy
} from "@event-agg/connector-common";
import { redactDiagnostic, type RawSourceEvent } from "@event-agg/core";
import type {
  ConnectorMessage,
  ConnectorStatus,
  EventConnector,
  ResolvedSearchQuery
} from "@event-agg/core";

import {
  GUILD_EVENTS_API_URL,
  GUILD_LOCATION_RADIUS_KM,
  distanceKilometres,
  resolveGuildLocation,
  type GuildSearchLocation
} from "./contract.js";
import { GuildPayloadError, parseGuildEventsPage } from "./parser.js";

const DEFAULT_MAX_BODY_BYTES = 2_000_000;
const DEFAULT_TIMEOUT_MS = 20_000;

export interface GuildConnectorOptions {
  fetch?: typeof globalThis.fetch;
  diagnostic?: (value: unknown) => void;
  maxPages?: number;
  radiusKm?: number;
  maxBodyBytes?: number;
  timeoutMs?: number;
  retry?: ConnectorRetryOptions;
}

export function createGuildConnector(
  options: GuildConnectorOptions = {}
): EventConnector {
  return new DirectGuildConnector(options);
}

class DirectGuildConnector implements EventConnector {
  readonly source = "guild" as const;

  private readonly fetch: typeof globalThis.fetch;
  private readonly diagnostic: (value: unknown) => void;
  private readonly maxPages: number;
  private readonly radiusKm: number;
  private readonly retry: ConnectorRetryOptions;
  private readonly policy: DirectRequestPolicy;
  private status: ConnectorStatus = {
    source: "guild",
    state: "ready",
    lastSuccessAt: null,
    errorCode: null,
    safeMessage: null
  };

  constructor(options: GuildConnectorOptions) {
    this.fetch = options.fetch ?? globalThis.fetch;
    this.diagnostic = options.diagnostic ?? (() => undefined);
    this.maxPages = positiveInteger(options.maxPages ?? 100, "maxPages");
    this.radiusKm = nonNegativeNumber(
      options.radiusKm ?? GUILD_LOCATION_RADIUS_KM,
      "radiusKm"
    );
    this.retry = options.retry ?? {};
    this.policy = {
      method: "GET",
      allowedHosts: ["guild.host"],
      allowedPath: (pathname) => pathname === "/api/next/events/upcoming",
      maxBodyBytes: options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    };
  }

  async getStatus(): Promise<ConnectorStatus> {
    return { ...this.status };
  }

  async *connect(): AsyncIterable<ConnectorMessage> {
    this.setStatus("ready");
    yield { type: "progress", source: "guild", phase: "ready" };
    yield { type: "complete", source: "guild", count: 0 };
  }

  async *search(
    query: ResolvedSearchQuery,
    signal: AbortSignal
  ): AsyncIterable<ConnectorMessage> {
    this.setStatus("searching");
    yield {
      type: "progress",
      source: "guild",
      phase: "resolving_location",
      resolvedLocation: query.locationText
    };

    try {
      signal.throwIfAborted();
      const location = resolveGuildLocation(query.locationText);
      if (location === null) {
        throw connectorFailure(
          "user_action_required",
          `Guild.host needs a supported city for ${query.locationText}`
        );
      }

      const startsAt = Date.parse(query.startsAtUtc);
      const endsBefore = Date.parse(query.endsBeforeUtc);
      const seenEvents = new Set<string>();
      const seenCursors = new Set<string>();
      let cursor: string | null = null;
      let count = 0;
      let completed = false;

      for (let pageNumber = 1; pageNumber <= this.maxPages; pageNumber += 1) {
        signal.throwIfAborted();
        const payload = await withConnectorRetry(
          () =>
            requestBoundedJson(
              { url: guildPageUrl(cursor), fetch: this.fetch },
              this.policy,
              signal
            ),
          { ...this.retry, signal }
        );
        const page = parseGuildEventsPage(payload);
        let reachedEnd = false;

        for (const event of page.events) {
          const eventStart = Date.parse(event.startsAt);
          if (eventStart >= endsBefore) {
            reachedEnd = true;
            continue;
          }
          if (eventStart < startsAt) continue;
          if (!isEligibleForLocation(event, location, this.radiusKm)) continue;
          const identity = event.sourceEventId ?? event.canonicalUrl;
          if (seenEvents.has(identity)) continue;
          seenEvents.add(identity);
          count += 1;
          yield { type: "event", source: "guild", event };
        }

        if (reachedEnd || !page.hasNextPage) {
          completed = true;
          break;
        }
        if (
          page.endCursor === null ||
          seenCursors.has(page.endCursor)
        ) {
          throw new GuildPayloadError();
        }
        seenCursors.add(page.endCursor);
        cursor = page.endCursor;
      }

      if (!completed) throw new GuildPayloadError();

      this.setStatus("complete", { lastSuccessAt: new Date().toISOString() });
      yield { type: "complete", source: "guild", count };
    } catch (error) {
      if (signal.aborted) return;
      this.diagnostic(
        redactDiagnostic({
          source: "guild",
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
        return {
          type: "auth_required",
          source: "guild",
          safeMessage: error.message
        };
      }
      if (error.code === "user_action_required") {
        this.setStatus("user_action_required", {
          errorCode: error.code,
          safeMessage: error.message
        });
        return {
          type: "user_action_required",
          source: "guild",
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
          source: "guild",
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
        source: "guild",
        errorCode: error.code,
        safeMessage: error.message
      };
    }

    const contractDrift = error instanceof GuildPayloadError;
    const errorCode = contractDrift ? "contract_drift" : "connector_exception";
    const safeMessage = contractDrift
      ? error.message
      : "Guild.host search failed";
    this.setStatus("failed", { errorCode, safeMessage });
    return { type: "failed", source: "guild", errorCode, safeMessage };
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

function guildPageUrl(cursor: string | null): string {
  const url = new URL(GUILD_EVENTS_API_URL);
  url.searchParams.set("first", "5");
  if (cursor !== null) url.searchParams.set("after", cursor);
  return url.href;
}

function isEligibleForLocation(
  event: RawSourceEvent,
  location: GuildSearchLocation,
  radiusKm: number
): boolean {
  if (event.isOnline === true) return true;
  if (event.latitude == null || event.longitude == null) return false;
  return (
    distanceKilometres(location, {
      latitude: event.latitude,
      longitude: event.longitude
    }) <= radiusKm
  );
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function nonNegativeNumber(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative finite number`);
  }
  return value;
}
