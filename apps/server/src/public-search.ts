import {
  createSearchService,
  eventSearchQuerySchema,
  resolveSearchQuery,
  type ConnectorMessage,
  type EventConnector,
  type EventRelevanceEvaluator,
  type InterestProfile,
  type NormalizedEvent,
  type RelevanceDecision,
  type SearchService,
  type SearchStore,
  type SearchStreamMessage
} from "@event-agg/core";
import { createDirectEventbriteConnector } from "@event-agg/connector-eventbrite/direct";
import { createGuildConnector } from "@event-agg/connector-guild/direct";
import { createDirectLumaConnector } from "@event-agg/connector-luma/direct";
import { createDirectMeetupConnector } from "@event-agg/connector-meetup/direct";
import { z } from "zod";

const publicInterestSchema = z.object({
  positive: z.array(z.string().trim().min(1).max(120)).min(1).max(30),
  excluded: z.array(z.string().trim().min(1).max(120)).max(30),
  note: z.string().trim().max(500)
});

export const publicSearchRequestSchema = z
  .object({
    query: eventSearchQuerySchema,
    interests: publicInterestSchema
  })
  .superRefine((input, context) => {
    try {
      resolveSearchQuery(input.query);
    } catch (error) {
      context.addIssue({
        code: "custom",
        path: ["query"],
        message: error instanceof Error ? error.message : "Invalid search query"
      });
      return;
    }
    const inclusiveDays = calendarDays(input.query.startDate, input.query.endDate);
    if (inclusiveDays > 31) {
      context.addIssue({
        code: "custom",
        path: ["query", "endDate"],
        message: "Public searches are limited to 31 inclusive calendar days"
      });
    }
  });

export type PublicSearchRequest = z.infer<typeof publicSearchRequestSchema>;

export interface PublicSearchRuntimeOptions {
  connectors?: EventConnector[];
  createId?: () => string;
  now?: () => Date;
}

export interface PublicSearchRuntime {
  stream(input: unknown, signal: AbortSignal): AsyncIterable<SearchStreamMessage>;
}

export function createPublicSearchRuntime(
  options: PublicSearchRuntimeOptions = {}
): PublicSearchRuntime {
  return {
    stream(input, signal) {
      return runPublicSearch(input, signal, options);
    }
  };
}

export function streamPublicSearch(
  input: unknown,
  signal: AbortSignal
): AsyncIterable<SearchStreamMessage> {
  return createPublicSearchRuntime().stream(input, signal);
}

