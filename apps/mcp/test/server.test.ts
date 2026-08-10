import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  ConnectorStatus,
  EventSearchQuery,
  InterestProfile,
  NormalizedEvent,
  ResolvedSearchQuery,
  SearchService,
  SearchSnapshot,
  SearchStreamMessage
} from "@event-agg/core";

import { buildEventMcpServer, type EventMcpDependencies } from "../src/server.js";

const event: NormalizedEvent = {
  id: "luma:ai-builders",
  source: "luma",
  sourceEventId: "ai-builders",
  canonicalUrl: "https://lu.ma/example",
  title: "AI Builders",
  startsAt: "2026-08-11T17:00:00.000Z",
  endsAt: null,
  timeZone: "Europe/London",
  descriptionText: "Build useful AI products.",
  organizerName: "London AI",
  venueName: "Shoreditch Works",
  addressText: "London",
  latitude: null,
  longitude: null,
  isOnline: false,
  imageUrl: null,
  priceText: null,
  tags: ["AI"],
  relevanceScore: 42,
  matchedInterests: ["AI"],
  firstSeenAt: "2026-08-10T00:00:00.000Z"
};

const statuses: ConnectorStatus[] = [
  {
    source: "luma",
    state: "complete",
    lastSuccessAt: "2026-08-10T00:00:00.000Z",
    errorCode: null,
    safeMessage: null
  },
  {
    source: "meetup",
    state: "failed",
    lastSuccessAt: null,
    errorCode: "source_unavailable",
    safeMessage: "Meetup could not be searched right now."
  }
];

const query: EventSearchQuery = {
  locationText: "London",
  startDate: "2026-08-10",
  endDate: "2026-08-12",
  timeZone: "Europe/London"
};

class FakeSearchService implements SearchService {
  public readonly inputs: EventSearchQuery[] = [];
  public readonly cancelled: string[] = [];
  public hang = false;
  private readonly snapshots = new Map<string, SearchSnapshot>();
  private readonly releases = new Map<string, () => void>();
  private sequence = 0;

  public async start(input: EventSearchQuery): Promise<{ searchId: string }> {
    this.inputs.push(input);
    const searchId = `search-${++this.sequence}`;
    this.snapshots.set(searchId, {
      searchId,
      query: {
        ...input,
        startsAtUtc: "2026-08-09T23:00:00.000Z",
        endsBeforeUtc: "2026-08-13T23:00:00.000Z"
      },
      status: "running",
      events: [],
      sources: statuses.map((status) => ({ ...status, state: "searching" }))
    });
    return { searchId };
  }

  public subscribe(searchId: string): AsyncIterable<SearchStreamMessage> {
    const snapshot = this.snapshots.get(searchId);
    if (!snapshot) throw new Error("Search not found");
    const messages: SearchStreamMessage[] = [
      { sequence: 1, searchId, type: "search.started" },
      { sequence: 2, searchId, type: "event.added", source: "luma", event },
      {
        sequence: 3,
        searchId,
        type: "source.failed",
        source: "meetup",
        status: statuses[1]!
      },
      { sequence: 4, searchId, type: "search.completed" }
    ];
    const finish = () => {
      this.snapshots.set(searchId, {
        ...snapshot,
        status: "complete",
        events: [event],
        sources: statuses
      });
    };
    if (this.hang) {
      const releases = this.releases;
      return {
        [Symbol.asyncIterator]() {
          return {
            next: () =>
              new Promise<IteratorResult<SearchStreamMessage>>((resolve) => {
                releases.set(searchId, () =>
                  resolve({ done: true, value: undefined })
                );
              }),
            return: async () => ({ done: true, value: undefined })
          };
        }
      };
    }
    return {
      async *[Symbol.asyncIterator]() {
        for (const message of messages) yield message;
        finish();
      }
    };
  }

  public snapshot(searchId: string): SearchSnapshot | null {
    return this.snapshots.get(searchId) ?? null;
  }

  public complete(searchId: string): void {
    const snapshot = this.snapshots.get(searchId);
    if (!snapshot) throw new Error("Search not found");
    this.snapshots.set(searchId, {
      ...snapshot,
      status: "complete",
      events: [event],
      sources: statuses
    });
  }

  public cancel(searchId: string): void {
    this.cancelled.push(searchId);
    this.releases.get(searchId)?.();
    this.releases.delete(searchId);
    const snapshot = this.snapshots.get(searchId);
    if (snapshot) this.snapshots.set(searchId, { ...snapshot, status: "cancelled" });
  }

