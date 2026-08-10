import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createRepositories, openDatabase } from "../src/index.js";

const databases: Array<ReturnType<typeof openDatabase>> = [];
const temporaryDirectories: string[] = [];

function memoryRepositories() {
  const database = openDatabase(":memory:");
  databases.push(database);
  return { database, repositories: createRepositories(database) };
}

afterEach(() => {
  while (databases.length > 0) {
    databases.pop()?.close();
  }
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory) {
      rmSync(directory, { force: true, recursive: true });
    }
  }
});

describe("interest repository", () => {
  it("atomically replaces and preserves ordered interest terms", () => {
    const { repositories } = memoryRepositories();

    repositories.interests.replace({
      positive: ["AI", "founders"],
      excluded: ["sales pitch"],
      note: "Technical networking"
    });

    expect(repositories.interests.get()).toEqual({
      positive: ["AI", "founders"],
      excluded: ["sales pitch"],
      note: "Technical networking"
    });
  });
});

describe("search and event repositories", () => {
  it("returns ranked normalized events and isolated source state", () => {
    const { repositories } = memoryRepositories();
    const query = {
      locationText: "London",
      startDate: "2026-08-10",
      endDate: "2026-08-12",
      timeZone: "Europe/London",
      startsAtUtc: "2026-08-09T23:00:00.000Z",
      endsBeforeUtc: "2026-08-12T23:00:00.000Z"
    };
    const event = {
      id: "luma:evt-1",
      source: "luma" as const,
      sourceEventId: "evt-1",
      canonicalUrl: "https://lu.ma/evt-1",
      title: "AI Builders",
      startsAt: "2026-08-12T18:00:00.000Z",
      endsAt: null,
      timeZone: "Europe/London",
      descriptionText: "Builders meeting",
      organizerName: "AI London",
      venueName: "The Ministry",
      addressText: "London",
      latitude: 51.5,
      longitude: -0.1,
      isOnline: false,
      imageUrl: null,
      priceText: "Free",
      tags: ["AI"],
      relevanceScore: 12,
      matchedInterests: ["AI"],
      firstSeenAt: "2026-08-10T00:00:00.000Z"
    };

    repositories.searches.create({
      id: "search-1",
      query,
      createdAt: "2026-08-10T00:00:00.000Z"
    });
    repositories.searches.upsertSource({
      searchId: "search-1",
      source: "guild",
      state: "failed",
      count: 0,
      errorCode: "contract_drift",
      safeMessage: "Guild search changed"
    });
    repositories.events.upsert(event);
    repositories.events.linkToSearch("search-1", event, 1);

    expect(repositories.events.listForSearch("search-1")).toEqual([event]);
    expect(repositories.searches.getSources("search-1")).toEqual([
      expect.objectContaining({
        source: "guild",
        state: "failed",
        errorCode: "contract_drift"
      })
    ]);
  });
});

describe("database schema safety", () => {
  it("contains no raw-response table or credential-shaped columns", () => {
    const { database } = memoryRepositories();
    const tableNames = database
      .prepare("select name from sqlite_master where type = 'table'")
      .all()
      .map((row) => String((row as { name: unknown }).name));

    expect(tableNames).not.toContain("raw_responses");

    const unsafeColumn = tableNames
      .flatMap((table) =>
        database
          .prepare(`pragma table_info(${table})`)
          .all()
          .map((row) => String((row as { name: unknown }).name))
      )
      .find((name) => /cookie|csrf|authorization|token|raw_response/i.test(name));

    expect(unsafeColumn).toBeUndefined();
  });

  it("restricts the data directory and database file to the current user", () => {
    const root = mkdtempSync(join(tmpdir(), "event-agg-storage-"));
    temporaryDirectories.push(root);
    const dataDirectory = join(root, ".data");
    const databasePath = join(dataDirectory, "events.sqlite");
    const database = openDatabase(databasePath);
    database.close();

    expect(statSync(dataDirectory).mode & 0o777).toBe(0o700);
    expect(statSync(databasePath).mode & 0o777).toBe(0o600);
  });
});
