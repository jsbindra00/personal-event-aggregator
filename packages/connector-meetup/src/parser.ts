import type { RawSourceEvent } from "@event-agg/core";
import { z } from "zod";

const photoSchema = z
  .object({
    highResUrl: z.string().url().nullable().optional(),
    baseUrl: z.string().url().nullable().optional()
  })
  .passthrough();

const nodeSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    dateTime: z.string().min(1),
    description: z.string().nullable().optional(),
    eventType: z.string(),
    eventUrl: z.string().url(),
    featuredEventPhoto: photoSchema.nullable().optional(),
    displayPhoto: photoSchema.nullable().optional(),
    feeSettings: z
      .object({
        currency: z.string().min(1),
        amount: z.number().nonnegative()
      })
      .passthrough()
      .nullable()
      .optional(),
    group: z
      .object({
        name: z.string().min(1),
        timezone: z.string().nullable().optional()
      })
      .passthrough(),
    venue: z
      .object({
        name: z.string().nullable().optional(),
        address: z.string().nullable().optional(),
        city: z.string().nullable().optional(),
        state: z.string().nullable().optional(),
        country: z.string().nullable().optional()
      })
      .passthrough()
      .nullable()
      .optional()
  })
  .passthrough();

const payloadSchema = z
  .object({
    data: z.object({
      result: z.object({
        pageInfo: z.object({
          hasNextPage: z.boolean(),
          endCursor: z.string().nullable()
        }),
        edges: z.array(z.object({ node: nodeSchema }).passthrough())
      })
    })
  })
  .passthrough();

export class MeetupPayloadError extends Error {
  readonly code = "contract_drift" as const;

  constructor(options: { cause?: unknown } = {}) {
    super("Meetup's event response changed", options);
    this.name = "MeetupPayloadError";
  }
}

export interface ParsedMeetupPage {
  events: RawSourceEvent[];
  hasNextPage: boolean;
  endCursor: string | null;
}

export function parseMeetupSearchPayload(payload: unknown): ParsedMeetupPage {
  const parsed = payloadSchema.safeParse(payload);
  if (!parsed.success) {
    throw new MeetupPayloadError({ cause: parsed.error });
  }

  try {
    return {
      events: parsed.data.data.result.edges.map(({ node }) => mapNode(node)),
      hasNextPage: parsed.data.data.result.pageInfo.hasNextPage,
      endCursor: parsed.data.data.result.pageInfo.endCursor
    };
  } catch (error) {
    if (error instanceof MeetupPayloadError) throw error;
    throw new MeetupPayloadError({ cause: error });
  }
}

export function meetupPayloadRequiresAuth(payload: unknown): boolean {
  if (typeof payload !== "object" || payload === null || !("errors" in payload)) {
    return false;
  }
  const errors = (payload as { errors?: unknown }).errors;
  if (!Array.isArray(errors)) return false;
  return errors.some((error) => {
    if (typeof error !== "object" || error === null) return false;
    const extensions = (error as { extensions?: unknown }).extensions;
    return (
      typeof extensions === "object" &&
      extensions !== null &&
      (extensions as { code?: unknown }).code === "UNAUTHENTICATED"
    );
  });
}

function mapNode(node: z.infer<typeof nodeSchema>): RawSourceEvent {
  if (Number.isNaN(Date.parse(node.dateTime))) throw new MeetupPayloadError();
  const canonicalUrl = new URL(node.eventUrl);
  if (
    canonicalUrl.protocol !== "https:" ||
    (canonicalUrl.hostname !== "www.meetup.com" &&
      canonicalUrl.hostname !== "meetup.com")
  ) {
    throw new MeetupPayloadError();
  }

  return {
    source: "meetup",
    sourceEventId: node.id,
    canonicalUrl: canonicalUrl.href,
    title: node.title,
    startsAt: node.dateTime,
    endsAt: null,
    timeZone: node.group.timezone ?? null,
    descriptionHtml: node.description ?? null,
    organizerName: node.group.name,
    venueName: node.venue?.name ?? null,
    addressText: meetupAddress(node.venue),
    latitude: null,
    longitude: null,
    isOnline: node.eventType === "ONLINE",
    imageUrl:
      node.featuredEventPhoto?.highResUrl ??
      node.featuredEventPhoto?.baseUrl ??
      node.displayPhoto?.highResUrl ??
      node.displayPhoto?.baseUrl ??
      null,
    priceText:
      node.feeSettings === undefined || node.feeSettings === null
        ? null
        : `${node.feeSettings.currency.toUpperCase()} ${node.feeSettings.amount.toFixed(2)}`,
    tags: []
  };
}

function meetupAddress(
  venue:
    | {
        address?: string | null | undefined;
        city?: string | null | undefined;
        state?: string | null | undefined;
        country?: string | null | undefined;
      }
    | null
    | undefined
): string | null {
  if (venue === undefined || venue === null) return null;
  const parts = [venue.address, venue.city, venue.state, venue.country?.toUpperCase()]
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part));
  return parts.length === 0 ? null : [...new Set(parts)].join(", ");
}
