import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import {
  eventSearchQuerySchema,
  interestProfileSchema,
  relevanceStatusSchema,
  type ConnectorStatus,
  type InterestProfile,
  type NormalizedEvent,
  type SearchService,
  type SearchSnapshot
} from "@event-agg/core";

interface InterestService {
  get(): InterestProfile;
  replace(profile: InterestProfile): void;
}

interface ConnectorStatusService {
  getStatuses(): Promise<ConnectorStatus[]>;
}

export interface EventMcpDependencies {
  searchService: SearchService;
  interests: InterestService;
  connectors: ConnectorStatusService;
}

const connectorStateSchema = z.enum([
  "disconnected",
  "ready",
  "searching",
  "auth_required",
  "user_action_required",
  "rate_limited",
  "failed",
  "cancelled",
  "complete"
]);

const sourceSchema = z.enum(["meetup", "luma", "guild", "eventbrite"]);
const nullableString = z.string().nullable();
const connectorStatusSchema = z.object({
  source: sourceSchema,
  state: connectorStateSchema,
  lastSuccessAt: nullableString,
  errorCode: nullableString,
  safeMessage: nullableString
});
const eventLinkSchema = z.object({
  id: z.string(),
  title: z.string(),
  url: z.string(),
  source: sourceSchema,
  startsAt: z.string(),
  endsAt: nullableString,
  venueName: nullableString,
  addressText: nullableString,
  isOnline: z.boolean(),
  priceText: nullableString,
  relevanceDecision: z.enum(["show", "maybe", "hide"]),
  relevanceScore: z.number(),
  relevanceConfidence: z.number(),
  relevanceReason: z.string(),
  matchedInterests: z.array(z.string())
});
const searchOutputSchema = z.object({
  searchId: z.string(),
  status: z.enum(["running", "complete", "cancelled"]),
  events: z.array(eventLinkSchema),
  maybeCount: z.number().int().nonnegative(),
  maybeEvents: z.array(eventLinkSchema).optional(),
  relevance: relevanceStatusSchema,
  sources: z.array(connectorStatusSchema)
});
const sourcesOutputSchema = z.object({ sources: z.array(connectorStatusSchema) });
const startedOutputSchema = z.object({
  searchId: z.string(),
  status: z.literal("running")
});
const includeMaybeSchema = { includeMaybe: z.boolean().optional().default(false) };
const searchInputSchema = eventSearchQuerySchema.extend(includeMaybeSchema);
const searchIdSchema = z.object({
  searchId: z.string().trim().min(1),
  ...includeMaybeSchema
});

type HandlerExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

function textResult(structuredContent: Record<string, unknown>, text?: string) {
  return {
    content: [
      {
        type: "text" as const,
        text: text ?? JSON.stringify(structuredContent)
      }
    ],
    structuredContent
  };
}

function uniqueProfile(profile: InterestProfile): InterestProfile {
  return {
    positive: [...new Set(profile.positive)],
    excluded: [...new Set(profile.excluded)],
    note: profile.note
  };
}

function eventLink(event: NormalizedEvent) {
  return {
    id: event.id,
    title: event.title,
    url: event.canonicalUrl,
    source: event.source,
    startsAt: event.startsAt,
    endsAt: event.endsAt,
    venueName: event.venueName,
    addressText: event.addressText,
    isOnline: event.isOnline,
    priceText: event.priceText,
    relevanceDecision: event.relevanceDecision,
    relevanceScore: event.relevanceScore,
    relevanceConfidence: event.relevanceConfidence,
    relevanceReason: event.relevanceReason,
    matchedInterests: event.matchedInterests
  };
}

function snapshotResult(snapshot: SearchSnapshot, includeMaybe: boolean) {
  return {
    searchId: snapshot.searchId,
    status: snapshot.status,
    events: snapshot.events.map(eventLink),
    maybeCount: snapshot.maybeEvents.length,
    ...(includeMaybe
      ? { maybeEvents: snapshot.maybeEvents.map(eventLink) }
      : {}),
    relevance: snapshot.relevance,
    sources: snapshot.sources
  };
}

function searchText(snapshot: SearchSnapshot, includeMaybe: boolean): string {
  const events = includeMaybe
    ? [...snapshot.events, ...snapshot.maybeEvents]
    : snapshot.events;
  if (events.length === 0) {
    return `No events found. Search status: ${snapshot.status}.`;
  }
  return events
    .map((event) => `${event.title} — ${event.startsAt}\n${event.canonicalUrl}`)
    .join("\n\n");
}

