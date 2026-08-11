import { canonicalizeEventUrl, type RawSourceEvent } from "@event-agg/core";
import { z } from "zod";

const ownerSchema = z
  .union([
    z.object({
      __typename: z.literal("Guild"),
      id: z.string().min(1),
      name: z.string().min(1)
    }),
    z.object({
      __typename: z.literal("User"),
      id: z.string().min(1),
      firstName: z.string(),
      lastName: z.string()
    }),
    z.object({ __typename: z.string().min(1) })
  ])
  .nullable()
  .optional();

const venueSchema = z
  .object({
    address: z
      .object({
        location: z
          .object({
            geojson: z
              .object({
                type: z.string(),
                coordinates: z.array(z.number()).min(2)
              })
              .nullable()
              .optional()
          })
          .nullable()
          .optional()
      })
      .nullable()
      .optional()
  })
  .nullable()
  .optional();

const eventSchema = z
  .object({
    __typename: z.literal("Event").optional(),
    id: z.string().min(1),
    slug: z.string().min(1),
    prettyUrl: z.string().min(1),
    fullUrl: z.string().url(),
    shortUrl: z.string().url(),
    name: z.string().min(1),
    description: z.string().nullable().optional(),
    startAt: z.string().min(1),
    endAt: z.string().min(1),
    timeZone: z.string().min(1),
    visibility: z.string().min(1),
    hasVenue: z.boolean().nullable().optional(),
    hasExternalUrl: z.boolean().nullable().optional(),
    owner: ownerSchema,
    venue: venueSchema,
    uploadedSocialCard: z.unknown().nullable().optional(),
    generatedSocialCardURL: z.string().url(),
    presentations: z.object({ edges: z.array(z.unknown()) }).passthrough(),
    createdAt: z.string().min(1),
    updatedAt: z.string().nullable().optional()
  })
  .passthrough();

const pageSchema = z
  .object({
    edges: z.array(
      z
        .object({
          cursor: z.string().nullable().optional(),
          node: eventSchema.nullable()
        })
        .passthrough()
    ),
    pageInfo: z
      .object({
        hasPreviousPage: z.boolean(),
        hasNextPage: z.boolean(),
        startCursor: z.string().nullable().optional(),
        endCursor: z.string().nullable().optional()
      })
      .passthrough()
  })
  .passthrough();

export interface ParsedGuildEventsPage {
  events: RawSourceEvent[];
  hasNextPage: boolean;
  endCursor: string | null;
}

export class GuildPayloadError extends Error {
  readonly code = "contract_drift" as const;

  constructor(options: { cause?: unknown } = {}) {
    super("Guild.host's event response changed", options);
    this.name = "GuildPayloadError";
  }
}

export function parseGuildEventsPage(payload: unknown): ParsedGuildEventsPage {
  const parsed = pageSchema.safeParse(payload);
  if (!parsed.success) {
    throw new GuildPayloadError({ cause: parsed.error });
  }

  try {
    return {
      events: parsed.data.edges.flatMap(({ node }) =>
        node === null ? [] : [mapGuildEvent(node)]
      ),
      hasNextPage: parsed.data.pageInfo.hasNextPage,
      endCursor: parsed.data.pageInfo.endCursor ?? null
    };
  } catch (error) {
    if (error instanceof GuildPayloadError) throw error;
    throw new GuildPayloadError({ cause: error });
  }
}

function mapGuildEvent(event: z.infer<typeof eventSchema>): RawSourceEvent {
  if (Number.isNaN(Date.parse(event.startAt))) throw new GuildPayloadError();
  if (Number.isNaN(Date.parse(event.endAt))) throw new GuildPayloadError();

  const canonicalUrl = canonicalizeEventUrl(event.fullUrl).replace(/\/$/, "");
  const parsedUrl = new URL(canonicalUrl);
  if (
    parsedUrl.protocol !== "https:" ||
    parsedUrl.hostname !== "guild.host" ||
    !/^\/events\/[^/]+$/.test(parsedUrl.pathname)
  ) {
    throw new GuildPayloadError();
  }

  const coordinates = event.venue?.address?.location?.geojson?.coordinates;
  const longitude = coordinates?.[0] ?? null;
  const latitude = coordinates?.[1] ?? null;
  if (
    (longitude !== null && (longitude < -180 || longitude > 180)) ||
    (latitude !== null && (latitude < -90 || latitude > 90))
  ) {
    throw new GuildPayloadError();
  }

  return {
    source: "guild",
    sourceEventId: event.id,
    canonicalUrl,
    title: event.name,
    startsAt: event.startAt,
    endsAt: event.endAt,
    timeZone: event.timeZone,
    descriptionText: event.description ?? null,
    organizerName: organizerName(event.owner),
    venueName: null,
    addressText: null,
    latitude,
    longitude,
    isOnline: event.hasExternalUrl === true,
    imageUrl: event.generatedSocialCardURL,
    priceText: null,
    tags: []
  };
}

function organizerName(owner: z.infer<typeof ownerSchema>): string | null {
  if (owner === null || owner === undefined) return null;
  if (owner.__typename === "Guild" && "name" in owner) return owner.name;
  if (owner.__typename === "User" && "firstName" in owner) {
    const value = `${owner.firstName} ${owner.lastName}`.trim();
    return value.length === 0 ? null : value;
  }
  return null;
}
