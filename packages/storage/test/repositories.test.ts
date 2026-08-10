import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import {
  createRepositories,
  eventRelevanceFingerprint,
  openDatabase,
  profileRelevanceFingerprint
} from "../src/index.js";

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
      relevanceDecision: "show" as const,
      relevanceScore: 12,
      relevanceConfidence: 0.9,
      relevanceReason: "Matches AI",
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

    const maybe = {
      ...event,
      id: "luma:evt-2",
      sourceEventId: "evt-2",
      canonicalUrl: "https://lu.ma/evt-2",
      title: "Possible Builders Event",
      relevanceDecision: "maybe" as const,
      relevanceScore: 55,
      relevanceConfidence: 0.7,
      relevanceReason: "Possibly relevant"
    };
    repositories.events.upsert(maybe);
    repositories.events.linkToSearch("search-1", maybe, 2);

    expect(repositories.events.listForSearch("search-1", "show")).toEqual([event]);
    expect(repositories.events.listForSearch("search-1", "maybe")).toEqual([maybe]);
    expect(repositories.events.listForSearch("search-1")).toEqual([event, maybe]);
    expect(repositories.searches.getSources("search-1")).toEqual([
      expect.objectContaining({
        source: "guild",
        state: "failed",
        errorCode: "contract_drift"
      })
    ]);
  });

  it("caches decisions by event, profile, and evaluator fingerprints", () => {
    const { repositories } = memoryRepositories();
    const key = {
      eventFingerprint: "event-hash",
      profileFingerprint: "profile-hash",
      evaluatorFingerprint: "ollama:gemma3:4b:prompt-v1:70:0.55:40"
    };
    repositories.relevanceCache.put({
      ...key,
      decision: {
        eventId: "luma:1",
        decision: "show",
        score: 88,
        confidence: 0.93,
        matchedInterests: ["AI"],
        reason: "Strong AI match"
      },
      createdAt: "2026-08-10T00:00:00.000Z"
    });

    expect(repositories.relevanceCache.get(key)).toEqual({
      eventId: "luma:1",
      decision: "show",
      score: 88,
      confidence: 0.93,
      matchedInterests: ["AI"],
      reason: "Strong AI match"
    });
    expect(
      repositories.relevanceCache.get({
        ...key,
        profileFingerprint: "different-profile"
      })
    ).toBeNull();
  });

  it("creates stable relevance fingerprints", () => {
    const base = {
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
      relevanceDecision: "maybe" as const,
      relevanceScore: 0,
      relevanceConfidence: 0,
      relevanceReason: "Awaiting relevance evaluation",
      matchedInterests: [],
      firstSeenAt: "2026-08-10T00:00:00.000Z"
    };

    expect(eventRelevanceFingerprint(base)).toBe(
      eventRelevanceFingerprint({
        ...base,
        relevanceScore: 99,
        relevanceDecision: "show"
      })
    );
    expect(
      profileRelevanceFingerprint({
        positive: ["AI", "climate"],
        excluded: ["sales", "crypto"],
        note: "Technical"
      })
    ).toBe(
      profileRelevanceFingerprint({
        positive: ["climate", "AI"],
        excluded: ["crypto", "sales"],
        note: "Technical"
      })
    );
  });
});

describe("database schema safety", () => {
  it("adds relevance columns to an existing search_events table", () => {
    const root = mkdtempSync(join(tmpdir(), "event-agg-migration-"));
    temporaryDirectories.push(root);
    const databasePath = join(root, "events.sqlite");
    const legacy = new Database(databasePath);
    legacy.exec(`
      create table search_events (
        search_id text not null,
        event_id text not null,
        relevance_score real not null,
        event_rank integer not null,
        matched_interests_json text not null,
        primary key (search_id, event_id)
      )
    `);
    legacy.close();

    const migrated = openDatabase(databasePath);
    databases.push(migrated);
    const columns = migrated
      .prepare("pragma table_info(search_events)")
      .all()
      .map((row) => String((row as { name: unknown }).name));

    expect(columns).toEqual(
      expect.arrayContaining([
        "relevance_decision",
        "relevance_confidence",
        "relevance_reason"
      ])
    );
  });

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
