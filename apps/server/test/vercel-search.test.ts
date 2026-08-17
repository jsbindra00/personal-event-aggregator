import { describe, expect, it } from "vitest";

import type { SearchStreamMessage } from "@event-agg/core";

import { createSearchHandler } from "../src/vercel-search.js";

const requestBody = {
  query: {
    locationText: "Birmingham",
    startDate: "2026-08-17",
    endDate: "2026-09-16",
    timeZone: "Europe/London"
  },
  interests: {
    positive: ["AI"],
    excluded: [],
    note: "Technical talks"
  }
};

describe("public search function", () => {
  it("rejects unsupported methods without invoking a search", async () => {
    let invoked = false;
    const handler = createSearchHandler(async function* () {
      invoked = true;
    });

    const response = await handler(
      new Request("https://events.example/api/search", { method: "GET" })
    );

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
    expect(invoked).toBe(false);
  });

  it("returns a 400 JSON response before streaming invalid input", async () => {
    const handler = createSearchHandler(async function* () {
      throw new Error("must not run");
    });

    const response = await handler(post({
      ...requestBody,
      interests: { ...requestBody.interests, positive: [] }
    }));

    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toMatchObject({ error: "validation_error" });
  });

  it("streams newline-delimited search messages with no-cache headers", async () => {
    const handler = createSearchHandler(async function* () {
      yield started;
      yield completed;
    });

    const response = await handler(post(requestBody));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "application/x-ndjson; charset=utf-8"
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    const lines = (await response.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(lines).toEqual([started, completed]);
  });

  it("makes the first search message readable before completion", async () => {
    let finish!: () => void;
    const waitForFinish = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const handler = createSearchHandler(async function* () {
      yield started;
      await waitForFinish;
      yield completed;
    });

    const response = await handler(post(requestBody));
    const reader = response.body!.getReader();
    const first = await reader.read();

    expect(new TextDecoder().decode(first.value)).toBe(
      `${JSON.stringify(started)}\n`
    );
    finish();
    await reader.cancel();
  });
});

const started: SearchStreamMessage = {
  sequence: 1,
  searchId: "public-search-1",
  type: "search.started"
};

const completed: SearchStreamMessage = {
  sequence: 2,
  searchId: "public-search-1",
  type: "search.completed"
};

function post(body: unknown): Request {
  return new Request("https://events.example/api/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}
