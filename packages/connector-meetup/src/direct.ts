import { Temporal } from "@js-temporal/polyfill";
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
  RawSourceEvent,
  ResolvedSearchQuery
} from "@event-agg/core";
import { z } from "zod";

import {
  MeetupPayloadError,
  meetupPayloadRequiresAuth,
  parseMeetupSearchPayload
} from "./parser.js";

const GRAPHQL_URL = "https://www.meetup.com/gql2";
const LOCATION_OPERATION = "getLocationSearch";
const EVENT_OPERATION = "recommendedEventsWithSeries";
const LOCATION_QUERY_HASH =
  "950b939f7033b26849b13e829e04cad7fb6b6e4593e97499fceb3ff21764206d";
const EVENT_QUERY_HASH =
  "fe189ee9858cbae80c3cb4100ed216f1c60b4f2956d26e27187fb6d0aca23506";

const GRAPHQL_POLICY: DirectRequestPolicy = {
  method: "POST",
  allowedHosts: ["www.meetup.com"],
  allowedPath: (pathname) => pathname === "/gql2",
  maxBodyBytes: 2_000_000,
  timeoutMs: 20_000
};

const locationPayloadSchema = z.object({
  data: z.object({
    result: z.array(
      z.object({
        city: z.string().min(1),
        country: z.string().min(1),
        lat: z.number().min(-90).max(90),
        lon: z.number().min(-180).max(180),
        name: z.string().min(1),
        timeZone: z.string().min(1)
      }).passthrough()
    )
  })
}).passthrough();

interface MeetupLocation {
  city: string;
  country: string;
  latitude: number;
  longitude: number;
  name: string;
  timeZone: string;
}

export interface DirectMeetupOptions {
  fetch?: typeof globalThis.fetch;
  diagnostic?: (value: unknown) => void;
  maxPages?: number;
  pageSize?: number;
  strictLocation?: boolean;
  retry?: ConnectorRetryOptions;
}

export function createDirectMeetupConnector(
  options: DirectMeetupOptions = {}
): EventConnector {
  return new DirectMeetupConnector(options);
}

class DirectMeetupConnector implements EventConnector {
  readonly source = "meetup" as const;

  private readonly fetch: typeof globalThis.fetch;
  private readonly diagnostic: (value: unknown) => void;
  private readonly maxPages: number;
  private readonly pageSize: number;
  private readonly strictLocation: boolean;
  private readonly retry: ConnectorRetryOptions;
  private status: ConnectorStatus = {
    source: "meetup",
    state: "ready",
    lastSuccessAt: null,
    errorCode: null,
    safeMessage: null
  };

  constructor(options: DirectMeetupOptions) {
    this.fetch = options.fetch ?? globalThis.fetch;
    this.diagnostic = options.diagnostic ?? (() => undefined);
    this.maxPages = positiveInteger(options.maxPages ?? 12, "maxPages");
    this.pageSize = positiveInteger(options.pageSize ?? 50, "pageSize");
    this.strictLocation = options.strictLocation ?? false;
    this.retry = options.retry ?? {};
  }

  async getStatus(): Promise<ConnectorStatus> {
    return { ...this.status };
  }

  async *connect(): AsyncIterable<ConnectorMessage> {
    this.setStatus("ready");
    yield { type: "progress", source: "meetup", phase: "ready" };
    yield { type: "complete", source: "meetup", count: 0 };
  }

  async *search(
    query: ResolvedSearchQuery,
    signal: AbortSignal
  ): AsyncIterable<ConnectorMessage> {
    this.setStatus("searching");
    yield {
      type: "progress",
      source: "meetup",
      phase: "resolving_location",
      resolvedLocation: query.locationText
    };

    try {
      signal.throwIfAborted();
      const locationPayload = await this.graphql(
        locationRequest(query.locationText),
        signal
      );
      if (meetupPayloadRequiresAuth(locationPayload)) {
        throw connectorFailure("auth_required", "Sign in to Meetup");
      }
      const location = parseLocation(locationPayload, query.locationText);
      if (location === null) {
        throw connectorFailure(
          "user_action_required",
          `Meetup could not resolve ${query.locationText}`
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
        const payload = await this.graphql(
          eventRequest(query, location, cursor, this.pageSize),
          signal
        );
        if (meetupPayloadRequiresAuth(payload)) {
          throw connectorFailure("auth_required", "Sign in to Meetup");
        }
        if (hasGraphqlErrors(payload)) throw new MeetupPayloadError();
        const page = parseMeetupSearchPayload(payload);
        let allBeyondEnd = page.events.length > 0;
        for (const event of page.events) {
          const eventStart = Date.parse(event.startsAt);
          if (eventStart < endsBefore) allBeyondEnd = false;
          if (eventStart < startsAt || eventStart >= endsBefore) continue;
          if (
            this.strictLocation &&
            !matchesResolvedLocation(event, location)
          ) {
            continue;
          }
          const identity = event.sourceEventId ?? event.canonicalUrl;
          if (seenEvents.has(identity)) continue;
          seenEvents.add(identity);
          count += 1;
          yield { type: "event", source: "meetup", event };
        }

        const repeated =
          page.endCursor !== null && seenCursors.has(page.endCursor);
        if (
          !page.hasNextPage ||
          page.endCursor === null ||
          repeated ||
          allBeyondEnd ||
          pageNumber === this.maxPages
        ) {
          break;
        }
        seenCursors.add(page.endCursor);
        cursor = page.endCursor;
      }

      this.setStatus("complete", { lastSuccessAt: new Date().toISOString() });
      yield { type: "complete", source: "meetup", count };
    } catch (error) {
      if (signal.aborted) return;
      this.diagnostic(
        redactDiagnostic({
          source: "meetup",
          transport: "direct",
          event: "connector.error",
          error
        })
      );
      yield this.failureMessage(error);
    }
  }

  private graphql(body: unknown, signal: AbortSignal): Promise<unknown> {
    return withConnectorRetry(
      () =>
        requestBoundedJson(
          {
            url: GRAPHQL_URL,
            fetch: this.fetch,
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body)
          },
          GRAPHQL_POLICY,
          signal
        ),
      { ...this.retry, signal }
    );
  }

