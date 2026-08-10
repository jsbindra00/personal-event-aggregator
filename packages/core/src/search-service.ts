import { randomUUID } from "node:crypto";

import { AsyncQueue } from "./async-queue.js";
import { areProbableDuplicates, mergeDuplicate } from "./dedupe.js";
import { normalizeEvent } from "./normalize.js";
import { resolveSearchQuery } from "./query.js";
import { rankEvent, sortRankedEvents } from "./rank.js";
import type {
  ConnectorMessage,
  ConnectorState,
  ConnectorStatus,
  EventConnector,
  EventSearchQuery,
  EventSource,
  InterestProfile,
  NormalizedEvent,
  ResolvedSearchQuery,
  SearchStreamMessage
} from "./types.js";

export interface SearchStore {
  createSearch(input: {
    id: string;
    query: ResolvedSearchQuery;
    createdAt: string;
  }): void;
  setSearchStatus(
    searchId: string,
    status: "running" | "complete" | "cancelled",
    completedAt: string | null
  ): void;
  upsertSource(input: {
    searchId: string;
    source: EventSource;
    state: ConnectorState;
    count: number;
    errorCode: string | null;
    safeMessage: string | null;
  }): void;
  saveEvent(
    searchId: string,
    event: NormalizedEvent,
    rank: number,
    replacesEventId?: string
  ): void;
}

export interface SearchSnapshot {
  searchId: string;
  query: ResolvedSearchQuery;
  status: "running" | "complete" | "cancelled";
  events: NormalizedEvent[];
  sources: ConnectorStatus[];
}

interface SourceRun {
  controller: AbortController;
  count: number;
  status: ConnectorStatus;
  terminal: boolean;
}

interface SearchRun {
  searchId: string;
  query: ResolvedSearchQuery;
  status: "running" | "complete" | "cancelled";
  nextSequence: number;
  history: SearchStreamMessage[];
  subscribers: Set<AsyncQueue<SearchStreamMessage>>;
  sources: Map<EventSource, SourceRun>;
  events: Map<string, NormalizedEvent>;
  finalized: boolean;
}

export interface SearchServiceOptions {
  connectors: EventConnector[];
  store: SearchStore;
  getInterests: () => InterestProfile;
  createId?: () => string;
  now?: () => Date;
  maxHistoryMessages?: number;
}

export interface SearchService {
  start(query: EventSearchQuery): Promise<{ searchId: string }>;
  subscribe(searchId: string, afterSequence?: number): AsyncIterable<SearchStreamMessage>;
  snapshot(searchId: string): SearchSnapshot | null;
  cancel(searchId: string): void;
}

class DefaultSearchService implements SearchService {
  private readonly connectors: EventConnector[];
  private readonly store: SearchStore;
  private readonly getInterests: () => InterestProfile;
  private readonly createId: () => string;
  private readonly now: () => Date;
  private readonly maxHistoryMessages: number;
  private readonly runs = new Map<string, SearchRun>();

  public constructor(options: SearchServiceOptions) {
    this.connectors = options.connectors;
    this.store = options.store;
    this.getInterests = options.getInterests;
    this.createId = options.createId ?? randomUUID;
    this.now = options.now ?? (() => new Date());
    this.maxHistoryMessages = Math.max(1, options.maxHistoryMessages ?? 10_000);
  }

  public async start(input: EventSearchQuery): Promise<{ searchId: string }> {
    const query = resolveSearchQuery(input);
    const searchId = this.createId();
    const createdAt = this.now().toISOString();
    const run: SearchRun = {
      searchId,
      query,
      status: "running",
      nextSequence: 1,
      history: [],
      subscribers: new Set(),
      sources: new Map(),
      events: new Map(),
      finalized: false
    };

    this.runs.set(searchId, run);
    this.store.createSearch({ id: searchId, query, createdAt });
    for (const connector of this.connectors) {
      const sourceRun: SourceRun = {
        controller: new AbortController(),
        count: 0,
        status: this.statusFor(connector.source, "searching"),
        terminal: false
      };
      run.sources.set(connector.source, sourceRun);
      this.persistSource(run, connector.source);
    }
    this.emit(run, { type: "search.started" });

    if (this.connectors.length === 0) {
      this.finishSearch(run);
    } else {
      for (const connector of this.connectors) {
        void this.consumeConnector(run, connector);
      }
    }

    return { searchId };
  }

