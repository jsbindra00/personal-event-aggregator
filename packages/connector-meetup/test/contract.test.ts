import type { ResolvedSearchQuery } from "@event-agg/core";
import type { Page } from "playwright-core";
import { describe, expect, it, vi } from "vitest";

import {
  meetupSearchContract,
  meetupSelectionMatches
} from "../src/contract.js";

const query: ResolvedSearchQuery = {
  locationText: "London",
  startDate: "2026-08-10",
  endDate: "2026-08-31",
  timeZone: "Europe/London",
  startsAtUtc: "2026-08-09T23:00:00.000Z",
  endsBeforeUtc: "2026-08-31T23:00:00.000Z"
};

describe("Meetup search interaction", () => {
  it("selects the first autocomplete result instead of trusting a stale location", async () => {
    const fill = vi.fn(async (_value: string) => undefined);
    const press = vi.fn(async (_key: string) => undefined);
    const inputValue = vi.fn(async () => "London, GB");
    const baseUrl = "https://www.meetup.com/find/?source=EVENTS";
    const pageUrl = vi.fn(() => baseUrl);
    const page = {
      goto: vi.fn(async () => undefined),
      url: pageUrl,
      getByLabel: vi.fn(() => ({ fill, press, inputValue })),
      waitForTimeout: vi.fn(async () => undefined),
      waitForResponse: vi.fn(async () => undefined),
      waitForLoadState: vi.fn(async () => undefined)
    } as unknown as Page;

    await meetupSearchContract.performSearch(page, query);

    expect(page.goto).toHaveBeenNthCalledWith(
      1,
      "https://www.meetup.com/find/?source=EVENTS",
      { waitUntil: "domcontentloaded" }
    );
    expect(page.goto).toHaveBeenCalledTimes(1);
    expect(page.getByLabel).toHaveBeenCalledWith(
      "Search for location by city or zip code"
    );
    expect(fill).toHaveBeenCalledWith("London");
    expect(press.mock.calls.map(([key]) => key)).toEqual([
      "ArrowDown",
      "Enter"
    ]);
    expect(page.waitForResponse).toHaveBeenCalledOnce();
    expect(page.waitForLoadState).not.toHaveBeenCalled();
  });

  it("rejects a stale city URL and accepts the selected location", () => {
    expect(
      meetupSelectionMatches(
        "London",
        "London",
        "https://www.meetup.com/find/?source=EVENTS&location=gb--43--Birmingham"
      )
    ).toBe(false);
    expect(
      meetupSelectionMatches(
        "London",
        "Birmingham, GB",
        "https://www.meetup.com/find/?source=EVENTS&location=gb--43--Birmingham"
      )
    ).toBe(false);
    expect(
      meetupSelectionMatches(
        "London",
        "London, GB",
        "https://www.meetup.com/find/?source=EVENTS"
      )
    ).toBe(true);
  });
});
