import type {
  ConnectorMessage,
  ConnectorStatus,
  EventConnector,
  EventRelevanceEvaluator,
  EventSource,
  RelevanceStatus,
  ResolvedSearchQuery
} from "@event-agg/core";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import {
  createProductionDependencies,
  serializeConnectorOperations,
  type ProductionDependencies
} from "../src/dependencies.js";
import { createDirectFixtureFetch } from "../../../test/helpers/direct-fixture-fetch.js";

class FakeBrowserHost {
  readonly opened: Array<{ source: EventSource; url: string }> = [];
  readonly closed: EventSource[] = [];

  async pageFor(source: EventSource, url: string): Promise<never> {
    this.opened.push({ source, url });
    return undefined as never;
  }

  async closeSource(source: EventSource): Promise<void> {
    this.closed.push(source);
  }

  async close(): Promise<void> {}
}

class StaticConnector implements EventConnector {
  readonly source: EventSource;

  constructor(private readonly status: ConnectorStatus) {
    this.source = status.source;
  }

  async getStatus(): Promise<ConnectorStatus> {
    return { ...this.status };
  }

  async *connect(): AsyncIterable<ConnectorMessage> {}

  async *search(
    _query: ResolvedSearchQuery,
    _signal: AbortSignal
  ): AsyncIterable<ConnectorMessage> {}
}

const dependenciesToClose: ProductionDependencies[] = [];
const apps: Array<ReturnType<typeof buildApp>> = [];

const showAllEvaluator: EventRelevanceEvaluator = {
  fingerprint: "test-show-all",
  evaluate: async (events) =>
    events.map((event) => ({
      eventId: event.id,
      decision: "show" as const,
      score: 100,
      confidence: 1,
      matchedInterests: [],
      reason: "Accepted by connector integration fixture"
    })),
  status: async () => ({
    state: "ready",
    evaluator: "test-show-all",
    model: null,
    evaluatedCount: 0,
    showCount: 0,
    maybeCount: 0,
    hideCount: 0,
    safeMessage: null
  })
};

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(dependenciesToClose.splice(0).map((deps) => deps.close()));
});

function status(source: EventSource, state: ConnectorStatus["state"]): ConnectorStatus {
  return {
    source,
    state,
    lastSuccessAt: null,
    errorCode: state === "auth_required" ? "auth_required" : null,
    safeMessage: state === "auth_required" ? `Sign in to ${source}` : null
  };
}