  public subscribe(
    searchId: string,
    afterSequence = 0
  ): AsyncIterable<SearchStreamMessage> {
    const run = this.runs.get(searchId);
    if (!run) {
      throw new Error("Search not found");
    }

    const queue = new AsyncQueue<SearchStreamMessage>();
    for (const message of run.history) {
      if (message.sequence > afterSequence) {
        queue.push(message);
      }
    }
    if (run.status === "running") {
      run.subscribers.add(queue);
    } else {
      queue.close();
    }

    return {
      [Symbol.asyncIterator]: () => ({
        next: () => queue.next(),
        return: async () => {
          run.subscribers.delete(queue);
          queue.close();
          return { done: true, value: undefined };
        }
      })
    };
  }

  public snapshot(searchId: string): SearchSnapshot | null {
    const run = this.runs.get(searchId);
    if (!run) {
      return null;
    }
    return {
      searchId,
      query: run.query,
      status: run.status,
      events: sortRankedEvents([...run.events.values()]),
      sources: [...run.sources.values()]
        .map((source) => ({ ...source.status }))
        .sort((left, right) => left.source.localeCompare(right.source))
    };
  }

  public cancel(searchId: string): void {
    const run = this.runs.get(searchId);
    if (!run || run.status !== "running") {
      return;
    }
    run.status = "cancelled";
    for (const [source, sourceRun] of run.sources) {
      if (sourceRun.terminal) {
        continue;
      }
      sourceRun.controller.abort();
      this.finishSource(run, source, "cancelled", "source.completed");
    }
    this.finishSearch(run);
  }

  private async consumeConnector(
    run: SearchRun,
    connector: EventConnector
  ): Promise<void> {
    const sourceRun = run.sources.get(connector.source);
    if (!sourceRun) {
      return;
    }

    try {
      for await (const message of connector.search(
        run.query,
        sourceRun.controller.signal
      )) {
        if (sourceRun.terminal) {
          break;
        }
        const terminal = this.handleConnectorMessage(run, message);
        if (terminal) {
          break;
        }
      }
      if (!sourceRun.terminal) {
        this.finishSource(run, connector.source, "complete", "source.completed");
      }
    } catch {
      if (sourceRun.terminal) {
        return;
      }
      if (sourceRun.controller.signal.aborted) {
        this.finishSource(run, connector.source, "cancelled", "source.completed");
      } else {
        this.finishSource(
          run,
          connector.source,
          "failed",
          "source.failed",
          "connector_exception",
          "Connector search failed"
        );
      }
    }
  }

  private handleConnectorMessage(
    run: SearchRun,
    message: ConnectorMessage
  ): boolean {
    const sourceRun = run.sources.get(message.source);
    if (!sourceRun || sourceRun.terminal) {
      return true;
    }

    switch (message.type) {
      case "progress":
        this.emit(run, {
          type: "source.progress",
          source: message.source,
          status: { ...sourceRun.status },
          progress: {
            phase: message.phase,
            ...(message.count === undefined ? {} : { count: message.count }),
            ...(message.resolvedLocation === undefined
              ? {}
              : { resolvedLocation: message.resolvedLocation })
          }
        });
        return false;
      case "event":
        return this.handleEvent(run, message);
      case "auth_required":
        this.finishSource(
          run,
          message.source,
          "auth_required",
          "source.auth_required",
          "auth_required",
          message.safeMessage
        );
        return true;
      case "user_action_required":
        this.finishSource(
          run,
          message.source,
          "user_action_required",
          "source.user_action_required",
          "user_action_required",
          message.safeMessage
        );
        return true;
      case "rate_limited":
        this.finishSource(
          run,
          message.source,
          "rate_limited",
          "source.rate_limited",
          "rate_limited",
          message.safeMessage
        );
        return true;
      case "failed":
        this.finishSource(
          run,
          message.source,
          "failed",
          "source.failed",
          message.errorCode,
          message.safeMessage
        );
        return true;
      case "complete":
        sourceRun.count = message.count;
        this.finishSource(run, message.source, "complete", "source.completed");
        return true;
    }
  }

