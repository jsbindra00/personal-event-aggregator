import { describe, expect, it } from "vitest";

import { resolveListenOptions } from "../src/config.js";

describe("resolveListenOptions", () => {
  it("binds to loopback and the local default port", () => {
    expect(resolveListenOptions({})).toEqual({
      host: "127.0.0.1",
      port: 4317
    });
  });

  it("rejects an invalid configured port", () => {
    expect(() => resolveListenOptions({ EVENT_AGG_PORT: "70000" })).toThrow(
      /port/i
    );
  });
});
