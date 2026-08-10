import { chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import Database from "better-sqlite3";

export type AppDatabase = Database.Database;

const migration = `
  create table if not exists interest_profile (
    id integer primary key check (id = 1),
    note text not null,
    updated_at text not null
  );

  create table if not exists interest_terms (
    id integer primary key autoincrement,
    kind text not null check (kind in ('positive', 'excluded')),
    position integer not null,
    value text not null,
    unique (kind, position)
  );

  create table if not exists searches (
    id text primary key,
    location_text text not null,
    start_date text not null,
    end_date text not null,
    time_zone text not null,
    starts_at_utc text not null,
    ends_before_utc text not null,
    status text not null,
    created_at text not null,
    completed_at text
  );

  create table if not exists search_sources (
    search_id text not null references searches(id) on delete cascade,
    source text not null,
    state text not null,
    event_count integer not null default 0,
    error_code text,
    safe_message text,
    primary key (search_id, source)
  );

  create table if not exists events (
    id text primary key,
    source text not null,
    source_event_id text,
    canonical_url text not null,
    title text not null,
    starts_at text not null,
    ends_at text,
    time_zone text,
    description_text text,
    organizer_name text,
    venue_name text,
    address_text text,
    latitude real,
    longitude real,
    is_online integer not null,
    image_url text,
    price_text text,
    tags_json text not null,
    first_seen_at text not null
  );

  create index if not exists events_source_id
    on events(source, source_event_id);
  create index if not exists events_canonical_url
    on events(canonical_url);

  create table if not exists search_events (
    search_id text not null references searches(id) on delete cascade,
    event_id text not null references events(id) on delete cascade,
    relevance_score real not null,
    event_rank integer not null,
    matched_interests_json text not null,
    primary key (search_id, event_id)
  );

  create table if not exists connector_status (
    source text primary key,
    state text not null,
    last_success_at text,
    error_code text,
    safe_message text
  );

  create table if not exists relevance_cache (
    event_fingerprint text not null,
    profile_fingerprint text not null,
    evaluator_fingerprint text not null,
    event_id text not null,
    decision text not null check (decision in ('show', 'maybe', 'hide')),
    score real not null,
    confidence real not null,
    matched_interests_json text not null,
    reason text not null,
    created_at text not null,
    primary key (event_fingerprint, profile_fingerprint, evaluator_fingerprint)
  );
`;

export function openDatabase(path: string): AppDatabase {
  const databasePath = path === ":memory:" ? path : resolve(path);
  if (databasePath !== ":memory:") {
    const dataDirectory = dirname(databasePath);
    mkdirSync(dataDirectory, { mode: 0o700, recursive: true });
    chmodSync(dataDirectory, 0o700);
  }

  const database = new Database(databasePath);
  if (databasePath !== ":memory:") {
    chmodSync(databasePath, 0o600);
    database.pragma("journal_mode = WAL");
  }
  database.pragma("foreign_keys = ON");
  database.pragma("busy_timeout = 5000");
  database.exec(migration);
  ensureColumn(
    database,
    "search_events",
    "relevance_decision",
    "text not null default 'show'"
  );
  ensureColumn(
    database,
    "search_events",
    "relevance_confidence",
    "real not null default 0"
  );
  ensureColumn(
    database,
    "search_events",
    "relevance_reason",
    "text not null default ''"
  );
  return database;
}

function ensureColumn(
  database: AppDatabase,
  table: string,
  column: string,
  definition: string
): void {
  const columns = database
    .prepare(`pragma table_info(${table})`)
    .all() as Array<{ name: string }>;
  if (!columns.some((candidate) => candidate.name === column)) {
    database.exec(`alter table ${table} add column ${column} ${definition}`);
  }
}
