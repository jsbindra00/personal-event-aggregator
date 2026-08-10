import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BrowserHost } from "@event-agg/browser";
import { resolveSearchQuery } from "@event-agg/core";
import { expect, it } from "vitest";

import { createLumaConnector } from "../src/connector.js";
import {
  enforceReadOnlyLumaPage,
  lumaSearchContract
} from "../src/contract.js";

const liveTest = process.env.LIVE_CONNECTOR_SMOKE === "luma" ? it : it.skip;

liveTest("performs a read-only Luma search", async () => {
  const profilePath = await mkdtemp(join(tmpdir(), "event-agg-luma-live-"));
  const host = new BrowserHost({
    profilePath,
    launchOptions: { headless: true }
  });

  try {
    const completedMutations: string[] = [];
    const page = await host.pageFor("luma", lumaSearchContract.connectUrl);
    await enforceReadOnlyLumaPage(page);
    await page.waitForLoadState("networkidle");
    page.on("requestfinished", (request) => {
      if (!["GET", "HEAD", "OPTIONS"].includes(request.method())) {
        completedMutations.push(`${request.method()} ${request.url()}`);
      }
    });
    const connector = createLumaConnector(host, { maxPages: 1 });
    const query = resolveSearchQuery({
      locationText: "London",
      startDate: "2026-08-10",
      endDate: "2026-09-10",
      timeZone: "Europe/London"
    });
    const messages = [];
    for await (const message of connector.search(
      query,
      new AbortController().signal
    )) {
      messages.push(message);
    }

    expect(
      messages.some((message) => message.type === "event"),
      JSON.stringify(messages)
    ).toBe(true);
    expect(messages.at(-1)?.type).toBe("complete");
    expect(completedMutations).toEqual([]);
  } finally {
    await host.close();
  }
}, 30_000);
