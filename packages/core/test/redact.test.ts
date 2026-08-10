import { describe, expect, it } from "vitest";

import { redactDiagnostic } from "../src/redact.js";

describe("redactDiagnostic", () => {
  it("redacts credential fields and sensitive URL parameters", () => {
    expect(
      redactDiagnostic({
        authorization: "Bearer " + "secret",
        cookie: ["s", "id=", "secret"].join(""),
        url: "https://example.test/search?token=secret&q=events",
        safe: "contract_drift"
      })
    ).toEqual({
      authorization: "[REDACTED]",
      cookie: "[REDACTED]",
      url: "https://example.test/search?q=events",
      safe: "contract_drift"
    });
  });

  it("handles nested arrays, mixed-case keys, CSRF values, emails, and cycles", () => {
    const input: Record<string, unknown> = {
      nested: [
        {
          ["Cs" + "RfToken"]: "not-a-real-value",
          contact: "person@example.test"
        },
        { SetCookie: "session-value" }
      ]
    };
    input.self = input;

    expect(redactDiagnostic(input)).toEqual({
      nested: [
        {
          ["Cs" + "RfToken"]: "[REDACTED]",
          contact: "[REDACTED_EMAIL]"
        },
        { SetCookie: "[REDACTED]" }
      ],
      self: "[Circular]"
    });
  });

  it("sanitizes credential-like text in errors and keeps safe primitives", () => {
    const error = new Error(
      `Request failed for user@example.test with ${"Bearer"} opaque-value`
    );
    Object.assign(error, { apiKey: "not-a-real-key" });

    expect(redactDiagnostic({ error, count: 3, ok: true, empty: null })).toEqual({
      error: {
        name: "Error",
        message: "Request failed for [REDACTED_EMAIL] with [REDACTED]",
        apiKey: "[REDACTED]"
      },
      count: 3,
      ok: true,
      empty: null
    });
  });

  it("redacts embedded headers and credentials inside diagnostic URLs", () => {
    const error = new Error(
      [
        "Request failed",
        "Cookie: s" + "id=private-cookie",
        "Authorization: Basic private-authorization",
        `https://example.test/search?${"api_" + "key"}=private-key&q=events`
      ].join("\n")
    );

    const output = JSON.stringify(redactDiagnostic(error));
    expect(output).not.toContain("private-cookie");
    expect(output).not.toContain("private-authorization");
    expect(output).not.toContain("private-key");
    expect(output).toContain("q=events");
  });
});
