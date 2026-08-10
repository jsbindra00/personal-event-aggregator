import { createSearchService } from "../../../packages/core/src/search-service.js";
import type {
  ConnectorStatus,
  EventSource,
  InterestProfile,
  SearchStore
} from "../../../packages/core/src/index.js";
import type { AppDependencies } from "../src/app.js";

function memoryStore(): SearchStore {
  return {
    createSearch: () => undefined,
    setSearchStatus: () => undefined,
    upsertSource: () => undefined,
    saveEvent: () => undefined
  };
}

export function testDependencies(): AppDependencies & {
  connectedSources: EventSource[];
} {
  let interests: InterestProfile = {
    positive: ["AI"],
    excluded: [],
    note: ""
  };
  const connectedSources: EventSource[] = [];
  const statuses: ConnectorStatus[] = [
    {
      source: "luma",
      state: "ready",
      lastSuccessAt: null,
      errorCode: null,
      safeMessage: null
    }
  ];

  return {
    searchService: createSearchService({
      connectors: [],
      store: memoryStore(),
      getInterests: () => interests,
      createId: () => "search-1",
      now: () => new Date("2026-08-10T00:00:00.000Z")
    }),
    interests: {
      get: () => interests,
      replace: (next) => {
        interests = next;
      }
    },
    connectors: {
      getStatuses: async () => statuses,
      connect: async (source) => {
        connectedSources.push(source);
      }
    },
    connectedSources
  };
}

