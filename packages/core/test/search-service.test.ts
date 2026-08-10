import { describe, expect, it } from "vitest";

import { createSearchService } from "../src/search-service.js";
import type {
  ConnectorMessage,
  ConnectorStatus,
  EventConnector,
  EventSource,
  RawSourceEvent,
  ResolvedSearchQuery,
  SearchStreamMessage
} from "../src/types.js";
import type { SearchStore } from "../src/search-service.js";

const query = {
  locationText: "London",
  startDate: "2026-08-10",
  endDate: "2026-08-12",
  timeZone: "Europe/London"
};

function rawEvent(
  source: EventSource,
  overrides: Partial<RawSourceEvent> = {}
): RawSourceEvent {
  return {
    source,
    sourceEventId: `${source}-1`,
    canonicalUrl: `https://events.example/${source}-1`,
    title: "AI Builders London",
    startsAt: "2026-08-12T18:00:00.000Z",
    venueName: "The Ministry",
    ...overrides
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class TestConnector implements EventConnector {
  public constructor(
    public readonly source: EventSource,
    private readonly run: (
      query: ResolvedSearchQuery,
      signal: AbortSignal
    ) => AsyncIterable<ConnectorMessage>
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
    return;
  }

  public search(
    resolvedQuery: ResolvedSearchQuery,
    signal: AbortSignal
  ): AsyncIterable<ConnectorMessage> {
    return this.run(resolvedQuery, signal);
  }
}

function connectorFromMessages(
  source: EventSource,
  messages: ConnectorMessage[]
): TestConnector {
  return new TestConnector(source, async function* () {
    for (const message of messages) {
      yield message;
    }
  });
}

function memoryStore(): SearchStore {
  return {
    createSearch: () => undefined,
    setSearchStatus: () => undefined,
    upsertSource: () => undefined,
    saveEvent: () => undefined
  };
}

async function nextMessage(
  iterator: AsyncIterator<SearchStreamMessage>
): Promise<SearchStreamMessage> {
  const result = await iterator.next();
  if (result.done) {
    throw new Error("Search stream ended unexpectedly");
  }
  return result.value;
}

async function nextOfType<T extends SearchStreamMessage["type"]>(
  iterator: AsyncIterator<SearchStreamMessage>,
  type: T
): Promise<SearchStreamMessage & { type: T }> {
  for (let index = 0; index < 30; index += 1) {
    const message = await nextMessage(iterator);
    if (message.type === type) {
      return message as SearchStreamMessage & { type: T };
    }
  }
  throw new Error(`No ${type} message arrived`);
}

function serviceWith(connectors: EventConnector[]) {
  return createSearchService({
    connectors,
    store: memoryStore(),
    getInterests: () => ({
      positive: ["AI builders"],
      excluded: [],
      note: ""
    }),
    createId: () => "search-1",
    now: () => new Date("2026-08-10T00:00:00.000Z")
  });
}

describe("SearchService", () => {
  it("emits a fast connector event before a gated connector finishes", async () => {
    const gate = deferred();
    const slow = new TestConnector("guild", async function* () {
      await gate.promise;
      yield { type: "event", source: "guild", event: rawEvent("guild") };
      yield { type: "complete", source: "guild", count: 1 };
    });
    const fast = connectorFromMessages("luma", [
      {
        type: "progress",
        source: "luma",
        phase: "page",
        count: 0,
        resolvedLocation: "London, UK"
      },
      { type: "event", source: "luma", event: rawEvent("luma") },
      { type: "complete", source: "luma", count: 1 }
    ]);
    const service = serviceWith([slow, fast]);

    const { searchId } = await service.start(query);
    const stream = service.subscribe(searchId)[Symbol.asyncIterator]();

    expect((await nextMessage(stream)).type).toBe("search.started");
    expect((await nextOfType(stream, "source.progress")).progress).toEqual({
      phase: "page",
      count: 0,
      resolvedLocation: "London, UK"
    });
    expect((await nextOfType(stream, "event.added")).event?.source).toBe("luma");

    gate.resolve();
    await nextOfType(stream, "search.completed");
  });

  it("keeps healthy sources running after another source fails", async () => {
    const service = serviceWith([
      connectorFromMessages("meetup", [
        {
          type: "failed",
          source: "meetup",
          errorCode: "contract_drift",
          safeMessage: "Meetup search changed"
        }
      ]),
      connectorFromMessages("eventbrite", [
        {
          type: "event",
          source: "eventbrite",
          event: rawEvent("eventbrite")
        },
        { type: "complete", source: "eventbrite", count: 1 }
      ])
    ]);

    const { searchId } = await service.start(query);
    const stream = service.subscribe(searchId)[Symbol.asyncIterator]();

    expect((await nextOfType(stream, "source.failed")).source).toBe("meetup");
    expect((await nextOfType(stream, "event.added")).event?.source).toBe(
      "eventbrite"
    );
    await nextOfType(stream, "search.completed");
  });

  it("emits an update when a later cross-source duplicate is richer", async () => {
    const service = serviceWith([
      connectorFromMessages("luma", [
        {
          type: "event",
          source: "luma",
          event: rawEvent("luma", { descriptionText: null })
        },
        { type: "complete", source: "luma", count: 1 }
      ]),
      connectorFromMessages("meetup", [
        {
          type: "event",
          source: "meetup",
          event: rawEvent("meetup", {
            canonicalUrl: "https://www.meetup.com/ai/events/1",
            descriptionText: "A detailed builder event"
          })
        },
        { type: "complete", source: "meetup", count: 1 }
      ])
    ]);

    const { searchId } = await service.start(query);
    const stream = service.subscribe(searchId)[Symbol.asyncIterator]();
    const added = await nextOfType(stream, "event.added");
    const updated = await nextOfType(stream, "event.updated");

    expect(updated.event?.id).toBe(added.event?.id);
    expect(updated.event?.descriptionText).toBe("A detailed builder event");
    expect(service.snapshot(searchId)?.events).toHaveLength(1);
  });

  it("cancels unfinished connectors and completes the search exactly once", async () => {
    let observedAbort = false;
    const waiting = new TestConnector("guild", async function* (_query, signal) {
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => {
          observedAbort = signal.aborted;
          resolve();
        });
      });
    });
    const service = serviceWith([waiting]);

    const { searchId } = await service.start(query);
    const stream = service.subscribe(searchId)[Symbol.asyncIterator]();
    await nextMessage(stream);
    service.cancel(searchId);

    expect((await nextOfType(stream, "source.completed")).status?.state).toBe(
      "cancelled"
    );
    expect((await nextOfType(stream, "search.completed")).type).toBe(
      "search.completed"
    );
    expect((await stream.next()).done).toBe(true);
    expect(observedAbort).toBe(true);

    const replayed: SearchStreamMessage[] = [];
    for await (const message of service.subscribe(searchId)) {
      replayed.push(message);
    }
    expect(
      replayed.filter((message) => message.type === "search.completed")
    ).toHaveLength(1);
  });

  it("cancels every active search during shutdown", async () => {
    const waiting = new TestConnector("guild", async function* (_query, signal) {
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true })
      );
    });
    const service = serviceWith([waiting]);
    const { searchId } = await service.start(query);

    service.cancelAll();

    expect(service.snapshot(searchId)?.status).toBe("cancelled");
    const replayed: SearchStreamMessage[] = [];
    for await (const message of service.subscribe(searchId)) replayed.push(message);
    expect(replayed.at(-1)?.type).toBe("search.completed");
  });

  it("bounds replay history without affecting the live stream", async () => {
    const service = createSearchService({
      connectors: [
        connectorFromMessages("luma", [
          { type: "progress", source: "luma", phase: "page-1" },
          { type: "progress", source: "luma", phase: "page-2" },
          { type: "progress", source: "luma", phase: "page-3" },
          { type: "progress", source: "luma", phase: "page-4" },
          { type: "complete", source: "luma", count: 0 }
        ])
      ],
      store: memoryStore(),
      getInterests: () => ({ positive: [], excluded: [], note: "" }),
      createId: () => "bounded-search",
      now: () => new Date("2026-08-10T00:00:00.000Z"),
      maxHistoryMessages: 3
    });

    const { searchId } = await service.start(query);
    for await (const _message of service.subscribe(searchId)) {
      // Consume the complete live stream before testing replay.
    }

    const replayed: SearchStreamMessage[] = [];
    for await (const message of service.subscribe(searchId)) {
      replayed.push(message);
    }
    expect(replayed).toHaveLength(3);
    expect(replayed.at(-1)?.type).toBe("search.completed");
  });
});
