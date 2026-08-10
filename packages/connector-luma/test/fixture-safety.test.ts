import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("redacted Luma fixtures", () => {
  const text = readFileSync(
    new URL("../fixtures/search-page-1.redacted.json", import.meta.url),
    "utf8"
  );

  it("contains valid minimized JSON", () => {
    const payload = JSON.parse(text) as { entries?: unknown[] };
    expect(payload.entries).toHaveLength(2);
  });

  it("contains no credential or personal-contact material", () => {
    expect(text).not.toMatch(
      /authorization|set-cookie|cookie\s*:|csrf|bearer\s|@[a-z0-9.-]+\.[a-z]{2,}/i
    );
    expect(text).not.toMatch(
      /user_api_id|personal_user|guest_info|host_info|account_redacted/i
    );
  });

  it("uses stable fixture identifiers", () => {
    expect(text).toContain('"api_id": "evt_fixture_1"');
    expect(text).toContain('"next_cursor": "cursor_fixture_page_2"');
  });
});
