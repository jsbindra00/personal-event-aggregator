export { canonicalizeEventUrl } from "./canonical-url.js";
export {
  areProbableDuplicates,
  eventIdentity,
  mergeDuplicate
} from "./dedupe.js";
export { normalizeEvent } from "./normalize.js";
export { resolveSearchQuery } from "./query.js";
export { redactDiagnostic } from "./redact.js";
export {
  eventSearchQuerySchema,
  eventSourceSchema,
  interestProfileSchema,
  relevanceDecisionKindSchema,
  relevanceDecisionSchema,
  relevanceStatusSchema
} from "./schemas.js";
export {
  MATCH_WEIGHTS,
  isEventExcluded,
  rankEvent,
  sortRankedEvents
} from "./rank.js";
export { createSearchService } from "./search-service.js";
export {
  applyRelevanceDecision,
  DEFAULT_RELEVANCE_POLICY,
  strictLexicalDecision
} from "./relevance.js";
export type { RelevancePolicy } from "./relevance.js";
export type {
  RelevanceCache,
  SearchService,
  SearchServiceOptions,
  SearchSnapshot,
  SearchStore
} from "./search-service.js";
export type {
  ConnectorMessage,
  ConnectorState,
  ConnectorStatus,
  EventConnector,
  EventRelevanceEvaluator,
  EventSearchQuery,
  EventSource,
  InterestProfile,
  NormalizedEvent,
  RawSourceEvent,
  RelevanceDecision,
  RelevanceDecisionKind,
  RelevanceStatus,
  ResolvedSearchQuery,
  SearchStreamMessage
} from "./types.js";
export { AsyncQueue } from "./async-queue.js";
