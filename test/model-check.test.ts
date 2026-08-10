import { describe, expect, it, vi } from "vitest";

import { checkLocalModel } from "../scripts/check-local-model.js";

describe("local model readiness check", () => {
  it("accepts the configured installed model", async () => {
    const write = vi.fn();
    const ready = await checkLocalModel({
      environment: {
        EVENT_AGG_OLLAMA_URL: "http://localhost:11434",
        EVENT_AGG_RELEVANCE_MODEL: "gemma3:4b"
      },
      fetch: async () =>
        Response.json({ models: [{ name: "gemma3:4b" }] }),
      write
    });

    expect(ready).toBe(true);
    expect(write).toHaveBeenCalledWith("Local model gemma3:4b is ready\n");
  });

  it("prints the exact pull command when the model is missing", async () => {
    const write = vi.fn();
    const ready = await checkLocalModel({
      environment: {},
      fetch: async () => Response.json({ models: [] }),
      write
    });

    expect(ready).toBe(false);
    expect(write).toHaveBeenCalledWith(
      "Missing local model gemma3:4b\nRun: ollama pull gemma3:4b\n"
    );
  });

  it("rejects non-loopback endpoints without making a request", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const write = vi.fn();
    const ready = await checkLocalModel({
      environment: { EVENT_AGG_OLLAMA_URL: "https://example.com" },
      fetch,
      write
    });

    expect(ready).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
    expect(write.mock.calls[0]?.[0]).toMatch(/loopback/i);
  });
});
