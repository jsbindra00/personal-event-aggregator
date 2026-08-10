import { describe, expect, it } from "vitest";

import {
  requestBoundedJson,
  requestBoundedText,
  type DirectRequestPolicy
} from "../src/index.js";

const policy: DirectRequestPolicy = {
  method: "GET",
  allowedHosts: ["api.example.test"],
  allowedPath: (pathname) => pathname === "/events",
  maxBodyBytes: 32,
  timeoutMs: 500
};

const signal = new AbortController().signal;

describe("bounded direct HTTP", () => {
  it("returns JSON from an allowlisted HTTPS endpoint", async () => {
    const result = await requestBoundedJson(
      {
        url: "https://api.example.test/events",
        fetch: async () => new Response('{"ok":true}')
      },
      policy,
      signal
    );

    expect(result).toEqual({ ok: true });
  });

  it.each([
    "http://api.example.test/events",
    "https://other.example.test/events",
    "https://api.example.test/private"
  ])("rejects a request outside the allowlist: %s", async (url) => {
    await expect(
      requestBoundedText(
        {
          url,
          fetch: async () => new Response("not reached")
        },
        policy,
        signal
      )
    ).rejects.toMatchObject({ code: "parsing" });
  });

  it("rejects a response that exceeds the byte limit", async () => {
    await expect(
      requestBoundedText(
        {
          url: "https://api.example.test/events",
          fetch: async () => new Response("x".repeat(33))
        },
        policy,
        signal
      )
    ).rejects.toMatchObject({ code: "parsing" });
  });

  it("classifies rate limits and respects delta-second retry-after", async () => {
    await expect(
      requestBoundedText(
        {
          url: "https://api.example.test/events",
          fetch: async () =>
            new Response("slow down", {
              status: 429,
              headers: { "retry-after": "2" }
            })
        },
        policy,
        signal
      )
    ).rejects.toMatchObject({ code: "rate_limited", retryAfterMs: 2_000 });
  });

  it("classifies a body stall that reaches the deadline as a network timeout", async () => {
    await expect(
      requestBoundedText(
        {
          url: "https://api.example.test/events",
          fetch: async (_input, init) =>
            new Response(
              new ReadableStream<Uint8Array>({
                start(controller) {
                  init?.signal?.addEventListener(
                    "abort",
                    () => controller.error(init.signal?.reason),
                    { once: true }
                  );
                }
              })
            )
        },
        { ...policy, timeoutMs: 5 },
        signal
      )
    ).rejects.toMatchObject({
      code: "network",
      message: "Event source request timed out"
    });
  });
});
