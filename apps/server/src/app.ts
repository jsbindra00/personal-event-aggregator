import Fastify, { type FastifyReply } from "fastify";
import { z } from "zod";

import type {
  ConnectorStatus,
  EventSource,
  InterestProfile,
  SearchService
} from "@event-agg/core";

import { pipeSse } from "./sse.js";

export interface InterestService {
  get(): InterestProfile;
  replace(profile: InterestProfile): void;
}

export interface ConnectorManager {
  getStatuses(): Promise<ConnectorStatus[]>;
  connect(source: EventSource): Promise<void>;
}

export interface AppDependencies {
  searchService: SearchService;
  interests: InterestService;
  connectors: ConnectorManager;
}

const sourceSchema = z.enum(["meetup", "luma", "guild", "eventbrite"]);
const searchSchema = z.object({
  locationText: z.string().trim().min(1),
  startDate: z.string(),
  endDate: z.string(),
  timeZone: z.string().trim().min(1)
});
const profileSchema = z.object({
  positive: z.array(z.string().trim().min(1)).max(100),
  excluded: z.array(z.string().trim().min(1)).max(100),
  note: z.string().trim().max(2_000)
});

function validationError(reply: FastifyReply, error: unknown) {
  const message = error instanceof Error ? error.message : "Invalid request";
  return reply.code(400).send({ error: "validation_error", message });
}

export function buildApp(dependencies: AppDependencies) {
  const app = Fastify({ logger: false });

  app.get("/api/interests", async () => dependencies.interests.get());

  app.put("/api/interests", async (request, reply) => {
    const parsed = profileSchema.safeParse(request.body);
    if (!parsed.success) {
      return validationError(reply, parsed.error);
    }
    const profile = {
      positive: [...new Set(parsed.data.positive)],
      excluded: [...new Set(parsed.data.excluded)],
      note: parsed.data.note
    };
    dependencies.interests.replace(profile);
    return profile;
  });

  app.get("/api/connectors", async () => dependencies.connectors.getStatuses());

  app.post<{ Params: { source: string } }>(
    "/api/connectors/:source/connect",
    async (request, reply) => {
      const parsed = sourceSchema.safeParse(request.params.source);
      if (!parsed.success) {
        return validationError(reply, parsed.error);
      }
      await dependencies.connectors.connect(parsed.data);
      return reply.code(202).send({ source: parsed.data, status: "opening" });
    }
  );

  app.post("/api/searches", async (request, reply) => {
    const parsed = searchSchema.safeParse(request.body);
    if (!parsed.success) {
      return validationError(reply, parsed.error);
    }
    try {
      const { searchId } = await dependencies.searchService.start(parsed.data);
      return reply.code(202).send({
        searchId,
        streamUrl: `/api/searches/${searchId}/stream`
      });
    } catch (error) {
      return validationError(reply, error);
    }
  });

  app.get<{ Params: { id: string } }>(
    "/api/searches/:id",
    async (request, reply) => {
      const snapshot = dependencies.searchService.snapshot(request.params.id);
      return snapshot ?? reply.code(404).send({ error: "search_not_found" });
    }
  );

  app.get<{ Params: { id: string } }>(
    "/api/searches/:id/events",
    async (request, reply) => {
      const snapshot = dependencies.searchService.snapshot(request.params.id);
      return snapshot?.events ?? reply.code(404).send({ error: "search_not_found" });
    }
  );

  app.post<{ Params: { id: string } }>(
    "/api/searches/:id/cancel",
    async (request, reply) => {
      if (!dependencies.searchService.snapshot(request.params.id)) {
        return reply.code(404).send({ error: "search_not_found" });
      }
      dependencies.searchService.cancel(request.params.id);
      return reply.code(202).send({ searchId: request.params.id, status: "cancelled" });
    }
  );

  app.get<{ Params: { id: string } }>(
    "/api/searches/:id/stream",
    async (request, reply) => {
      if (!dependencies.searchService.snapshot(request.params.id)) {
        return reply.code(404).send({ error: "search_not_found" });
      }
      const header = request.headers["last-event-id"];
      const parsedSequence = Number(Array.isArray(header) ? header[0] : header);
      const afterSequence = Number.isSafeInteger(parsedSequence) && parsedSequence > 0
        ? parsedSequence
        : 0;
      const messages = dependencies.searchService.subscribe(
        request.params.id,
        afterSequence
      );

      reply.hijack();
      reply.raw.writeHead(200, {
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "content-type": "text/event-stream; charset=utf-8",
        "x-accel-buffering": "no"
      });
      await pipeSse(messages, reply.raw);
      return reply;
    }
  );

  return app;
}

