import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("Guild closure fixture", () => {
  const text = readFileSync(
    new URL("../fixtures/service-status.redacted.json", import.meta.url),
    "utf8"
  );

  it("contains only non-personal service status", () => {
    expect(JSON.parse(text)).toEqual({
      service: "guild",
      state: "closed",
      closedOn: "2024-10-01",
      events: []
    });
    expect(text).not.toMatch(
      /authorization|cookie|csrf|bearer|email|member|message|profile/i
    );
  });
});
