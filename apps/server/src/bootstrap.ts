import { resolve } from "node:path";

import {
  createSearchService,
  type ConnectorStatus,
  type EventSource,
  type SearchStore
} from "@event-agg/core";
import { createRepositories, openDatabase } from "@event-agg/storage";

import { buildApp } from "./app.js";
import { resolveListenOptions } from "./config.js";

const database = openDatabase(
  process.env.EVENT_AGG_DATABASE_PATH ?? resolve(".data/events.sqlite")
);
const repositories = createRepositories(database);

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
  connectors: [],
  store,
  getInterests: () => repositories.interests.get()
});

const app = buildApp({
  searchService,
  interests: repositories.interests,
  connectors: {
    getStatuses: async (): Promise<ConnectorStatus[]> => [],
    connect: async (_source: EventSource): Promise<void> => undefined
  }
});

const { host, port } = resolveListenOptions(process.env);

await app.listen({ host, port });

async function shutdown() {
  await app.close();
  database.close();
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
