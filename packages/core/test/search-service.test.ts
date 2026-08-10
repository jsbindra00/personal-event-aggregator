import { describe, expect, it } from "vitest";

import { createSearchService } from "../src/search-service.js";
import type {
  ConnectorMessage,
  ConnectorStatus,
  EventConnector,
  EventRelevanceEvaluator,
  EventSource,
  InterestProfile,
  NormalizedEvent,
  RawSourceEvent,
  RelevanceDecision,
  RelevanceStatus,
  ResolvedSearchQuery,
  SearchStreamMessage
} from "../src/types.js";
import type {
  RelevanceCache,
  SearchServiceOptions,
  SearchStore
} from "../src/search-service.js";

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

function serviceWith(
  connectors: EventConnector[],
  overrides: Partial<SearchServiceOptions> = {}
) {
  return createSearchService({
    connectors,
    store: memoryStore(),
    getInterests: () => ({
      positive: ["AI builders"],
      excluded: [],
      note: ""
    }),
    createId: () => "search-1",
    now: () => new Date("2026-08-10T00:00:00.000Z"),
    ...overrides
  });
}

function relevanceEvaluator(
  evaluate: EventRelevanceEvaluator["evaluate"],
  statusOverrides: Partial<RelevanceStatus> = {}
): EventRelevanceEvaluator {
  return {
    fingerprint: "test-evaluator:v1",
    evaluate,
    async status() {
      return {
        state: "ready",
        evaluator: "test",
        model: "test-model",
        evaluatedCount: 0,
        showCount: 0,
        maybeCount: 0,
        hideCount: 0,
        safeMessage: null,
        ...statusOverrides
      };
    }
  };
}

function relevanceDecision(
  eventId: string,
  decision: RelevanceDecision["decision"],
  score: number
): RelevanceDecision {
  return {
    eventId,
    decision,
    score,
    confidence: 0.9,
    matchedInterests: decision === "hide" ? [] : ["AI builders"],
    reason: `${decision} fixture decision`
  };
}

