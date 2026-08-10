import { randomUUID } from "node:crypto";

import { AsyncQueue } from "./async-queue.js";
import { areProbableDuplicates, mergeDuplicate } from "./dedupe.js";
import { normalizeEvent } from "./normalize.js";
import { resolveSearchQuery } from "./query.js";
import { applyRelevanceDecision, strictLexicalDecision } from "./relevance.js";
import { isEventExcluded, sortRankedEvents } from "./rank.js";
import type {
  ConnectorMessage,
  ConnectorState,
  ConnectorStatus,
  EventConnector,
  EventRelevanceEvaluator,
  EventSearchQuery,
  EventSource,
  InterestProfile,
  NormalizedEvent,
  RelevanceDecision,
  RelevanceStatus,
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

export interface RelevanceCache {
  get(
    event: NormalizedEvent,
    profile: InterestProfile,
    evaluatorFingerprint: string
  ): RelevanceDecision | null;
  put(
    event: NormalizedEvent,
    profile: InterestProfile,
    evaluatorFingerprint: string,
    decision: RelevanceDecision
  ): void;
}

export interface SearchSnapshot {
  searchId: string;
  query: ResolvedSearchQuery;
  status: "running" | "complete" | "cancelled";
  events: NormalizedEvent[];
  maybeEvents: NormalizedEvent[];
  sources: ConnectorStatus[];
  relevance: RelevanceStatus;
}

interface PendingTerminal {
  state: ConnectorState;
  eventType:
    | "source.auth_required"
    | "source.user_action_required"
    | "source.rate_limited"
    | "source.failed"
    | "source.completed";
  errorCode: string | null;
  safeMessage: string | null;
}

interface SourceRun {
  controller: AbortController;
  count: number;
  status: ConnectorStatus;
  terminal: boolean;
  pendingTerminal: PendingTerminal | null;
}

interface PendingCandidate {
  event: NormalizedEvent;
  sources: EventSource[];
  version: number;
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
  maybeEvents: Map<string, NormalizedEvent>;
  candidateEvents: Map<string, NormalizedEvent>;
  candidateVersions: Map<string, number>;
  evaluatedIds: Set<string>;
  interests: InterestProfile;
  relevanceQueue: PendingCandidate[];
  relevanceFlushTimer: ReturnType<typeof setTimeout> | null;
  relevanceWorker: Promise<void> | null;
  relevanceController: AbortController;
  pendingBySource: Map<EventSource, number>;
  relevance: RelevanceStatus;
  usedFallback: boolean;
  finalized: boolean;
}

export interface SearchServiceOptions {
  connectors: EventConnector[];
  store: SearchStore;
  getInterests: () => InterestProfile;
  relevanceEvaluator?: EventRelevanceEvaluator;
  relevanceCache?: RelevanceCache;
  relevanceBatchSize?: number;
  relevanceFlushMs?: number;
  createId?: () => string;
  now?: () => Date;
  maxHistoryMessages?: number;
}

export interface SearchService {
  start(query: EventSearchQuery): Promise<{ searchId: string }>;
  subscribe(searchId: string, afterSequence?: number): AsyncIterable<SearchStreamMessage>;
  snapshot(searchId: string): SearchSnapshot | null;
  cancel(searchId: string): void;
  cancelAll(): void;
}

class DefaultSearchService implements SearchService {
  private readonly connectors: EventConnector[];
  private readonly store: SearchStore;
  private readonly getInterests: () => InterestProfile;
  private readonly relevanceEvaluator: EventRelevanceEvaluator;
  private readonly relevanceCache: RelevanceCache;
  private readonly relevanceBatchSize: number;
  private readonly relevanceFlushMs: number;
  private readonly createId: () => string;
  private readonly now: () => Date;
  private readonly maxHistoryMessages: number;
  private readonly runs = new Map<string, SearchRun>();

  constructor(options: SearchServiceOptions) {
    this.connectors = options.connectors;
    this.store = options.store;
    this.getInterests = options.getInterests;
    this.relevanceEvaluator = options.relevanceEvaluator ?? strictEvaluator;
    this.relevanceCache = options.relevanceCache ?? noRelevanceCache;
    this.relevanceBatchSize = positiveInteger(
      options.relevanceBatchSize ?? 10,
      "relevanceBatchSize"
    );
    this.relevanceFlushMs = nonNegativeInteger(
      options.relevanceFlushMs ?? 300,
      "relevanceFlushMs"
    );
    this.createId = options.createId ?? randomUUID;
    this.now = options.now ?? (() => new Date());
    this.maxHistoryMessages = Math.max(1, options.maxHistoryMessages ?? 10_000);
  }

  async start(input: EventSearchQuery): Promise<{ searchId: string }> {
    const query = resolveSearchQuery(input);
    const currentInterests = this.getInterests();
    const searchId = this.createId();
    const createdAt = this.now().toISOString();
    const relevance = await this.initialRelevanceStatus();
    const run: SearchRun = {
      searchId,
      query,
      status: "running",
      nextSequence: 1,
      history: [],
      subscribers: new Set(),
      sources: new Map(),
      events: new Map(),
      maybeEvents: new Map(),
      candidateEvents: new Map(),
      candidateVersions: new Map(),
      evaluatedIds: new Set(),
      interests: {
        positive: [...currentInterests.positive],
        excluded: [...currentInterests.excluded],
        note: currentInterests.note
      },
      relevanceQueue: [],
      relevanceFlushTimer: null,
      relevanceWorker: null,
      relevanceController: new AbortController(),
      pendingBySource: new Map(),
      relevance,
      usedFallback: false,
      finalized: false
    };

    this.runs.set(searchId, run);
    this.store.createSearch({ id: searchId, query, createdAt });
    for (const connector of this.connectors) {
      run.sources.set(connector.source, {
        controller: new AbortController(),
        count: 0,
        status: this.statusFor(connector.source, "searching"),
        terminal: false,
        pendingTerminal: null
      });
      run.pendingBySource.set(connector.source, 0);
      this.persistSource(run, connector.source);
    }
    this.emit(run, { type: "search.started", relevance: { ...run.relevance } });

    if (this.connectors.length === 0) {
      this.finishSearch(run);
    } else {
      for (const connector of this.connectors) void this.consumeConnector(run, connector);
    }
    return { searchId };
  }

  subscribe(searchId: string, afterSequence = 0): AsyncIterable<SearchStreamMessage> {
    const run = this.runs.get(searchId);
    if (!run) throw new Error("Search not found");
    const queue = new AsyncQueue<SearchStreamMessage>();
    for (const message of run.history) {
      if (message.sequence > afterSequence) queue.push(message);
    }
    if (run.status === "running") run.subscribers.add(queue);
    else queue.close();
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

  snapshot(searchId: string): SearchSnapshot | null {
    const run = this.runs.get(searchId);
    if (!run) return null;
    return {
      searchId,
      query: run.query,
      status: run.status,
      events: sortRankedEvents([...run.events.values()]),
      maybeEvents: sortRankedEvents([...run.maybeEvents.values()]),
      sources: [...run.sources.values()]
        .map(({ status }) => ({ ...status }))
        .sort((left, right) => left.source.localeCompare(right.source)),
      relevance: { ...run.relevance }
    };
  }

  cancel(searchId: string): void {
    const run = this.runs.get(searchId);
    if (!run || run.status !== "running") return;
    run.status = "cancelled";
    if (run.relevanceFlushTimer !== null) clearTimeout(run.relevanceFlushTimer);
    run.relevanceFlushTimer = null;
    run.relevanceQueue = [];
    run.relevanceController.abort(new Error("Search cancelled"));
    for (const source of run.pendingBySource.keys()) run.pendingBySource.set(source, 0);
    for (const [source, sourceRun] of run.sources) {
      sourceRun.controller.abort();
      this.finishSource(
        run,
        source,
        "cancelled",
        "source.completed",
        null,
        null,
        true
      );
    }
    this.finishSearch(run);
  }

  cancelAll(): void {
    for (const run of this.runs.values()) {
      if (run.status === "running") this.cancel(run.searchId);
    }
  }

  private async initialRelevanceStatus(): Promise<RelevanceStatus> {
    try {
      const status = await this.relevanceEvaluator.status();
      return {
        ...status,
        evaluatedCount: 0,
        showCount: 0,
        maybeCount: 0,
        hideCount: 0
      };
    } catch {
      return {
        state: "unavailable",
        evaluator: "unknown",
        model: null,
        evaluatedCount: 0,
        showCount: 0,
        maybeCount: 0,
        hideCount: 0,
        safeMessage: "Relevance evaluator is unavailable"
      };
    }
  }

  private async consumeConnector(run: SearchRun, connector: EventConnector): Promise<void> {
    const sourceRun = run.sources.get(connector.source);
    if (!sourceRun) return;
    try {
      for await (const message of connector.search(run.query, sourceRun.controller.signal)) {
        if (sourceRun.terminal || run.status !== "running") break;
        if (this.handleConnectorMessage(run, message)) break;
      }
      if (!sourceRun.terminal && sourceRun.pendingTerminal === null) {
        this.finishSource(run, connector.source, "complete", "source.completed");
      }
    } catch {
      if (sourceRun.terminal || sourceRun.pendingTerminal !== null) return;
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

  private handleConnectorMessage(run: SearchRun, message: ConnectorMessage): boolean {
    const sourceRun = run.sources.get(message.source);
    if (!sourceRun || sourceRun.terminal) return true;
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
      event = normalizeEvent(message.event, { now: this.now });
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

    const duplicate = [...run.candidateEvents.values()].find((current) =>
      areProbableDuplicates(current, event)
    );
    if (duplicate !== undefined) {
      event = { ...mergeDuplicate(duplicate, event), id: duplicate.id };
      if (run.evaluatedIds.has(duplicate.id)) {
        event = preserveRelevance(event, duplicate);
        run.candidateEvents.set(event.id, event);
        if (event.relevanceDecision === "show") {
          run.events.set(event.id, event);
          this.persistRankedEvents(run);
          this.emit(run, { type: "event.updated", source: message.source, event });
        } else if (event.relevanceDecision === "maybe") {
          run.maybeEvents.set(event.id, event);
          this.persistRankedEvents(run);
          this.emit(run, { type: "event.maybe", source: message.source, event });
        }
        return false;
      }
    }

    const version = (run.candidateVersions.get(event.id) ?? 0) + 1;
    run.candidateEvents.set(event.id, event);
    run.candidateVersions.set(event.id, version);
    if (isEventExcluded(event, run.interests)) {
      const excluded = applyRelevanceDecision(
        event,
        strictLexicalDecision(event, run.interests)
      );
      run.candidateEvents.set(event.id, excluded);
      run.evaluatedIds.add(event.id);
      this.updateRelevanceCounts(run);
      return false;
    }

    const queued = run.relevanceQueue.find((candidate) => candidate.event.id === event.id);
    if (queued !== undefined) {
      queued.event = event;
      queued.version = version;
      queued.sources.push(message.source);
      this.incrementPending(run, message.source);
      return false;
    }
    this.queueForRelevance(run, message.source, event, version);
    return false;
  }

  private queueForRelevance(
    run: SearchRun,
    source: EventSource,
    event: NormalizedEvent,
    version: number
  ): void {
    let cached: RelevanceDecision | null = null;
    try {
      cached = this.relevanceCache.get(
        event,
        run.interests,
        this.relevanceEvaluator.fingerprint
      );
    } catch {
      cached = null;
    }
    if (cached !== null) {
      this.applyEvaluatedEvent(run, source, event, cached);
      this.updateRelevanceCounts(run);
      this.emit(run, {
        type: "relevance.progress",
        relevance: { ...run.relevance }
      });
      return;
    }
    run.relevanceQueue.push({ event, sources: [source], version });
    this.incrementPending(run, source);
    if (run.relevanceWorker !== null) return;
    if (run.relevanceQueue.length >= this.relevanceBatchSize) {
      this.clearFlushTimer(run);
      queueMicrotask(() => this.startRelevanceWorker(run));
    } else if (run.relevanceFlushTimer === null) {
      run.relevanceFlushTimer = setTimeout(() => {
        run.relevanceFlushTimer = null;
        this.startRelevanceWorker(run);
      }, this.relevanceFlushMs);
    }
  }

  private startRelevanceWorker(run: SearchRun): void {
    if (
      run.status !== "running" ||
      run.relevanceWorker !== null ||
      run.relevanceQueue.length === 0
    ) {
      return;
    }
    this.clearFlushTimer(run);
    const worker = this.processRelevanceQueue(run);
    run.relevanceWorker = worker;
    const finished = () => {
      if (run.relevanceWorker === worker) run.relevanceWorker = null;
      if (run.status === "running" && run.relevanceQueue.length > 0) {
        this.startRelevanceWorker(run);
      } else {
        this.maybeFinishSearch(run);
      }
    };
    void worker.then(finished, finished);
  }

  private async processRelevanceQueue(run: SearchRun): Promise<void> {
    while (run.status === "running" && run.relevanceQueue.length > 0) {
      const batch = run.relevanceQueue.splice(0, this.relevanceBatchSize);
      run.relevance.state = "evaluating";
      this.emit(run, {
        type: "relevance.progress",
        relevance: { ...run.relevance }
      });

      let decisions: RelevanceDecision[];
      let evaluatorStatus: RelevanceStatus | null = null;
      try {
        decisions = await this.relevanceEvaluator.evaluate(
          batch.map(({ event }) => event),
          run.interests,
          run.relevanceController.signal
        );
        decisions = validateDecisionBatch(batch, decisions);
        evaluatorStatus = await this.relevanceEvaluator.status(
          run.relevanceController.signal
        );
      } catch (error) {
        if (run.status !== "running" || run.relevanceController.signal.aborted) {
          this.releaseBatch(run, batch);
          return;
        }
        run.usedFallback = true;
        decisions = batch.map(({ event }) =>
          strictLexicalDecision(event, run.interests)
        );
        evaluatorStatus = {
          state: "fallback",
          evaluator: run.relevance.evaluator,
          model: run.relevance.model,
          evaluatedCount: 0,
          showCount: 0,
          maybeCount: 0,
          hideCount: 0,
          safeMessage: "Relevance evaluator failed; using strict lexical fallback"
        };
      }

      for (let index = 0; index < batch.length; index += 1) {
        const candidate = batch[index]!;
        const decision = decisions[index]!;
        if (run.candidateVersions.get(candidate.event.id) === candidate.version) {
          try {
            this.relevanceCache.put(
              candidate.event,
              run.interests,
              this.relevanceEvaluator.fingerprint,
              decision
            );
          } catch {
            // Cache failure must not fail a search.
          }
          this.applyEvaluatedEvent(
            run,
            candidate.sources.at(-1)!,
            candidate.event,
            decision
          );
        }
      }
      this.releaseBatch(run, batch);
      if (evaluatorStatus.state === "fallback") run.usedFallback = true;
      run.relevance = {
        ...run.relevance,
        state: run.usedFallback ? "fallback" : "evaluating",
        evaluator: evaluatorStatus.evaluator,
        model: evaluatorStatus.model,
        safeMessage: run.usedFallback
          ? evaluatorStatus.safeMessage ?? run.relevance.safeMessage
          : null
      };
      this.updateRelevanceCounts(run);
      this.emit(run, {
        type: run.usedFallback ? "relevance.fallback" : "relevance.progress",
        relevance: { ...run.relevance }
      });
    }
  }

  private applyEvaluatedEvent(
    run: SearchRun,
    source: EventSource,
    event: NormalizedEvent,
    decision: RelevanceDecision
  ): void {
    if (run.status !== "running") return;
    const evaluated = applyRelevanceDecision(event, decision);
    run.candidateEvents.set(evaluated.id, evaluated);
    run.evaluatedIds.add(evaluated.id);
    if (evaluated.relevanceDecision === "show") {
      const existed = run.events.has(evaluated.id);
      run.maybeEvents.delete(evaluated.id);
      run.events.set(evaluated.id, evaluated);
      this.persistRankedEvents(run);
      this.emit(run, {
        type: existed ? "event.updated" : "event.added",
        source,
        event: evaluated
      });
    } else if (evaluated.relevanceDecision === "maybe") {
      run.events.delete(evaluated.id);
      run.maybeEvents.set(evaluated.id, evaluated);
      this.persistRankedEvents(run);
      this.emit(run, { type: "event.maybe", source, event: evaluated });
    }
  }

  private releaseBatch(run: SearchRun, batch: readonly PendingCandidate[]): void {
    for (const candidate of batch) {
      for (const source of candidate.sources) this.decrementPending(run, source);
    }
  }

  private incrementPending(run: SearchRun, source: EventSource): void {
    run.pendingBySource.set(source, (run.pendingBySource.get(source) ?? 0) + 1);
  }

  private decrementPending(run: SearchRun, source: EventSource): void {
    run.pendingBySource.set(
      source,
      Math.max(0, (run.pendingBySource.get(source) ?? 0) - 1)
    );
    this.tryFinalizeSource(run, source);
  }

  private persistRankedEvents(run: SearchRun): void {
    const visible = sortRankedEvents([...run.events.values()]);
    const maybe = sortRankedEvents([...run.maybeEvents.values()]);
    [...visible, ...maybe].forEach((event, index) =>
      this.store.saveEvent(run.searchId, event, index + 1)
    );
  }

  private updateRelevanceCounts(run: SearchRun): void {
    const evaluated = [...run.evaluatedIds]
      .map((id) => run.candidateEvents.get(id))
      .filter((event): event is NormalizedEvent => event !== undefined);
    run.relevance = {
      ...run.relevance,
      evaluatedCount: evaluated.length,
      showCount: evaluated.filter(({ relevanceDecision }) => relevanceDecision === "show").length,
      maybeCount: evaluated.filter(({ relevanceDecision }) => relevanceDecision === "maybe").length,
      hideCount: evaluated.filter(({ relevanceDecision }) => relevanceDecision === "hide").length
    };
  }

  private finishSource(
    run: SearchRun,
    source: EventSource,
    state: ConnectorState,
    eventType: PendingTerminal["eventType"],
    errorCode: string | null = null,
    safeMessage: string | null = null,
    force = false
  ): void {
    const sourceRun = run.sources.get(source);
    if (!sourceRun || sourceRun.terminal) return;
    if (sourceRun.pendingTerminal === null || force) {
      sourceRun.pendingTerminal = { state, eventType, errorCode, safeMessage };
    }
    if (force || (run.pendingBySource.get(source) ?? 0) === 0) {
      this.finalizeSource(run, source);
    }
  }

  private tryFinalizeSource(run: SearchRun, source: EventSource): void {
    const sourceRun = run.sources.get(source);
    if (
      sourceRun !== undefined &&
      !sourceRun.terminal &&
      sourceRun.pendingTerminal !== null &&
      (run.pendingBySource.get(source) ?? 0) === 0
    ) {
      this.finalizeSource(run, source);
    }
  }

  private finalizeSource(run: SearchRun, source: EventSource): void {
    const sourceRun = run.sources.get(source);
    const terminal = sourceRun?.pendingTerminal;
    if (!sourceRun || sourceRun.terminal || terminal === null || terminal === undefined) return;
    sourceRun.terminal = true;
    sourceRun.status = this.statusFor(
      source,
      terminal.state,
      terminal.errorCode,
      terminal.safeMessage
    );
    this.persistSource(run, source);
    this.emit(run, {
      type: terminal.eventType,
      source,
      status: { ...sourceRun.status }
    });
    this.maybeFinishSearch(run);
  }

  private maybeFinishSearch(run: SearchRun): void {
    if (
      !run.finalized &&
      [...run.sources.values()].every(({ terminal }) => terminal) &&
      run.relevanceQueue.length === 0 &&
      run.relevanceWorker === null
    ) {
      this.finishSearch(run);
    }
  }

  private finishSearch(run: SearchRun): void {
    if (run.finalized) return;
    run.finalized = true;
    this.clearFlushTimer(run);
    if (run.status !== "cancelled") run.status = "complete";
    if (!run.usedFallback && run.relevance.state !== "unavailable") {
      run.relevance.state = "complete";
      run.relevance.safeMessage = null;
    }
    this.store.setSearchStatus(run.searchId, run.status, this.now().toISOString());
    this.emit(run, { type: "search.completed", relevance: { ...run.relevance } });
    for (const subscriber of run.subscribers) subscriber.close();
    run.subscribers.clear();
  }

  private clearFlushTimer(run: SearchRun): void {
    if (run.relevanceFlushTimer !== null) clearTimeout(run.relevanceFlushTimer);
    run.relevanceFlushTimer = null;
  }

  private persistSource(run: SearchRun, source: EventSource): void {
    const sourceRun = run.sources.get(source);
    if (!sourceRun) return;
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
    if (run.finalized && message.type !== "search.completed") return;
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
    for (const subscriber of run.subscribers) subscriber.push(sequenced);
  }
}

const noRelevanceCache: RelevanceCache = {
  get: () => null,
  put: () => undefined
};

const strictEvaluator: EventRelevanceEvaluator = {
  fingerprint: "core-strict-lexical:v1:70:1:40",
  async evaluate(events, profile, signal) {
    signal.throwIfAborted();
    return events.map((event) => strictLexicalDecision(event, profile));
  },
  async status() {
    return {
      state: "ready",
      evaluator: "strict-lexical",
      model: null,
      evaluatedCount: 0,
      showCount: 0,
      maybeCount: 0,
      hideCount: 0,
      safeMessage: null
    };
  }
};

function validateDecisionBatch(
  batch: readonly PendingCandidate[],
  decisions: readonly RelevanceDecision[]
): RelevanceDecision[] {
  const expected = new Set(batch.map(({ event }) => event.id));
  const byId = new Map<string, RelevanceDecision>();
  for (const decision of decisions) {
    if (!expected.has(decision.eventId) || byId.has(decision.eventId)) {
      throw new Error("Relevance evaluator returned invalid event IDs");
    }
    byId.set(decision.eventId, decision);
  }
  if (byId.size !== expected.size) {
    throw new Error("Relevance evaluator returned an incomplete batch");
  }
  return batch.map(({ event }) => {
    const decision = byId.get(event.id)!;
    applyRelevanceDecision(event, decision);
    return decision;
  });
}

function preserveRelevance(
  event: NormalizedEvent,
  evaluated: NormalizedEvent
): NormalizedEvent {
  return {
    ...event,
    relevanceDecision: evaluated.relevanceDecision,
    relevanceScore: evaluated.relevanceScore,
    relevanceConfidence: evaluated.relevanceConfidence,
    relevanceReason: evaluated.relevanceReason,
    matchedInterests: [...evaluated.matchedInterests]
  };
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

export function createSearchService(options: SearchServiceOptions): SearchService {
  return new DefaultSearchService(options);
}
