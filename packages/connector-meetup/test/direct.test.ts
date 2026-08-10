import { readFileSync } from "node:fs";

import type { ConnectorMessage, ResolvedSearchQuery } from "@event-agg/core";
import { describe, expect, it } from "vitest";

import { createDirectMeetupConnector } from "../src/index.js";

const locationPayload = load("location-search.redacted.json");
const pageOne = load("search-page-1.redacted.json") as MeetupPage;

const query: ResolvedSearchQuery = {
  locationText: "10 Downing Street, London",
  startDate: "2026-08-12",
  endDate: "2026-08-13",
  timeZone: "Europe/London",
  startsAtUtc: "2026-08-11T23:00:00.000Z",
  endsBeforeUtc: "2026-08-13T23:00:00.000Z"
};

describe("direct Meetup discovery", () => {
  it("resolves location and pages the anonymous persisted event query", async () => {
    const requests: GraphqlRequest[] = [];
    const connector = createDirectMeetupConnector({
      fetch: graphqlFetch(requests, [
        pageOne,
        page({ events: [pageOne.data.result.edges[0]!], hasNextPage: false })
      ]),
      pageSize: 50,
      maxPages: 8
    });

    const messages = await collect(
      connector.search(query, new AbortController().signal)
    );

    expect(requests.map(({ body }) => body.operationName)).toEqual([
      "getLocationSearch",
      "recommendedEventsWithSeries",
      "recommendedEventsWithSeries"
    ]);
    expect(requests[0]?.body).toMatchObject({
      variables: {
        query: "10 Downing Street, London",
        dataConfiguration: "{}"
      },
      extensions: {
        persistedQuery: {
          version: 1,
          sha256Hash:
            "950b939f7033b26849b13e829e04cad7fb6b6e4593e97499fceb3ff21764206d"
        }
      }
    });
    expect(requests[1]?.body.variables).toMatchObject({
      first: 50,
      lat: 51.52,
      lon: -0.1,
      startDateRange: "2026-08-12T00:00:00+01:00[Europe/London]",
      seriesStartDate: "2026-08-12"
    });
    expect(requests[2]?.body.variables).toMatchObject({
      after: "cursor_fixture_page_2"
    });
    expect(messages.map(({ type }) => type)).toEqual([
      "progress",
      "event",
      "event",
      "complete"
    ]);
    expect(messages.at(-1)).toMatchObject({ count: 2 });
  });

  it("classifies an anonymous GraphQL auth response", async () => {
    const connector = createDirectMeetupConnector({
      fetch: graphqlFetch([], [
        {
          errors: [
            {
              message: "private detail",
              extensions: { code: "UNAUTHENTICATED" }
            }
          ]
        }
      ])
    });

    const messages = await collect(
      connector.search(query, new AbortController().signal)
    );

    expect(messages.at(-1)).toEqual({
      type: "auth_required",
      source: "meetup",
      safeMessage: "Sign in to Meetup"
    });
  });

  it("requires user action when the location query has no result", async () => {
    const connector = createDirectMeetupConnector({
      fetch: async () =>
        new Response(JSON.stringify({ data: { result: [] } }))
    });

    const messages = await collect(
      connector.search(query, new AbortController().signal)
    );

    expect(messages.at(-1)).toEqual({
      type: "user_action_required",
      source: "meetup",
      safeMessage: "Meetup could not resolve 10 Downing Street, London"
    });
  });

  it("stops after a repeated cursor", async () => {
    const requests: GraphqlRequest[] = [];
    const connector = createDirectMeetupConnector({
      fetch: graphqlFetch(requests, [pageOne, structuredClone(pageOne), pageOne]),
      maxPages: 8
    });

    await collect(connector.search(query, new AbortController().signal));

    expect(
      requests.filter(
        ({ body }) => body.operationName === "recommendedEventsWithSeries"
      )
    ).toHaveLength(2);
  });

  it("reports persisted-query drift without logging GraphQL details", async () => {
    const diagnostics: unknown[] = [];
    const connector = createDirectMeetupConnector({
      fetch: graphqlFetch([], [
        {
          errors: [
            {
              message: "PersistedQueryNotFound and internal trace",
              extensions: { code: "PERSISTED_QUERY_NOT_FOUND" }
            }
          ]
        }
      ]),
      diagnostic: (value) => diagnostics.push(value)
    });

    const messages = await collect(
      connector.search(query, new AbortController().signal)
    );

    expect(messages.at(-1)).toEqual({
      type: "failed",
      source: "meetup",
      errorCode: "contract_drift",
      safeMessage: "Meetup's event response changed"
    });
    expect(JSON.stringify(diagnostics)).not.toContain("internal trace");
  });

  it("reports rate limiting after the bounded retry policy", async () => {
    const connector = createDirectMeetupConnector({
      fetch: graphqlFetch([], [], 429),
      retry: { maxAttempts: 1 }
    });

    const messages = await collect(
      connector.search(query, new AbortController().signal)
    );

    expect(messages.at(-1)).toMatchObject({
      type: "rate_limited",
      source: "meetup",
      safeMessage: "Event source rate limit reached"
    });
  });

  it("does not call GraphQL after cancellation", async () => {
    let requested = false;
    const connector = createDirectMeetupConnector({
      fetch: async () => {
        requested = true;
        return new Response(JSON.stringify(locationPayload));
      }
    });
    const controller = new AbortController();
    controller.abort();

    const messages = await collect(connector.search(query, controller.signal));

    expect(requested).toBe(false);
    expect(messages.map(({ type }) => type)).toEqual(["progress"]);
  });
});

interface MeetupPage {
  data: {
    result: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      edges: unknown[];
    };
  };
}

interface GraphqlRequest {
  url: string;
  body: {
    operationName: string;
    variables: Record<string, unknown>;
    extensions: unknown;
  };
}

function graphqlFetch(
  requests: GraphqlRequest[],
  eventPages: unknown[],
  status = 200
): typeof globalThis.fetch {
  let pageIndex = 0;
  return async (input, init) => {
    const body = JSON.parse(String(init?.body)) as GraphqlRequest["body"];
    requests.push({ url: String(input), body });
    const payload =
      body.operationName === "getLocationSearch"
        ? locationPayload
        : eventPages[pageIndex++] ?? {};
    return new Response(JSON.stringify(payload), {
      status,
      ...(status === 429 ? { headers: { "retry-after": "1" } } : {})
    });
  };
}

function page(input: {
  events: unknown[];
  hasNextPage: boolean;
}): MeetupPage {
  return {
    data: {
      result: {
        pageInfo: { hasNextPage: input.hasNextPage, endCursor: null },
        edges: input.events
      }
    }
  };
}

function load(name: string): unknown {
  return JSON.parse(
    readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8")
  ) as unknown;
}

async function collect(
  iterable: AsyncIterable<ConnectorMessage>
): Promise<ConnectorMessage[]> {
  const messages: ConnectorMessage[] = [];
  for await (const message of iterable) messages.push(message);
  return messages;
}
