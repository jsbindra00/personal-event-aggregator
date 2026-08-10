import type {
  ConnectorStatus,
  EventSearchQuery,
  EventSource,
  InterestProfile,
  SearchStreamMessage
} from "@event-agg/core";

import type { EventApi } from "../src/lib/api.js";

export interface TestEventApi extends EventApi {
  emit(message: SearchStreamMessage): void;
  connectedSources: EventSource[];
  connectorStatuses: ConnectorStatus[];
  searches: EventSearchQuery[];
}

export function createTestEventApi(): TestEventApi {
  let listener: ((message: SearchStreamMessage) => void) | null = null;
  let interests: InterestProfile = {
    positive: ["AI"],
    excluded: [],
    note: ""
  };
  const statuses: ConnectorStatus[] = [
    {
      source: "luma",
      state: "ready",
      lastSuccessAt: null,
      errorCode: null,
      safeMessage: null
    }
  ];
  const searches: EventSearchQuery[] = [];
  const connectedSources: EventSource[] = [];

  return {
    searches,
    connectedSources,
    connectorStatuses: statuses,
    getInterests: async () => interests,
    setInterests: async (next) => {
      interests = next;
      return next;
    },
    getConnectors: async () => statuses,
    connectSource: async (source) => {
      connectedSources.push(source);
    },
    startSearch: async (query) => {
      searches.push(query);
      return {
        searchId: "search-1",
        streamUrl: "/api/searches/search-1/stream"
      };
    },
    cancelSearch: async () => undefined,
    openSearchStream: (_url, onMessage) => {
      listener = onMessage;
      return () => {
        listener = null;
      };
    },
    emit: (message) => listener?.(message)
  };
}
