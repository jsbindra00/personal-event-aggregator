import type { ObservedSearchContract } from "@event-agg/browser";
import type { Page, Request } from "playwright-core";

const FIND_URL = "https://www.meetup.com/find/?source=EVENTS";
const GRAPHQL_PATH = "/gql2";
const EVENT_OPERATION = "recommendedEventsWithSeries";
const ALLOWED_QUERY_OPERATIONS = new Set([
  "getSelf",
  "unreadMessages",
  "getLocationSearch",
  EVENT_OPERATION
]);

export const meetupSearchContract: ObservedSearchContract = {
  source: "meetup",
  origin: "https://www.meetup.com",
  allowedHosts: ["www.meetup.com"],
  connectUrl: FIND_URL,
  async performSearch(page, query) {
    const target = new URL(FIND_URL);
    target.searchParams.set("location", query.locationText);
    target.searchParams.set("source", "EVENTS");
    await page.goto(target.href, { waitUntil: "networkidle" });
    if (new URL(page.url()).pathname.startsWith("/login")) {
      throw new Error("meetup_login_required");
    }
  },
  responseMatches(response) {
    const request = response.request();
    return (
      request.method() === "POST" &&
      new URL(response.url()).pathname === GRAPHQL_PATH &&
      meetupOperationName(request) === EVENT_OPERATION
    );
  }
};

const protectedPages = new WeakSet<Page>();

export async function enforceReadOnlyMeetupPage(page: Page): Promise<void> {
  if (protectedPages.has(page)) return;
  protectedPages.add(page);
  await page.route("**/*", async (route) => {
    const request = route.request();
    const method = request.method();
    if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
      await route.continue();
      return;
    }

    const url = new URL(request.url());
    if (
      method === "POST" &&
      url.hostname === "www.meetup.com" &&
      ((url.pathname === GRAPHQL_PATH &&
        ALLOWED_QUERY_OPERATIONS.has(meetupOperationName(request))) ||
        url.pathname === "/orion/v3/identity/settings")
    ) {
      await route.continue();
      return;
    }
    await route.abort("blockedbyclient");
  });
}

export function meetupOperationName(request: Request): string {
  try {
    const payload = request.postDataJSON() as { operationName?: unknown };
    return typeof payload?.operationName === "string"
      ? payload.operationName
      : "";
  } catch {
    return "";
  }
}