  public cancelAll(): void {
    for (const searchId of this.snapshots.keys()) this.cancel(searchId);
  }
}

const openConnections: Array<{ client: Client; close: () => Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(openConnections.splice(0).map(({ close }) => close()));
});

async function fixture() {
  let profile: InterestProfile = {
    positive: ["AI"],
    excluded: ["crypto"],
    note: "Prefer technical events"
  };
  const searchService = new FakeSearchService();
  const dependencies: EventMcpDependencies = {
    searchService,
    interests: {
      get: () => profile,
      replace: (next) => {
        profile = next;
      }
    },
    connectors: { getStatuses: async () => statuses }
  };
  const server = buildEventMcpServer(dependencies);
  const client = new Client({ name: "event-agg-test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const close = async () => {
    await client.close();
    await server.close();
  };
  openConnections.push({ client, close });
  return { client, searchService };
}

function structured(result: Awaited<ReturnType<Client["callTool"]>>) {
  return result.structuredContent as Record<string, unknown>;
}

describe("event aggregator MCP server", () => {
  it("exposes the complete tool surface", async () => {
    const { client } = await fixture();
    const tools = await client.listTools();

    expect(tools.tools.map(({ name }) => name).sort()).toEqual([
      "get_event_interests",
      "get_event_search_results",
      "get_event_sources_status",
      "search_events",
      "set_event_interests",
      "start_event_search"
    ]);
  });

  it("gets and replaces the saved interest profile", async () => {
    const { client } = await fixture();
    const before = await client.callTool({ name: "get_event_interests" });
    expect(structured(before)).toMatchObject({ positive: ["AI"] });

    await client.callTool({
      name: "set_event_interests",
      arguments: {
        positive: ["climate", "climate"],
        excluded: ["sales"],
        note: "Small gatherings"
      }
    });
    const after = await client.callTool({ name: "get_event_interests" });
    expect(structured(after)).toEqual({
      positive: ["climate"],
      excluded: ["sales"],
      note: "Small gatherings"
    });
  });

  it("waits for a ranked search while preserving partial source failure", async () => {
    const { client, searchService } = await fixture();
    const result = await client.callTool({
      name: "search_events",
      arguments: { ...query }
    });

    expect(searchService.inputs).toEqual([query]);
    expect(structured(result)).toMatchObject({
      status: "complete",
      events: [{ title: "AI Builders", url: "https://lu.ma/example", source: "luma" }],
      sources: [
        { source: "luma", state: "complete" },
        { source: "meetup", state: "failed", errorCode: "source_unavailable" }
      ]
    });
  });

  it("starts immediately and supports progressive result polling", async () => {
    const { client, searchService } = await fixture();
    const started = await client.callTool({
      name: "start_event_search",
      arguments: { ...query }
    });
    const searchId = structured(started).searchId as string;

    const running = await client.callTool({
      name: "get_event_search_results",
      arguments: { searchId }
    });
    expect(structured(running)).toMatchObject({ status: "running", events: [] });

    searchService.complete(searchId);
    const complete = await client.callTool({
      name: "get_event_search_results",
      arguments: { searchId }
    });
    expect(structured(complete)).toMatchObject({
      status: "complete",
      events: [{ url: "https://lu.ma/example" }]
    });
  });

  it("reports source status and emits progress when requested", async () => {
    const { client } = await fixture();
    const sourceResult = await client.callTool({ name: "get_event_sources_status" });
    expect(structured(sourceResult)).toEqual({ sources: statuses });

    const progress: Array<{ progress: number; message?: string | undefined }> = [];
    await client.callTool(
      { name: "search_events", arguments: { ...query } },
      undefined,
      { onprogress: (update) => progress.push(update) }
    );
    expect(progress.length).toBeGreaterThan(0);
    expect(progress.at(-1)).toMatchObject({ message: "Search complete" });
  });

  it("cancels the underlying search when a synchronous tool call is aborted", async () => {
    const { client, searchService } = await fixture();
    searchService.hang = true;
    const controller = new AbortController();

    const call = client.callTool(
      { name: "search_events", arguments: { ...query } },
      undefined,
      { signal: controller.signal }
    );
    await vi.waitFor(() => expect(searchService.inputs).toHaveLength(1));
    controller.abort();

    await expect(call).rejects.toThrow();
    await vi.waitFor(() =>
      expect(searchService.cancelled).toContain("search-1")
    );
  });
});
