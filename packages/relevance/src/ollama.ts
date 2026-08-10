import {
  relevanceStatusSchema,
  type EventRelevanceEvaluator,
  type InterestProfile,
  type NormalizedEvent,
  type RelevanceDecision,
  type RelevanceEvaluation,
  type RelevanceStatus
} from "@event-agg/core";
import { z } from "zod";

import { buildRelevancePrompt, relevanceBatchSchema } from "./prompt.js";

const ollamaEnvelopeSchema = z.object({
  message: z.object({
    content: z.string()
  }).passthrough()
}).passthrough();

const tagsSchema = z.object({
  models: z.array(
    z.object({
      name: z.string(),
      model: z.string().optional()
    }).passthrough()
  )
}).passthrough();

export interface OllamaRelevanceOptions {
  endpoint?: string;
  model?: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  promptVersion?: string;
}

export class OllamaEvaluationError extends Error {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, options);
    this.name = "OllamaEvaluationError";
  }
}

export function createOllamaRelevanceEvaluator(
  options: OllamaRelevanceOptions = {}
): EventRelevanceEvaluator {
  return new OllamaRelevanceEvaluator(options);
}

class OllamaRelevanceEvaluator implements EventRelevanceEvaluator {
  readonly fingerprint: string;

  private readonly endpoint: URL;
  private readonly model: string;
  private readonly fetch: typeof globalThis.fetch;
  private readonly timeoutMs: number;
  private currentStatus: RelevanceStatus;

  constructor(options: OllamaRelevanceOptions) {
    this.endpoint = normalizedEndpoint(options.endpoint ?? "http://127.0.0.1:11434");
    this.model = options.model ?? "gemma3:4b";
    this.fetch = options.fetch ?? globalThis.fetch;
    this.timeoutMs = positiveInteger(options.timeoutMs ?? 60_000, "timeoutMs");
    const promptVersion = options.promptVersion ?? "prompt-v1";
    this.fingerprint = `ollama:${this.model}:${promptVersion}:70:0.55:40`;
    this.currentStatus = emptyStatus("ready", this.model, null);
  }

  async evaluate(
    events: readonly NormalizedEvent[],
    profile: InterestProfile,
    signal: AbortSignal
  ): Promise<RelevanceDecision[]> {
    return (await this.evaluateWithStatus(events, profile, signal)).decisions;
  }

  async evaluateWithStatus(
    events: readonly NormalizedEvent[],
    profile: InterestProfile,
    signal: AbortSignal
  ): Promise<RelevanceEvaluation> {
    signal.throwIfAborted();
    if (events.length === 0) {
      this.currentStatus = emptyStatus("complete", this.model, null);
      return { decisions: [], status: { ...this.currentStatus } };
    }
    this.currentStatus = {
      ...emptyStatus("evaluating", this.model, null),
      evaluatedCount: 0
    };
    try {
      const modelEvents = events.map((event, index) => ({
        ...event,
        id: `event_${index + 1}`
      }));
      const payload = await this.requestJson(
        "/api/chat",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: this.model,
            messages: [
              {
                role: "user",
                content: buildRelevancePrompt(modelEvents, profile)
              }
            ],
            stream: false,
            format: relevanceFormatSchema(modelEvents),
            options: { temperature: 0 }
          })
        },
        signal
      );
      const envelope = ollamaEnvelopeSchema.safeParse(payload);
      if (!envelope.success) throw invalidResponse(envelope.error);
      let content: unknown;
      try {
        content = JSON.parse(envelope.data.message.content) as unknown;
      } catch (error) {
        throw invalidResponse(error);
      }
      const batch = relevanceBatchSchema.safeParse(content);
      if (!batch.success) throw invalidResponse(batch.error);
      const orderedAliases = exactDecisionSet(modelEvents, batch.data.decisions);
      const ordered = orderedAliases.map((decision, index) => ({
        ...decision,
        eventId: events[index]!.id
      }));
      this.currentStatus = summarize("complete", this.model, ordered, null);
      return { decisions: ordered, status: { ...this.currentStatus } };
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? error;
      const safe =
        error instanceof OllamaEvaluationError
          ? error
          : new OllamaEvaluationError("Local relevance model is unavailable", {
              cause: error
            });
      this.currentStatus = emptyStatus("unavailable", this.model, safe.message);
      throw safe;
    }
  }

  async status(signal?: AbortSignal): Promise<RelevanceStatus> {
    const callerSignal = signal ?? new AbortController().signal;
    try {
      const payload = await this.requestJson(
        "/api/tags",
        { method: "GET" },
        callerSignal
      );
      const parsed = tagsSchema.safeParse(payload);
      if (!parsed.success) throw invalidResponse(parsed.error);
      const installed = parsed.data.models.some(
        (candidate) =>
          candidate.name === this.model || candidate.model === this.model
      );
      this.currentStatus = installed
        ? { ...this.currentStatus, state: "ready", safeMessage: null }
        : emptyStatus(
            "unavailable",
            this.model,
            `Local model ${this.model} is not installed`
          );
      return relevanceStatusSchema.parse({ ...this.currentStatus });
    } catch (error) {
      if (callerSignal.aborted) throw callerSignal.reason ?? error;
      const safeMessage =
        error instanceof OllamaEvaluationError
          ? error.message
          : "Local relevance model is unavailable";
      this.currentStatus = emptyStatus("unavailable", this.model, safeMessage);
      return { ...this.currentStatus };
    }
  }

  private async requestJson(
    path: string,
    init: Omit<RequestInit, "signal">,
    signal: AbortSignal
  ): Promise<unknown> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const combined = AbortSignal.any([signal, timeout]);
    let response: Response;
    try {
      response = await this.fetch(new URL(path, this.endpoint), {
        ...init,
        signal: combined
      });
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? error;
      if (timeout.aborted) {
        throw new OllamaEvaluationError("Local relevance model timed out", {
          cause: error
        });
      }
      throw new OllamaEvaluationError("Local relevance model is unavailable", {
        cause: error
      });
    }
    if (!response.ok) {
      throw new OllamaEvaluationError("Local relevance model is unavailable");
    }
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > 2_000_000) throw invalidResponse();
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
    } catch (error) {
      throw invalidResponse(error);
    }
  }
}

