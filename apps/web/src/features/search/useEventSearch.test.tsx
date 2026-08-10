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
  relevanceDecision: "show" as const,
  relevanceScore: 10,
  relevanceConfidence: 0.9,
  relevanceReason: "Matches the saved AI interest",
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

  it("removes an event when richer evidence changes it to hide", async () => {
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
        source: "meetup",
        event: {
          ...baseEvent,
          relevanceDecision: "hide",
          relevanceScore: 3,
          relevanceReason: "Richer source data ruled it out"
        }
      });
    });

    expect(result.current.events).toEqual([]);
    expect(result.current.maybeEvents).toEqual([]);
  });

  it("cancels an active search before starting its replacement", async () => {
    const api = createTestEventApi();
    const { result } = renderHook(() => useEventSearch(api));
    const query = {
      locationText: "London",
      startDate: "2026-08-10",
      endDate: "2026-08-12",
      timeZone: "Europe/London"
    };

    await act(() => result.current.start(query));
    await act(() => result.current.start({ ...query, locationText: "Paris" }));

    expect(api.cancelledSearches).toEqual(["search-1"]);
    expect(api.searches).toHaveLength(2);
  });

  it("tracks relevance progress and keeps maybe events out of the main list", async () => {
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
        type: "relevance.progress",
        relevance: {
          state: "evaluating",
          evaluator: "ollama",
          model: "gemma3:4b",
          evaluatedCount: 10,
          showCount: 3,
          maybeCount: 2,
          hideCount: 5,
          safeMessage: null
        }
      });
      api.emit({
        sequence: 3,
        searchId: "search-1",
        type: "event.added",
        source: "luma",
        event: baseEvent
      });
      api.emit({
        sequence: 4,
        searchId: "search-1",
        type: "event.maybe",
        source: "meetup",
        event: {
          ...baseEvent,
          id: "meetup:maybe",
          source: "meetup",
          relevanceDecision: "maybe",
          relevanceScore: 52,
          relevanceReason: "Possibly related"
        }
      });
    });

    expect(result.current.events).toEqual([baseEvent]);
    expect(result.current.maybeEvents).toHaveLength(1);
    expect(result.current.relevance).toMatchObject({
      evaluatedCount: 10,
      showCount: 3,
      maybeCount: 2
    });
  });
});
