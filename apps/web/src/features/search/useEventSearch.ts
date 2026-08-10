import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  ConnectorStatus,
  EventSearchQuery,
  EventSource,
  NormalizedEvent,
  RelevanceStatus,
  SearchStreamMessage
} from "@event-agg/core";

import type { EventApi } from "../../lib/api.js";

export type SearchPhase = "idle" | "searching" | "complete" | "cancelled" | "error";

export function useEventSearch(api: EventApi) {
  const [eventMap, setEventMap] = useState<Map<string, NormalizedEvent>>(
    () => new Map()
  );
  const [maybeEventMap, setMaybeEventMap] = useState<
    Map<string, NormalizedEvent>
  >(() => new Map());
  const [sourceStatuses, setSourceStatuses] = useState<
    Partial<Record<EventSource, ConnectorStatus>>
  >({});
  const [phase, setPhase] = useState<SearchPhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [relevance, setRelevance] = useState<RelevanceStatus | null>(null);
  const searchIdRef = useRef<string | null>(null);
  const closeStreamRef = useRef<(() => void) | null>(null);

  const closeStream = useCallback(() => {
    closeStreamRef.current?.();
    closeStreamRef.current = null;
  }, []);

  useEffect(
    () => () => {
      closeStream();
      const searchId = searchIdRef.current;
      searchIdRef.current = null;
      if (searchId) void api.cancelSearch(searchId);
    },
    [api, closeStream]
  );

  const onMessage = useCallback(
    (message: SearchStreamMessage) => {
      if (
        (message.type === "event.added" || message.type === "event.updated") &&
        message.event?.relevanceDecision === "show"
      ) {
        setEventMap((current) => {
          const next = new Map(current);
          next.set(message.event!.id, message.event!);
          return next;
        });
        setMaybeEventMap((current) => {
          const next = new Map(current);
          next.delete(message.event!.id);
          return next;
        });
      }
      if (
        message.type === "event.updated" &&
        message.event?.relevanceDecision === "hide"
      ) {
        setEventMap((current) => {
          const next = new Map(current);
          next.delete(message.event!.id);
          return next;
        });
        setMaybeEventMap((current) => {
          const next = new Map(current);
          next.delete(message.event!.id);
          return next;
        });
      }
      if (message.type === "event.maybe" && message.event) {
        setMaybeEventMap((current) => {
          const next = new Map(current);
          next.set(message.event!.id, message.event!);
          return next;
        });
        setEventMap((current) => {
          const next = new Map(current);
          next.delete(message.event!.id);
          return next;
        });
      }
      if (message.relevance) setRelevance(message.relevance);
      if (message.source && message.status) {
        setSourceStatuses((current) => ({
          ...current,
          [message.source!]: message.status
        }));
      }
      if (message.type === "search.completed") {
        searchIdRef.current = null;
        setPhase("complete");
        closeStream();
      }
    },
    [closeStream]
  );

  const start = useCallback(
    async (query: EventSearchQuery) => {
      const previousSearchId = searchIdRef.current;
      searchIdRef.current = null;
      closeStream();
      if (previousSearchId) await api.cancelSearch(previousSearchId);
      setEventMap(new Map());
      setMaybeEventMap(new Map());
      setSourceStatuses({});
      setError(null);
      setRelevance(null);
      setPhase("searching");
      try {
        const { searchId, streamUrl } = await api.startSearch(query);
        searchIdRef.current = searchId;
        closeStreamRef.current = api.openSearchStream(streamUrl, onMessage, () => {
          setError("The event stream disconnected");
          setPhase("error");
        });
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Search could not start");
        setPhase("error");
      }
    },
    [api, closeStream, onMessage]
  );

  const stop = useCallback(async () => {
    const searchId = searchIdRef.current;
    searchIdRef.current = null;
    closeStream();
    if (searchId) {
      await api.cancelSearch(searchId);
    }
    setPhase("cancelled");
  }, [api, closeStream]);

  const events = useMemo(
    () => sortEvents(eventMap),
    [eventMap]
  );
  const maybeEvents = useMemo(() => sortEvents(maybeEventMap), [maybeEventMap]);

  return {
    events,
    maybeEvents,
    relevance,
    sourceStatuses,
    phase,
    error,
    start,
    stop
  };
}

function sortEvents(events: Map<string, NormalizedEvent>): NormalizedEvent[] {
  return [...events.values()].sort(
    (left, right) =>
      right.relevanceScore - left.relevanceScore ||
      Date.parse(left.startsAt) - Date.parse(right.startsAt) ||
      left.title.localeCompare(right.title)
  );
}
