import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("redacted Eventbrite fixtures", () => {
  const fixtures = [
    "../fixtures/search-page-1.redacted.json",
    "../fixtures/search-page.redacted.html"
  ].map((path) => readFileSync(new URL(path, import.meta.url), "utf8"));
  const text = fixtures.join("\n");

  it("is valid JSON with two synthetic events", () => {
    const payload = JSON.parse(fixtures[0]!) as { itemListElement?: unknown[] };
    expect(payload.itemListElement).toHaveLength(2);
  });

  it("contains no secret, account, order, or attendee data", () => {
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
    expect(text).not.toMatch(
      /attendee|order_id|organizer_account|public_eb_user|local_storage_id/i
    );
  });
});
