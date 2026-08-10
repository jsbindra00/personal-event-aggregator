import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("redacted Meetup fixtures", () => {
  const fixtures = [
    "../fixtures/search-page-1.redacted.json",
    "../fixtures/location-search.redacted.json"
  ].map((path) => readFileSync(new URL(path, import.meta.url), "utf8"));
  const text = fixtures.join("\n");

  it("is valid JSON with two synthetic events", () => {
    const payload = JSON.parse(fixtures[0]!) as {
      data?: { result?: { edges?: unknown[] } };
    };
    expect(payload.data?.result?.edges).toHaveLength(2);
  });

  it("contains no secrets or personal contact data", () => {
    const prohibited = new RegExp(
      [
        "authorization",
        "set" + "-cookie",
        "cookie\\s*:",
        "c" + "srf",
        "bearer\\s",
        "@[a-z0-9.-]+\\.[a-z]{2,}"
      ].join("|"),
      "i"
    );
    expect(text).not.toMatch(prohibited);
    expect(text).not.toMatch(/memberPhoto|rsvps|user\s*[:_]|account\s*[:_]/i);
  });
});
