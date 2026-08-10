import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BrowserHost } from "../../packages/browser/src/index.js";
import {
  normalizeEvent,
  resolveSearchQuery,
  type ConnectorMessage,
  type EventConnector,
  type EventSource
} from "../../packages/core/src/index.js";
import {
  createDirectEventbriteConnector,
  createEventbriteConnector
} from "../../packages/connector-eventbrite/src/index.js";
import {
  createDirectLumaConnector,
  createLumaConnector
} from "../../packages/connector-luma/src/index.js";
import {
  createDirectMeetupConnector,
  createMeetupConnector
} from "../../packages/connector-meetup/src/index.js";
import { expect, it } from "vitest";

type ParitySource = Exclude<EventSource, "guild">;

const sources: ParitySource[] = ["eventbrite", "luma", "meetup"];
const query = resolveSearchQuery({
  locationText: "London",
  startDate: "2026-08-10",
  endDate: "2026-09-10",
  timeZone: "Europe/London"
});

for (const source of sources) {
  const live = process.env.LIVE_DIRECT_PARITY === source ? it : it.skip;

  live(
    `compares ${source} direct and browser candidates`,
    async () => {
      const profilePath = await mkdtemp(
        join(tmpdir(), `event-agg-${source}-parity-`)
      );
      const browserHost = new BrowserHost({
        profilePath,
        launchOptions: { headless: true }
      });

      try {
        const connectors = connectorsFor(source, browserHost);
        const browser = await collect(
          connectors.browser,
          AbortSignal.timeout(90_000)
        );
        const direct = await collect(
          connectors.direct,
          AbortSignal.timeout(90_000)
        );
        const browserUrls = new Set(browser.urls);
        const overlap = direct.urls.filter((url) => browserUrls.has(url)).length;
        const aggregate = {
          source,
          browserCount: browser.urls.length,
          directCount: direct.urls.length,
          overlap,
          browserTerminal: browser.terminal,
          directTerminal: direct.terminal
        };

        console.info(JSON.stringify(aggregate));
        expect(direct.urls.length, JSON.stringify(aggregate)).toBeGreaterThanOrEqual(
          browser.urls.length
        );
        expect(overlap, JSON.stringify(aggregate)).toBeGreaterThan(0);
      } finally {
        await browserHost.close();
      }
    },
    200_000
  );
}

function connectorsFor(
  source: ParitySource,
  browserHost: BrowserHost
): { browser: EventConnector; direct: EventConnector } {
  switch (source) {
    case "eventbrite":
      return {
        browser: createEventbriteConnector(browserHost),
        direct: createDirectEventbriteConnector()
      };
    case "luma":
      return {
        browser: createLumaConnector(browserHost, { maxPages: 1 }),
        direct: createDirectLumaConnector({ maxPages: 1 })
      };
    case "meetup":
      return {
        browser: createMeetupConnector(browserHost, { maxPages: 1 }),
        direct: createDirectMeetupConnector({ maxPages: 1 })
      };
  }
}

async function collect(
  connector: EventConnector,
  signal: AbortSignal
): Promise<{ urls: string[]; terminal: string }> {
  const urls: string[] = [];
  let terminal = "missing";
  for await (const message of connector.search(query, signal)) {
    if (message.type === "event") {
      urls.push(normalizeEvent(message.event).canonicalUrl);
    }
    if (isTerminal(message)) {
      terminal =
        message.type === "failed"
          ? `failed:${message.errorCode}`
          : message.type;
    }
  }
  return { urls: [...new Set(urls)], terminal };
}

function isTerminal(message: ConnectorMessage): boolean {
  return [
    "complete",
    "failed",
    "auth_required",
    "user_action_required",
    "rate_limited"
  ].includes(message.type);
}
