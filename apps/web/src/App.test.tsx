// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { App } from "./App.js";
import { createTestEventApi } from "../test/test-api.js";

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
        id: "luma:evt-1",
        source: "luma",
        sourceEventId: "evt-1",
        canonicalUrl: "https://lu.ma/example",
        title: "AI Builders",
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
        relevanceScore: 12,
        matchedInterests: ["AI"],
        firstSeenAt: "2026-08-10T00:00:00.000Z"
      }
    });

    const link = await screen.findByRole("link", { name: /open event/i });
    expect(link.getAttribute("href")).toBe("https://lu.ma/example");
    expect(screen.getByText("AI Builders")).toBeTruthy();
  });
});
