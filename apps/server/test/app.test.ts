import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { testDependencies } from "./test-dependencies.js";

const apps: Array<ReturnType<typeof buildApp>> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("event aggregator HTTP API", () => {
  it("starts a validated search and exposes its snapshot", async () => {
    const app = buildApp(testDependencies());
    apps.push(app);

    const created = await app.inject({
      method: "POST",
      url: "/api/searches",
      payload: {
        locationText: "London",
        startDate: "2026-08-10",
        endDate: "2026-08-12",
        timeZone: "Europe/London"
      }
    });

    expect(created.statusCode).toBe(202);
    expect(created.json()).toEqual({
      searchId: "search-1",
      streamUrl: "/api/searches/search-1/stream"
    });

    const snapshot = await app.inject({
      method: "GET",
      url: "/api/searches/search-1"
    });
    expect(snapshot.statusCode).toBe(200);
    expect(snapshot.json()).toMatchObject({
      searchId: "search-1",
      status: "complete",
      events: []
    });
  });

  it("returns 400 for a reversed date interval", async () => {
    const app = buildApp(testDependencies());
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/searches",
      payload: {
        locationText: "London",
        startDate: "2026-08-12",
        endDate: "2026-08-10",
        timeZone: "Europe/London"
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "validation_error" });
  });

  it("reads and replaces the interest profile", async () => {
    const app = buildApp(testDependencies());
    apps.push(app);

    const updated = await app.inject({
      method: "PUT",
      url: "/api/interests",
      payload: {
        positive: ["AI", "founders"],
        excluded: ["crypto trading"],
        note: "Technical events"
      }
    });
    expect(updated.statusCode).toBe(200);

    const response = await app.inject({ method: "GET", url: "/api/interests" });
    expect(response.json()).toEqual({
      positive: ["AI", "founders"],
      excluded: ["crypto trading"],
      note: "Technical events"
    });
  });

  it("exposes safe local relevance readiness", async () => {
    const app = buildApp(testDependencies());
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/api/relevance/status"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      state: "ready",
      evaluator: "resilient",
      model: "gemma3:4b",
      evaluatedCount: 0,
      showCount: 0,
      maybeCount: 0,
      hideCount: 0,
      safeMessage: null
    });
  });

  it("keeps connector actions source-scoped", async () => {
    const dependencies = testDependencies();
    const app = buildApp(dependencies);
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/connectors/luma/connect"
    });

    expect(response.statusCode).toBe(202);
    expect(dependencies.connectedSources).toEqual(["luma"]);
  });

  it("returns 404 for an unknown search and makes cancellation idempotent", async () => {
    const app = buildApp(testDependencies());
    apps.push(app);

    expect(
      (await app.inject({ method: "GET", url: "/api/searches/missing" }))
        .statusCode
    ).toBe(404);
    expect(
      (await app.inject({ method: "POST", url: "/api/searches/missing/cancel" }))
        .statusCode
    ).toBe(404);
  });
});
