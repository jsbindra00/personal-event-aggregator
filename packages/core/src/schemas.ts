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

export const relevanceDecisionKindSchema = z.enum(["show", "maybe", "hide"]);

export const relevanceDecisionSchema = z.object({
  eventId: z.string().trim().min(1).max(500),
  decision: relevanceDecisionKindSchema,
  score: z.number().min(0).max(100),
  confidence: z.number().min(0).max(1),
  matchedInterests: z.array(z.string().trim().min(1).max(200)).max(100),
  reason: z.string().trim().min(1).max(500)
});

export const relevanceStatusSchema = z.object({
  state: z.enum(["ready", "evaluating", "fallback", "unavailable", "complete"]),
  evaluator: z.string().trim().min(1),
  model: z.string().trim().min(1).nullable(),
  evaluatedCount: z.number().int().nonnegative(),
  showCount: z.number().int().nonnegative(),
  maybeCount: z.number().int().nonnegative(),
  hideCount: z.number().int().nonnegative(),
  safeMessage: z.string().nullable()
});
