import { readFileSync } from "node:fs";

const fixtures = {
  lumaDiscover: fixture(
    "../../packages/connector-luma/fixtures/discover-page.redacted.html"
  ),
  lumaCity: fixture(
    "../../packages/connector-luma/fixtures/city-page.redacted.html"
  ),
  lumaEvents: fixture(
    "../../packages/connector-luma/fixtures/search-page-1.redacted.json"
  ),
  meetupLocation: fixture(
    "../../packages/connector-meetup/fixtures/location-search.redacted.json"
  ),
  meetupEvents: fixture(
    "../../packages/connector-meetup/fixtures/search-page-1.redacted.json"
  ),
  eventbrite: fixture(
    "../../packages/connector-eventbrite/fixtures/search-page.redacted.html"
  )
};

export function createDirectFixtureFetch(
  options: { meetupDrift?: boolean } = {}
): typeof globalThis.fetch {
  return async (input, init) => {
    const url = String(input);
    if (url === "https://luma.com/discover") {
      return new Response(fixtures.lumaDiscover);
    }
    if (url === "https://luma.com/london?k=p") {
      return new Response(fixtures.lumaCity);
    }
    if (url.startsWith("https://api.luma.com/discover/get-paginated-events")) {
      const payload = JSON.parse(fixtures.lumaEvents) as {
        has_more: boolean;
        next_cursor: string | null;
      };
      payload.has_more = false;
      payload.next_cursor = null;
      return Response.json(payload);
    }
    if (url === "https://www.meetup.com/gql2") {
      const body = JSON.parse(String(init?.body)) as { operationName?: string };
      if (body.operationName === "getLocationSearch") {
        return new Response(fixtures.meetupLocation);
      }
      if (options.meetupDrift === true) {
        return Response.json({
          errors: [
            {
              message: "fixture drift",
              extensions: { code: "PERSISTED_QUERY_NOT_FOUND" }
            }
          ]
        });
      }
      const payload = JSON.parse(fixtures.meetupEvents) as {
        data: {
          result: {
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
          };
        };
      };
      payload.data.result.pageInfo = { hasNextPage: false, endCursor: null };
      return Response.json(payload);
    }
    if (url.startsWith("https://www.eventbrite.co.uk/d/")) {
      return new Response(fixtures.eventbrite);
    }
    throw new Error(`Unexpected direct fixture URL: ${url}`);
  };
}

function fixture(path: string): string {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}
