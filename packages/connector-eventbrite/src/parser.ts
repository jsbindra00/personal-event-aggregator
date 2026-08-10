import {
  canonicalizeEventUrl,
  type RawSourceEvent
} from "@event-agg/core";
import { z } from "zod";

const addressSchema = z
  .object({
    streetAddress: z.string().nullable().optional(),
    addressLocality: z.string().nullable().optional(),
    addressRegion: z.string().nullable().optional(),
    postalCode: z.string().nullable().optional(),
    addressCountry: z.string().nullable().optional()
  })
  .passthrough();

const locationSchema = z
  .object({
    name: z.string().nullable().optional(),
    address: addressSchema.nullable().optional(),
    geo: z
      .object({
        latitude: z.union([z.string(), z.number()]),
        longitude: z.union([z.string(), z.number()])
      })
      .passthrough()
      .nullable()
      .optional()
  })
  .passthrough();

const eventSchema = z
  .object({
    name: z.string().min(1),
    startDate: z.string().min(1),
    endDate: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
    url: z.string().url(),
    image: z.union([z.string().url(), z.array(z.string().url())]).nullable().optional(),
    eventAttendanceMode: z.string().nullable().optional(),
    location: locationSchema.nullable().optional()
  })
  .passthrough();

const itemListSchema = z
  .object({
    "@type": z.literal("ItemList"),
    itemListElement: z.array(
      z.object({ item: eventSchema }).passthrough()
    )
  })
  .passthrough();

export class EventbritePayloadError extends Error {
  readonly code = "contract_drift" as const;

  constructor(options: { cause?: unknown } = {}) {
    super("Eventbrite's event response changed", options);
    this.name = "EventbritePayloadError";
  }
}

export function parseEventbriteSearchPayload(
  payload: unknown
): RawSourceEvent[] {
  const parsed = itemListSchema.safeParse(payload);
  if (!parsed.success) {
    throw new EventbritePayloadError({ cause: parsed.error });
  }

  try {
    const events = new Map<string, RawSourceEvent>();
    for (const { item } of parsed.data.itemListElement) {
      const event = mapEvent(item);
      events.set(event.canonicalUrl, event);
    }
    return [...events.values()];
  } catch (error) {
    if (error instanceof EventbritePayloadError) throw error;
    throw new EventbritePayloadError({ cause: error });
  }
}

function mapEvent(item: z.infer<typeof eventSchema>): RawSourceEvent {
  if (Number.isNaN(Date.parse(item.startDate))) {
    throw new EventbritePayloadError();
  }
  if (item.endDate !== undefined && item.endDate !== null) {
    if (Number.isNaN(Date.parse(item.endDate))) {
      throw new EventbritePayloadError();
    }
  }

  const canonicalUrl = canonicalizeEventUrl(item.url).replace(/\/$/, "");
  const hostname = new URL(canonicalUrl).hostname;
  if (!/(^|\.)eventbrite\.[a-z.]+$/i.test(hostname)) {
    throw new EventbritePayloadError();
  }
  const idMatch = new URL(canonicalUrl).pathname.match(/-(\d+)\/?$/);
  const image = Array.isArray(item.image) ? item.image[0] : item.image;

  return {
    source: "eventbrite",
    sourceEventId: idMatch?.[1] ?? null,
    canonicalUrl,
    title: item.name,
    startsAt: item.startDate,
    endsAt: item.endDate ?? null,
    timeZone: null,
    descriptionText: item.description ?? null,
    organizerName: null,
    venueName: item.location?.name ?? null,
    addressText: formattedAddress(item.location?.address),
    latitude: coordinate(item.location?.geo?.latitude),
    longitude: coordinate(item.location?.geo?.longitude),
    isOnline: item.eventAttendanceMode?.includes("Online") === true,
    imageUrl: image ?? null,
    priceText: null,
    tags: []
  };
}

function formattedAddress(
  address:
    | {
        streetAddress?: string | null | undefined;
        addressLocality?: string | null | undefined;
        addressRegion?: string | null | undefined;
        postalCode?: string | null | undefined;
        addressCountry?: string | null | undefined;
      }
    | null
    | undefined
): string | null {
  if (address === undefined || address === null) return null;
  const parts = [
    address.streetAddress,
    address.addressLocality,
    address.addressRegion,
    address.postalCode,
    address.addressCountry
  ]
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part));
  return parts.length === 0 ? null : [...new Set(parts)].join(", ");
}

function coordinate(value: string | number | null | undefined): number | null {
  if (value === undefined || value === null) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
