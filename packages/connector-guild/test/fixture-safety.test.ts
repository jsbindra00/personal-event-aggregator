import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("redacted Guild.host fixtures", () => {
  const fixtures = [
    "../fixtures/upcoming-page-1.redacted.json",
    "../fixtures/upcoming-page-2.redacted.json"
  ].map((path) => readFileSync(new URL(path, import.meta.url), "utf8"));
  const text = fixtures.join("\n");

  it("contains only synthetic public event data", () => {
    expect(
      fixtures.flatMap((fixture) => {
        const payload = JSON.parse(fixture) as { edges: unknown[] };
        return payload.edges;
      })
    ).toHaveLength(5);
    expect(text).not.toMatch(
      /authorization|set-cookie|cookie\s*:|csrf|bearer\s|email|member|message|profile/i
    );
    expect(text).not.toMatch(/@[a-z0-9.-]+\.[a-z]{2,}/i);
  });
});
