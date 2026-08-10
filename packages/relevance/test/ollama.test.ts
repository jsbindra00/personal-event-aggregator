import { createServer, type Server } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { createOllamaRelevanceEvaluator } from "../src/index.js";
import { decision, event, profile } from "./factories.js";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve()))
        )
    )
  );
});

describe("Ollama relevance evaluator", () => {
  it("requests non-streaming schema output at temperature zero and restores input order", async () => {
    const events = [event({ id: "luma:first" }), event({ id: "meetup:second" })];
    const server = await fakeOllama((request) => {
      expect(request.method).toBe("POST");
      expect(request.path).toBe("/api/chat");
      expect(request.body).toMatchObject({
        model: "gemma3:4b",
        stream: false,
        format: expect.objectContaining({
          type: "object",
          properties: {
            decisions: expect.objectContaining({
              minItems: 2,
              maxItems: 2,
              items: expect.objectContaining({
                properties: expect.objectContaining({
                  eventId: expect.objectContaining({
                    enum: ["event_1", "event_2"]
                  })
                })
              })
            })
          }
        }),
        options: { temperature: 0 },
        messages: [{ role: "user", content: expect.any(String) }]
      });
      const prompt = (request.body.messages as Array<{ content: string }>)[0]!
        .content;
      expect(prompt).toContain('"id":"event_1"');
      expect(prompt).toContain('"id":"event_2"');
      expect(prompt).not.toContain("luma:first");
      expect(prompt).not.toContain("meetup:second");
      return {
        message: {
          role: "assistant",
          content: JSON.stringify({
            decisions: [decision("event_2"), decision("event_1")]
          })
        }
      };
    });
    const evaluator = createOllamaRelevanceEvaluator({ endpoint: server.url });

    await expect(
      evaluator.evaluate(events, profile, new AbortController().signal)
    ).resolves.toEqual([decision("luma:first"), decision("meetup:second")]);
  });

  it("reports whether the configured model is installed", async () => {
    const ready = createOllamaRelevanceEvaluator({
      fetch: async () =>
        Response.json({ models: [{ name: "gemma3:4b", model: "gemma3:4b" }] })
    });
    const missing = createOllamaRelevanceEvaluator({
      fetch: async () => Response.json({ models: [{ name: "other:latest" }] })
    });

    await expect(ready.status()).resolves.toMatchObject({
      state: "ready",
      model: "gemma3:4b",
      safeMessage: null
    });
    await expect(missing.status()).resolves.toMatchObject({
      state: "unavailable",
      model: "gemma3:4b",
      safeMessage: "Local model gemma3:4b is not installed"
    });
  });

  it("reports a custom local model in status and its cache fingerprint", async () => {
    const evaluator = createOllamaRelevanceEvaluator({
      model: "gemma-custom:latest",
      fetch: async () =>
        Response.json({ models: [{ name: "gemma-custom:latest" }] })
    });

    await expect(evaluator.status()).resolves.toMatchObject({
      state: "ready",
      model: "gemma-custom:latest"
    });
    expect(evaluator.fingerprint).toContain("gemma-custom:latest");
  });

  it.each([
    {
      name: "missing ID",
      decisions: [decision("event_1")]
    },
    {
      name: "duplicate ID",
      decisions: [decision("event_1"), decision("event_1")]
    },
    {
      name: "unknown ID",
      decisions: [decision("event_1"), decision("unknown")]
    }
  ])("rejects a schema-valid batch with a $name", async ({ decisions }) => {
    const evaluator = evaluatorReturning({ decisions });
    const events = [event({ id: "luma:first" }), event({ id: "meetup:second" })];

    await expect(
      evaluator.evaluate(events, profile, new AbortController().signal)
    ).rejects.toThrow("Local relevance model returned invalid event IDs");
  });

  it.each([
    { response: new Response("not json"), message: "invalid response" },
    {
      response: Response.json({ message: { content: "not json" } }),
      message: "invalid response"
    },
    {
      response: Response.json({ message: { content: JSON.stringify({ decisions: [] }) } }),
      message: "invalid event IDs"
    },
    { response: new Response("private body", { status: 500 }), message: "unavailable" }
  ])("uses a safe error for $message", async ({ response, message }) => {
    const evaluator = createOllamaRelevanceEvaluator({ fetch: async () => response });

    await expect(
      evaluator.evaluate([event()], profile, new AbortController().signal)
    ).rejects.toThrow(message);
  });

  it("propagates caller cancellation", async () => {
    const evaluator = createOllamaRelevanceEvaluator({ fetch: abortableFetch });
    const controller = new AbortController();
    const evaluation = evaluator.evaluate([event()], profile, controller.signal);
    controller.abort(new Error("caller cancelled"));

    await expect(evaluation).rejects.toThrow("caller cancelled");
  });

  it("times out a stalled local model request", async () => {
    const evaluator = createOllamaRelevanceEvaluator({
      fetch: abortableFetch,
      timeoutMs: 5
    });

    await expect(
      evaluator.evaluate([event()], profile, new AbortController().signal)
    ).rejects.toThrow("timed out");
  });

  it("rejects a non-loopback model endpoint", () => {
    expect(() =>
      createOllamaRelevanceEvaluator({ endpoint: "http://model.example.test:11434" })
    ).toThrow(/loopback/i);
  });
});

function evaluatorReturning(value: unknown) {
  return createOllamaRelevanceEvaluator({
    fetch: async () =>
      Response.json({
        message: { role: "assistant", content: JSON.stringify(value) }
      })
  });
}

const abortableFetch: typeof globalThis.fetch = async (_input, init) =>
  new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
  });

async function fakeOllama(
  handler: (request: {
    method: string;
    path: string;
    body: Record<string, unknown>;
  }) => unknown
): Promise<{ url: string }> {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
          string,
          unknown
        >;
        const value = handler({
          method: request.method ?? "",
          path: request.url ?? "",
          body
        });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(value));
      } catch (error) {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: String(error) }));
      }
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No port");
  return { url: `http://127.0.0.1:${address.port}` };
}
