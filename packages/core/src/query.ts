import { Temporal } from "@js-temporal/polyfill";
import { z } from "zod";

import type { EventSearchQuery, ResolvedSearchQuery } from "./types.js";

const calendarDatePattern = /^\d{4}-\d{2}-\d{2}$/;

const eventSearchQuerySchema = z.object({
  locationText: z.string().trim().min(1, "Location is required"),
  startDate: z.string().regex(calendarDatePattern, "Invalid start date"),
  endDate: z.string().regex(calendarDatePattern, "Invalid end date"),
  timeZone: z.string().trim().min(1, "Time zone is required")
});

function parseDate(value: string, field: "start" | "end"): Temporal.PlainDate {
  try {
    return Temporal.PlainDate.from(value);
  } catch {
    throw new Error(`Invalid ${field} date`);
  }
}

function atStartOfDay(
  date: Temporal.PlainDate,
  timeZone: string
): Temporal.ZonedDateTime {
  try {
    return date.toZonedDateTime({ plainTime: "00:00", timeZone });
  } catch {
    throw new Error("Invalid time zone");
  }
}

function toUtcString(value: Temporal.ZonedDateTime): string {
  return value.toInstant().toString({ fractionalSecondDigits: 3 });
}

export function resolveSearchQuery(input: EventSearchQuery): ResolvedSearchQuery {
  const query = eventSearchQuerySchema.parse(input);
  const startDate = parseDate(query.startDate, "start");
  const endDate = parseDate(query.endDate, "end");

  if (Temporal.PlainDate.compare(endDate, startDate) < 0) {
    throw new Error("End date must not precede start date");
  }

  const startsAt = atStartOfDay(startDate, query.timeZone);
  const endsBefore = atStartOfDay(endDate.add({ days: 1 }), query.timeZone);

  return {
    ...query,
    startsAtUtc: toUtcString(startsAt),
    endsBeforeUtc: toUtcString(endsBefore)
  };
}
