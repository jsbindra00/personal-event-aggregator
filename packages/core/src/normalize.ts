import { createHash } from "node:crypto";

import { convert } from "html-to-text";

import { canonicalizeEventUrl } from "./canonical-url.js";
import type { NormalizedEvent, RawSourceEvent } from "./types.js";

export interface NormalizationOptions {
  now?: () => Date;
}

function cleanText(value: string | null | undefined): string | null {
  if (value == null) {
    return null;
  }

  const cleaned = value.normalize("NFKC").replace(/\s+/g, " ").trim();
  return cleaned || null;
}

function normalizeTimestamp(
  value: string | null | undefined,
  field: "start" | "end"
): string | null {
  if (value == null) {
    return null;
  }

  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) {
    throw new Error(`Event ${field} timestamp is invalid`);
  }
  return timestamp.toISOString();
}

function optionalHttpUrl(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function normalizeTimeZone(value: string | null | undefined): string | null {
  const cleaned = cleanText(value);
  if (!cleaned) return null;

  try {
    return new Intl.DateTimeFormat("en", { timeZone: cleaned }).resolvedOptions()
      .timeZone;
  } catch {
    return null;
  }
}

function stableEventId(source: string, sourceId: string | null, url: string): string {
  if (sourceId) {
    return `${source}:${sourceId}`;
  }

  const digest = createHash("sha256").update(url).digest("hex").slice(0, 20);
  return `${source}:url:${digest}`;
}

export function normalizeEvent(
  raw: RawSourceEvent,
  options: NormalizationOptions = {}
): NormalizedEvent {
  const title = cleanText(raw.title);
  if (!title) {
    throw new Error("Event title is required");
  }

  const startsAt = normalizeTimestamp(raw.startsAt, "start");
  if (!startsAt) {
    throw new Error("Event start timestamp is required");
  }

  const canonicalUrl = canonicalizeEventUrl(raw.canonicalUrl);
  const htmlDescription = raw.descriptionHtml
    ? convert(raw.descriptionHtml, {
        selectors: [{ selector: "a", options: { ignoreHref: true } }],
        wordwrap: false
      })
    : null;
  const descriptionText = cleanText(raw.descriptionText ?? htmlDescription);
  const tags = [...new Set((raw.tags ?? []).map(cleanText).filter((tag): tag is string => Boolean(tag)))];
  const sourceEventId = cleanText(raw.sourceEventId);

  return {
    id: stableEventId(raw.source, sourceEventId, canonicalUrl),
    source: raw.source,
    sourceEventId,
    canonicalUrl,
    title,
    startsAt,
    endsAt: normalizeTimestamp(raw.endsAt, "end"),
    timeZone: normalizeTimeZone(raw.timeZone),
    descriptionText,
    organizerName: cleanText(raw.organizerName),
    venueName: cleanText(raw.venueName),
    addressText: cleanText(raw.addressText),
    latitude: Number.isFinite(raw.latitude) ? (raw.latitude ?? null) : null,
    longitude: Number.isFinite(raw.longitude) ? (raw.longitude ?? null) : null,
    isOnline: raw.isOnline ?? false,
    imageUrl: optionalHttpUrl(raw.imageUrl),
    priceText: cleanText(raw.priceText),
    tags,
    relevanceScore: 0,
    matchedInterests: [],
    firstSeenAt: (options.now ?? (() => new Date()))().toISOString()
  };
}
