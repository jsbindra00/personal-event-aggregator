import type { ConnectorStatus, EventSource } from "@event-agg/core";

const sourceNames: Record<EventSource, string> = {
  meetup: "Meetup",
  luma: "Luma",
  guild: "Guild.host",
  eventbrite: "Eventbrite"
};

interface SourceStatusProps {
  statuses: Partial<Record<EventSource, ConnectorStatus>>;
  onConnect(source: EventSource): void | Promise<void>;
}

export function SourceStatus({ statuses, onConnect }: SourceStatusProps) {
  return (
    <div className="source-strip" aria-label="Event sources">
      {(Object.keys(sourceNames) as EventSource[]).map((source) => {
        const status = statuses[source];
        return (
          <div className={`source-chip state-${status?.state ?? "disconnected"}`} key={source}>
            <span className="source-dot" aria-hidden="true" />
            <strong>{sourceNames[source]}</strong>
            <span>{(status?.state ?? "disconnected").replaceAll("_", " ")}</span>
            {actionFor(source, status) && (
              <button
                type="button"
                className="source-action"
                aria-label={`${actionFor(source, status)} ${sourceNames[source]}`}
                title={status?.safeMessage ?? undefined}
                onClick={() => void onConnect(source)}
              >
                {actionFor(source, status)}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

function actionFor(
  source: EventSource,
  status: ConnectorStatus | undefined
): string | null {
  const state = status?.state ?? "disconnected";
  if (source === "guild") return null;
  if (state === "disconnected") return "Connect";
  if (state === "auth_required") return "Sign in again";
  if (state === "failed" || state === "user_action_required") {
    return "Open source";
  }
  return null;
}
