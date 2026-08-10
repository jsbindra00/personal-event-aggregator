import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";

import type {
  ConnectorMessage,
  ConnectorStatus,
  EventConnector,
  EventSource,
  RawSourceEvent,
  ResolvedSearchQuery
} from "../../packages/core/src/index.js";

import { buildEventMcpServer } from "../../apps/mcp/src/server.js";
import { buildApp } from "../../apps/server/src/app.js";
import { createProductionDependencies } from "../../apps/server/src/dependencies.js";
import { createDirectFixtureFetch } from "../helpers/direct-fixture-fetch.js";

const query = {
  locationText: "London",
  startDate: "2026-08-10",
  endDate: "2026-08-12",
  timeZone: "Europe/London"
};

const lumaEvent: RawSourceEvent = {
  source: "luma",
  sourceEventId: "ai-builders",
  canonicalUrl: "https://lu.ma/ai-builders",
  title: "AI Builders London",
  startsAt: "2026-08-11T17:00:00.000Z",
  endsAt: null,
  timeZone: "Europe/London",
  descriptionText: null,
  organizerName: null,
  venueName: "Shoreditch Works",
  addressText: "London",
  latitude: null,
  longitude: null,
  isOnline: false,
  imageUrl: null,
  priceText: null,
  tags: ["AI"]
};

const meetupDuplicate: RawSourceEvent = {
  ...lumaEvent,
  source: "meetup",
  sourceEventId: "meetup-ai-builders",
  canonicalUrl: "https://www.meetup.com/london-ai/events/ai-builders",
  startsAt: "2026-08-11T17:05:00.000Z",
  descriptionText: "A technical workshop for people building useful AI products.",
  organizerName: "London AI",
  imageUrl: "https://images.example.test/ai-builders.jpg"
};

const eventbriteEvent: RawSourceEvent = {
  source: "eventbrite",
  sourceEventId: "climate-ai-forum",
  canonicalUrl: "https://www.eventbrite.co.uk/e/climate-ai-forum-123",
  title: "Climate AI Forum",
  startsAt: "2026-08-12T09:00:00.000Z",
  endsAt: "2026-08-12T12:00:00.000Z",
  timeZone: "Europe/London",
  descriptionText: "Applied climate technology.",
  organizerName: "Climate Founders",
  venueName: "County Hall",
  addressText: "Belvedere Road, London",
  latitude: 51.5,
  longitude: -0.12,
  isOnline: false,
  imageUrl: null,
  priceText: "Free",
  tags: ["climate", "AI"]
};

class AsyncFakeConnector implements EventConnector {
  public constructor(
    public readonly source: EventSource,
    private readonly messages: ConnectorMessage[],
    private readonly delayMs: number
  ) {}

  public async getStatus(): Promise<ConnectorStatus> {
    return {
      source: this.source,
      state: "ready",
      lastSuccessAt: null,
      errorCode: null,
      safeMessage: null
    };
  }

  public async *connect(): AsyncIterable<ConnectorMessage> {
    yield { type: "complete", source: this.source, count: 0 };
  }

  public async *search(
    _query: ResolvedSearchQuery,
    signal: AbortSignal
  ): AsyncIterable<ConnectorMessage> {
    await new Promise<void>((resolve) => setTimeout(resolve, this.delayMs));
    if (signal.aborted) return;
    for (const message of this.messages) yield message;
  }
}

function connectors(): EventConnector[] {
  return [
    new AsyncFakeConnector(
      "luma",
      [
        { type: "event", source: "luma", event: lumaEvent },
        { type: "complete", source: "luma", count: 1 }
      ],
      3
    ),
    new AsyncFakeConnector(
      "meetup",
      [
        { type: "event", source: "meetup", event: meetupDuplicate },
        { type: "complete", source: "meetup", count: 1 }
      ],
      7
    ),
    new AsyncFakeConnector(
      "eventbrite",
      [
        { type: "event", source: "eventbrite", event: eventbriteEvent },
        { type: "complete", source: "eventbrite", count: 1 }
      ],
      11
    ),
    new AsyncFakeConnector(
      "guild",
      [
        {
          type: "failed",
          source: "guild",
          errorCode: "source_unavailable",
          safeMessage: "Guild closed on 1 October 2024"
        }
      ],
      1
    )
  ];
}

function parseSse(payload: string) {
  return payload
    .split("\n\n")
    .map((block) => block.split("\n").find((line) => line.startsWith("data: ")))
    .filter((line): line is string => Boolean(line))
    .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);
}

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