describe("production connector wiring", () => {
  it("uses an injected local evaluator and exposes its readiness", async () => {
    const expected: RelevanceStatus = {
      state: "ready",
      evaluator: "ollama",
      model: "gemma3:4b",
      evaluatedCount: 0,
      showCount: 0,
      maybeCount: 0,
      hideCount: 0,
      safeMessage: null
    };
    const evaluator: EventRelevanceEvaluator = {
      fingerprint: "test-evaluator",
      evaluate: async () => [],
      status: async () => expected
    };
    const dependencies = createProductionDependencies({
      databasePath: ":memory:",
      browserHost: new FakeBrowserHost(),
      relevanceEvaluator: evaluator
    });
    dependenciesToClose.push(dependencies);
    const app = buildApp(dependencies);
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/api/relevance/status"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(expected);
  });

  it("configures the default evaluator from the local-model environment", async () => {
    const requests: string[] = [];
    const dependencies = createProductionDependencies({
      databasePath: ":memory:",
      browserHost: new FakeBrowserHost(),
      environment: {
        EVENT_AGG_OLLAMA_URL: "http://localhost:11555",
        EVENT_AGG_RELEVANCE_MODEL: "gemma3:12b",
        EVENT_AGG_RELEVANCE_TIMEOUT_MS: "1234"
      },
      relevanceFetch: async (input) => {
        requests.push(String(input));
        return Response.json({ models: [{ name: "gemma3:12b" }] });
      }
    });
    dependenciesToClose.push(dependencies);
    const app = buildApp(dependencies);
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/api/relevance/status"
    });

    expect(response.json()).toMatchObject({
      state: "ready",
      evaluator: "resilient",
      model: "gemma3:12b"
    });
    expect(requests).toEqual(["http://localhost:11555/api/tags"]);
  });

  it("constructs exactly the four configured source connectors", () => {
    const dependencies = createProductionDependencies({
      databasePath: ":memory:",
      browserHost: new FakeBrowserHost()
    });
    dependenciesToClose.push(dependencies);

    expect(new Set(dependencies.connectorSources)).toEqual(
      new Set(["luma", "meetup", "eventbrite", "guild"])
    );
  });

  it("searches all available sources directly without opening browser pages", async () => {
    const browserHost = new FakeBrowserHost();
    const dependencies = createProductionDependencies({
      databasePath: ":memory:",
      browserHost,
      fetch: createDirectFixtureFetch(),
      relevanceEvaluator: showAllEvaluator
    });
    dependenciesToClose.push(dependencies);

    const { searchId } = await dependencies.searchService.start(searchQuery);
    await drain(dependencies.searchService.subscribe(searchId));

    expect(browserHost.opened).toEqual([]);
    const snapshot = dependencies.searchService.snapshot(searchId);
    expect(snapshot?.events).toHaveLength(5);
    expect(
      snapshot?.sources
        .filter(({ source }) => source !== "guild")
        .map(({ state }) => state)
    ).toEqual(["complete", "complete", "complete"]);
  });

  it("opens only the source whose direct private contract drifted", async () => {
    const browserHost = new FakeBrowserHost();
    const dependencies = createProductionDependencies({
      databasePath: ":memory:",
      browserHost,
      fetch: createDirectFixtureFetch({ meetupDrift: true })
    });
    dependenciesToClose.push(dependencies);

    const { searchId } = await dependencies.searchService.start(searchQuery);
    await drain(dependencies.searchService.subscribe(searchId));

    expect(browserHost.opened.map(({ source }) => source)).toEqual(["meetup"]);
  });

  it("exposes one auth-required state without changing other sources", async () => {
    const connectors = ([
      status("luma", "auth_required"),
      status("meetup", "ready"),
      status("eventbrite", "complete"),
      status("guild", "failed")
    ] as const).map((value) => new StaticConnector(value));
    const dependencies = createProductionDependencies({
      databasePath: ":memory:",
      browserHost: new FakeBrowserHost(),
      connectors
    });
    dependenciesToClose.push(dependencies);
    const app = buildApp(dependencies);
    apps.push(app);

    const response = await app.inject({ method: "GET", url: "/api/connectors" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      status("luma", "auth_required"),
      status("meetup", "ready"),
      status("eventbrite", "complete"),
      status("guild", "failed")
    ]);
  });

  it("opens only the selected source connect URL", async () => {
    const browserHost = new FakeBrowserHost();
    const dependencies = createProductionDependencies({
      databasePath: ":memory:",
      browserHost
    });
    dependenciesToClose.push(dependencies);
    const app = buildApp(dependencies);
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/connectors/meetup/connect"
    });
    expect(response.statusCode).toBe(202);
    expect(browserHost.opened).toEqual([
      {
        source: "meetup",
        url: "https://www.meetup.com/find/?source=EVENTS"
      }
    ]);
    expect(browserHost.closed).toEqual(["meetup"]);
  });

  it("serializes overlapping operations for a shared source page", async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const starts: number[] = [];
    const base: EventConnector = {
      source: "luma",
      getStatus: async () => status("luma", "ready"),
      connect: async function* () {
        starts.push(starts.length + 1);
        yield { type: "complete", source: "luma", count: 0 };
      },
      search: async function* () {
        starts.push(starts.length + 1);
        if (starts.length === 1) await firstGate;
        yield { type: "complete", source: "luma", count: 0 };
      }
    };
    const connector = serializeConnectorOperations(base);
    const resolvedQuery: ResolvedSearchQuery = {
      locationText: "London",
      startDate: "2026-08-10",
      endDate: "2026-08-12",
      timeZone: "Europe/London",
      startsAtUtc: "2026-08-09T23:00:00.000Z",
      endsBeforeUtc: "2026-08-12T23:00:00.000Z"
    };
    const collect = async (iterable: AsyncIterable<ConnectorMessage>) => {
      for await (const _message of iterable) {
        // Drain the operation.
      }
    };

    const first = collect(connector.search(resolvedQuery, new AbortController().signal));
    await Promise.resolve();
    const second = collect(connector.connect());
    await Promise.resolve();
    expect(starts).toEqual([1]);

    releaseFirst();
    await Promise.all([first, second]);
    expect(starts).toEqual([1, 2]);
  });
});

const searchQuery = {
  locationText: "London",
  startDate: "2026-08-12",
  endDate: "2026-08-13",
  timeZone: "Europe/London"
};

async function drain(iterable: AsyncIterable<unknown>): Promise<void> {
  for await (const _message of iterable) {
    // Drain the search to completion.
  }
}
