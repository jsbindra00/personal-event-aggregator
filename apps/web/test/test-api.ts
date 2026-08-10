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
  cancelledSearches: string[];
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
  const cancelledSearches: string[] = [];

  return {
    searches,
    cancelledSearches,
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
      const searchId = `search-${searches.length}`;
      return {
        searchId,
        streamUrl: `/api/searches/${searchId}/stream`
      };
    },
    cancelSearch: async (searchId) => {
      cancelledSearches.push(searchId);
    },
    openSearchStream: (_url, onMessage) => {
      listener = onMessage;
      return () => {
        listener = null;
      };
    },
    emit: (message) => listener?.(message)
  };
}