  private failureMessage(error: unknown): ConnectorMessage {
    if (error instanceof ConnectorFailure) {
      if (error.code === "auth_required") {
        this.setStatus("auth_required", {
          errorCode: error.code,
          safeMessage: error.message
        });
        return { type: "auth_required", source: "meetup", safeMessage: error.message };
      }
      if (error.code === "user_action_required") {
        this.setStatus("user_action_required", {
          errorCode: error.code,
          safeMessage: error.message
        });
        return {
          type: "user_action_required",
          source: "meetup",
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
          source: "meetup",
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
        source: "meetup",
        errorCode: error.code,
        safeMessage: error.message
      };
    }

    const contractDrift = error instanceof MeetupPayloadError;
    const errorCode = contractDrift ? "contract_drift" : "connector_exception";
    const safeMessage = contractDrift
      ? "Meetup's event response changed"
      : "Meetup search failed";
    this.setStatus("failed", { errorCode, safeMessage });
    return { type: "failed", source: "meetup", errorCode, safeMessage };
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

function locationRequest(query: string): unknown {
  return {
    operationName: LOCATION_OPERATION,
    variables: { query, dataConfiguration: "{}" },
    extensions: {
      persistedQuery: { version: 1, sha256Hash: LOCATION_QUERY_HASH }
    }
  };
}

function eventRequest(
  query: ResolvedSearchQuery,
  location: MeetupLocation,
  after: string | null,
  pageSize: number
): unknown {
  const zonedStart = Temporal.Instant.from(query.startsAtUtc)
    .toZonedDateTimeISO(location.timeZone);
  return {
    operationName: EVENT_OPERATION,
    variables: {
      first: pageSize,
      ...(after === null ? {} : { after }),
      lat: location.latitude,
      lon: location.longitude,
      startDateRange: zonedStart.toString(),
      numberOfEventsForSeries: 5,
      seriesStartDate: zonedStart.toPlainDate().toString(),
      sortField: "RELEVANCE",
      doConsolidateEvents: true,
      doPromotePaypalEvents: false,
      indexAlias: JSON.stringify(
        JSON.stringify({
          filterOutWrongLanguage: "true",
          modelVersion: "split_offline_online"
        })
      ),
      dataConfiguration: JSON.stringify({
        isSimplifiedSearchEnabled: true,
        include_events_from_user_chapters: false
      })
    },
    extensions: {
      persistedQuery: { version: 1, sha256Hash: EVENT_QUERY_HASH }
    }
  };
}

function parseLocation(
  payload: unknown,
  locationText: string
): MeetupLocation | null {
  if (hasGraphqlErrors(payload)) throw new MeetupPayloadError();
  const parsed = locationPayloadSchema.safeParse(payload);
  if (!parsed.success) throw new MeetupPayloadError({ cause: parsed.error });
  const components = locationText
    .split(",")
    .map(normalizeLocation)
    .filter((component) => component.length > 1);
  let best: { score: number; value: MeetupLocation } | null = null;
  for (const result of parsed.data.data.result) {
    const city = normalizeLocation(result.city);
    const name = normalizeLocation(result.name);
    const score = Math.max(
      ...components.map((component) => {
        if (city === component) return 100;
        if (name === component || name.startsWith(`${component} `)) return 90;
        if (name.includes(component) || component.includes(city)) return 50;
        return 0;
      }),
      1
    );
    const value = {
      city: result.city,
      country: result.country,
      latitude: result.lat,
      longitude: result.lon,
      name: result.name,
      timeZone: result.timeZone
    };
    if (best === null || score > best.score) best = { score, value };
  }
  return best?.value ?? null;
}

function hasGraphqlErrors(payload: unknown): boolean {
  return (
    typeof payload === "object" &&
    payload !== null &&
    "errors" in payload &&
    Array.isArray((payload as { errors?: unknown }).errors) &&
    (payload as { errors: unknown[] }).errors.length > 0
  );
}

function normalizeLocation(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function matchesResolvedLocation(
  event: RawSourceEvent,
  location: MeetupLocation
): boolean {
  if (event.isOnline === true) return true;
  const city = normalizeLocation(location.city);
  const eventLocation = normalizeLocation(
    [event.venueName, event.addressText].filter(Boolean).join(" ")
  );
  return ` ${eventLocation} `.includes(` ${city} `);
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}
