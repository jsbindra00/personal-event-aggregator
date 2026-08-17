// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { NormalizedEvent } from "@event-agg/core";

import { App } from "./App.js";
import { createTestEventApi } from "../test/test-api.js";

afterEach(cleanup);

function streamedEvent(
  id: string,
  relevanceDecision: NormalizedEvent["relevanceDecision"] = "show"
): NormalizedEvent {
  return {
    id,
    source: "luma",
    sourceEventId: id,
    canonicalUrl: `https://lu.ma/${id}`,
    title: id === "evt-1" ? "AI Builders" : `Possible event ${id}`,
    startsAt: "2026-08-12T18:00:00.000Z",
    endsAt: null,
    timeZone: "Europe/London",
    descriptionText: "A builder meetup",
    organizerName: "AI London",
    venueName: "The Ministry",
    addressText: "London",
    latitude: null,
    longitude: null,
    isOnline: false,
    imageUrl: null,
    priceText: "Free",
    tags: ["AI"],
    relevanceDecision,
    relevanceScore: relevanceDecision === "show" ? 82 : 55,
    relevanceConfidence: 0.94,
    relevanceReason: "Matches AI and builder interests",
    matchedInterests: ["AI"],
    firstSeenAt: "2026-08-10T00:00:00.000Z"
  };
}

describe("App", () => {
  it("starts a search and renders a streamed canonical event link", async () => {
    const api = createTestEventApi();
    const user = userEvent.setup();
    render(<App api={api} />);

    await user.type(screen.getByLabelText(/location/i), "London");
    fireEvent.change(screen.getByLabelText(/start date/i), {
      target: { value: "2026-08-10" }
    });
    fireEvent.change(screen.getByLabelText(/end date/i), {
      target: { value: "2026-08-12" }
    });
    await user.click(screen.getByRole("button", { name: /^search$/i }));

    expect(api.searches).toEqual([
      expect.objectContaining({
        locationText: "London",
        startDate: "2026-08-10",
        endDate: "2026-08-12"
      })
    ]);

    api.emit({
      sequence: 2,
      searchId: "search-1",
      type: "event.added",
      source: "luma",
      event: {
        ...streamedEvent("evt-1"),
        canonicalUrl: "https://lu.ma/example"
      }
    });

    const link = await screen.findByRole("link", { name: /open event/i });
    expect(link.getAttribute("href")).toBe("https://lu.ma/example");
    expect(screen.getByText("AI Builders")).toBeTruthy();
  });

  it("keeps uncertain matches in a collapsed Maybe section", async () => {
    const api = createTestEventApi();
    const user = userEvent.setup();
    render(<App api={api} />);

    await user.type(screen.getByLabelText(/location/i), "London");
    fireEvent.change(screen.getByLabelText(/start date/i), {
      target: { value: "2026-08-10" }
    });
    fireEvent.change(screen.getByLabelText(/end date/i), {
      target: { value: "2026-08-12" }
    });
    await user.click(screen.getByRole("button", { name: /^search$/i }));

    api.emit({
      sequence: 2,
      searchId: "search-1",
      type: "event.maybe",
      source: "luma",
      event: streamedEvent("maybe-1", "maybe")
    });
    api.emit({
      sequence: 3,
      searchId: "search-1",
      type: "event.maybe",
      source: "luma",
      event: streamedEvent("maybe-2", "maybe")
    });

    const summary = await screen.findByText("Maybe (2)");
    expect((summary.parentElement as HTMLDetailsElement).open).toBe(false);
  });

  it("offers a source-scoped sign-in action from safe connector status", async () => {
    const api = createTestEventApi();
    api.connectorStatuses[0] = {
      source: "luma",
      state: "auth_required",
      lastSuccessAt: null,
      errorCode: "auth_required",
      safeMessage: "Sign in to Luma"
    };
    const user = userEvent.setup();
    render(<App api={api} />);

    await user.click(
      await screen.findByRole("button", { name: "Sign in again Luma" })
    );
    expect(api.connectedSources).toEqual(["luma"]);
  });

  it("explains public privacy, hides connection actions, and defaults 31 days", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-17T12:00:00.000Z"));
    try {
      const api = createTestEventApi({ isPublicMode: true });
      api.connectorStatuses[0] = {
        source: "luma",
        state: "auth_required",
        lastSuccessAt: null,
        errorCode: "auth_required",
        safeMessage: "Sign in to Luma"
      };

      render(<App api={api} />);

      expect(
        screen.getByText(/interests stay only in this browser/i)
      ).toBeTruthy();
      expect(
        screen.queryByRole("button", { name: /sign in again luma/i })
      ).toBeNull();
      expect(
        (screen.getByLabelText(/start date/i) as HTMLInputElement).value
      ).toBe("2026-08-17");
      expect(
        (screen.getByLabelText(/end date/i) as HTMLInputElement).value
      ).toBe("2026-09-16");
    } finally {
      vi.useRealTimers();
    }
  });
});