async function* runPublicSearch(
  input: unknown,
  signal: AbortSignal,
  options: PublicSearchRuntimeOptions
): AsyncIterable<SearchStreamMessage> {
  signal.throwIfAborted();
  const request = publicSearchRequestSchema.parse(input);
  const service = searchService(request.interests, options);
  const { searchId } = await service.start(request.query);
  const cancel = () => service.cancel(searchId);
  signal.addEventListener("abort", cancel, { once: true });
  try {
    for await (const message of service.subscribe(searchId)) {
      yield message;
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    if (service.snapshot(searchId)?.status === "running") service.cancel(searchId);
  }
}

function searchService(
  interests: InterestProfile,
  options: PublicSearchRuntimeOptions
): SearchService {
  return createSearchService({
    connectors: (options.connectors ?? directConnectors()).map(inPersonOnly),
    store: noOpStore,
    getInterests: () => interests,
    relevanceEvaluator: createHostedRelevanceEvaluator(),
    relevanceBatchSize: 10,
    relevanceFlushMs: 50,
    ...(options.createId === undefined ? {} : { createId: options.createId }),
    ...(options.now === undefined ? {} : { now: options.now })
  });
}

function directConnectors(): EventConnector[] {
  const retry = { maxAttempts: 1 };
  return [
    createDirectLumaConnector({ maxPages: 6, retry }),
    createDirectMeetupConnector({ maxPages: 6, retry, strictLocation: true }),
    createDirectEventbriteConnector({ timeoutMs: 12_000, retry }),
    createGuildConnector({ maxPages: 40, timeoutMs: 12_000, retry })
  ];
}

function inPersonOnly(connector: EventConnector): EventConnector {
  return {
    source: connector.source,
    getStatus: () => connector.getStatus(),
    connect: () => connector.connect(),
    async *search(query, signal) {
      let count = 0;
      for await (const message of connector.search(query, signal)) {
        if (message.type === "event") {
          if (
            message.event.isOnline === true ||
            looksLikeOnlineEvent(message.event)
          ) {
            continue;
          }
          count += 1;
          yield message;
          continue;
        }
        yield message.type === "complete"
          ? ({ ...message, count } satisfies ConnectorMessage)
          : message;
      }
    }
  };
}

function createHostedRelevanceEvaluator(): EventRelevanceEvaluator {
  return {
    fingerprint: "hosted-phrase:v1",
    async evaluate(events, profile, signal) {
      signal.throwIfAborted();
      return events.map((event) => hostedPhraseDecision(event, profile));
    },
    async status(signal) {
      signal?.throwIfAborted();
      return {
        state: "ready",
        evaluator: "hosted-phrase",
        model: null,
        evaluatedCount: 0,
        showCount: 0,
        maybeCount: 0,
        hideCount: 0,
        safeMessage: null
      };
    }
  };
}

function hostedPhraseDecision(
  event: NormalizedEvent,
  profile: InterestProfile
): RelevanceDecision {
  const title = normalizeWords(event.title);
  const searchable = normalizeWords(
    [
      event.title,
      event.descriptionText,
      event.organizerName,
      event.tags.join(" ")
    ]
      .filter(Boolean)
      .join(" ")
  );
  if (
    profile.excluded.some((interest) =>
      includesWholePhrase(searchable, normalizeWords(interest))
    )
  ) {
    return hiddenDecision(event.id, "Matches a saved exclusion");
  }

  const matchedInterests = profile.positive.filter((interest) =>
    includesWholePhrase(searchable, normalizeWords(interest))
  );
  if (matchedInterests.length === 0) {
    return hiddenDecision(event.id, "No complete saved-interest phrase matched");
  }
  const titleMatches = matchedInterests.filter((interest) =>
    includesWholePhrase(title, normalizeWords(interest))
  ).length;
  return {
    eventId: event.id,
    decision: "show",
    score: Math.min(100, 72 + titleMatches * 8 + matchedInterests.length * 2),
    confidence: 1,
    matchedInterests,
    reason: "Matched complete saved-interest phrases"
  };
}

function hiddenDecision(eventId: string, reason: string): RelevanceDecision {
  return {
    eventId,
    decision: "hide",
    score: 0,
    confidence: 1,
    matchedInterests: [],
    reason
  };
}

function looksLikeOnlineEvent(event: { title: string }): boolean {
  return /\b(?:online|virtual|webinar|livestream|live stream)\b/i.test(event.title);
}

function includesWholePhrase(haystack: string, phrase: string): boolean {
  return phrase.length > 0 && ` ${haystack} `.includes(` ${phrase} `);
}

function normalizeWords(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const noOpStore: SearchStore = {
  createSearch: () => undefined,
  setSearchStatus: () => undefined,
  upsertSource: () => undefined,
  saveEvent: () => undefined,
  removeEvent: () => undefined
};

function calendarDays(start: string, end: string): number {
  const startMs = exactUtcDate(start);
  const endMs = exactUtcDate(end);
  return Math.floor((endMs - startMs) / 86_400_000) + 1;
}

function exactUtcDate(value: string): number {
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(timestamp)) throw new Error("Invalid calendar date");
  if (new Date(timestamp).toISOString().slice(0, 10) !== value) {
    throw new Error("Invalid calendar date");
  }
  return timestamp;
}