describe("SearchService", () => {
  it("batches candidates and emits only show decisions", async () => {
    const batches: string[][] = [];
    const evaluator = relevanceEvaluator(async (events) => {
      batches.push(events.map(({ id }) => id));
      return [
        relevanceDecision(events[0]!.id, "show", 90),
        relevanceDecision(events[1]!.id, "hide", 5)
      ];
    });
    const service = serviceWith(
      [
        connectorFromMessages("luma", [
          {
            type: "event",
            source: "luma",
            event: rawEvent("luma", { title: "AI Builders One", venueName: "One" })
          },
          { type: "complete", source: "luma", count: 1 }
        ]),
        connectorFromMessages("meetup", [
          {
            type: "event",
            source: "meetup",
            event: rawEvent("meetup", { title: "AI Builders Two", venueName: "Two" })
          },
          { type: "complete", source: "meetup", count: 1 }
        ])
      ],
      { relevanceEvaluator: evaluator, relevanceBatchSize: 2, relevanceFlushMs: 10 }
    );

    const { searchId } = await service.start(query);
    const messages: SearchStreamMessage[] = [];
    for await (const message of service.subscribe(searchId)) messages.push(message);

    expect(batches).toEqual([["luma:luma-1", "meetup:meetup-1"]]);
    expect(messages.filter(({ type }) => type === "event.added")).toHaveLength(1);
    expect(service.snapshot(searchId)).toMatchObject({
      events: [{ id: "luma:luma-1" }],
      maybeEvents: []
    });
  });

  it("flushes a partial batch on the timer and waits before completing", async () => {
    let release!: (decisions: RelevanceDecision[]) => void;
    const evaluating = new Promise<RelevanceDecision[]>((resolve) => {
      release = resolve;
    });
    let called = false;
    const evaluator = relevanceEvaluator(async (events) => {
      called = true;
      return evaluating.then((decisions) =>
        decisions.map((decision) => ({ ...decision, eventId: events[0]!.id }))
      );
    });
    const service = serviceWith(
      [
        connectorFromMessages("luma", [
          { type: "event", source: "luma", event: rawEvent("luma") },
          { type: "complete", source: "luma", count: 1 }
        ])
      ],
      { relevanceEvaluator: evaluator, relevanceBatchSize: 10, relevanceFlushMs: 5 }
    );

    const { searchId } = await service.start(query);
    await new Promise<void>((resolve) => setTimeout(resolve, 15));
    expect(called).toBe(true);
    expect(service.snapshot(searchId)?.status).toBe("running");

    release([relevanceDecision("placeholder", "show", 90)]);
    for await (const _message of service.subscribe(searchId)) {
      // Drain after releasing evaluation.
    }
    expect(service.snapshot(searchId)?.status).toBe("complete");
  });

  it("separates maybe events and reuses cached decisions", async () => {
    let evaluations = 0;
    const evaluator = relevanceEvaluator(async () => {
      evaluations += 1;
      return [];
    });
    const cache: RelevanceCache = {
      get(event) {
        return relevanceDecision(event.id, "maybe", 55);
      },
      put() {}
    };
    const service = serviceWith(
      [
        connectorFromMessages("eventbrite", [
          {
            type: "event",
            source: "eventbrite",
            event: rawEvent("eventbrite")
          },
          { type: "complete", source: "eventbrite", count: 1 }
        ])
      ],
      { relevanceEvaluator: evaluator, relevanceCache: cache }
    );

    const { searchId } = await service.start(query);
    const messages: SearchStreamMessage[] = [];
    for await (const message of service.subscribe(searchId)) messages.push(message);

    expect(evaluations).toBe(0);
    expect(messages.filter(({ type }) => type === "event.maybe")).toHaveLength(1);
    expect(service.snapshot(searchId)?.events).toEqual([]);
    expect(service.snapshot(searchId)?.maybeEvents).toHaveLength(1);
  });

  it("surfaces model fallback status without failing the source", async () => {
    const evaluator = relevanceEvaluator(
      async (events) => events.map(({ id }) => relevanceDecision(id, "show", 90)),
      {
        state: "fallback",
        safeMessage: "Using strict lexical fallback"
      }
    );
    const service = serviceWith(
      [
        connectorFromMessages("luma", [
          { type: "event", source: "luma", event: rawEvent("luma") },
          { type: "complete", source: "luma", count: 1 }
        ])
      ],
      { relevanceEvaluator: evaluator, relevanceFlushMs: 1 }
    );

    const { searchId } = await service.start(query);
    const messages: SearchStreamMessage[] = [];
    for await (const message of service.subscribe(searchId)) messages.push(message);

    expect(messages.some(({ type }) => type === "relevance.fallback")).toBe(true);
    expect(service.snapshot(searchId)?.relevance).toMatchObject({
      state: "fallback",
      safeMessage: "Using strict lexical fallback"
    });
    expect(service.snapshot(searchId)?.sources[0]?.state).toBe("complete");
  });

  it("rejects an invalid evaluator batch before applying any partial result", async () => {
    const evaluator = relevanceEvaluator(async (events) => [
      relevanceDecision(events[0]!.id, "show", 90),
      { ...relevanceDecision(events[1]!.id, "show", 90), score: 101 }
    ]);
    const service = serviceWith(
      [
        connectorFromMessages("luma", [
          {
            type: "event",
            source: "luma",
            event: rawEvent("luma", { title: "AI Builders One", venueName: "One" })
          },
          {
            type: "event",
            source: "luma",
            event: rawEvent("luma", {
              sourceEventId: "luma-2",
              canonicalUrl: "https://events.example/luma-2",
              title: "AI Builders Two",
              venueName: "Two"
            })
          },
          { type: "complete", source: "luma", count: 2 }
        ])
      ],
      { relevanceEvaluator: evaluator, relevanceBatchSize: 2 }
    );

    const { searchId } = await service.start(query);
    const outcome = await Promise.race([
      (async () => {
        for await (const _message of service.subscribe(searchId)) {
          // Drain to completion.
        }
        return "complete";
      })(),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 50))
    ]);
    if (outcome === "timeout") service.cancel(searchId);

    expect(outcome).toBe("complete");
    expect(service.snapshot(searchId)?.events).toHaveLength(2);
    expect(service.snapshot(searchId)?.relevance.state).toBe("fallback");
  });

  it("aborts relevance evaluation and suppresses late events on cancellation", async () => {
    let observedAbort = false;
    const started = deferred();
    const evaluator = relevanceEvaluator(async (events, _profile, signal) =>
      new Promise<RelevanceDecision[]>((resolve) => {
        started.resolve();
        signal.addEventListener(
          "abort",
          () => {
            observedAbort = true;
            resolve(events.map(({ id }) => relevanceDecision(id, "show", 90)));
          },
          { once: true }
        );
      })
    );
    const service = serviceWith(
      [
        connectorFromMessages("luma", [
          { type: "event", source: "luma", event: rawEvent("luma") },
          { type: "complete", source: "luma", count: 1 }
        ])
      ],
      { relevanceEvaluator: evaluator, relevanceBatchSize: 1 }
    );

    const { searchId } = await service.start(query);
    await started.promise;
    service.cancel(searchId);
    const messages: SearchStreamMessage[] = [];
    for await (const message of service.subscribe(searchId)) messages.push(message);

    expect(observedAbort).toBe(true);
    expect(messages.some(({ type }) => type === "event.added")).toBe(false);
    expect(service.snapshot(searchId)?.events).toEqual([]);
  });

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

  it("merges a richer cross-source duplicate before relevance evaluation", async () => {
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

    expect(added.event?.descriptionText).toBe("A detailed builder event");
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

  it("filters excluded topics before emitting or persisting events", async () => {
    const saved: NormalizedEvent[] = [];
    const store: SearchStore = {
      ...memoryStore(),
      saveEvent: (_searchId, event) => saved.push(event)
    };
    const service = createSearchService({
      connectors: [
        connectorFromMessages("luma", [
          {
            type: "event",
            source: "luma",
            event: rawEvent("luma", { title: "Crypto Trading Masterclass" })
          },
          { type: "complete", source: "luma", count: 1 }
        ])
      ],
      store,
      getInterests: () => ({ positive: [], excluded: ["crypto"], note: "" }),
      createId: () => "excluded-search",
      now: () => new Date("2026-08-10T00:00:00.000Z")
    });

    const { searchId } = await service.start(query);
    const messages: SearchStreamMessage[] = [];
    for await (const message of service.subscribe(searchId)) messages.push(message);

    expect(messages.some(({ type }) => type === "event.added")).toBe(false);
    expect(service.snapshot(searchId)?.events).toEqual([]);
    expect(saved).toEqual([]);
  });

  it("uses one interest-profile snapshot for an entire search", async () => {
    let reads = 0;
    const service = createSearchService({
      connectors: [
        connectorFromMessages("luma", [
          { type: "event", source: "luma", event: rawEvent("luma") },
          {
            type: "event",
            source: "luma",
            event: rawEvent("luma", {
              sourceEventId: "luma-2",
              canonicalUrl: "https://events.example/luma-2",
              title: "AI Engineers London"
            })
          },
          { type: "complete", source: "luma", count: 2 }
        ])
      ],
      store: memoryStore(),
      getInterests: () => {
        reads += 1;
        return reads === 1
          ? { positive: ["AI"], excluded: [], note: "" }
          : { positive: ["gardening"], excluded: [], note: "" };
      },
      createId: () => "profile-search",
      now: () => new Date("2026-08-10T00:00:00.000Z")
    });

    const { searchId } = await service.start(query);
    for await (const _message of service.subscribe(searchId)) {
      // Wait for the search to finish.
    }

    expect(reads).toBe(1);
    expect(service.snapshot(searchId)?.events).toHaveLength(2);
    expect(
      service.snapshot(searchId)?.events.every(({ relevanceScore }) => relevanceScore > 0)
    ).toBe(true);
  });
});
