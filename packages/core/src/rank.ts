import type { InterestProfile, NormalizedEvent } from "./types.js";

export const MATCH_WEIGHTS = {
  titlePhrase: 12,
  titleToken: 5,
  tagPhrase: 7,
  organizerPhrase: 5,
  descriptionPhrase: 2,
  exclusion: -100
} as const;

function normalizedText(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase("en")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function includesPhrase(haystack: string, phrase: string): boolean {
  return Boolean(phrase && ` ${haystack} `.includes(` ${phrase} `));
}

function scoreInterest(event: NormalizedEvent, interest: string): number {
  const phrase = normalizedText(interest);
  const title = normalizedText(event.title);
  if (includesPhrase(title, phrase)) {
    return MATCH_WEIGHTS.titlePhrase;
  }

  const interestTokens = phrase.split(" ").filter(Boolean);
  const titleTokens = new Set(title.split(" ").filter(Boolean));
  const titleMatches = interestTokens.filter((token) => titleTokens.has(token)).length;
  if (titleMatches > 0) {
    return titleMatches * MATCH_WEIGHTS.titleToken;
  }

  if (event.tags.some((tag) => includesPhrase(normalizedText(tag), phrase))) {
    return MATCH_WEIGHTS.tagPhrase;
  }
  if (includesPhrase(normalizedText(event.organizerName), phrase)) {
    return MATCH_WEIGHTS.organizerPhrase;
  }
  if (includesPhrase(normalizedText(event.descriptionText), phrase)) {
    return MATCH_WEIGHTS.descriptionPhrase;
  }
  return 0;
}

function searchableText(event: NormalizedEvent): string {
  return normalizedText(
    [
      event.title,
      event.descriptionText,
      event.organizerName,
      event.tags.join(" ")
    ]
      .filter(Boolean)
      .join(" ")
  );
}

export function isEventExcluded(
  event: NormalizedEvent,
  profile: InterestProfile
): boolean {
  const allText = searchableText(event);
  return profile.excluded.some((excluded) =>
    includesPhrase(allText, normalizedText(excluded))
  );
}

export function rankEvent(
  event: NormalizedEvent,
  profile: InterestProfile
): NormalizedEvent {
  let relevanceScore = 0;
  const matchedInterests: string[] = [];

  for (const interest of profile.positive) {
    const score = scoreInterest(event, interest);
    if (score > 0) {
      relevanceScore += score;
      matchedInterests.push(interest);
    }
  }

  if (isEventExcluded(event, profile)) relevanceScore += MATCH_WEIGHTS.exclusion;

  const allText = searchableText(event);

  if (profile.note && includesPhrase(allText, normalizedText(profile.note))) {
    relevanceScore += 1;
  }

  return { ...event, relevanceScore, matchedInterests };
}

export function sortRankedEvents(
  events: readonly NormalizedEvent[]
): NormalizedEvent[] {
  return [...events].sort(
    (left, right) =>
      right.relevanceScore - left.relevanceScore ||
      Date.parse(left.startsAt) - Date.parse(right.startsAt) ||
      left.title.localeCompare(right.title)
  );
}
