import {
  observeJsonResponses,
  type BrowserHost,
  type ObservedSearchContract
} from "@event-agg/browser";
import { withConnectorRetry } from "@event-agg/connector-common";
import type {
  ConnectorMessage,
  ConnectorStatus,
  EventConnector,
  ResolvedSearchQuery
} from "@event-agg/core";
import type { Page } from "playwright-core";

import {
  enforceReadOnlyMeetupPage,
  meetupSearchContract
} from "./contract.js";
import {
  MeetupPayloadError,
  meetupPayloadRequiresAuth,
  parseMeetupSearchPayload
} from "./parser.js";

export interface MeetupBrowserHost {
  pageFor(source: "meetup", origin: string): Promise<Page>;
}

export interface MeetupConnectorOptions {
  contract?: ObservedSearchContract;
  maxPages?: number;
  observeJson?: typeof observeJsonResponses;
  scrollForNextPage?: (page: Page) => Promise<void>;
}

export function createMeetupConnector(
  browserHost: MeetupBrowserHost | BrowserHost,
  options: MeetupConnectorOptions = {}
): EventConnector {
  return new MeetupConnector(browserHost, options);
}

class MeetupConnector implements EventConnector {
  readonly source = "meetup" as const;

  private readonly contract: ObservedSearchContract;
  private readonly maxPages: number;
  private readonly observeJson: typeof observeJsonResponses;
  private readonly scrollForNextPage: (page: Page) => Promise<void>;
  private status: ConnectorStatus = {
    source: "meetup",
    state: "ready",
    lastSuccessAt: null,
    errorCode: null,
    safeMessage: null
  };

  constructor(
    private readonly browserHost: MeetupBrowserHost | BrowserHost,
    options: MeetupConnectorOptions
  ) {
    this.contract = options.contract ?? meetupSearchContract;
    this.maxPages = Math.max(1, options.maxPages ?? 12);
    this.observeJson = options.observeJson ?? observeJsonResponses;
    this.scrollForNextPage = options.scrollForNextPage ?? defaultScroll;
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
      const page = await this.browserHost.pageFor(
        "meetup",
        this.contract.connectUrl
      );
      await enforceReadOnlyMeetupPage(page);
      let payloads = await this.capture(page, () =>
        this.contract.performSearch(page, query)
      );
      const seenEvents = new Set<string>();
      const seenCursors = new Set<string>();
      let count = 0;

      for (let pageNumber = 1; pageNumber <= this.maxPages; pageNumber += 1) {
        signal.throwIfAborted();
        const payload = payloads.at(-1);
        if (payload === undefined) throw new MeetupPayloadError();
        if (meetupPayloadRequiresAuth(payload)) {
          this.setStatus("auth_required", {
            errorCode: "auth_required",
            safeMessage: "Sign in to Meetup"
          });
          yield {
            type: "auth_required",
            source: "meetup",
            safeMessage: "Sign in to Meetup"
          };
          return;
        }

        const parsed = parseMeetupSearchPayload(payload);
        let allBeyondEnd = parsed.events.length > 0;
        for (const event of parsed.events) {
          const startsAt = Date.parse(event.startsAt);
          if (startsAt < Date.parse(query.endsBeforeUtc)) allBeyondEnd = false;
          if (
            startsAt < Date.parse(query.startsAtUtc) ||
            startsAt >= Date.parse(query.endsBeforeUtc)
          ) {
            continue;
          }
          const identity = event.sourceEventId ?? event.canonicalUrl;
          if (seenEvents.has(identity)) continue;
          seenEvents.add(identity);
          count += 1;
          yield { type: "event", source: "meetup", event };
        }

        const cursorRepeated =
          parsed.endCursor !== null && seenCursors.has(parsed.endCursor);
        if (
          !parsed.hasNextPage ||
          parsed.endCursor === null ||
          cursorRepeated ||
          allBeyondEnd ||
          pageNumber === this.maxPages
        ) {
          break;
        }
        seenCursors.add(parsed.endCursor);
        payloads = await this.capture(page, () => this.scrollForNextPage(page));
      }

      this.setStatus("complete", { lastSuccessAt: new Date().toISOString() });
      yield { type: "complete", source: "meetup", count };
    } catch (error) {
      if (signal.aborted) return;
      if (
        error instanceof Error &&
        error.message === "meetup_login_required"
      ) {
        this.setStatus("auth_required", {
          errorCode: "auth_required",
          safeMessage: "Sign in to Meetup"
        });
        yield {
          type: "auth_required",
          source: "meetup",
          safeMessage: "Sign in to Meetup"
        };
        return;
      }
      const isContractDrift = error instanceof MeetupPayloadError;
      const errorCode = isContractDrift
        ? "contract_drift"
        : "connector_exception";
      const safeMessage = isContractDrift
        ? "Meetup's event response changed"
        : "Meetup search failed";
      this.setStatus("failed", { errorCode, safeMessage });
      yield { type: "failed", source: "meetup", errorCode, safeMessage };
    }
  }

  private capture(page: Page, action: () => Promise<unknown>): Promise<unknown[]> {
    return withConnectorRetry(
      () =>
        this.observeJson(
          page,
          {
            allowedHosts: this.contract.allowedHosts,
            maxBodyBytes: 2_000_000,
            responseMatches: this.contract.responseMatches
          },
          action
        ),
      { maxAttempts: 3 }
    );
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

async function defaultScroll(page: Page): Promise<void> {
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(1_200);
}
