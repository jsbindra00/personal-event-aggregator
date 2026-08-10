// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { NormalizedEvent } from "@event-agg/core";

import { EventResults } from "./EventResults.js";

const event: NormalizedEvent = {
  id: "luma:bad-zone",
  source: "luma",
  sourceEventId: "bad-zone",
  canonicalUrl: "https://lu.ma/example",
  title: "AI Builders",
  startsAt: "2026-08-12T18:00:00.000Z",
  endsAt: null,
  timeZone: "Not/AZone",
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
  relevanceDecision: "show",
  relevanceScore: 10,
  relevanceConfidence: 0.82,
  relevanceReason: "Strong match for AI builders",
  matchedInterests: [],
  firstSeenAt: "2026-08-10T00:00:00.000Z"
};

describe("EventResults", () => {
  it("falls back safely when a source supplies an invalid timezone", () => {
    render(<EventResults events={[event]} searching={false} />);

    expect(
      screen.getByRole<HTMLAnchorElement>("link", { name: /open event/i }).href
    ).toBe("https://lu.ma/example");
    expect(screen.getByText("Strong match for AI builders")).toBeTruthy();
  });
});
