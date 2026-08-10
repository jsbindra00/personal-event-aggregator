import type { Page, Response } from "playwright-core";
import { describe, expect, it } from "vitest";

import { observeJsonResponses } from "../src/observe-json.js";

interface ListenerPage {
  on(event: "response", listener: (response: Response) => void): void;
  off(event: "response", listener: (response: Response) => void): void;
  emit(response: Response): void;
}

function createPage(): ListenerPage {
  const listeners = new Set<(response: Response) => void>();
  return {
    on: (_event, listener) => listeners.add(listener),
    off: (_event, listener) => listeners.delete(listener),
    emit: (response) => {
      for (const listener of listeners) listener(response);
    }
  };
}

function response(options: {
  url?: string;
  contentType?: string;
  body?: string;
  contentLength?: string;
} = {}): Response {
  const body = options.body ?? '{"events":[{"title":"Safe fixture"}]}';
  return {
    url: () => options.url ?? "http://127.0.0.1/events.json",
    headers: () => ({
      "content-type": options.contentType ?? "application/json",
      ...(options.contentLength === undefined
        ? {}
        : { "content-length": options.contentLength })
    }),
    body: async () => Buffer.from(body)
  } as unknown as Response;
}

const policy = {
  allowedHosts: ["127.0.0.1"],
  maxBodyBytes: 1_000_000,
  responseMatches: (candidate: Response) => candidate.url().endsWith("/events.json")
};

describe("observeJsonResponses", () => {
  it("captures matching JSON responses during the bounded action", async () => {
    const page = createPage();
    const payloads = await observeJsonResponses(
      page as unknown as Page,
      policy,
      async () => page.emit(response())
    );

    expect(payloads).toEqual([{ events: [{ title: "Safe fixture" }] }]);
  });

  it.each([
    ["a disallowed host", response({ url: "https://example.com/events.json" })],
    ["a non-JSON response", response({ contentType: "text/html" })],
    ["an oversized declared body", response({ contentLength: "1000001" })],
    ["an oversized received body", response({ body: `"${"x".repeat(1_000_001)}"` })]
  ])("discards %s", async (_label, candidate) => {
    const page = createPage();
    const payloads = await observeJsonResponses(
      page as unknown as Page,
      policy,
      async () => page.emit(candidate)
    );

    expect(payloads).toEqual([]);
  });

  it("removes its response listener when the action aborts", async () => {
    const page = createPage();
    await expect(
      observeJsonResponses(page as unknown as Page, policy, async () => {
        throw new DOMException("cancelled", "AbortError");
      })
    ).rejects.toMatchObject({ name: "AbortError" });

    page.emit(response());
    const payloads = await observeJsonResponses(
      page as unknown as Page,
      policy,
      async () => undefined
    );
    expect(payloads).toEqual([]);
  });
});
