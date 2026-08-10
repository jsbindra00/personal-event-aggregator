export type EventSource = "meetup" | "luma" | "guild" | "eventbrite";

export type ConnectorState =
  | "disconnected"
  | "ready"
  | "searching"
  | "auth_required"
  | "user_action_required"
  | "rate_limited"
  | "failed"
  | "cancelled"
  | "complete";

export interface ConnectorStatus {
  source: EventSource;
  state: ConnectorState;
  lastSuccessAt: string | null;
  errorCode: string | null;
  safeMessage: string | null;
}

export interface EventSearchQuery {
  locationText: string;
  startDate: string;
  endDate: string;
  timeZone: string;
}

export interface ResolvedSearchQuery extends EventSearchQuery {
  startsAtUtc: string;
  endsBeforeUtc: string;
}

export interface InterestProfile {
  positive: string[];
  excluded: string[];
  note: string;
}

export interface RawSourceEvent {
  source: EventSource;
  sourceEventId: string | null;
  canonicalUrl: string;
  title: string;
  startsAt: string;
  endsAt?: string | null;
  timeZone?: string | null;
  descriptionHtml?: string | null;
  descriptionText?: string | null;
  organizerName?: string | null;
  venueName?: string | null;
  addressText?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  isOnline?: boolean;
  imageUrl?: string | null;
  priceText?: string | null;
  tags?: string[];
}

export interface NormalizedEvent
  extends Required<Omit<RawSourceEvent, "descriptionHtml">> {
  id: string;
  relevanceDecision: RelevanceDecisionKind;
  relevanceScore: number;
  relevanceConfidence: number;
  relevanceReason: string;
  matchedInterests: string[];
  firstSeenAt: string;
}

export type RelevanceDecisionKind = "show" | "maybe" | "hide";

export interface RelevanceDecision {
  eventId: string;
  decision: RelevanceDecisionKind;
  score: number;
  confidence: number;
  matchedInterests: string[];
  reason: string;
}

export interface RelevanceStatus {
  state: "ready" | "evaluating" | "fallback" | "unavailable" | "complete";
  evaluator: string;
  model: string | null;
  evaluatedCount: number;
  showCount: number;
  maybeCount: number;
  hideCount: number;
  safeMessage: string | null;
}

export interface EventRelevanceEvaluator {
  readonly fingerprint: string;
  evaluate(
    events: readonly NormalizedEvent[],
    profile: InterestProfile,
    signal: AbortSignal
  ): Promise<RelevanceDecision[]>;
  status(signal?: AbortSignal): Promise<RelevanceStatus>;
}

export type ConnectorMessage =
  | {
      type: "progress";
      source: EventSource;
      phase: string;
      count?: number;
      resolvedLocation?: string;
    }
  | { type: "event"; source: EventSource; event: RawSourceEvent }
  | { type: "auth_required"; source: EventSource; safeMessage: string }
  | {
      type: "user_action_required";
      source: EventSource;
      safeMessage: string;
    }
  | {
      type: "rate_limited";
      source: EventSource;
      retryAfterMs?: number;
      safeMessage: string;
    }
  | {
      type: "failed";
      source: EventSource;
      errorCode: string;
      safeMessage: string;
    }
  | { type: "complete"; source: EventSource; count: number };

export interface EventConnector {
  readonly source: EventSource;
  getStatus(): Promise<ConnectorStatus>;
  connect(): AsyncIterable<ConnectorMessage>;
  search(
    query: ResolvedSearchQuery,
    signal: AbortSignal
  ): AsyncIterable<ConnectorMessage>;
}

export interface SearchStreamMessage {
  sequence: number;
  searchId: string;
  type:
    | "search.started"
    | "source.progress"
    | "source.auth_required"
    | "source.user_action_required"
    | "source.rate_limited"
    | "source.failed"
    | "event.added"
    | "event.updated"
    | "event.maybe"
    | "relevance.progress"
    | "relevance.fallback"
    | "source.completed"
    | "search.completed";
  source?: EventSource;
  event?: NormalizedEvent;
  status?: ConnectorStatus;
  relevance?: RelevanceStatus;
  progress?: {
    phase: string;
    count?: number;
    resolvedLocation?: string;
  };
}
