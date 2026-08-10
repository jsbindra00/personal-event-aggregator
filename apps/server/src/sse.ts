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
  try {
    for await (const message of messages) {
      if (!output.write(serializeSseMessage(message))) {
        await once(output, "drain");
      }
    }
  } finally {
    if (!output.writableEnded) {
      output.end();
    }
  }
}

