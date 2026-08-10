import type { NormalizedEvent } from "@event-agg/core";

interface EventResultsProps {
  events: NormalizedEvent[];
  searching: boolean;
}

function formatDate(event: NormalizedEvent): string {
  const options: Intl.DateTimeFormatOptions = {
    dateStyle: "medium",
    timeStyle: "short",
    ...(event.timeZone ? { timeZone: event.timeZone } : {})
  };
  try {
    return new Intl.DateTimeFormat(undefined, options).format(
      new Date(event.startsAt)
    );
  } catch {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short"
    }).format(new Date(event.startsAt));
  }
}

export function EventResults({ events, searching }: EventResultsProps) {
  if (events.length === 0) {
    return (
      <div className="empty-state">
        <p>{searching ? "Scanning event sources…" : "Run a search to find your next room."}</p>
      </div>
    );
  }

  return (
    <div className="event-list">
      {events.map((event) => (
        <article className="event-card" key={event.id}>
          <div className="event-card-topline">
            <span className="source-label">{event.source}</span>
            <span className="score-label">{event.relevanceScore} relevance</span>
          </div>
          <h3>{event.title}</h3>
          <p className="event-time">{formatDate(event)}</p>
          <p className="event-location">
            {event.isOnline
              ? "Online"
              : [event.venueName, event.addressText].filter(Boolean).join(" · ") ||
                "Location on event page"}
          </p>
          {event.matchedInterests.length > 0 && (
            <div className="interest-matches">
              {event.matchedInterests.map((interest) => (
                <span key={interest}>{interest}</span>
              ))}
            </div>
          )}
          <a href={event.canonicalUrl} target="_blank" rel="noreferrer">
            Open event <span aria-hidden="true">↗</span>
          </a>
        </article>
      ))}
    </div>
  );
}
