import type {
  ConnectorStatus,
  EventSearchQuery,
  EventSource,
  InterestProfile,
  SearchStreamMessage
} from "@event-agg/core";
import { interestProfileSchema } from "@event-agg/core/schemas";

import type { EventApi } from "./api.js";

export const PUBLIC_INTERESTS_KEY = "event-aggregator:interests:v1";

const emptyInterests: InterestProfile = { positive: [], excluded: [], note: "" };
const sources: EventSource[] = ["meetup", "luma", "guild", "eventbrite"];
const messageTypes = new Set<SearchStreamMessage["type"]>([
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
]);

export interface BrowserStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface PublicEventApiOptions {
  storage?: BrowserStorage;
  fetch?: typeof globalThis.fetch;
  createId?: () => string;
  baseUrl?: string;
}

interface StreamListener {
  onMessage(message: SearchStreamMessage): void;
  onError?: () => void;
}

interface BrowserSearch {
  controller: AbortController;
  messages: SearchStreamMessage[];
  listeners: Set<StreamListener>;
  failed: boolean;
  done: boolean;
}

export function createPublicEventApi(
  options: PublicEventApiOptions = {}
): EventApi {
  const storage = options.storage ?? globalThis.localStorage;
  const fetch = options.fetch ?? globalThis.fetch;
  const createId = options.createId ?? (() => globalThis.crypto.randomUUID());
  const baseUrl = options.baseUrl ?? "";
  const searches = new Map<string, BrowserSearch>();

  function readInterests(): InterestProfile {
    const value = storage.getItem(PUBLIC_INTERESTS_KEY);
    if (value === null) return { ...emptyInterests };
    try {
      const parsed = interestProfileSchema.safeParse(JSON.parse(value));
      return parsed.success ? parsed.data : { ...emptyInterests };
    } catch {
      return { ...emptyInterests };
    }
  }

  function emit(search: BrowserSearch, message: SearchStreamMessage): void {
    search.messages.push(message);
    for (const listener of search.listeners) listener.onMessage(message);
  }

  function fail(search: BrowserSearch): void {
    search.failed = true;
    search.done = true;
    for (const listener of search.listeners) listener.onError?.();
  }

  async function consumeSearch(
    search: BrowserSearch,
    query: EventSearchQuery,
    interests: InterestProfile
  ): Promise<void> {
    try {
      const response = await fetch(`${baseUrl}/api/search`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query, interests }),
        signal: search.controller.signal
      });
      if (!response.ok) {
        const detail = (await response.json().catch(() => null)) as
          | { message?: string }
          | null;
        throw new Error(detail?.message ?? `Search failed with ${response.status}`);
      }
      if (response.body === null) throw new Error("Search response did not stream");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffered = "";
      while (true) {
        const chunk = await reader.read();
        buffered += decoder.decode(chunk.value, { stream: !chunk.done });
        const lines = buffered.split("\n");
        buffered = lines.pop() ?? "";
        for (const line of lines) {
          if (line.trim() !== "") emit(search, parseMessage(line));
        }
        if (chunk.done) break;
      }
      if (buffered.trim() !== "") emit(search, parseMessage(buffered));
      search.done = true;
    } catch {
      if (!search.controller.signal.aborted) fail(search);
    }
  }

  return {
    isPublicMode: true,
    getInterests: async () => readInterests(),
    setInterests: async (profile) => {
      const normalized = normalizeProfile(profile);
      storage.setItem(PUBLIC_INTERESTS_KEY, JSON.stringify(normalized));
      return normalized;
    },
    getConnectors: async () => sources.map(readyStatus),
    connectSource: async () => undefined,
    startSearch: async (query) => {
      const searchId = createId();
      const search: BrowserSearch = {
        controller: new AbortController(),
        messages: [],
        listeners: new Set(),
        failed: false,
        done: false
      };
      searches.set(searchId, search);
      void consumeSearch(search, query, readInterests());
      return { searchId, streamUrl: `public:${searchId}` };
    },
    cancelSearch: async (searchId) => {
      const search = searches.get(searchId);
      search?.controller.abort(new DOMException("Search cancelled", "AbortError"));
      searches.delete(searchId);
    },
    openSearchStream: (streamUrl, onMessage, onError) => {
      const searchId = streamUrl.startsWith("public:")
        ? streamUrl.slice("public:".length)
        : "";
      const search = searches.get(searchId);
      if (search === undefined) {
        queueMicrotask(() => onError?.());
        return () => undefined;
      }
      const listener = { onMessage, ...(onError === undefined ? {} : { onError }) };
      search.listeners.add(listener);
      for (const message of search.messages) onMessage(message);
      if (search.failed) queueMicrotask(() => onError?.());
      return () => {
        search.listeners.delete(listener);
        if (search.done && search.listeners.size === 0) searches.delete(searchId);
      };
    }
  };
}

function normalizeProfile(profile: InterestProfile): InterestProfile {
  return {
    positive: uniqueLines(profile.positive),
    excluded: uniqueLines(profile.excluded),
    note: profile.note.trim()
  };
}

function uniqueLines(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function readyStatus(source: EventSource): ConnectorStatus {
  return {
    source,
    state: "ready",
    lastSuccessAt: null,
    errorCode: null,
    safeMessage: null
  };
}

function parseMessage(line: string): SearchStreamMessage {
  const value = JSON.parse(line) as unknown;
  if (typeof value !== "object" || value === null) throw new Error("Invalid stream message");
  const candidate = value as Partial<SearchStreamMessage>;
  if (
    !Number.isSafeInteger(candidate.sequence) ||
    typeof candidate.searchId !== "string" ||
    !messageTypes.has(candidate.type as SearchStreamMessage["type"])
  ) {
    throw new Error("Invalid stream message");
  }
  return candidate as SearchStreamMessage;
}
