import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  LumaPayloadError,
  parseLumaSearchPayload
} from "../src/parser.js";

function loadFixture(): unknown {
  return JSON.parse(
    readFileSync(
      new URL("../fixtures/search-page-1.redacted.json", import.meta.url),
      "utf8"
    )
  ) as unknown;
}

describe("parseLumaSearchPayload", () => {
  it("maps the exact captured response envelope", () => {
    const page = parseLumaSearchPayload(loadFixture());

    expect(page.events).toHaveLength(2);
    expect(page.events[0]).toMatchObject({
      source: "luma",
      sourceEventId: "evt_fixture_1",
      canonicalUrl: "https://luma.com/evt-fixture-1",
      title: "AI Builders London",
      addressText: "Fixture Hall, London, United Kingdom",
      organizerName: "London Builders",
      priceText: "Free"
    });
    expect(Number.isNaN(Date.parse(page.events[0]?.startsAt ?? ""))).toBe(false);
    expect(page.events[1]).toMatchObject({
      sourceEventId: "evt_fixture_2",
      isOnline: true,
      priceText: "GBP 5.00"
    });
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).toBe("cursor_fixture_page_2");
  });

  it("reports contract drift instead of guessing at unrelated arrays", () => {
    expect(() => parseLumaSearchPayload({ events: [] })).toThrowError(
      LumaPayloadError
    );
    try {
      parseLumaSearchPayload({ events: [] });
    } catch (error) {
      expect(error).toMatchObject({ code: "contract_drift" });
    }
  });
});
