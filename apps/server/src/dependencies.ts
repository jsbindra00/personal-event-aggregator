import { resolve } from "node:path";

import { BrowserHost } from "@event-agg/browser";
import {
  createEventbriteConnector,
  eventbriteSearchContract
} from "@event-agg/connector-eventbrite";
import {
  createGuildConnector,
  GUILD_CLOSURE_URL
} from "@event-agg/connector-guild";
import {
  createLumaConnector,
  lumaSearchContract
} from "@event-agg/connector-luma";
import {
  createMeetupConnector,
  meetupSearchContract
} from "@event-agg/connector-meetup";
import {
  createSearchService,
  type ConnectorMessage,
  type EventConnector,
  type EventSource,
  type ResolvedSearchQuery,
  type SearchStore
} from "@event-agg/core";
import { createRepositories, openDatabase } from "@event-agg/storage";
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
  close(): Promise<void>;
}

export interface ProductionDependencyOptions {
  databasePath?: string;
  browserHost?: ServerBrowserHost;
  connectors?: EventConnector[];
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
  const browserHost = options.browserHost ?? new BrowserHost();
  const rawConnectors =
    options.connectors ??
    [
      createLumaConnector(browserHost),
      createMeetupConnector(browserHost),
      createEventbriteConnector(browserHost),
      createGuildConnector()
    ];
  validateConnectorSet(rawConnectors);

  let resourcesClosed = false;
  const persistStatus = async (connector: EventConnector): Promise<void> => {
    if (resourcesClosed) return;
    repositories.connectorStatuses.upsert(await connector.getStatus());
  };
  const connectors = rawConnectors.map((connector) =>
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
    }
  };
  const searchService = createSearchService({
    connectors,
    store,
    getInterests: () => repositories.interests.get()
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
      if (!registry.has(source)) throw new Error("Unknown connector source");
      await browserHost.pageFor(source, connectUrls[source]);
      await persistStatus(registry.get(source)!);
    }
  };

  return {
    searchService,
    interests: repositories.interests,
    connectors: connectorManager,
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
