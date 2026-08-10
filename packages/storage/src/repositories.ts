import type {
  ConnectorState,
  ConnectorStatus,
  EventSource,
  InterestProfile,
  NormalizedEvent,
  ResolvedSearchQuery
} from "@event-agg/core";

import type { AppDatabase } from "./database.js";

export interface StoredSearchInput {
  id: string;
  query: ResolvedSearchQuery;
  createdAt: string;
}

export interface StoredSearch {
  id: string;
  query: ResolvedSearchQuery;
  status: string;
  createdAt: string;
  completedAt: string | null;
}

export interface StoredSearchSource {
  searchId: string;
  source: EventSource;
  state: ConnectorState;
  count: number;
  errorCode: string | null;
  safeMessage: string | null;
}

export interface SearchSourceInput extends StoredSearchSource {}

function parseStringArray(value: string): string[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
    throw new Error("Stored string array is invalid");
  }
  return parsed;
}

export class InterestRepository {
  public constructor(private readonly database: AppDatabase) {}

  public get(): InterestProfile {
    const profile = this.database
      .prepare("select note from interest_profile where id = 1")
      .get() as { note: string } | undefined;
    const terms = this.database
      .prepare("select kind, value from interest_terms order by kind, position")
      .all() as Array<{ kind: "positive" | "excluded"; value: string }>;

    return {
      positive: terms.filter((term) => term.kind === "positive").map((term) => term.value),
      excluded: terms.filter((term) => term.kind === "excluded").map((term) => term.value),
      note: profile?.note ?? ""
    };
  }

  public replace(profile: InterestProfile): void {
    this.database.transaction(() => {
      this.database
        .prepare(
          `insert into interest_profile (id, note, updated_at)
           values (1, ?, ?)
           on conflict(id) do update set note = excluded.note, updated_at = excluded.updated_at`
        )
        .run(profile.note, new Date().toISOString());
      this.database.prepare("delete from interest_terms").run();
      const insert = this.database.prepare(
        "insert into interest_terms (kind, position, value) values (?, ?, ?)"
      );
      profile.positive.forEach((value, position) => insert.run("positive", position, value));
      profile.excluded.forEach((value, position) => insert.run("excluded", position, value));
    })();
  }
}

export class SearchRepository {
  public constructor(private readonly database: AppDatabase) {}

  public create(input: StoredSearchInput): void {
    this.database
      .prepare(
        `insert into searches (
          id, location_text, start_date, end_date, time_zone,
          starts_at_utc, ends_before_utc, status, created_at
        ) values (?, ?, ?, ?, ?, ?, ?, 'running', ?)`
      )
      .run(
        input.id,
        input.query.locationText,
        input.query.startDate,
        input.query.endDate,
        input.query.timeZone,
        input.query.startsAtUtc,
        input.query.endsBeforeUtc,
        input.createdAt
      );
  }

  public setStatus(searchId: string, status: string, completedAt: string | null): void {
    this.database
      .prepare("update searches set status = ?, completed_at = ? where id = ?")
      .run(status, completedAt, searchId);
  }

  public get(searchId: string): StoredSearch | null {
    const row = this.database
      .prepare("select * from searches where id = ?")
      .get(searchId) as Record<string, unknown> | undefined;
    if (!row) {
      return null;
    }

    return {
      id: String(row.id),
      query: {
        locationText: String(row.location_text),
        startDate: String(row.start_date),
        endDate: String(row.end_date),
        timeZone: String(row.time_zone),
        startsAtUtc: String(row.starts_at_utc),
        endsBeforeUtc: String(row.ends_before_utc)
      },
      status: String(row.status),
      createdAt: String(row.created_at),
      completedAt: row.completed_at == null ? null : String(row.completed_at)
    };
  }

  public upsertSource(input: SearchSourceInput): void {
    this.database
      .prepare(
        `insert into search_sources (
          search_id, source, state, event_count, error_code, safe_message
        ) values (?, ?, ?, ?, ?, ?)
        on conflict(search_id, source) do update set
          state = excluded.state,
          event_count = excluded.event_count,
          error_code = excluded.error_code,
          safe_message = excluded.safe_message`
      )
      .run(
        input.searchId,
        input.source,
        input.state,
        input.count,
        input.errorCode,
        input.safeMessage
      );
  }

  public getSources(searchId: string): StoredSearchSource[] {
    const rows = this.database
      .prepare("select * from search_sources where search_id = ? order by source")
      .all(searchId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      searchId: String(row.search_id),
      source: String(row.source) as EventSource,
      state: String(row.state) as ConnectorState,
      count: Number(row.event_count),
      errorCode: row.error_code == null ? null : String(row.error_code),
      safeMessage: row.safe_message == null ? null : String(row.safe_message)
    }));
  }
}

export class EventRepository {
  public constructor(private readonly database: AppDatabase) {}

