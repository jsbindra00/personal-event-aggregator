export { canonicalizeEventUrl } from "./canonical-url.js";
export {
  areProbableDuplicates,
  eventIdentity,
  mergeDuplicate
} from "./dedupe.js";
export { normalizeEvent } from "./normalize.js";
export { resolveSearchQuery } from "./query.js";
export { MATCH_WEIGHTS, rankEvent, sortRankedEvents } from "./rank.js";
export type {
  ConnectorMessage,
  ConnectorState,
  ConnectorStatus,
  EventConnector,
  EventSearchQuery,
  EventSource,
  InterestProfile,
  NormalizedEvent,
  RawSourceEvent,
  ResolvedSearchQuery,
  SearchStreamMessage
} from "./types.js";
