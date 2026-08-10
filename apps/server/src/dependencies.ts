import { resolve } from "node:path";

import { BrowserHost } from "@event-agg/browser";
import { withConnectorFallback } from "@event-agg/connector-common";
import {
  createDirectEventbriteConnector,
  createEventbriteConnector,
  eventbriteSearchContract
} from "@event-agg/connector-eventbrite";
import {
  createGuildConnector,
  GUILD_CLOSURE_URL
} from "@event-agg/connector-guild";
import {
  createDirectLumaConnector,
  createLumaConnector,
  lumaSearchContract
} from "@event-agg/connector-luma";
import {
  createDirectMeetupConnector,
  createMeetupConnector,
  meetupSearchContract
} from "@event-agg/connector-meetup";
import {
  createSearchService,
  type ConnectorMessage,
  type EventConnector,
  type EventRelevanceEvaluator,
  type EventSource,
  type RelevanceCache,
  type ResolvedSearchQuery,
  type SearchStore
} from "@event-agg/core";
import {
  createLexicalRelevanceEvaluator,
  createOllamaRelevanceEvaluator,
  createResilientRelevanceEvaluator
} from "@event-agg/relevance";
import {
  createRepositories,
  eventRelevanceFingerprint,
  openDatabase,
  profileRelevanceFingerprint
} from "@event-agg/storage";
import type { Page } from "playwright-core";

import type { AppDependencies, ConnectorManager } from "./app.js";

const connectUrls: Record<EventSource, string> = {
  luma: lumaSearchContract.connectUrl,
  meetup: meetupSearchContract.connectUrl,
  eventbrite: eventbriteSearchContract.connectUrl,
  guild: GUILD_CLOSURE_URL
};

export interface ServerBrowserHost {
  pageFor(source: EventSource, url: string): Promise<Page>;
  closeSource(source: EventSource): Promise<void>;
  close(): Promise<void>;
}

export interface ProductionDependencyOptions {
  databasePath?: string;
  browserHost?: ServerBrowserHost;
  connectors?: EventConnector[];
  fetch?: typeof globalThis.fetch;
  diagnostic?: (value: unknown) => void;
  relevanceEvaluator?: EventRelevanceEvaluator;
  relevanceFetch?: typeof globalThis.fetch;
  environment?: Record<string, string | undefined>;
}

export interface ProductionDependencies extends AppDependencies {
  connectorSources: EventSource[];
  cancelActiveSearches(): void;
  close(): Promise<void>;
}

export function createProductionDependencies(
  options: ProductionDependencyOptions = {}
): ProductionDependencies {
  const database = openDatabase(
    options.databasePath ??
      process.env.EVENT_AGG_DATABASE_PATH ??
      resolve(".data/events.sqlite")
  );
  const repositories = createRepositories(database);
  const environment = options.environment ?? process.env;
  const browserHost = options.browserHost ?? new BrowserHost();
  const diagnosticOptions =
    options.diagnostic === undefined ? {} : { diagnostic: options.diagnostic };
  const directOptions = {
    ...diagnosticOptions,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch })
  };
  const rawConnectors =
    options.connectors ??
    [
      withConnectorFallback(
        createDirectLumaConnector(directOptions),
        createLumaConnector(browserHost, diagnosticOptions)
      ),
      withConnectorFallback(
        createDirectMeetupConnector(directOptions),
        createMeetupConnector(browserHost, diagnosticOptions)
      ),
      withConnectorFallback(
        createDirectEventbriteConnector(directOptions),
        createEventbriteConnector(browserHost, diagnosticOptions)
      ),
      createGuildConnector()
    ];
  validateConnectorSet(rawConnectors);

  const isolatedConnectors = rawConnectors.map((connector) =>
    serializeConnectorOperations(
      withInteractiveConnection(
        connector,
        browserHost,
        connectUrls[connector.source]
      )
    )
  );

  let resourcesClosed = false;
  const persistStatus = async (connector: EventConnector): Promise<void> => {
    if (resourcesClosed) return;
    repositories.connectorStatuses.upsert(await connector.getStatus());
  };
  const connectors = isolatedConnectors.map((connector) =>
    withStatusPersistence(connector, () => persistStatus(connector))
  );

  const store: SearchStore = {
    createSearch: (input) => repositories.searches.create(input),
    setSearchStatus: (searchId, status, completedAt) =>
      repositories.searches.setStatus(searchId, status, completedAt),
    upsertSource: (input) => repositories.searches.upsertSource(input),
    saveEvent: (searchId, event, rank) => {
      repositories.events.upsert(event);
      repositories.events.linkToSearch(searchId, event, rank);
    },
    removeEvent: (searchId, eventId) =>
      repositories.events.unlinkFromSearch(searchId, eventId)
  };
  const relevanceEvaluator =
    options.relevanceEvaluator ??
    createResilientRelevanceEvaluator(
      createOllamaRelevanceEvaluator({
        endpoint:
          environment.EVENT_AGG_OLLAMA_URL ?? "http://127.0.0.1:11434",
        model: environment.EVENT_AGG_RELEVANCE_MODEL ?? "gemma3:4b",
        timeoutMs: relevanceTimeout(environment.EVENT_AGG_RELEVANCE_TIMEOUT_MS),
        promptVersion: "event-relevance-v3",
        ...(options.relevanceFetch === undefined
          ? {}
          : { fetch: options.relevanceFetch })
      }),
      createLexicalRelevanceEvaluator()
    );
  const relevanceCache: RelevanceCache = {
    get: (event, profile, evaluatorFingerprint) =>
      repositories.relevanceCache.get({
        eventFingerprint: eventRelevanceFingerprint(event),
        profileFingerprint: profileRelevanceFingerprint(profile),
        evaluatorFingerprint
      }),
    put: (event, profile, evaluatorFingerprint, decision) =>
      repositories.relevanceCache.put({
        eventFingerprint: eventRelevanceFingerprint(event),
        profileFingerprint: profileRelevanceFingerprint(profile),
        evaluatorFingerprint,
        decision,
        createdAt: new Date().toISOString()
      })
  };
  const searchService = createSearchService({
    connectors,
    store,
    getInterests: () => repositories.interests.get(),
    relevanceEvaluator,
    relevanceCache,
    relevanceBatchSize: positiveEnvironmentInteger(
      environment.EVENT_AGG_RELEVANCE_BATCH_SIZE,
      5,
      "Relevance batch size"
    )
  });
  const registry = new Map(
    connectors.map((connector) => [connector.source, connector] as const)
  );
  const connectorManager: ConnectorManager = {
    getStatuses: async () => {
      const statuses = [];
      for (const connector of connectors) {
        const status = await connector.getStatus();
        repositories.connectorStatuses.upsert(status);
        statuses.push(status);
      }
      return statuses;
    },
    connect: async (source) => {
      const connector = registry.get(source);
      if (!connector) throw new Error("Unknown connector source");
      for await (const _message of connector.connect()) {
        // Opening and status updates happen inside the serialized operation.
      }
      await persistStatus(connector);
    }
  };

  return {
    searchService,
    interests: repositories.interests,
    connectors: connectorManager,
    relevance: { getStatus: () => relevanceEvaluator.status() },
    connectorSources: connectors.map((connector) => connector.source),
    cancelActiveSearches: () => searchService.cancelAll(),
    close: async () => {
      if (resourcesClosed) return;
      resourcesClosed = true;
      searchService.cancelAll();
      await browserHost.close();
      database.close();
    }
  };
}

