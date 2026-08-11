import { describe, expect, it } from "vitest";

import {
  EVENTBRITE_DISCOVERY_INTENTS,
  eventbriteSearchUrl,
  eventbriteSearchUrls
} from "../src/index.js";

describe("Eventbrite discovery URLs", () => {
  it("builds the fixed broad-discovery routes for Birmingham", () => {
    expect(EVENTBRITE_DISCOVERY_INTENTS).toEqual([
      "events",
      "ai",
      "machine-learning",
      "startups",
      "technology",
      "software",
      "developer",
      "product-design",
      "hackathon",
      "tech-networking",
      "business-networking"
    ]);
    expect(eventbriteSearchUrls("Birmingham")).toEqual([
      "https://www.eventbrite.co.uk/d/united-kingdom--birmingham/events/",
      "https://www.eventbrite.co.uk/d/united-kingdom--birmingham/ai/",
      "https://www.eventbrite.co.uk/d/united-kingdom--birmingham/machine-learning/",
      "https://www.eventbrite.co.uk/d/united-kingdom--birmingham/startups/",
      "https://www.eventbrite.co.uk/d/united-kingdom--birmingham/technology/",
      "https://www.eventbrite.co.uk/d/united-kingdom--birmingham/software/",
      "https://www.eventbrite.co.uk/d/united-kingdom--birmingham/developer/",
      "https://www.eventbrite.co.uk/d/united-kingdom--birmingham/product-design/",
      "https://www.eventbrite.co.uk/d/united-kingdom--birmingham/hackathon/",
      "https://www.eventbrite.co.uk/d/united-kingdom--birmingham/tech-networking/",
      "https://www.eventbrite.co.uk/d/united-kingdom--birmingham/business-networking/"
    ]);
  });

  it("resolves a supported city inside an address", () => {
    expect(
      eventbriteSearchUrls("Digbeth, Birmingham, B5 6DY", [
        "events",
        "startups"
      ])
    ).toEqual([
      "https://www.eventbrite.co.uk/d/united-kingdom--birmingham/events/",
      "https://www.eventbrite.co.uk/d/united-kingdom--birmingham/startups/"
    ]);
    expect(eventbriteSearchUrl("10 Downing Street, London SW1A 2AA")).toBe(
      "https://www.eventbrite.co.uk/d/united-kingdom--london/events/"
    );
  });

  it("returns null for an unsupported location", () => {
    expect(eventbriteSearchUrls("Tokyo")).toBeNull();
    expect(eventbriteSearchUrl("Tokyo")).toBeNull();
  });
});
