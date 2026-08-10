import { isEventExcluded, rankEvent } from "./rank.js";
import { relevanceDecisionSchema } from "./schemas.js";
import type {
  InterestProfile,
  NormalizedEvent,
  RelevanceDecision
} from "./types.js";

export interface RelevancePolicy {
  showScore: number;
  showConfidence: number;
  maybeScore: number;
}

export const DEFAULT_RELEVANCE_POLICY: RelevancePolicy = {
  showScore: 70,
  showConfidence: 0.55,
  maybeScore: 40
};

export function applyRelevanceDecision(
  event: NormalizedEvent,
  input: RelevanceDecision,
  policy: RelevancePolicy = DEFAULT_RELEVANCE_POLICY
): NormalizedEvent {
  const parsed = relevanceDecisionSchema.parse(input);
  if (parsed.eventId !== event.id) {
    throw new TypeError("Relevance decision event ID does not match the event");
  }
  const decision =
    parsed.decision === "hide" || parsed.score < policy.maybeScore
      ? "hide"
      : parsed.decision === "show" &&
          parsed.score >= policy.showScore &&
          parsed.confidence >= policy.showConfidence
        ? "show"
        : "maybe";
  return {
    ...event,
    relevanceDecision: decision,
    relevanceScore: parsed.score,
    relevanceConfidence: parsed.confidence,
    relevanceReason: parsed.reason,
    matchedInterests: [...new Set(parsed.matchedInterests)]
  };
}

export function strictLexicalDecision(
  event: NormalizedEvent,
  profile: InterestProfile
): RelevanceDecision {
  if (isEventExcluded(event, profile)) {
    return {
      eventId: event.id,
      decision: "hide",
      score: 0,
      confidence: 1,
      matchedInterests: [],
      reason: "Matches a saved exclusion"
    };
  }

  const ranked = rankEvent(event, profile);
  if (ranked.relevanceScore <= 0) {
    return {
      eventId: event.id,
      decision: "hide",
      score: 0,
      confidence: 1,
      matchedInterests: [],
      reason: "No saved interest matched"
    };
  }

  return {
    eventId: event.id,
    decision: "show",
    score: Math.min(100, DEFAULT_RELEVANCE_POLICY.showScore + ranked.relevanceScore),
    confidence: 1,
    matchedInterests: ranked.matchedInterests,
    reason: "Matched saved interests using strict lexical fallback"
  };
}
