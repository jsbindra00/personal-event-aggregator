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
    await page.goto(FIND_URL, { waitUntil: "domcontentloaded" });
    if (new URL(page.url()).pathname.startsWith("/login")) {
      throw new Error("meetup_login_required");
    }

    const locationInput = page.getByLabel(
      "Search for location by city or zip code"
    );
    await locationInput.fill(query.locationText);
    await page.waitForTimeout(700);
    const resultsReady = page.waitForResponse(
      (response) => meetupSearchContract.responseMatches(response),
      { timeout: 20_000 }
    );
    await locationInput.press("ArrowDown");
    await locationInput.press("Enter");
    let selectionResolved = false;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (
        meetupSelectionMatches(
          query.locationText,
          await locationInput.inputValue(),
          page.url()
        )
      ) {
        selectionResolved = true;
        break;
      }
      await page.waitForTimeout(250);
    }
    if (!selectionResolved) {
      void resultsReady.catch(() => undefined);
      throw new Error("meetup_location_unresolved");
    }
    await resultsReady;
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

export function meetupSelectionMatches(
  query: string,
  inputValue: string,
  pageUrl: string
): boolean {
  let selectedLocation: string;
  try {
    selectedLocation = new URL(pageUrl).searchParams.get("location") ?? "";
  } catch {
    return false;
  }
  const normalizedQuery = normalizeLocationText(query);
  const normalizedInput = normalizeLocationText(inputValue);
  const normalizedLocation = normalizeLocationText(selectedLocation);
  return normalizedQuery
    .split(" ")
    .filter((token) => token.length >= 3)
    .some(
      (token) =>
        normalizedLocation.includes(token) ||
        (normalizedInput !== normalizedQuery && normalizedInput.includes(token))
    );
}

function normalizeLocationText(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

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
