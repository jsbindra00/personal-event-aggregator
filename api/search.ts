import type { SearchStreamMessage } from "@event-agg/core";
import {
  publicSearchRequestSchema,
  streamPublicSearch,
  type PublicSearchRequest
} from "@event-agg/server/public-search";

export const maxDuration = 300;

const MAX_REQUEST_BYTES = 64 * 1024;

export type PublicSearchStreamer = (
  input: PublicSearchRequest,
  signal: AbortSignal
) => AsyncIterable<SearchStreamMessage>;

export function createSearchHandler(
  streamSearch: PublicSearchStreamer = streamPublicSearch
): (request: Request) => Promise<Response> {
  return async (request) => {
    if (request.method !== "POST") {
      return jsonResponse(405, { error: "method_not_allowed" }, { allow: "POST" });
    }
    if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
      return jsonResponse(415, { error: "unsupported_media_type" });
    }
    const declaredLength = Number(request.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
      return jsonResponse(413, { error: "request_too_large" });
    }

    let text: string;
    try {
      text = await request.text();
    } catch {
      return jsonResponse(400, { error: "invalid_json" });
    }
    if (new TextEncoder().encode(text).byteLength > MAX_REQUEST_BYTES) {
      return jsonResponse(413, { error: "request_too_large" });
    }

    let input: unknown;
    try {
      input = JSON.parse(text) as unknown;
    } catch {
      return jsonResponse(400, { error: "invalid_json" });
    }
    const parsed = publicSearchRequestSchema.safeParse(input);
    if (!parsed.success) {
      return jsonResponse(400, {
        error: "validation_error",
        message: parsed.error.issues[0]?.message ?? "Invalid public search request"
      });
    }

    const encoder = new TextEncoder();
    const controller = new AbortController();
    const abortFromRequest = () => controller.abort(request.signal.reason);
    if (request.signal.aborted) abortFromRequest();
    else request.signal.addEventListener("abort", abortFromRequest, { once: true });

    const body = new ReadableStream<Uint8Array>({
      async start(streamController) {
        try {
          for await (const message of streamSearch(parsed.data, controller.signal)) {
            streamController.enqueue(
              encoder.encode(`${JSON.stringify(message)}\n`)
            );
          }
          streamController.close();
        } catch (error) {
          streamController.error(error);
        } finally {
          request.signal.removeEventListener("abort", abortFromRequest);
        }
      },
      cancel(reason) {
        controller.abort(reason);
        request.signal.removeEventListener("abort", abortFromRequest);
      }
    });

    return new Response(body, {
      status: 200,
      headers: {
        "cache-control": "no-store",
        "content-type": "application/x-ndjson; charset=utf-8",
        "x-content-type-options": "nosniff"
      }
    });
  };
}

const handleSearch = createSearchHandler();

export default {
  fetch(request: Request): Promise<Response> {
    return handleSearch(request);
  }
};

function jsonResponse(
  status: number,
  body: Record<string, unknown>,
  extraHeaders: Record<string, string> = {}
): Response {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...extraHeaders
    }
  });
}
