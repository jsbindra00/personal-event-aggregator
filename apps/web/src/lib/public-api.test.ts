import { describe, expect, it } from "vitest";

import type { SearchStreamMessage } from "@event-agg/core";

import {
  PUBLIC_INTERESTS_KEY,
  createPublicEventApi,
  type BrowserStorage
} from "./public-api.js";

describe("createPublicEventApi", () => {
  it("stores a versioned interest profile in the visitor's browser", async () => {
    const storage = memoryStorage();
    const api = createPublicEventApi({ storage, fetch: unusedFetch });

    expect(await api.getInterests()).toEqual({
      positive: [],
      excluded: [],
      note: ""
    });
    await api.setInterests({
      positive: ["AI", "AI", "software engineering"],
      excluded: ["crypto sales"],
      note: "Technical talks"
    });

    expect(JSON.parse(storage.getItem(PUBLIC_INTERESTS_KEY)!)).toEqual({
      positive: ["AI", "software engineering"],
      excluded: ["crypto sales"],
      note: "Technical talks"
    });
    expect(await api.getInterests()).toEqual({
      positive: ["AI", "software engineering"],
      excluded: ["crypto sales"],
      note: "Technical talks"
    });
  });

  it("posts interests with the query and replays buffered stream messages", async () => {
    const storage = memoryStorage();
    storage.setItem(
      PUBLIC_INTERESTS_KEY,
      JSON.stringify({ positive: ["AI"], excluded: [], note: "Builders" })
    );
    let capturedBody: unknown;
    const fetch: typeof globalThis.fetch = async (_input, init) => {
      capturedBody = JSON.parse(String(init?.body));
      return ndjsonResponse([started, completed]);
    };
    const api = createPublicEventApi({
      storage,
      fetch,
      createId: () => "browser-search-1"
    });

    const search = await api.startSearch(query);
    await tick();
    const messages: SearchStreamMessage[] = [];
    api.openSearchStream(search.streamUrl, (message) => messages.push(message));

    expect(capturedBody).toEqual({
      query,
      interests: { positive: ["AI"], excluded: [], note: "Builders" }
    });
    expect(messages).toEqual([started, completed]);
  });

  it("reports a malformed stream line through the stream error callback", async () => {
    const api = createPublicEventApi({
      storage: storageWithInterests(),
      fetch: async () => new Response("not-json\n", { status: 200 }),
      createId: () => "browser-search-2"
    });
    const search = await api.startSearch(query);

    const error = new Promise<void>((resolve) => {
      api.openSearchStream(search.streamUrl, () => undefined, resolve);
    });

    await error;
  });

  it("aborts the hosted request when a search is cancelled", async () => {
    let requestSignal: AbortSignal | undefined;
    const fetch: typeof globalThis.fetch = async (_input, init) => {
      requestSignal = init?.signal ?? undefined;
      return await new Promise<Response>((_resolve, reject) => {
        requestSignal?.addEventListener(
          "abort",
          () => reject(new DOMException("Cancelled", "AbortError")),
          { once: true }
        );
      });
    };
    const api = createPublicEventApi({
      storage: storageWithInterests(),
      fetch,
      createId: () => "browser-search-3"
    });

    await api.startSearch(query);
    await api.cancelSearch("browser-search-3");

    expect(requestSignal?.aborted).toBe(true);
  });
});

const query = {
  locationText: "Birmingham",
  startDate: "2026-08-17",
  endDate: "2026-09-16",
  timeZone: "Europe/London"
};

const started: SearchStreamMessage = {
  sequence: 1,
  searchId: "server-search-1",
  type: "search.started"
};

const completed: SearchStreamMessage = {
  sequence: 2,
  searchId: "server-search-1",
  type: "search.completed"
};

function ndjsonResponse(messages: readonly SearchStreamMessage[]): Response {
  return new Response(`${messages.map((message) => JSON.stringify(message)).join("\n")}\n`, {
    status: 200,
    headers: { "content-type": "application/x-ndjson" }
  });
}

function storageWithInterests(): BrowserStorage {
  const storage = memoryStorage();
  storage.setItem(
    PUBLIC_INTERESTS_KEY,
    JSON.stringify({ positive: ["AI"], excluded: [], note: "" })
  );
  return storage;
}

function memoryStorage(): BrowserStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value)
  };
}

async function unusedFetch(): Promise<Response> {
  throw new Error("fetch should not be called");
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
