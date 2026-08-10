import type {
  ConnectorMessage,
  ConnectorStatus,
  EventConnector,
  EventSource,
  ResolvedSearchQuery
} from "@event-agg/core";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import {
  createProductionDependencies,
  type ProductionDependencies
} from "../src/dependencies.js";

class FakeBrowserHost {
  readonly opened: Array<{ source: EventSource; url: string }> = [];

  async pageFor(source: EventSource, url: string): Promise<never> {
    this.opened.push({ source, url });
    return undefined as never;
  }

  async close(): Promise<void> {}
}

class StaticConnector implements EventConnector {
  readonly source: EventSource;

  constructor(private readonly status: ConnectorStatus) {
    this.source = status.source;
  }

  async getStatus(): Promise<ConnectorStatus> {
    return { ...this.status };
  }

  async *connect(): AsyncIterable<ConnectorMessage> {}

  async *search(
    _query: ResolvedSearchQuery,
    _signal: AbortSignal
  ): AsyncIterable<ConnectorMessage> {}
}

const dependenciesToClose: ProductionDependencies[] = [];
const apps: Array<ReturnType<typeof buildApp>> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(dependenciesToClose.splice(0).map((deps) => deps.close()));
});

function status(source: EventSource, state: ConnectorStatus["state"]): ConnectorStatus {
  return {
    source,
    state,
    lastSuccessAt: null,
    errorCode: state === "auth_required" ? "auth_required" : null,
    safeMessage: state === "auth_required" ? `Sign in to ${source}` : null
  };
}

describe("production connector wiring", () => {
  it("constructs exactly the four configured source connectors", () => {
    const dependencies = createProductionDependencies({
      databasePath: ":memory:",
      browserHost: new FakeBrowserHost()
    });
    dependenciesToClose.push(dependencies);

    expect(new Set(dependencies.connectorSources)).toEqual(
      new Set(["luma", "meetup", "eventbrite", "guild"])
    );
  });

  it("exposes one auth-required state without changing other sources", async () => {
    const connectors = ([
      status("luma", "auth_required"),
      status("meetup", "ready"),
      status("eventbrite", "complete"),
      status("guild", "failed")
    ] as const).map((value) => new StaticConnector(value));
    const dependencies = createProductionDependencies({
      databasePath: ":memory:",
      browserHost: new FakeBrowserHost(),
      connectors
    });
    dependenciesToClose.push(dependencies);
    const app = buildApp(dependencies);
    apps.push(app);

    const response = await app.inject({ method: "GET", url: "/api/connectors" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      status("luma", "auth_required"),
      status("meetup", "ready"),
      status("eventbrite", "complete"),
      status("guild", "failed")
    ]);
  });

  it("opens only the selected source connect URL", async () => {
    const browserHost = new FakeBrowserHost();
    const dependencies = createProductionDependencies({
      databasePath: ":memory:",
      browserHost
    });
    dependenciesToClose.push(dependencies);
    const app = buildApp(dependencies);
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/connectors/meetup/connect"
    });
    expect(response.statusCode).toBe(202);
    expect(browserHost.opened).toEqual([
      {
        source: "meetup",
        url: "https://www.meetup.com/find/?source=EVENTS"
      }
    ]);
  });
});
