import {
  connectorFailure
} from "@event-agg/connector-common";
import type { ObservedSearchContract } from "@event-agg/browser";
import type { Page } from "playwright-core";

const DISCOVER_URL = "https://luma.com/discover";
const EVENT_PATH = "/discover/get-paginated-events";

export const lumaSearchContract: ObservedSearchContract = {
  source: "luma",
  origin: "https://luma.com",
  allowedHosts: ["api.luma.com"],
  connectUrl: DISCOVER_URL,
  async performSearch(page, query) {
    if (new URL(page.url()).pathname !== "/discover") {
      await page.goto(DISCOVER_URL, { waitUntil: "domcontentloaded" });
    }

    const cityUrl = await resolveCityUrl(page, query.locationText);
    if (cityUrl === null) {
      throw connectorFailure(
        "user_action_required",
        `Luma does not expose a discovery page for ${query.locationText}`
      );
    }

    await page.goto(cityUrl, { waitUntil: "networkidle" });
    if (new URL(page.url()).pathname.startsWith("/signin")) {
      throw connectorFailure("auth_required", "Sign in to Luma");
    }
  },
  responseMatches(response) {
    const request = response.request();
    return (
      request.method() === "GET" &&
      new URL(response.url()).pathname === EVENT_PATH
    );
  }
};

const protectedPages = new WeakSet<Page>();

export async function enforceReadOnlyLumaPage(page: Page): Promise<void> {
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

async function resolveCityUrl(
  page: Page,
  locationText: string
): Promise<string | null> {
  const links = await page
    .locator('a[href$="?k=p"]')
    .evaluateAll((anchors) =>
      anchors.map((anchor) => ({
        href: (anchor as HTMLAnchorElement).href,
        text: anchor.textContent ?? ""
      }))
    );
  const components = locationText
    .split(",")
    .map(normalizeLocation)
    .filter((component) => component.length > 1);

  let best: { href: string; score: number } | null = null;
  for (const link of links) {
    const url = new URL(link.href);
    if (url.hostname !== "luma.com") continue;
    const slug = normalizeLocation(url.pathname.slice(1));
    const text = normalizeLocation(link.text);
    const score = Math.max(
      ...components.map((component) => {
        if (slug === component) return 100;
        if (text === component || text.startsWith(`${component} `)) return 90;
        if (component.includes(slug) || text.includes(component)) return 50;
        return 0;
      }),
      0
    );
    if (score > 0 && (best === null || score > best.score)) {
      best = { href: link.href, score };
    }
  }
  return best?.href ?? null;
}

function normalizeLocation(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
