import { describe, expect, it } from "vitest";

import {
  applyRelevanceDecision,
  relevanceDecisionSchema,
  strictLexicalDecision,
  type RelevanceDecision
} from "../src/index.js";
import { eventFixture } from "./factories.js";

const profile = {
  positive: ["AI engineering", "climate tech"],
  excluded: ["crypto trading"],
  note: "hands-on technical events"
};

describe("relevance decision policy", () => {
  it("shows a high-confidence model decision", () => {
    const event = eventFixture();

    expect(
      applyRelevanceDecision(
        event,
        decision({
          eventId: event.id,
          decision: "show",
          score: 84,
          confidence: 0.91,
          matchedInterests: ["AI engineering", "AI engineering"],
          reason: "Hands-on AI engineering content"
        })
      )
    ).toMatchObject({
      relevanceDecision: "show",
      relevanceScore: 84,
      relevanceConfidence: 0.91,
      matchedInterests: ["AI engineering"],
      relevanceReason: "Hands-on AI engineering content"
    });
  });

  it("converts an under-threshold show decision into maybe", () => {
    const event = eventFixture();

    expect(
      applyRelevanceDecision(
        event,
        decision({ eventId: event.id, score: 62, confidence: 0.8 })
      ).relevanceDecision
    ).toBe("maybe");
  });

  it("hides a decision below the maybe threshold", () => {
    const event = eventFixture();

    expect(
      applyRelevanceDecision(
        event,
        decision({ eventId: event.id, score: 39, confidence: 0.99 })
      ).relevanceDecision
    ).toBe("hide");
  });

  it("rejects a decision for another event", () => {
    expect(() =>
      applyRelevanceDecision(
        eventFixture({ id: "expected" }),
        decision({ eventId: "unexpected" })
      )
    ).toThrow(/event ID/i);
  });

  it.each([
    decision({ score: -1 }),
    decision({ score: 101 }),
    decision({ confidence: -0.01 }),
    decision({ confidence: 1.01 }),
    decision({ reason: "" }),
    decision({ reason: "x".repeat(501) })
  ])("rejects an invalid structured decision", (candidate) => {
    expect(relevanceDecisionSchema.safeParse(candidate).success).toBe(false);
  });
});

describe("strict lexical fallback", () => {
  it("hides an event with no positive lexical match", () => {
    const event = eventFixture({
      title: "Watercolour painting for beginners",
      descriptionText: "A quiet studio session"
    });

    expect(strictLexicalDecision(event, profile)).toMatchObject({
      eventId: event.id,
      decision: "hide",
      score: 0,
      confidence: 1
    });
  });

  it("shows a positive match at the visible threshold", () => {
    const event = eventFixture({ title: "AI engineering workshop" });
    const result = strictLexicalDecision(event, profile);

    expect(result).toMatchObject({
      eventId: event.id,
      decision: "show",
      confidence: 1,
      matchedInterests: ["AI engineering"]
    });
    expect(result.score).toBeGreaterThanOrEqual(70);
  });

  it("always hides a hard exclusion even when interests also match", () => {
    const event = eventFixture({ title: "AI engineering for crypto trading" });

    expect(strictLexicalDecision(event, profile)).toMatchObject({
      decision: "hide",
      confidence: 1
    });
  });
});

function decision(
  overrides: Partial<RelevanceDecision> = {}
): RelevanceDecision {
  return {
    eventId: "event-fixture",
    decision: "show",
    score: 80,
    confidence: 0.8,
    matchedInterests: ["AI engineering"],
    reason: "Relevant to a saved interest",
    ...overrides
  };
}
