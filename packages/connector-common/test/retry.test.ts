import { describe, expect, it, vi } from "vitest";

import {
  classifyConnectorError,
  connectorFailure,
  withConnectorRetry
} from "../src/retry.js";

describe("withConnectorRetry", () => {
  it("retries transient failures with bounded exponential delay", async () => {
    const calls: string[] = [];
    const sleep = vi.fn(async () => undefined);
    const result = await withConnectorRetry(
      async (attempt) => {
        calls.push(`attempt-${attempt}`);
        if (attempt < 3) {
          throw connectorFailure("network", "temporary network failure");
        }
        return "ok";
      },
      {
        maxAttempts: 3,
        baseDelayMs: 500,
        maxDelayMs: 5_000,
        jitterRatio: 0.2,
        random: () => 0.5,
        sleep
      }
    );

    expect(result).toBe("ok");
    expect(calls).toEqual(["attempt-1", "attempt-2", "attempt-3"]);
    expect(sleep.mock.calls).toEqual([[500], [1_000]]);
  });

  it.each(["network", "rate_limited"] as const)(
    "may retry %s failures",
    async (code) => {
      let attempts = 0;
      await expect(
        withConnectorRetry(
          async () => {
            attempts += 1;
            throw connectorFailure(code, "try again");
          },
          { maxAttempts: 3, sleep: async () => undefined }
        )
      ).rejects.toMatchObject({ code });
      expect(attempts).toBe(3);
    }
  );

  it.each([
    "auth_required",
    "user_action_required",
    "contract_drift",
    "parsing"
  ] as const)("does not retry terminal %s failures", async (code) => {
    let attempts = 0;
    await expect(
      withConnectorRetry(async () => {
        attempts += 1;
        throw connectorFailure(code, "stop");
      })
    ).rejects.toMatchObject({ code });
    expect(attempts).toBe(1);
  });

  it("classifies HTTP outcomes and browser timeouts for safe retry handling", () => {
    expect(
      classifyConnectorError({
        name: "ObservedHttpError",
        status: 429,
        retryAfterMs: 2_000
      })
    ).toMatchObject({ code: "rate_limited", retryAfterMs: 2_000 });
    expect(
      classifyConnectorError(Object.assign(new Error("page timed out"), {
        name: "TimeoutError"
      }))
    ).toMatchObject({ code: "network" });
  });
});
