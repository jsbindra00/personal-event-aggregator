import {
  isEventExcluded,
  MATCH_WEIGHTS,
  rankEvent,
  strictLexicalDecision,
  type EventRelevanceEvaluator,
  type InterestProfile,
  type NormalizedEvent,
  type RelevanceDecision,
  type RelevanceEvaluation,
  type RelevanceStatus
} from "@event-agg/core";

import { OllamaEvaluationError } from "./ollama.js";

export function createLexicalRelevanceEvaluator(): EventRelevanceEvaluator {
  return {
    fingerprint: "lexical:v1:70:1:40",
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
}

export function createResilientRelevanceEvaluator(
  primary: EventRelevanceEvaluator,
  fallback: EventRelevanceEvaluator = createLexicalRelevanceEvaluator()
): EventRelevanceEvaluator {
  return new ResilientRelevanceEvaluator(primary, fallback);
}

class ResilientRelevanceEvaluator implements EventRelevanceEvaluator {
  readonly fingerprint: string;

  constructor(
    private readonly primary: EventRelevanceEvaluator,
    private readonly fallback: EventRelevanceEvaluator
  ) {
    this.fingerprint = `resilient:v4:${primary.fingerprint}:${fallback.fingerprint}`;
  }

  async evaluate(
    events: readonly NormalizedEvent[],
    profile: InterestProfile,
    signal: AbortSignal
  ): Promise<RelevanceDecision[]> {
    return (await this.evaluateWithStatus(events, profile, signal)).decisions;
  }

  async evaluateWithStatus(
    events: readonly NormalizedEvent[],
    profile: InterestProfile,
    signal: AbortSignal
  ): Promise<RelevanceEvaluation> {
    signal.throwIfAborted();
    let usedFallback = false;
    let safeFailure: string | null = null;
    let primaryStatus: RelevanceStatus | null = null;
    const decisions = new Map<string, RelevanceDecision>();
    const candidates: NormalizedEvent[] = [];
    for (const event of events) {
      if (isEventExcluded(event, profile)) {
        decisions.set(event.id, strictLexicalDecision(event, profile));
      } else {
        candidates.push(event);
      }
    }

    if (candidates.length > 0) {
      try {
        const result = await this.evaluatePrimary(candidates, profile, signal);
        primaryStatus = result.status;
        for (const decision of result.decisions) {
          decisions.set(decision.eventId, decision);
        }
      } catch (error) {
        this.throwIfCancelled(signal, error);
        ({ safeFailure, primaryStatus } = await this.failureDetails(error, signal));
        const halves = split(candidates);
        for (const half of halves) {
          try {
            const result = await this.evaluatePrimary(half, profile, signal);
            primaryStatus = result.status;
            for (const decision of result.decisions) {
              decisions.set(decision.eventId, decision);
            }
          } catch (halfError) {
            this.throwIfCancelled(signal, halfError);
            const failure = await this.failureDetails(halfError, signal);
            safeFailure = failure.safeFailure;
            primaryStatus = failure.primaryStatus ?? primaryStatus;
            usedFallback = true;
            for (const decision of await this.fallback.evaluate(
              half,
              profile,
              signal
            )) {
              decisions.set(decision.eventId, decision);
            }
          }
        }
      }
    }

    const ordered = events.map((event) => {
      const decision = decisions.get(event.id);
      if (decision === undefined) {
        throw new Error("Relevance evaluator returned an incomplete batch");
      }
      return corroborateModelShow(event, profile, decision);
    });
    const status = summarize(
      usedFallback ? "fallback" : "complete",
      ordered,
      primaryStatus?.model ?? null,
      usedFallback ? safeFailure : null
    );
    return { decisions: ordered, status: { ...status } };
  }

  async status(signal?: AbortSignal): Promise<RelevanceStatus> {
    const status = await this.primary.status(signal);
    return { ...status, evaluator: "resilient" };
  }

  private async evaluatePrimary(
    events: readonly NormalizedEvent[],
    profile: InterestProfile,
    signal: AbortSignal
  ): Promise<RelevanceEvaluation> {
    if (this.primary.evaluateWithStatus !== undefined) {
      return this.primary.evaluateWithStatus(events, profile, signal);
    }
    const decisions = await this.primary.evaluate(events, profile, signal);
    let status: RelevanceStatus;
    try {
      status = await this.primary.status(signal);
    } catch (error) {
      this.throwIfCancelled(signal, error);
      status = summarize("complete", decisions, null, null);
    }
    return { decisions, status };
  }

  private throwIfCancelled(signal: AbortSignal, error: unknown): void {
    if (signal.aborted) throw signal.reason ?? error;
  }

  private async failureDetails(
    error: unknown,
    signal: AbortSignal
  ): Promise<{
    safeFailure: string;
    primaryStatus: RelevanceStatus | null;
  }> {
    if (error instanceof OllamaEvaluationError) {
      return { safeFailure: error.message, primaryStatus: null };
    }
    try {
      const status = await this.primary.status(signal);
      return {
        safeFailure:
          status.safeMessage ??
          "Local relevance model was unavailable; using strict fallback",
        primaryStatus: status
      };
    } catch (statusError) {
      this.throwIfCancelled(signal, statusError);
      return {
        safeFailure:
          "Local relevance model was unavailable; using strict fallback",
        primaryStatus: null
      };
    }
  }
}

function corroborateModelShow(
  event: NormalizedEvent,
  profile: InterestProfile,
  decision: RelevanceDecision
): RelevanceDecision {
  if (decision.decision !== "show") return decision;
  const lexical = strictLexicalDecision(event, profile);
  const lexicalScore = rankEvent(event, profile).relevanceScore;
  const lexicalMatches = new Set(
    lexical.matchedInterests.map((interest) => interest.trim().toLocaleLowerCase("en"))
  );
  const corroborated = decision.matchedInterests.filter((interest) =>
    lexicalMatches.has(interest.trim().toLocaleLowerCase("en"))
  );
  if (
    lexical.decision === "show" &&
    lexicalScore >= MATCH_WEIGHTS.titleToken &&
    corroborated.length > 0
  ) {
    return { ...decision, matchedInterests: corroborated };
  }
  return {
    ...decision,
    decision: "maybe",
    score: Math.min(69, decision.score),
    matchedInterests: [],
    reason: "Possible semantic match without a direct saved-interest signal"
  };
}

function split<T>(values: readonly T[]): T[][] {
  if (values.length <= 1) return [[...values]];
  const middle = Math.ceil(values.length / 2);
  return [values.slice(0, middle), values.slice(middle)];
}

function summarize(
  state: RelevanceStatus["state"],
  decisions: readonly RelevanceDecision[],
  model: string | null,
  safeMessage: string | null
): RelevanceStatus {
  return {
    state,
    evaluator: "resilient",
    model,
    evaluatedCount: decisions.length,
    showCount: decisions.filter(({ decision }) => decision === "show").length,
    maybeCount: decisions.filter(({ decision }) => decision === "maybe").length,
    hideCount: decisions.filter(({ decision }) => decision === "hide").length,
    safeMessage
  };
}
