import {
  ConnectorFailure,
  classifyConnectorError,
  connectorFailure
} from "./retry.js";

export interface DirectRequestPolicy {
  method: "GET" | "POST";
  allowedHosts: readonly string[];
  allowedPath(pathname: string): boolean;
  maxBodyBytes: number;
  timeoutMs: number;
}

export interface DirectRequestInput {
  url: string;
  fetch?: typeof globalThis.fetch;
  headers?: Readonly<Record<string, string>>;
  body?: string;
}

export async function requestBoundedText(
  input: DirectRequestInput,
  policy: DirectRequestPolicy,
  signal: AbortSignal
): Promise<string> {
  validatePolicy(policy);
  const url = new URL(input.url);
  if (
    url.protocol !== "https:" ||
    !policy.allowedHosts.includes(url.hostname) ||
    !policy.allowedPath(url.pathname)
  ) {
    throw connectorFailure(
      "parsing",
      "Direct request failed allowlist validation"
    );
  }

  const timeout = AbortSignal.timeout(policy.timeoutMs);
  const combined = AbortSignal.any([signal, timeout]);
  let response: Response;
  try {
    response = await (input.fetch ?? globalThis.fetch)(url, {
      method: policy.method,
      ...(input.headers === undefined ? {} : { headers: input.headers }),
      ...(input.body === undefined ? {} : { body: input.body }),
      signal: combined,
      redirect: "error"
    });
  } catch (error) {
    if (signal.aborted) throw signal.reason ?? error;
    const classified = classifyConnectorError(error);
    if (classified instanceof ConnectorFailure) throw classified;
    throw connectorFailure("network", "Event source is temporarily unavailable", {
      cause: error
    });
  }

  if (response.status === 401 || response.status === 403) {
    throw connectorFailure("auth_required", "Sign in to this event source");
  }
  if (response.status === 429) {
    const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
    throw connectorFailure("rate_limited", "Event source rate limit reached", {
      ...(retryAfterMs === null ? {} : { retryAfterMs })
    });
  }
  if (response.status === 408 || response.status >= 500) {
    throw connectorFailure(
      "network",
      "Event source is temporarily unavailable"
    );
  }
  if (!response.ok || response.body === null) {
    throw connectorFailure(
      "parsing",
      "Event source returned an invalid response"
    );
  }

  return readLimitedUtf8(response.body, policy.maxBodyBytes);
}

export async function requestBoundedJson(
  input: DirectRequestInput,
  policy: DirectRequestPolicy,
  signal: AbortSignal
): Promise<unknown> {
  const text = await requestBoundedText(input, policy, signal);
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw connectorFailure("parsing", "Event source returned invalid JSON", {
      cause: error
    });
  }
}

async function readLimitedUtf8(
  body: ReadableStream<Uint8Array>,
  maxBodyBytes: number
): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let received = 0;
  let text = "";
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      received += result.value.byteLength;
      if (received > maxBodyBytes) {
        await reader.cancel();
        throw connectorFailure(
          "parsing",
          "Event source response exceeded the allowed size"
        );
      }
      text += decoder.decode(result.value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } catch (error) {
    if (error instanceof ConnectorFailure) throw error;
    throw connectorFailure("parsing", "Event source returned invalid text", {
      cause: error
    });
  } finally {
    reader.releaseLock();
  }
}

function parseRetryAfter(value: string | null): number | null {
  if (value === null) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1_000);
  }
  const date = Date.parse(value);
  if (!Number.isFinite(date)) return null;
  return Math.max(0, date - Date.now());
}

function validatePolicy(policy: DirectRequestPolicy): void {
  if (!Number.isSafeInteger(policy.maxBodyBytes) || policy.maxBodyBytes < 1) {
    throw new TypeError("maxBodyBytes must be a positive safe integer");
  }
  if (!Number.isSafeInteger(policy.timeoutMs) || policy.timeoutMs < 1) {
    throw new TypeError("timeoutMs must be a positive safe integer");
  }
}
