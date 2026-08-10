import {
  observeJsonResponses,
  type BrowserHost,
  type ObservedSearchContract
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
  enforceReadOnlyLumaPage,
  lumaSearchContract
} from "./contract.js";
import { LumaPayloadError, parseLumaSearchPayload } from "./parser.js";

export interface LumaBrowserHost {
  pageFor(source: "luma", origin: string): Promise<Page>;
}

export interface LumaConnectorOptions {
  contract?: ObservedSearchContract;
  maxPages?: number;
  observeJson?: typeof observeJsonResponses;
  scrollForNextPage?: (page: Page) => Promise<void>;
  diagnostic?: (value: unknown) => void;
}

export function createLumaConnector(
  browserHost: LumaBrowserHost | BrowserHost,
  options: LumaConnectorOptions = {}
): EventConnector {
  return new LumaConnector(browserHost, options);
}

class LumaConnector implements EventConnector {
  readonly source = "luma" as const;

  private readonly contract: ObservedSearchContract;
  private readonly maxPages: number;
  private readonly observeJson: typeof observeJsonResponses;
  private readonly scrollForNextPage: (page: Page) => Promise<void>;
  private readonly diagnostic: (value: unknown) => void;
  private status: ConnectorStatus = {
    source: "luma",
    state: "ready",
    lastSuccessAt: null,
    errorCode: null,
    safeMessage: null
  };

  constructor(
    private readonly browserHost: LumaBrowserHost | BrowserHost,
    options: LumaConnectorOptions
  ) {
    this.contract = options.contract ?? lumaSearchContract;
    this.maxPages = Math.max(1, options.maxPages ?? 12);
    this.observeJson = options.observeJson ?? observeJsonResponses;
    this.scrollForNextPage = options.scrollForNextPage ?? defaultScroll;
    this.diagnostic = options.diagnostic ?? (() => undefined);
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
      const page = await this.browserHost.pageFor("luma", this.contract.connectUrl);
      await enforceReadOnlyLumaPage(page);
      let payloads = await this.capture(page, () =>
        this.contract.performSearch(page, query)
      );
      const seenEvents = new Set<string>();
      const seenCursors = new Set<string>();
      let count = 0;

      for (let pageNumber = 1; pageNumber <= this.maxPages; pageNumber += 1) {
        signal.throwIfAborted();
        if (payloads.length === 0) throw new LumaPayloadError();

        let hasMore = false;
        let nextCursor: string | null = null;
        let latestStart = Number.NEGATIVE_INFINITY;
        for (const payload of payloads) {
          const parsed = parseLumaSearchPayload(payload);
          hasMore ||= parsed.hasMore;
          nextCursor = parsed.nextCursor ?? nextCursor;
          for (const event of parsed.events) {
            const startsAt = Date.parse(event.startsAt);
            latestStart = Math.max(latestStart, startsAt);
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
            yield { type: "event", source: "luma", event };
          }
        }

        const cursorRepeated =
          nextCursor !== null && seenCursors.has(nextCursor);
        if (
          !hasMore ||
          nextCursor === null ||
          cursorRepeated ||
          latestStart >= Date.parse(query.endsBeforeUtc) ||
          pageNumber === this.maxPages
        ) {
          break;
        }
        seenCursors.add(nextCursor);
        payloads = await this.capture(page, () => this.scrollForNextPage(page));
      }

      this.setStatus("complete", { lastSuccessAt: new Date().toISOString() });
      yield { type: "complete", source: "luma", count };
    } catch (error) {
      if (signal.aborted) return;
      this.diagnostic(
        redactDiagnostic({ source: "luma", event: "connector.error", error })
      );
      yield this.failureMessage(error);
    }
  }

  private capture(page: Page, action: () => Promise<unknown>): Promise<unknown[]> {
    return withConnectorRetry(
      async () => {
        try {
          return await this.observeJson(
            page,
            {
              allowedHosts: this.contract.allowedHosts,
              maxBodyBytes: 2_000_000,
              responseMatches: this.contract.responseMatches
            },
            action
          );
        } catch (error) {
          throw classifyConnectorError(error);
        }
      },
      { maxAttempts: 3 }
    );
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
          source: "luma",
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
      if (error.code === "network") {
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
    }

    const isContractDrift = error instanceof LumaPayloadError;
    const errorCode = isContractDrift ? "contract_drift" : "connector_exception";
    const safeMessage = isContractDrift
      ? "Luma's event response changed"
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

async function defaultScroll(page: Page): Promise<void> {
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(1_200);
}
