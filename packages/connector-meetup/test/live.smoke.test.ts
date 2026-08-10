import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BrowserHost } from "@event-agg/browser";
import { resolveSearchQuery } from "@event-agg/core";
import { expect, it } from "vitest";

import { createMeetupConnector } from "../src/connector.js";
import {
  enforceReadOnlyMeetupPage,
  meetupSearchContract
} from "../src/contract.js";

const liveTest = process.env.LIVE_CONNECTOR_SMOKE === "meetup" ? it : it.skip;

liveTest("performs a read-only Meetup search", async () => {
  const profilePath = await mkdtemp(join(tmpdir(), "event-agg-meetup-live-"));
  const host = new BrowserHost({
    profilePath,
    launchOptions: { headless: true }
  });

  try {
    const page = await host.pageFor("meetup", meetupSearchContract.connectUrl);
    await enforceReadOnlyMeetupPage(page);
    await page.waitForLoadState("networkidle");
    const completedDisallowedMutations: string[] = [];
    page.on("requestfinished", (request) => {
      const operation = meetupOperationName(request.postData());
      if (
        !["GET", "HEAD", "OPTIONS"].includes(request.method()) &&
        new URL(request.url()).pathname !== "/orion/v3/identity/settings" &&
        ![
          "getSelf",
          "unreadMessages",
          "getLocationSearch",
          "recommendedEventsWithSeries"
        ].includes(operation)
      ) {
        completedDisallowedMutations.push(`${request.method()} ${request.url()}`);
      }
    });

    const connector = createMeetupConnector(host, { maxPages: 1 });
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
    expect(completedDisallowedMutations).toEqual([]);
  } finally {
    await host.close();
  }
}, 30_000);

function meetupOperationName(postData: string | null): string {
  if (postData === null) return "";
  try {
    const payload = JSON.parse(postData) as { operationName?: unknown };
    return typeof payload.operationName === "string" ? payload.operationName : "";
  } catch {
    return "";
  }
}
