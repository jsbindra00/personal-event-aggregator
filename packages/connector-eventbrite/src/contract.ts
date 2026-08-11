import type { ObservedSearchContract } from "@event-agg/browser";
import { connectorFailure } from "@event-agg/connector-common";
import type { Page } from "playwright-core";

const LONDON_URL =
  "https://www.eventbrite.co.uk/d/united-kingdom--london/events/";

export const EVENTBRITE_DISCOVERY_INTENTS = [
  "events",
  "ai",
  "machine-learning",
  "startups",
  "technology",
  "software",
  "developer",
  "product-design",
  "hackathon",
  "tech-networking",
  "business-networking"
] as const;

export type EventbriteDiscoveryIntent =
  (typeof EVENTBRITE_DISCOVERY_INTENTS)[number];

const cityRoutes = [
  { name: "london", country: "united-kingdom", city: "london" },
  { name: "manchester", country: "united-kingdom", city: "manchester" },
  { name: "birmingham", country: "united-kingdom", city: "birmingham" },
  { name: "bristol", country: "united-kingdom", city: "bristol" },
  { name: "edinburgh", country: "united-kingdom", city: "edinburgh" },
  { name: "paris", country: "france", city: "paris" },
  { name: "berlin", country: "germany", city: "berlin" },
  { name: "amsterdam", country: "netherlands", city: "amsterdam" },
  { name: "barcelona", country: "spain", city: "barcelona" }
] as const;

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

export function eventbriteSearchUrl(locationText: string): string | null {
  return eventbriteSearchUrls(locationText, ["events"])?.[0] ?? null;
}

export function eventbriteSearchUrls(
  locationText: string,
  intents: readonly EventbriteDiscoveryIntent[] = EVENTBRITE_DISCOVERY_INTENTS
): string[] | null {
  const route = resolveEventbriteCityRoute(locationText);
  if (route === null) return null;
  return intents.map(
    (intent) =>
      `https://www.eventbrite.co.uk/d/${route.country}--${route.city}/${intent}/`
  );
}

function resolveEventbriteCityRoute(locationText: string):
  | { country: string; city: string }
  | null {
  const normalized = ` ${normalizeLocation(locationText)} `;
  const route = cityRoutes.find(({ name }) =>
    normalized.includes(` ${name} `)
  );
  return route === undefined
    ? null
    : { country: route.country, city: route.city };
}

function normalizeLocation(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
