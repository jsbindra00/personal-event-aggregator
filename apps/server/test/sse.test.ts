import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { pipeSse, serializeSseMessage } from "../src/sse.js";
import type { SearchStreamMessage } from "../../../packages/core/src/types.js";

const started: SearchStreamMessage = {
  sequence: 7,
  searchId: "search-1",
  type: "search.started"
};

describe("serializeSseMessage", () => {
  it("writes sequence, event type, and one JSON data line", () => {
    expect(serializeSseMessage(started)).toBe(
      'id: 7\nevent: search.started\ndata: {"sequence":7,"searchId":"search-1","type":"search.started"}\n\n'
    );
  });
});

describe("pipeSse", () => {
  it("writes every message and closes a finite stream", async () => {
    async function* messages() {
      yield started;
      yield { ...started, sequence: 8, type: "search.completed" as const };
    }
    const output = new PassThrough();
    let body = "";
    output.setEncoding("utf8");
    output.on("data", (chunk: string) => {
      body += chunk;
    });

    await pipeSse(messages(), output);

    expect(body).toContain("id: 7\nevent: search.started");
    expect(body).toContain("id: 8\nevent: search.completed");
    expect(output.writableEnded).toBe(true);
  });

  it("unsubscribes promptly when the client disconnects", async () => {
    const iterator = {
      next: vi.fn(() => new Promise<IteratorResult<SearchStreamMessage>>(() => undefined)),
      return: vi.fn(async () => ({ done: true as const, value: undefined }))
    };
    const messages = {
      [Symbol.asyncIterator]: () => iterator
    };
    const output = new PassThrough();

    const piping = pipeSse(messages, output);
    await Promise.resolve();
    output.destroy();
    await piping;

    expect(iterator.return).toHaveBeenCalledOnce();
  });
});
