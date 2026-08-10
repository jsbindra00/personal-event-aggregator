import {
  isEventExcluded,
  strictLexicalDecision,
  type EventRelevanceEvaluator,
  type InterestProfile,
  type NormalizedEvent,
  type RelevanceDecision,
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

  private currentStatus: RelevanceStatus | null = null;
  private lastPrimaryStatus: RelevanceStatus | null = null;
  private usedFallback = false;
  private safeFailure: string | null = null;

  constructor(
    private readonly primary: EventRelevanceEvaluator,
    private readonly fallback: EventRelevanceEvaluator
  ) {
    this.fingerprint = `resilient:${primary.fingerprint}:${fallback.fingerprint}`;
  }

  async evaluate(
    events: readonly NormalizedEvent[],
    profile: InterestProfile,
    signal: AbortSignal
  ): Promise<RelevanceDecision[]> {
    signal.throwIfAborted();
    this.usedFallback = false;
    this.safeFailure = null;
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
        for (const decision of await this.primary.evaluate(
          candidates,
          profile,
          signal
        )) {
          decisions.set(decision.eventId, decision);
        }
      } catch (error) {
        this.throwIfCancelled(signal, error);
        await this.rememberFailure(error, signal);
        const halves = split(candidates);
        for (const half of halves) {
          try {
            for (const decision of await this.primary.evaluate(
              half,
              profile,
              signal
            )) {
              decisions.set(decision.eventId, decision);
            }
          } catch (halfError) {
            this.throwIfCancelled(signal, halfError);
            await this.rememberFailure(halfError, signal);
            this.usedFallback = true;
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
      return decision;
    });
    this.currentStatus = summarize(
      this.usedFallback ? "fallback" : "complete",
      ordered,
      this.lastPrimaryStatus?.model ?? null,
      this.usedFallback ? this.safeFailure : null
    );
    return ordered;
  }

  async status(signal?: AbortSignal): Promise<RelevanceStatus> {
    if (this.currentStatus !== null) return { ...this.currentStatus };
    const status = await this.primary.status(signal);
    this.lastPrimaryStatus = status;
    return { ...status, evaluator: "resilient" };
  }

  private throwIfCancelled(signal: AbortSignal, error: unknown): void {
    if (signal.aborted) throw signal.reason ?? error;
  }

  private async rememberFailure(
    error: unknown,
    signal: AbortSignal
  ): Promise<void> {
    if (error instanceof OllamaEvaluationError) {
      this.safeFailure = error.message;
      return;
    }
    try {
      const status = await this.primary.status(signal);
      this.lastPrimaryStatus = status;
      this.safeFailure =
        status.safeMessage ??
        "Local relevance model was unavailable; using strict fallback";
    } catch (statusError) {
      this.throwIfCancelled(signal, statusError);
      this.safeFailure =
        "Local relevance model was unavailable; using strict fallback";
    }
  }
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
