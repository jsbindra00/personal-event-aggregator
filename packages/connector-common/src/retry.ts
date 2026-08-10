export type ConnectorFailureCode =
  | "auth_required"
  | "user_action_required"
  | "contract_drift"
  | "parsing"
  | "network"
  | "rate_limited";

export class ConnectorFailure extends Error {
  readonly code: ConnectorFailureCode;
  readonly retryAfterMs: number | null;

  constructor(
    code: ConnectorFailureCode,
    safeMessage: string,
    options: { cause?: unknown; retryAfterMs?: number } = {}
  ) {
    super(safeMessage, { cause: options.cause });
    this.name = "ConnectorFailure";
    this.code = code;
    this.retryAfterMs = options.retryAfterMs ?? null;
  }
}

export interface ConnectorRetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitterRatio?: number;
  sleep?: (delayMs: number) => Promise<void>;
  random?: () => number;
}

export function connectorFailure(
  code: ConnectorFailureCode,
  safeMessage: string,
  options?: { cause?: unknown; retryAfterMs?: number }
): ConnectorFailure {
  return new ConnectorFailure(code, safeMessage, options);
}

export function classifyConnectorError(error: unknown): unknown {
  if (error instanceof ConnectorFailure) return error;

  if (typeof error === "object" && error !== null) {
    const candidate = error as {
      name?: unknown;
      status?: unknown;
      retryAfterMs?: unknown;
    };
    if (
      candidate.name === "ObservedHttpError" &&
      typeof candidate.status === "number"
    ) {
      const options =
        typeof candidate.retryAfterMs === "number"
          ? { cause: error, retryAfterMs: candidate.retryAfterMs }
          : { cause: error };
      if (candidate.status === 401 || candidate.status === 403) {
        return connectorFailure("auth_required", "Sign in to this event source", {
          cause: error
        });
      }
      if (candidate.status === 429) {
        return connectorFailure("rate_limited", "Event source rate limit reached", options);
      }
      if (candidate.status === 408 || candidate.status >= 500) {
        return connectorFailure("network", "Event source is temporarily unavailable", {
          cause: error
        });
      }
    }
  }

  if (error instanceof Error && error.name === "TimeoutError") {
    return connectorFailure("network", "Event source request timed out", {
      cause: error
    });
  }
  return error;
}

export async function withConnectorRetry<T>(
  action: (attempt: number) => Promise<T>,
  options: ConnectorRetryOptions = {}
): Promise<T> {
  const maxAttempts = positiveInteger(options.maxAttempts ?? 3, "maxAttempts");
  const baseDelayMs = nonNegativeNumber(options.baseDelayMs ?? 500, "baseDelayMs");
  const maxDelayMs = nonNegativeNumber(options.maxDelayMs ?? 5_000, "maxDelayMs");
  const jitterRatio = boundedRatio(options.jitterRatio ?? 0.2);
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await action(attempt);
    } catch (error) {
      const retryable =
        error instanceof ConnectorFailure &&
        (error.code === "network" || error.code === "rate_limited");
      if (!retryable || attempt === maxAttempts) throw error;

      const exponential = Math.min(
        maxDelayMs,
        error.retryAfterMs ?? baseDelayMs * 2 ** (attempt - 1)
      );
      const jitter = 1 + (random() * 2 - 1) * jitterRatio;
      await sleep(Math.max(0, Math.round(exponential * jitter)));
    }
  }

  throw new Error("connector retry exhausted unexpectedly");
}

async function defaultSleep(delayMs: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function nonNegativeNumber(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative finite number`);
  }
  return value;
}

function boundedRatio(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new TypeError("jitterRatio must be between zero and one");
  }
  return value;
}
