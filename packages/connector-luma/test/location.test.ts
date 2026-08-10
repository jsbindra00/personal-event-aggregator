import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  LumaLocationError,
  resolveLumaPlace
} from "../src/index.js";

const discoverHtml = readFileSync(
  new URL("../fixtures/discover-page.redacted.html", import.meta.url),
  "utf8"
);
const cityHtml = readFileSync(
  new URL("../fixtures/city-page.redacted.html", import.meta.url),
  "utf8"
);

describe("direct Luma place resolution", () => {
  it("resolves an address to the matching city and public place ID", async () => {
    const requested: string[] = [];

    await expect(
      resolveLumaPlace(
        "10 Downing Street, London",
        routeFetch(requested),
        new AbortController().signal
      )
    ).resolves.toEqual({
      name: "London",
      cityUrl: "https://luma.com/london?k=p",
      placeId: "discplace-fixture-london",
      timeZone: "Europe/London"
    });
    expect(requested).toEqual([
      "https://luma.com/discover",
      "https://luma.com/london?k=p"
    ]);
  });

  it("matches an accented city name to its normalized slug", async () => {
    const montrealPage = cityHtml
      .replace("Europe/London", "America/Toronto")
      .replaceAll("London", "Montréal")
      .replaceAll("london", "montreal");
    const requested: string[] = [];

    const place = await resolveLumaPlace(
      "Montréal",
      routeFetch(requested, montrealPage),
      new AbortController().signal
    );

    expect(place).toMatchObject({ name: "Montréal", timeZone: "America/Toronto" });
    expect(requested.at(-1)).toBe("https://luma.com/montreal?k=p");
  });

  it("ignores a matching link on a hostile host", async () => {
    const hostile = '<a href="https://evil.example/london?k=p">London</a>';
    const requested: string[] = [];

    await expect(
      resolveLumaPlace(
        "London",
        routeFetch(requested, cityHtml, hostile),
        new AbortController().signal
      )
    ).resolves.toBeNull();
    expect(requested).toEqual(["https://luma.com/discover"]);
  });

  it("reports contract drift for malformed city data", async () => {
    const requested: string[] = [];

    await expect(
      resolveLumaPlace(
        "London",
        routeFetch(requested, "<html><body>No next data</body></html>"),
        new AbortController().signal
      )
    ).rejects.toBeInstanceOf(LumaLocationError);
  });

  it("does not make a request after cancellation", async () => {
    let requested = false;
    const controller = new AbortController();
    controller.abort();

    await expect(
      resolveLumaPlace(
        "London",
        async () => {
          requested = true;
          return new Response(discoverHtml);
        },
        controller.signal
      )
    ).rejects.toBeDefined();
    expect(requested).toBe(false);
  });
});

function routeFetch(
  requested: string[],
  selectedCityHtml = cityHtml,
  selectedDiscoverHtml = discoverHtml
): typeof globalThis.fetch {
  return async (input) => {
    const url = String(input);
    requested.push(url);
    if (url === "https://luma.com/discover") {
      return new Response(selectedDiscoverHtml);
    }
    return new Response(selectedCityHtml);
  };
}
