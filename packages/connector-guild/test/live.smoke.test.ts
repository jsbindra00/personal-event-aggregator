import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BrowserHost } from "@event-agg/browser";
import { expect, it } from "vitest";

import { GUILD_CLOSURE_URL } from "../src/contract.js";

const liveTest = process.env.LIVE_CONNECTOR_SMOKE === "guild" ? it : it.skip;

liveTest("verifies the official Guild closure page", async () => {
  const profilePath = await mkdtemp(join(tmpdir(), "event-agg-guild-live-"));
  const host = new BrowserHost({
    profilePath,
    launchOptions: { headless: true }
  });
  try {
    const page = await host.pageFor("guild", GUILD_CLOSURE_URL);
    const text = await page.locator("body").innerText();
    expect(text).toContain("closed on 1 October 2024");
  } finally {
    await host.close();
  }
}, 30_000);
