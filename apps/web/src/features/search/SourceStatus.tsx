import type { ConnectorStatus, EventSource } from "@event-agg/core";

const sourceNames: Record<EventSource, string> = {
  meetup: "Meetup",
  luma: "Luma",
  guild: "Guild",
  eventbrite: "Eventbrite"
};

interface SourceStatusProps {
  statuses: Partial<Record<EventSource, ConnectorStatus>>;
}

export function SourceStatus({ statuses }: SourceStatusProps) {
  return (
    <div className="source-strip" aria-label="Event sources">
      {(Object.keys(sourceNames) as EventSource[]).map((source) => {
        const status = statuses[source];
        return (
          <div className={`source-chip state-${status?.state ?? "disconnected"}`} key={source}>
            <span className="source-dot" aria-hidden="true" />
            <strong>{sourceNames[source]}</strong>
            <span>{(status?.state ?? "disconnected").replaceAll("_", " ")}</span>
          </div>
        );
      })}
    </div>
  );
}

