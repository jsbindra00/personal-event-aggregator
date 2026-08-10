// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { createTestEventApi } from "../../../test/test-api.js";
import { useEventSearch } from "./useEventSearch.js";

const baseEvent = {
  id: "luma:evt-1",
  source: "luma" as const,
  sourceEventId: "evt-1",
  canonicalUrl: "https://lu.ma/example",
  title: "AI Builders",
  startsAt: "2026-08-12T18:00:00.000Z",
  endsAt: null,
  timeZone: "Europe/London",
  descriptionText: null,
  organizerName: null,
  venueName: null,
  addressText: null,
  latitude: null,
  longitude: null,
  isOnline: false,
  imageUrl: null,
  priceText: null,
  tags: [],
  relevanceScore: 10,
  matchedInterests: ["AI"],
  firstSeenAt: "2026-08-10T00:00:00.000Z"
};

describe("useEventSearch", () => {
  it("replaces an enriched event by ID instead of duplicating it", async () => {
    const api = createTestEventApi();
    const { result } = renderHook(() => useEventSearch(api));

    await act(() =>
      result.current.start({
        locationText: "London",
        startDate: "2026-08-10",
        endDate: "2026-08-12",
        timeZone: "Europe/London"
      })
    );
    act(() => {
      api.emit({
        sequence: 2,
        searchId: "search-1",
        type: "event.added",
        source: "luma",
        event: baseEvent
      });
      api.emit({
        sequence: 3,
        searchId: "search-1",
        type: "event.updated",
        source: "luma",
        event: { ...baseEvent, descriptionText: "Detailed description" }
      });
    });

    expect(result.current.events).toHaveLength(1);
    expect(result.current.events[0]?.descriptionText).toBe(
      "Detailed description"
    );
  });
});
