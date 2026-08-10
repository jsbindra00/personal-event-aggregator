import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("redacted Luma fixtures", () => {
  const fixtures = [
    "../fixtures/search-page-1.redacted.json",
    "../fixtures/discover-page.redacted.html",
    "../fixtures/city-page.redacted.html"
  ].map((path) => readFileSync(new URL(path, import.meta.url), "utf8"));
  const text = fixtures.join("\n");

  it("contains valid minimized JSON", () => {
    const payload = JSON.parse(fixtures[0]!) as { entries?: unknown[] };
    expect(payload.entries).toHaveLength(2);
  });

  it("contains no credential or personal-contact material", () => {
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
      /user_api_id|personal_user|guest_info|host_info|account_redacted/i
    );
  });

  it("uses stable fixture identifiers", () => {
    expect(text).toContain('"api_id": "evt_fixture_1"');
    expect(text).toContain('"next_cursor": "cursor_fixture_page_2"');
  });
});
