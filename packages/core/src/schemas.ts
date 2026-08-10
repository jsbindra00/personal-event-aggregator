import { z } from "zod";

export const eventSourceSchema = z.enum([
  "meetup",
  "luma",
  "guild",
  "eventbrite"
]);

export const eventSearchQuerySchema = z.object({
  locationText: z.string().trim().min(1, "Location is required"),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid start date"),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid end date"),
  timeZone: z.string().trim().min(1, "Time zone is required")
});

export const interestProfileSchema = z.object({
  positive: z.array(z.string().trim().min(1)).max(100),
  excluded: z.array(z.string().trim().min(1)).max(100),
  note: z.string().trim().max(2_000)
});