function relevanceFormatSchema(events: readonly NormalizedEvent[]): unknown {
  const schema = z.toJSONSchema(relevanceBatchSchema) as unknown as {
    properties: {
      decisions: {
        minItems?: number;
        maxItems?: number;
        items: {
          properties: {
            eventId: { enum?: string[] };
          };
        };
      };
    };
  };
  const decisions = schema.properties.decisions;
  decisions.minItems = events.length;
  decisions.maxItems = events.length;
  decisions.items.properties.eventId.enum = events.map(({ id }) => id);
  return schema;
}

function exactDecisionSet(
  events: readonly NormalizedEvent[],
  decisions: readonly RelevanceDecision[]
): RelevanceDecision[] {
  const expected = new Set(events.map(({ id }) => id));
  const byId = new Map<string, RelevanceDecision>();
  for (const decision of decisions) {
    if (!expected.has(decision.eventId) || byId.has(decision.eventId)) {
      throw new OllamaEvaluationError(
        "Local relevance model returned invalid event IDs"
      );
    }
    byId.set(decision.eventId, decision);
  }
  if (byId.size !== expected.size) {
    throw new OllamaEvaluationError(
      "Local relevance model returned invalid event IDs"
    );
  }
  return events.map(({ id }) => byId.get(id)!);
}

function summarize(
  state: RelevanceStatus["state"],
  model: string,
  decisions: readonly RelevanceDecision[],
  safeMessage: string | null
): RelevanceStatus {
  return {
    state,
    evaluator: "ollama",
    model,
    evaluatedCount: decisions.length,
    showCount: decisions.filter(({ decision }) => decision === "show").length,
    maybeCount: decisions.filter(({ decision }) => decision === "maybe").length,
    hideCount: decisions.filter(({ decision }) => decision === "hide").length,
    safeMessage
  };
}

function emptyStatus(
  state: RelevanceStatus["state"],
  model: string,
  safeMessage: string | null
): RelevanceStatus {
  return {
    state,
    evaluator: "ollama",
    model,
    evaluatedCount: 0,
    showCount: 0,
    maybeCount: 0,
    hideCount: 0,
    safeMessage
  };
}

function invalidResponse(cause?: unknown): OllamaEvaluationError {
  return new OllamaEvaluationError(
    "Local relevance model returned an invalid response",
    cause === undefined ? {} : { cause }
  );
}

function normalizedEndpoint(value: string): URL {
  const endpoint = new URL(value);
  if (
    endpoint.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname) ||
    endpoint.username !== "" ||
    endpoint.password !== ""
  ) {
    throw new TypeError("Local relevance endpoint must use loopback HTTP");
  }
  endpoint.pathname = "/";
  endpoint.search = "";
  endpoint.hash = "";
  return endpoint;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}