  private handleEvent(
    run: SearchRun,
    message: Extract<ConnectorMessage, { type: "event" }>
  ): boolean {
    let event: NormalizedEvent;
    try {
      event = rankEvent(
        normalizeEvent(message.event, { now: this.now }),
        this.getInterests()
      );
    } catch {
      this.finishSource(
        run,
        message.source,
        "failed",
        "source.failed",
        "normalization_failed",
        "Source returned an invalid event"
      );
      return true;
    }

    const startsAt = Date.parse(event.startsAt);
    if (
      startsAt < Date.parse(run.query.startsAtUtc) ||
      startsAt >= Date.parse(run.query.endsBeforeUtc)
    ) {
      return false;
    }

    const duplicate = [...run.events.values()].find((current) =>
      areProbableDuplicates(current, event)
    );
    let messageType: "event.added" | "event.updated" = "event.added";
    let replacesEventId: string | undefined;
    if (duplicate) {
      const merged = rankEvent(mergeDuplicate(duplicate, event), this.getInterests());
      run.events.delete(duplicate.id);
      run.events.set(merged.id, merged);
      event = merged;
      messageType = "event.updated";
      if (duplicate.id !== merged.id) {
        replacesEventId = duplicate.id;
      }
    } else {
      run.events.set(event.id, event);
    }

    const sourceRun = run.sources.get(message.source);
    if (sourceRun) {
      sourceRun.count += 1;
      this.persistSource(run, message.source);
    }
    this.persistRankedEvents(run, replacesEventId);
    this.emit(run, { type: messageType, source: message.source, event });
    return false;
  }

  private persistRankedEvents(run: SearchRun, replacesEventId?: string): void {
    const sorted = sortRankedEvents([...run.events.values()]);
    sorted.forEach((event, index) =>
      this.store.saveEvent(
        run.searchId,
        event,
        index + 1,
        index === 0 ? replacesEventId : undefined
      )
    );
  }

  private finishSource(
    run: SearchRun,
    source: EventSource,
    state: ConnectorState,
    eventType:
      | "source.auth_required"
      | "source.user_action_required"
      | "source.rate_limited"
      | "source.failed"
      | "source.completed",
    errorCode: string | null = null,
    safeMessage: string | null = null
  ): void {
    const sourceRun = run.sources.get(source);
    if (!sourceRun || sourceRun.terminal) {
      return;
    }
    sourceRun.terminal = true;
    sourceRun.status = this.statusFor(source, state, errorCode, safeMessage);
    this.persistSource(run, source);
    this.emit(run, { type: eventType, source, status: { ...sourceRun.status } });

    if ([...run.sources.values()].every((candidate) => candidate.terminal)) {
      this.finishSearch(run);
    }
  }

  private finishSearch(run: SearchRun): void {
    if (run.finalized) {
      return;
    }
    run.finalized = true;
    if (run.status !== "cancelled") {
      run.status = "complete";
    }
    const completedAt = this.now().toISOString();
    this.store.setSearchStatus(run.searchId, run.status, completedAt);
    this.emit(run, { type: "search.completed" });
    for (const subscriber of run.subscribers) {
      subscriber.close();
    }
    run.subscribers.clear();
  }

  private persistSource(run: SearchRun, source: EventSource): void {
    const sourceRun = run.sources.get(source);
    if (!sourceRun) {
      return;
    }
    this.store.upsertSource({
      searchId: run.searchId,
      source,
      state: sourceRun.status.state,
      count: sourceRun.count,
      errorCode: sourceRun.status.errorCode,
      safeMessage: sourceRun.status.safeMessage
    });
  }

  private statusFor(
    source: EventSource,
    state: ConnectorState,
    errorCode: string | null = null,
    safeMessage: string | null = null
  ): ConnectorStatus {
    return {
      source,
      state,
      lastSuccessAt: state === "complete" ? this.now().toISOString() : null,
      errorCode,
      safeMessage
    };
  }

  private emit(
    run: SearchRun,
    message: Omit<SearchStreamMessage, "sequence" | "searchId">
  ): void {
    const sequenced: SearchStreamMessage = {
      ...message,
      sequence: run.nextSequence,
      searchId: run.searchId
    };
    run.nextSequence += 1;
    run.history.push(sequenced);
    if (run.history.length > this.maxHistoryMessages) {
      run.history.splice(0, run.history.length - this.maxHistoryMessages);
    }
    for (const subscriber of run.subscribers) {
      subscriber.push(sequenced);
    }
  }
}

export function createSearchService(
  options: SearchServiceOptions
): SearchService {
  return new DefaultSearchService(options);
}
