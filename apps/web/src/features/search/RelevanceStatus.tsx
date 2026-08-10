import type { RelevanceStatus as RelevanceStatusValue } from "@event-agg/core";

interface RelevanceStatusProps {
  status: RelevanceStatusValue | null;
}

export function RelevanceStatus({ status }: RelevanceStatusProps) {
  if (status === null) return null;
  const progress = status.state === "evaluating"
    ? `Evaluating ${status.evaluatedCount} · ${status.showCount} accepted`
    : `Filtered ${status.evaluatedCount} · ${status.showCount} accepted`;
  const isFallback =
    status.state === "fallback" || status.state === "unavailable";

  return (
    <div
      className={`relevance-status${isFallback ? " relevance-fallback" : ""}`}
      role={isFallback ? "status" : undefined}
    >
      <div>
        <strong>{progress}</strong>
        <span>{status.maybeCount} maybe · {status.hideCount} hidden</span>
      </div>
      <div className="relevance-engine">
        {status.model ? `${status.model} · local` : "strict text filter"}
      </div>
      {isFallback && (
        <p>
          {status.safeMessage ?? "Local relevance model is unavailable"}; using
          the strict text filter.
        </p>
      )}
    </div>
  );
}