function relevanceTimeout(value: string | undefined): number {
  return positiveEnvironmentInteger(value, 60_000, "Relevance timeout");
}

function positiveEnvironmentInteger(
  value: string | undefined,
  fallback: number,
  label: string
): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function withInteractiveConnection(
  connector: EventConnector,
  browserHost: ServerBrowserHost,
  connectUrl: string
): EventConnector {
  return {
    source: connector.source,
    getStatus: () => connector.getStatus(),
    connect: async function* () {
      await browserHost.closeSource(connector.source);
      await browserHost.pageFor(connector.source, connectUrl);
      yield* connector.connect();
    },
    search: (query, signal) => connector.search(query, signal)
  };
}

/** Prevents one source's persistent page from serving overlapping operations. */
export function serializeConnectorOperations(
  connector: EventConnector
): EventConnector {
  let tail = Promise.resolve();

  const serialized = (
    create: () => AsyncIterable<ConnectorMessage>,
    signal?: AbortSignal
  ): AsyncIterable<ConnectorMessage> => ({
    async *[Symbol.asyncIterator]() {
      let release!: () => void;
      const previous = tail;
      tail = new Promise<void>((resolveLock) => {
        release = resolveLock;
      });
      await previous;
      try {
        if (signal?.aborted) return;
        yield* create();
      } finally {
        release();
      }
    }
  });

  return {
    source: connector.source,
    getStatus: () => connector.getStatus(),
    connect: () => serialized(() => connector.connect()),
    search: (query, signal) =>
      serialized(() => connector.search(query, signal), signal)
  };
}

function validateConnectorSet(connectors: EventConnector[]): void {
  const expected = new Set<EventSource>([
    "luma",
    "meetup",
    "eventbrite",
    "guild"
  ]);
  const actual = new Set(connectors.map((connector) => connector.source));
  if (
    connectors.length !== expected.size ||
    actual.size !== expected.size ||
    [...expected].some((source) => !actual.has(source))
  ) {
    throw new Error("Production dependencies require exactly four connectors");
  }
}

function withStatusPersistence(
  connector: EventConnector,
  persist: () => Promise<void>
): EventConnector {
  const track = async function* (
    iterable: AsyncIterable<ConnectorMessage>
  ): AsyncIterable<ConnectorMessage> {
    try {
      for await (const message of iterable) {
        await persist();
        yield message;
      }
    } finally {
      await persist();
    }
  };

  return {
    source: connector.source,
    getStatus: async () => {
      const status = await connector.getStatus();
      await persist();
      return status;
    },
    connect: () => track(connector.connect()),
    search: (query: ResolvedSearchQuery, signal: AbortSignal) =>
      track(connector.search(query, signal))
  };
}
