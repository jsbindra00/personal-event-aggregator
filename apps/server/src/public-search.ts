import {
  createSearchService,
  eventSearchQuerySchema,
  resolveSearchQuery,
  type EventConnector,
  type InterestProfile,
  type SearchService,
  type SearchStore,
  type SearchStreamMessage
} from "@event-agg/core";
import { createDirectEventbriteConnector } from "@event-agg/connector-eventbrite";
import { createGuildConnector } from "@event-agg/connector-guild";
import { createDirectLumaConnector } from "@event-agg/connector-luma";
import { createDirectMeetupConnector } from "@event-agg/connector-meetup";
import { createLexicalRelevanceEvaluator } from "@event-agg/relevance";
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
    connectors: options.connectors ?? directConnectors(),
    store: noOpStore,
    getInterests: () => interests,
    relevanceEvaluator: createLexicalRelevanceEvaluator(),
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
    createDirectMeetupConnector({ maxPages: 6, retry }),
    createDirectEventbriteConnector({ timeoutMs: 12_000, retry }),
    createGuildConnector({ maxPages: 40, timeoutMs: 12_000, retry })
  ];
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
