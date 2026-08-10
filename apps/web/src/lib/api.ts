import type {
  ConnectorStatus,
  EventSearchQuery,
  EventSource,
  InterestProfile,
  SearchStreamMessage
} from "@event-agg/core";

export interface EventApi {
  getInterests(): Promise<InterestProfile>;
  setInterests(profile: InterestProfile): Promise<InterestProfile>;
  getConnectors(): Promise<ConnectorStatus[]>;
  connectSource(source: EventSource): Promise<void>;
  startSearch(query: EventSearchQuery): Promise<{
    searchId: string;
    streamUrl: string;
  }>;
  cancelSearch(searchId: string): Promise<void>;
  openSearchStream(
    streamUrl: string,
    onMessage: (message: SearchStreamMessage) => void,
    onError?: () => void
  ): () => void;
}

const streamEventTypes: SearchStreamMessage["type"][] = [
  "search.started",
  "source.progress",
  "source.auth_required",
  "source.user_action_required",
  "source.rate_limited",
  "source.failed",
  "event.added",
  "event.updated",
  "event.maybe",
  "relevance.progress",
  "relevance.fallback",
  "source.completed",
  "search.completed"
];

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...init?.headers
    }
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as
      | { message?: string }
      | null;
    throw new Error(body?.message ?? `Request failed with ${response.status}`);
  }
  return (await response.json()) as T;
}

export function createEventApi(baseUrl = ""): EventApi {
  return {
    getInterests: () => fetchJson(`${baseUrl}/api/interests`),
    setInterests: (profile) =>
      fetchJson(`${baseUrl}/api/interests`, {
        method: "PUT",
        body: JSON.stringify(profile)
      }),
    getConnectors: () => fetchJson(`${baseUrl}/api/connectors`),
    connectSource: async (source) => {
      await fetchJson(`${baseUrl}/api/connectors/${source}/connect`, {
        method: "POST"
      });
    },
    startSearch: (query) =>
      fetchJson(`${baseUrl}/api/searches`, {
        method: "POST",
        body: JSON.stringify(query)
      }),
    cancelSearch: async (searchId) => {
      await fetchJson(`${baseUrl}/api/searches/${searchId}/cancel`, {
        method: "POST"
      });
    },
    openSearchStream: (streamUrl, onMessage, onError) => {
      const source = new EventSource(`${baseUrl}${streamUrl}`);
      const listeners = streamEventTypes.map((type) => {
        const listener = (event: Event) => {
          const message = JSON.parse((event as MessageEvent<string>).data) as
            SearchStreamMessage;
          onMessage(message);
        };
        source.addEventListener(type, listener);
        return { type, listener };
      });
      if (onError) {
        source.addEventListener("error", onError);
      }
      return () => {
        for (const { type, listener } of listeners) {
          source.removeEventListener(type, listener);
        }
        if (onError) {
          source.removeEventListener("error", onError);
        }
        source.close();
      };
    }
  };
}
