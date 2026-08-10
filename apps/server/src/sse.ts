import { once } from "node:events";
import type { Writable } from "node:stream";

import type { SearchStreamMessage } from "@event-agg/core";

export function serializeSseMessage(message: SearchStreamMessage): string {
  return `id: ${message.sequence}\nevent: ${message.type}\ndata: ${JSON.stringify(message)}\n\n`;
}

export async function pipeSse(
  messages: AsyncIterable<SearchStreamMessage>,
  output: Writable
): Promise<void> {
  const iterator = messages[Symbol.asyncIterator]();
  const disconnected = Symbol("disconnected");
  let resolveDisconnect!: (value: typeof disconnected) => void;
  const disconnect = new Promise<typeof disconnected>((resolve) => {
    resolveDisconnect = resolve;
  });
  const onDisconnect = () => resolveDisconnect(disconnected);
  output.once("close", onDisconnect);
  output.once("error", onDisconnect);

  try {
    while (!output.destroyed) {
      const next = iterator.next().then((result) => ({ result }));
      const outcome = await Promise.race([next, disconnect]);
      if (outcome === disconnected || outcome.result.done) break;

      if (!output.write(serializeSseMessage(outcome.result.value))) {
        const drained = await Promise.race([once(output, "drain"), disconnect]);
        if (drained === disconnected) break;
      }
    }
  } finally {
    output.off("close", onDisconnect);
    output.off("error", onDisconnect);
    const returned = iterator.return?.();
    if (returned) void returned.catch(() => undefined);
    if (!output.destroyed && !output.writableEnded) {
      output.end();
    }
  }
}