function progressText(type: string): string {
  if (type === "search.completed") return "Search complete";
  if (type === "relevance.progress") return "Evaluating relevance";
  if (type === "relevance.fallback") return "Using strict relevance fallback";
  return type.replaceAll(".", " ");
}

async function progress(
  extra: HandlerExtra,
  amount: number,
  message: string
): Promise<void> {
  const progressToken = extra._meta?.progressToken;
  if (progressToken === undefined) return;
  await extra.sendNotification({
    method: "notifications/progress",
    params: { progressToken, progress: amount, message }
  });
}

export function buildEventMcpServer(
  dependencies: EventMcpDependencies
): McpServer {
  const server = new McpServer(
    { name: "personal-event-aggregator", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );

  server.registerTool(
    "get_event_interests",
    {
      title: "Get event interests",
      description: "Get the saved interests used to rank and exclude events.",
      outputSchema: interestProfileSchema,
      annotations: { readOnlyHint: true }
    },
    async () => textResult({ ...dependencies.interests.get() })
  );

  server.registerTool(
    "set_event_interests",
    {
      title: "Set event interests",
      description: "Replace the saved event interest profile.",
      inputSchema: interestProfileSchema,
      outputSchema: interestProfileSchema,
      annotations: { destructiveHint: true, idempotentHint: true }
    },
    async (input) => {
      const profile = uniqueProfile(input);
      dependencies.interests.replace(profile);
      return textResult({ ...profile });
    }
  );

  server.registerTool(
    "get_event_sources_status",
    {
      title: "Get event source status",
      description: "Get safe connection and search status for every event source.",
      outputSchema: sourcesOutputSchema,
      annotations: { readOnlyHint: true }
    },
    async () => {
      const structuredContent = {
        sources: await dependencies.connectors.getStatuses()
      };
      return textResult(structuredContent);
    }
  );

  server.registerTool(
    "start_event_search",
    {
      title: "Start event search",
      description: "Start a progressive event search and return its polling ID immediately.",
      inputSchema: eventSearchQuerySchema,
      outputSchema: startedOutputSchema,
      annotations: { readOnlyHint: true }
    },
    async (input) => {
      const { searchId } = await dependencies.searchService.start(input);
      const structuredContent = { searchId, status: "running" as const };
      return textResult(
        structuredContent,
        `Event search started. Poll with searchId ${searchId}.`
      );
    }
  );

  server.registerTool(
    "get_event_search_results",
    {
      title: "Get event search results",
      description: "Poll a progressive event search for ranked event links and source outcomes.",
      inputSchema: searchIdSchema,
      outputSchema: searchOutputSchema,
      annotations: { readOnlyHint: true }
    },
    async ({ searchId, includeMaybe }) => {
      const snapshot = dependencies.searchService.snapshot(searchId);
      if (!snapshot) throw new Error("Event search not found");
      return textResult(
        snapshotResult(snapshot, includeMaybe),
        searchText(snapshot, includeMaybe)
      );
    }
  );

  server.registerTool(
    "search_events",
    {
      title: "Search events",
      description: "Search all event sources and wait for ranked event links and source outcomes.",
      inputSchema: searchInputSchema,
      outputSchema: searchOutputSchema,
      annotations: { readOnlyHint: true }
    },
    async ({ includeMaybe, ...input }, extra) => {
      const { searchId } = await dependencies.searchService.start(input);
      const cancel = () => dependencies.searchService.cancel(searchId);
      extra.signal.addEventListener("abort", cancel, { once: true });
      let step = 0;
      try {
        if (extra.signal.aborted) {
          cancel();
          throw extra.signal.reason ?? new Error("Event search cancelled");
        }
        await progress(extra, step, "Search started");
        for await (const message of dependencies.searchService.subscribe(searchId)) {
          step += 1;
          await progress(extra, step, progressText(message.type));
        }
      } finally {
        extra.signal.removeEventListener("abort", cancel);
        if (extra.signal.aborted) cancel();
      }
      const snapshot = dependencies.searchService.snapshot(searchId);
      if (!snapshot) throw new Error("Event search not found");
      return textResult(
        snapshotResult(snapshot, includeMaybe),
        searchText(snapshot, includeMaybe)
      );
    }
  );

  return server;
}
