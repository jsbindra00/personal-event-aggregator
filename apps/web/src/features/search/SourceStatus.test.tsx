import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SourceStatus } from "./SourceStatus.js";

describe("SourceStatus", () => {
  it("labels the active Guild.host source without closure actions", () => {
    const html = renderToStaticMarkup(
      <SourceStatus
        statuses={{
          guild: {
            source: "guild",
            state: "failed",
            lastSuccessAt: null,
            errorCode: "network",
            safeMessage: "Guild.host is temporarily unavailable"
          }
        }}
        onConnect={() => undefined}
      />
    );

    expect(html).toContain("<strong>Guild.host</strong>");
    expect(html).not.toContain("Why unavailable");
    expect(html).not.toContain("Open source");
  });
});