  public upsert(event: NormalizedEvent): void {
    this.database
      .prepare(
        `insert into events (
          id, source, source_event_id, canonical_url, title, starts_at, ends_at,
          time_zone, description_text, organizer_name, venue_name, address_text,
          latitude, longitude, is_online, image_url, price_text, tags_json, first_seen_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        on conflict(id) do update set
          source_event_id = excluded.source_event_id,
          canonical_url = excluded.canonical_url,
          title = excluded.title,
          starts_at = excluded.starts_at,
          ends_at = excluded.ends_at,
          time_zone = excluded.time_zone,
          description_text = excluded.description_text,
          organizer_name = excluded.organizer_name,
          venue_name = excluded.venue_name,
          address_text = excluded.address_text,
          latitude = excluded.latitude,
          longitude = excluded.longitude,
          is_online = excluded.is_online,
          image_url = excluded.image_url,
          price_text = excluded.price_text,
          tags_json = excluded.tags_json,
          first_seen_at = min(events.first_seen_at, excluded.first_seen_at)`
      )
      .run(
        event.id,
        event.source,
        event.sourceEventId,
        event.canonicalUrl,
        event.title,
        event.startsAt,
        event.endsAt,
        event.timeZone,
        event.descriptionText,
        event.organizerName,
        event.venueName,
        event.addressText,
        event.latitude,
        event.longitude,
        event.isOnline ? 1 : 0,
        event.imageUrl,
        event.priceText,
        JSON.stringify(event.tags),
        event.firstSeenAt
      );
  }

  public linkToSearch(searchId: string, event: NormalizedEvent, rank: number): void {
    this.database
      .prepare(
        `insert into search_events (
          search_id, event_id, relevance_score, event_rank, matched_interests_json
        ) values (?, ?, ?, ?, ?)
        on conflict(search_id, event_id) do update set
          relevance_score = excluded.relevance_score,
          event_rank = excluded.event_rank,
          matched_interests_json = excluded.matched_interests_json`
      )
      .run(
        searchId,
        event.id,
        event.relevanceScore,
        rank,
        JSON.stringify(event.matchedInterests)
      );
  }

  public listForSearch(searchId: string): NormalizedEvent[] {
    const rows = this.database
      .prepare(
        `select e.*, se.relevance_score, se.matched_interests_json
         from search_events se
         join events e on e.id = se.event_id
         where se.search_id = ?
         order by se.event_rank, e.starts_at, e.title`
      )
      .all(searchId) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      id: String(row.id),
      source: String(row.source) as EventSource,
      sourceEventId: row.source_event_id == null ? null : String(row.source_event_id),
      canonicalUrl: String(row.canonical_url),
      title: String(row.title),
      startsAt: String(row.starts_at),
      endsAt: row.ends_at == null ? null : String(row.ends_at),
      timeZone: row.time_zone == null ? null : String(row.time_zone),
      descriptionText:
        row.description_text == null ? null : String(row.description_text),
      organizerName: row.organizer_name == null ? null : String(row.organizer_name),
      venueName: row.venue_name == null ? null : String(row.venue_name),
      addressText: row.address_text == null ? null : String(row.address_text),
      latitude: row.latitude == null ? null : Number(row.latitude),
      longitude: row.longitude == null ? null : Number(row.longitude),
      isOnline: Boolean(row.is_online),
      imageUrl: row.image_url == null ? null : String(row.image_url),
      priceText: row.price_text == null ? null : String(row.price_text),
      tags: parseStringArray(String(row.tags_json)),
      relevanceScore: Number(row.relevance_score),
      matchedInterests: parseStringArray(String(row.matched_interests_json)),
      firstSeenAt: String(row.first_seen_at)
    }));
  }
}

export class ConnectorStatusRepository {
  public constructor(private readonly database: AppDatabase) {}

  public upsert(status: ConnectorStatus): void {
    this.database
      .prepare(
        `insert into connector_status (
          source, state, last_success_at, error_code, safe_message
        ) values (?, ?, ?, ?, ?)
        on conflict(source) do update set
          state = excluded.state,
          last_success_at = excluded.last_success_at,
          error_code = excluded.error_code,
          safe_message = excluded.safe_message`
      )
      .run(
        status.source,
        status.state,
        status.lastSuccessAt,
        status.errorCode,
        status.safeMessage
      );
  }

  public getAll(): ConnectorStatus[] {
    const rows = this.database
      .prepare("select * from connector_status order by source")
      .all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      source: String(row.source) as EventSource,
      state: String(row.state) as ConnectorState,
      lastSuccessAt:
        row.last_success_at == null ? null : String(row.last_success_at),
      errorCode: row.error_code == null ? null : String(row.error_code),
      safeMessage: row.safe_message == null ? null : String(row.safe_message)
    }));
  }
}

export function createRepositories(database: AppDatabase) {
  return {
    interests: new InterestRepository(database),
    searches: new SearchRepository(database),
    events: new EventRepository(database),
    connectorStatuses: new ConnectorStatusRepository(database)
  };
}

export type Repositories = ReturnType<typeof createRepositories>;

