import type { NormalizedEvent } from "./types.js";

const duplicateTimeToleranceMs = 15 * 60 * 1_000;

function normalizedText(value: string | null): string {
  return (value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase("en")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function tokenSet(value: string): Set<string> {
  return new Set(normalizedText(value).split(" ").filter(Boolean));
}

function jaccardSimilarity(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) {
    return 0;
  }

  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) {
      intersection += 1;
    }
  }
  return intersection / (left.size + right.size - intersection);
}

function sameVenueOrOrganizer(
  left: NormalizedEvent,
  right: NormalizedEvent
): boolean {
  const leftVenue = normalizedText(left.venueName);
  const rightVenue = normalizedText(right.venueName);
  if (leftVenue && rightVenue && leftVenue === rightVenue) {
    return true;
  }

  const leftOrganizer = normalizedText(left.organizerName);
  const rightOrganizer = normalizedText(right.organizerName);
  return Boolean(
    leftOrganizer && rightOrganizer && leftOrganizer === rightOrganizer
  );
}

function completeness(event: NormalizedEvent): number {
  return [
    event.descriptionText,
    event.endsAt,
    event.timeZone,
    event.organizerName,
    event.venueName,
    event.addressText,
    event.latitude,
    event.longitude,
    event.imageUrl,
    event.priceText
  ].filter((value) => value !== null).length + (event.tags.length > 0 ? 1 : 0);
}

export function eventIdentity(event: NormalizedEvent): string {
  return `url:${event.canonicalUrl}`;
}

export function areProbableDuplicates(
  left: NormalizedEvent,
  right: NormalizedEvent
): boolean {
  if (eventIdentity(left) === eventIdentity(right)) {
    return true;
  }

  if (
    left.source === right.source &&
    left.sourceEventId &&
    left.sourceEventId === right.sourceEventId
  ) {
    return true;
  }

  const timeDifference = Math.abs(
    Date.parse(left.startsAt) - Date.parse(right.startsAt)
  );
  if (timeDifference > duplicateTimeToleranceMs || !sameVenueOrOrganizer(left, right)) {
    return false;
  }

  const leftTitle = normalizedText(left.title);
  const rightTitle = normalizedText(right.title);
  return (
    leftTitle === rightTitle ||
    jaccardSimilarity(tokenSet(leftTitle), tokenSet(rightTitle)) >= 0.9
  );
}

export function mergeDuplicate(
  current: NormalizedEvent,
  incoming: NormalizedEvent
): NormalizedEvent {
  const primary = completeness(incoming) > completeness(current) ? incoming : current;
  const secondary = primary === current ? incoming : current;

  return {
    ...primary,
    descriptionText: primary.descriptionText ?? secondary.descriptionText,
    endsAt: primary.endsAt ?? secondary.endsAt,
    timeZone: primary.timeZone ?? secondary.timeZone,
    organizerName: primary.organizerName ?? secondary.organizerName,
    venueName: primary.venueName ?? secondary.venueName,
    addressText: primary.addressText ?? secondary.addressText,
    latitude: primary.latitude ?? secondary.latitude,
    longitude: primary.longitude ?? secondary.longitude,
    imageUrl: primary.imageUrl ?? secondary.imageUrl,
    priceText: primary.priceText ?? secondary.priceText,
    tags: [...new Set([...primary.tags, ...secondary.tags])],
    relevanceScore: Math.max(primary.relevanceScore, secondary.relevanceScore),
    matchedInterests: [
      ...new Set([...primary.matchedInterests, ...secondary.matchedInterests])
    ],
    firstSeenAt:
      primary.firstSeenAt < secondary.firstSeenAt
        ? primary.firstSeenAt
        : secondary.firstSeenAt
  };
}

