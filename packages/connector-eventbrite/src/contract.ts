import type { ObservedSearchContract } from "@event-agg/browser";
import { connectorFailure } from "@event-agg/connector-common";
import type { Page } from "playwright-core";

const LONDON_URL =
  "https://www.eventbrite.co.uk/d/united-kingdom--london/events/";

export const eventbriteSearchContract: ObservedSearchContract = {
  source: "eventbrite",
  origin: "https://www.eventbrite.co.uk",
  allowedHosts: ["www.eventbrite.co.uk"],
  connectUrl: LONDON_URL,
  async performSearch(page, query) {
    const target = eventbriteSearchUrl(query.locationText);
    if (target === null) {
      throw connectorFailure(
        "user_action_required",
        `Eventbrite needs a supported city for ${query.locationText}`
      );
    }
    await page.goto(target, { waitUntil: "networkidle" });
    if (new URL(page.url()).pathname.startsWith("/signin")) {
      throw connectorFailure("auth_required", "Sign in to Eventbrite");
    }
  },
  responseMatches(response) {
    const request = response.request();
    return (
      request.method() === "GET" &&
      new URL(response.url()).pathname.startsWith("/d/") &&
      new URL(response.url()).pathname.endsWith("/events/")
    );
  }
};

const protectedPages = new WeakSet<Page>();

export async function enforceReadOnlyEventbritePage(page: Page): Promise<void> {
  if (protectedPages.has(page)) return;
  protectedPages.add(page);
  await page.route("**/*", async (route) => {
    const method = route.request().method();
    if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
      await route.continue();
    } else {
      await route.abort("blockedbyclient");
    }
  });
}

export async function readEventbriteItemList(page: Page): Promise<unknown> {
  const scripts = await page
    .locator('script[type="application/ld+json"]')
    .allTextContents();
  for (const text of scripts) {
    try {
      const payload = JSON.parse(text) as { "@type"?: unknown };
      if (payload["@type"] === "ItemList") return payload;
    } catch {
      // Ignore unrelated malformed structured-data blocks.
    }
  }
  return {};
}

function eventbriteSearchUrl(locationText: string): string | null {
  const normalized = locationText.toLowerCase();
  if (/\blondon\b/.test(normalized)) return LONDON_URL;

  const exactCityCountry: Record<string, [string, string]> = {
    manchester: ["united-kingdom", "manchester"],
    birmingham: ["united-kingdom", "birmingham"],
    bristol: ["united-kingdom", "bristol"],
    edinburgh: ["united-kingdom", "edinburgh"],
    paris: ["france", "paris"],
    berlin: ["germany", "berlin"],
    amsterdam: ["netherlands", "amsterdam"],
    barcelona: ["spain", "barcelona"]
  };
  const match = exactCityCountry[normalized.trim()];
  if (match === undefined) return null;
  const [country, city] = match;
  return `https://www.eventbrite.co.uk/d/${country}--${city}/events/`;
}
