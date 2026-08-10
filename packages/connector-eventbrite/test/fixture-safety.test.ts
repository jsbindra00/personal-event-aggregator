import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("redacted Eventbrite fixtures", () => {
  const text = readFileSync(
    new URL("../fixtures/search-page-1.redacted.json", import.meta.url),
    "utf8"
  );

  it("is valid JSON with two synthetic events", () => {
    const payload = JSON.parse(text) as { itemListElement?: unknown[] };
    expect(payload.itemListElement).toHaveLength(2);
  });

  it("contains no secret, account, order, or attendee data", () => {
    expect(text).not.toMatch(
      /authorization|set-cookie|cookie\s*:|csrf|bearer\s|@[a-z0-9.-]+\.[a-z]{2,}/i
    );
    expect(text).not.toMatch(
      /attendee|order_id|organizer_account|public_eb_user|local_storage_id/i
    );
  });
});
