import { canonicalizeEventUrl, type RawSourceEvent } from "@event-agg/core";
import { z } from "zod";

const priceSchema = z
  .object({
    cents: z.number().int().nonnegative(),
    currency: z.string().min(1),
    min_cents: z.number().int().nonnegative().optional(),
    is_flexible: z.boolean().optional()
  })
  .passthrough();

const entrySchema = z
  .object({
    event: z
      .object({
        api_id: z.string().min(1),
        cover_url: z.string().url().nullable().optional(),
        end_at: z.string().nullable().optional(),
        location_type: z.string(),
        name: z.string().min(1),
        start_at: z.string().min(1),
        timezone: z.string().nullable().optional(),
        url: z.string().min(1),
        geo_address_info: z
          .object({
            city: z.string().nullable().optional(),
            city_state: z.string().nullable().optional(),
            description: z.string().nullable().optional(),
            full_address: z.string().nullable().optional(),
            short_address: z.string().nullable().optional()
          })
          .passthrough()
          .nullable()
          .optional(),
        coordinate: z
          .object({
            latitude: z.number(),
            longitude: z.number()
          })
          .nullable()
          .optional()
      })
      .passthrough(),
    calendar: z
      .object({ name: z.string().nullable().optional() })
      .passthrough()
      .nullable()
      .optional(),
    ticket_info: z
      .object({
        is_free: z.boolean(),
        price: priceSchema.nullable().optional(),
        max_price: priceSchema.nullable().optional()
      })
      .passthrough()
      .nullable()
      .optional()
  })
  .passthrough();

const payloadSchema = z
  .object({
    entries: z.array(entrySchema),
    has_more: z.boolean(),
    next_cursor: z.string().nullable().optional()
  })
  .passthrough();

export class LumaPayloadError extends Error {
  readonly code = "contract_drift" as const;

  constructor(options: { cause?: unknown } = {}) {
    super("Luma's event response changed", options);
    this.name = "LumaPayloadError";
  }
}

export interface ParsedLumaPage {
  events: RawSourceEvent[];
  hasMore: boolean;
  nextCursor: string | null;
}

export function parseLumaSearchPayload(payload: unknown): ParsedLumaPage {
  const parsed = payloadSchema.safeParse(payload);
  if (!parsed.success) {
    throw new LumaPayloadError({ cause: parsed.error });
  }

  try {
    return {
      events: parsed.data.entries.map(mapEntry),
      hasMore: parsed.data.has_more,
      nextCursor: parsed.data.next_cursor ?? null
    };
  } catch (error) {
    if (error instanceof LumaPayloadError) throw error;
    throw new LumaPayloadError({ cause: error });
  }
}

function mapEntry(entry: z.infer<typeof entrySchema>): RawSourceEvent {
  const event = entry.event;
  assertTimestamp(event.start_at);
  if (event.end_at !== undefined && event.end_at !== null) {
    assertTimestamp(event.end_at);
  }

  return {
    source: "luma",
    sourceEventId: event.api_id,
    canonicalUrl: canonicalEventUrl(event.url),
    title: event.name,
    startsAt: event.start_at,
    endsAt: event.end_at ?? null,
    timeZone: event.timezone ?? null,
    descriptionText: null,
    organizerName: entry.calendar?.name ?? null,
    venueName: event.geo_address_info?.description ?? null,
    addressText: addressFor(event.geo_address_info),
    latitude: event.coordinate?.latitude ?? null,
    longitude: event.coordinate?.longitude ?? null,
    isOnline: event.location_type === "online",
    imageUrl: event.cover_url ?? null,
    priceText: priceFor(entry.ticket_info),
    tags: []
  };
}

function canonicalEventUrl(value: string): string {
  const url = new URL(value, "https://luma.com/");
  if (url.protocol !== "https:") throw new LumaPayloadError();
  if (url.hostname !== "luma.com" && url.hostname !== "lu.ma") {
    throw new LumaPayloadError();
  }
  return canonicalizeEventUrl(url.href);
}

function assertTimestamp(value: string): void {
  if (Number.isNaN(Date.parse(value))) throw new LumaPayloadError();
}

function addressFor(
  address:
    | {
        city?: string | null | undefined;
        city_state?: string | null | undefined;
        full_address?: string | null | undefined;
        short_address?: string | null | undefined;
      }
    | null
    | undefined
): string | null {
  return (
    address?.full_address ??
    address?.short_address ??
    address?.city_state ??
    address?.city ??
    null
  );
}

function priceFor(
  ticket:
    | {
        is_free: boolean;
        price?: z.infer<typeof priceSchema> | null | undefined;
        max_price?: z.infer<typeof priceSchema> | null | undefined;
      }
    | null
    | undefined
): string | null {
  if (ticket?.is_free === true) return "Free";
  const price = ticket?.price ?? ticket?.max_price;
  if (price === undefined || price === null) return null;
  return `${price.currency.toUpperCase()} ${(price.cents / 100).toFixed(2)}`;
}
