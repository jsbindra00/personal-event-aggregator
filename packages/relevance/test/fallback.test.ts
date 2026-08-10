import type {
  EventRelevanceEvaluator,
  RelevanceDecision,
  RelevanceStatus
} from "@event-agg/core";
import { describe, expect, it } from "vitest";

import {
  createLexicalRelevanceEvaluator,
  createResilientRelevanceEvaluator
} from "../src/index.js";
import { decision, event, profile } from "./factories.js";

describe("resilient relevance evaluation", () => {
  it("retries a failed batch as two half-sized batches", async () => {
    const batch = [
      event({ id: "event:1" }),
      event({ id: "event:2" }),
      event({ id: "event:3" }),
      event({ id: "event:4" })
    ];
    const sizes: number[] = [];
    const primary = evaluator(async (events) => {
      sizes.push(events.length);
      if (events.length === 4) throw new Error("model batch failed");
      return events.map(({ id }) => decision(id));
    });
    const fallback = evaluator(async () => {
      throw new Error("fallback should not be used");
    });
    const resilient = createResilientRelevanceEvaluator(primary, fallback);

    await expect(
      resilient.evaluate(batch, profile, new AbortController().signal)
    ).resolves.toHaveLength(4);
    expect(sizes).toEqual([4, 2, 2]);
    await expect(resilient.status()).resolves.toMatchObject({
      state: "complete",
      evaluatedCount: 4,
      safeMessage: null
    });
  });

  it("falls back only for an unresolved half and reports a safe fallback state", async () => {
    const batch = [
      event({ id: "event:1" }),
      event({ id: "event:2" }),
      event({ id: "event:3" }),
      event({ id: "event:4" })
    ];
    const primary = evaluator(
      async (events) => {
        if (events.length === 4 || events[0]?.id === "event:3") {
          throw new Error("private model response");
        }
        return events.map(({ id }) => decision(id));
      },
      {
        state: "unavailable",
        safeMessage: "Local relevance model returned an invalid response"
      }
    );
    const fallbackIds: string[][] = [];
    const fallback = evaluator(async (events) => {
      fallbackIds.push(events.map(({ id }) => id));
      return events.map(({ id }) =>
        decision(id, {
          decision: "hide",
          score: 0,
          confidence: 1,
          matchedInterests: [],
          reason: "No saved interest matched"
        })
      );
    });
    const resilient = createResilientRelevanceEvaluator(primary, fallback);

    await resilient.evaluate(batch, profile, new AbortController().signal);

    expect(fallbackIds).toEqual([["event:3", "event:4"]]);
    await expect(resilient.status()).resolves.toMatchObject({
      state: "fallback",
      safeMessage: "Local relevance model returned an invalid response"
    });
    expect(JSON.stringify(await resilient.status())).not.toContain(
      "private model response"
    );
  });

  it("does not send hard exclusions to the model", async () => {
    const received: string[][] = [];
    const primary = evaluator(async (events) => {
      received.push(events.map(({ id }) => id));
      return events.map(({ id }) => decision(id));
    });
    const resilient = createResilientRelevanceEvaluator(
      primary,
      createLexicalRelevanceEvaluator()
    );
    const excluded = event({
      id: "event:excluded",
      title: "AI engineering for crypto trading"
    });
    const relevant = event({ id: "event:relevant" });

    const results = await resilient.evaluate(
      [excluded, relevant],
      profile,
      new AbortController().signal
    );

    expect(received).toEqual([["event:relevant"]]);
    expect(results[0]).toMatchObject({
      eventId: "event:excluded",
      decision: "hide"
    });
  });

  it("keeps an unsupported semantic model match out of the main feed", async () => {
    const unrelated = event({
      id: "event:music",
      title: "Electronic House Music Night",
      descriptionText: "Persian sounds, atmosphere, and storytelling",
      tags: ["music"]
    });
    const primary = evaluator(async () => [
      decision(unrelated.id, {
        decision: "show",
        score: 88,
        confidence: 0.9,
        matchedInterests: ["AI engineering", "climate tech"],
        reason: "The model inferred a connection"
      })
    ]);
    const resilient = createResilientRelevanceEvaluator(primary);

    const [result] = await resilient.evaluate(
      [unrelated],
      profile,
      new AbortController().signal
    );

    expect(result).toMatchObject({
      decision: "maybe",
      score: 69,
      matchedInterests: [],
      reason: "Possible semantic match without a direct saved-interest signal"
    });
  });

  it("requires the claimed model interest to corroborate the lexical signal", async () => {
    const incidental = event({
      id: "event:trip",
      title: "Cotswolds coach trip",
      descriptionText: "Pay by bank transfer using the listed sort code"
    });
    const customProfile = {
      positive: ["Code", "product design"],
      excluded: [],
      note: ""
    };
    const primary = evaluator(async () => [
      decision(incidental.id, {
        matchedInterests: ["Code", "product design"],
        reason: "Potentially related to product design"
      })
    ]);
    const resilient = createResilientRelevanceEvaluator(primary);

    const [result] = await resilient.evaluate(
      [incidental],
      customProfile,
      new AbortController().signal
    );

    expect(result).toMatchObject({
      decision: "maybe",
      score: 69,
      matchedInterests: []
    });
  });

  it("propagates caller cancellation instead of invoking fallback", async () => {
    let fallbackCalled = false;
    const controller = new AbortController();
    const primary = evaluator(async () => {
      controller.abort(new Error("search cancelled"));
      throw controller.signal.reason;
    });
    const fallback = evaluator(async () => {
      fallbackCalled = true;
      return [];
    });
    const resilient = createResilientRelevanceEvaluator(primary, fallback);

    await expect(
      resilient.evaluate([event()], profile, controller.signal)
    ).rejects.toThrow("search cancelled");
    expect(fallbackCalled).toBe(false);
  });
});

function evaluator(
  evaluate: EventRelevanceEvaluator["evaluate"],
  statusOverrides: Partial<RelevanceStatus> = {}
): EventRelevanceEvaluator {
  return {
    fingerprint: "fake:v1",
    evaluate,
    async status() {
      return {
        state: "ready",
        evaluator: "fake",
        model: "fake-model",
        evaluatedCount: 0,
        showCount: 0,
        maybeCount: 0,
        hideCount: 0,
        safeMessage: null,
        ...statusOverrides
      };
    }
  };
}
