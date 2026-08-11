import { resolveSearchQuery } from "@event-agg/core";
import { expect, it } from "vitest";

import { createGuildConnector } from "../src/connector.js";

const liveTest = process.env.LIVE_CONNECTOR_SMOKE === "guild" ? it : it.skip;

liveTest("reads the public Guild.host feed without a browser", async () => {
  const now = new Date();
  const end = new Date(now);
  end.setUTCDate(end.getUTCDate() + 30);
  const query = resolveSearchQuery({
    locationText: "Birmingham",
    startDate: now.toISOString().slice(0, 10),
    endDate: end.toISOString().slice(0, 10),
    timeZone: "Europe/London"
  });
  const messages = [];
  for await (const message of createGuildConnector().search(
    query,
    new AbortController().signal
  )) {
    messages.push(message);
  }

  expect(messages.at(-1)?.type, JSON.stringify(messages.at(-1))).toBe(
    "complete"
  );
}, 60_000);
