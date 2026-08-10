// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { RelevanceStatus } from "./RelevanceStatus.js";

describe("RelevanceStatus", () => {
  it("shows model progress without exposing raw model data", () => {
    render(
      <RelevanceStatus
        status={{
          state: "evaluating",
          evaluator: "ollama",
          model: "gemma3:4b",
          evaluatedCount: 10,
          showCount: 3,
          maybeCount: 2,
          hideCount: 5,
          safeMessage: null
        }}
      />
    );

    expect(screen.getByText("Evaluating 10 · 3 accepted")).toBeTruthy();
    expect(screen.getByText("gemma3:4b · local")).toBeTruthy();
  });

  it("shows a clear fallback banner", () => {
    render(
      <RelevanceStatus
        status={{
          state: "fallback",
          evaluator: "resilient",
          model: "gemma3:4b",
          evaluatedCount: 4,
          showCount: 1,
          maybeCount: 0,
          hideCount: 3,
          safeMessage: "Local relevance model is unavailable"
        }}
      />
    );

    expect(screen.getByRole("status").textContent).toContain(
      "Local relevance model is unavailable"
    );
    expect(screen.getByRole("status").textContent).toContain(
      "strict text filter"
    );
  });
});