describe("complete personal event search", () => {
  it("streams, deduplicates, ranks, persists, isolates failure, and matches MCP", async () => {
    const dependencies = createProductionDependencies({
      databasePath: ":memory:",
      connectors: connectors(),
      browserHost: {
        pageFor: async () => {
          throw new Error("browser should not open in the mocked flow");
        },
        closeSource: async () => undefined,
        close: async () => undefined
      }
    });
    const app = buildApp(dependencies);
    cleanup.push(async () => {
      await app.close();
      await dependencies.close();
    });

    const profileResponse = await app.inject({
      method: "PUT",
      url: "/api/interests",
      payload: {
        positive: ["AI", "climate"],
        excluded: ["crypto"],
        note: "Technical workshops"
      }
    });
    expect(profileResponse.statusCode).toBe(200);

    const started = await app.inject({
      method: "POST",
      url: "/api/searches",
      payload: query
    });
    expect(started.statusCode).toBe(202);
    const searchId = started.json().searchId as string;

    const stream = await app.inject({
      method: "GET",
      url: `/api/searches/${searchId}/stream`
    });
    expect(stream.statusCode).toBe(200);
    const messages = parseSse(stream.payload);
    expect(
      messages
        .filter(({ type }) => type === "event.added" || type === "event.updated")
        .map(({ type }) => type)
    ).toEqual(["event.added", "event.updated", "event.added"]);

    const snapshotResponse = await app.inject({
      method: "GET",
      url: `/api/searches/${searchId}`
    });
    const snapshot = snapshotResponse.json();
    expect(snapshot.status).toBe("complete");
    expect(snapshot.events).toHaveLength(2);
    expect(snapshot.events.map(({ title }: { title: string }) => title)).toEqual([
      "Climate AI Forum",
      "AI Builders London"
    ]);
    expect(snapshot.events[1]).toMatchObject({
      descriptionText: "A technical workshop for people building useful AI products.",
      organizerName: "London AI"
    });
    expect(snapshot.sources).toContainEqual(
      expect.objectContaining({
        source: "guild",
        state: "failed",
        errorCode: "source_unavailable"
      })
    );

    const mcpServer = buildEventMcpServer(dependencies);
    const client = new Client({ name: "e2e-client", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mcpServer.connect(serverTransport);
    await client.connect(clientTransport);
    cleanup.push(async () => {
      await client.close();
      await mcpServer.close();
    });

    const mcpResult = await client.callTool({
      name: "search_events",
      arguments: { ...query }
    });
    const mcp = mcpResult.structuredContent as {
      events: Array<{ title: string; url: string }>;
      sources: Array<{ source: string; state: string }>;
    };
    expect(mcp.events.map(({ title }) => title)).toEqual(
      snapshot.events.map(({ title }: { title: string }) => title)
    );
    expect(mcp.events.map(({ url }) => url)).toEqual(
      snapshot.events.map(
        ({ canonicalUrl }: { canonicalUrl: string }) => canonicalUrl
      )
    );
    expect(mcp.sources).toContainEqual(
      expect.objectContaining({ source: "guild", state: "failed" })
    );
  });

  it("runs real direct connectors through SSE, storage, REST, and MCP without a browser", async () => {
    const browserOpens: EventSource[] = [];
    const dependencies = createProductionDependencies({
      databasePath: ":memory:",
      fetch: createDirectFixtureFetch(),
      browserHost: {
        pageFor: async (source) => {
          browserOpens.push(source);
          throw new Error("browser fallback should not open for valid fixtures");
        },
        closeSource: async () => undefined,
        close: async () => undefined
      }
    });
    const app = buildApp(dependencies);
    cleanup.push(async () => {
      await app.close();
      await dependencies.close();
    });

    await app.inject({
      method: "PUT",
      url: "/api/interests",
      payload: {
        positive: ["AI", "agents"],
        excluded: ["crypto"],
        note: "Technical events"
      }
    });
    const directQuery = {
      locationText: "10 Downing Street, London",
      startDate: "2026-08-12",
      endDate: "2026-08-13",
      timeZone: "Europe/London"
    };
    const started = await app.inject({
      method: "POST",
      url: "/api/searches",
      payload: directQuery
    });
    const searchId = started.json().searchId as string;
    const stream = await app.inject({
      method: "GET",
      url: `/api/searches/${searchId}/stream`
    });
    const messages = parseSse(stream.payload);

    expect(browserOpens).toEqual([]);
    expect(
      messages.filter(
        ({ type }) => type === "event.added" || type === "event.updated"
      )
    ).toHaveLength(6);
    const snapshot = (
      await app.inject({ method: "GET", url: `/api/searches/${searchId}` })
    ).json();
    expect(snapshot.status).toBe("complete");
    expect(snapshot.events).toHaveLength(5);
    expect(
      snapshot.sources
        .filter(({ source }: { source: string }) => source !== "guild")
        .map(({ state }: { state: string }) => state)
    ).toEqual(["complete", "complete", "complete"]);

    const mcpServer = buildEventMcpServer(dependencies);
    const client = new Client({ name: "direct-e2e-client", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mcpServer.connect(serverTransport);
    await client.connect(clientTransport);
    cleanup.push(async () => {
      await client.close();
      await mcpServer.close();
    });
    const mcpResult = await client.callTool({
      name: "search_events",
      arguments: directQuery
    });
    const mcp = mcpResult.structuredContent as {
      events: Array<{ title: string; url: string }>;
    };
    expect(mcp.events.map(({ url }) => url)).toEqual(
      snapshot.events.map(
        ({ canonicalUrl }: { canonicalUrl: string }) => canonicalUrl
      )
    );
    expect(browserOpens).toEqual([]);
  });
});
