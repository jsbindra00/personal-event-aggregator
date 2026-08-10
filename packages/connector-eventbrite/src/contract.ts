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
    const response = await page.goto(target, { waitUntil: "networkidle" });
    const status = response?.status();
    if (status === 401 || status === 403) {
      throw connectorFailure("auth_required", "Sign in to Eventbrite");
    }
    if (status === 429) {
      throw connectorFailure("rate_limited", "Eventbrite rate limit reached", {
        retryAfterMs: retryAfterMilliseconds(response?.headers()["retry-after"])
      });
    }
    if (status === 408 || (status !== undefined && status >= 500)) {
      throw connectorFailure("network", "Eventbrite is temporarily unavailable");
    }
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

function retryAfterMilliseconds(value: string | undefined): number {
  if (value === undefined) return 1_000;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1_000);
  const at = Date.parse(value);
  return Number.isNaN(at) ? 1_000 : Math.max(0, at - Date.now());
}

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
