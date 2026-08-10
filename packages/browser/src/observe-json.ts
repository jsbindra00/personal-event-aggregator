import type { Page, Response } from "playwright-core";

export interface ObserveJsonPolicy {
  allowedHosts: readonly string[];
  maxBodyBytes: number;
  responseMatches(response: Response): boolean;
}

export class ObservedHttpError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfterMs: number | null
  ) {
    super(`Observed event source returned HTTP ${status}`);
    this.name = "ObservedHttpError";
  }
}

export async function observeJsonResponses(
  page: Page,
  policy: ObserveJsonPolicy,
  action: () => Promise<unknown>
): Promise<unknown[]> {
  if (!Number.isSafeInteger(policy.maxBodyBytes) || policy.maxBodyBytes < 1) {
    throw new TypeError("maxBodyBytes must be a positive safe integer");
  }

  const allowedHosts = new Set(
    policy.allowedHosts.map((host) => host.trim().toLowerCase())
  );
  const pending: Array<Promise<unknown | undefined>> = [];
  const listener = (response: Response): void => {
    const candidate = captureJsonResponse(response, policy, allowedHosts);
    if (candidate !== null) pending.push(candidate);
  };

  page.on("response", listener);
  try {
    await action();
  } finally {
    page.off("response", listener);
  }

  const settled = await Promise.all(pending);
  return settled.filter((value) => value !== undefined);
}

function captureJsonResponse(
  response: Response,
  policy: ObserveJsonPolicy,
  allowedHosts: ReadonlySet<string>
): Promise<unknown | undefined> | null {
  let url: URL;
  try {
    url = new URL(response.url());
  } catch {
    return null;
  }
  if (!allowedHosts.has(url.hostname.toLowerCase())) return null;
  if (!policy.responseMatches(response)) return null;

  const headers = response.headers();
  const status = response.status();
  if (status >= 400) {
    return Promise.reject(
      new ObservedHttpError(status, retryAfterMilliseconds(headers["retry-after"]))
    );
  }
  if (!isJsonContentType(headers["content-type"])) return null;

  const declaredLength = Number(headers["content-length"]);
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > policy.maxBodyBytes
  ) {
    return null;
  }

  return readBoundedJson(response, policy.maxBodyBytes);
}

function retryAfterMilliseconds(value: string | undefined): number | null {
  if (value === undefined) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1_000);
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, at - Date.now());
}

async function readBoundedJson(
  response: Response,
  maxBodyBytes: number
): Promise<unknown | undefined> {
  try {
    const body = await response.body();
    if (body.byteLength > maxBodyBytes) return undefined;
    return JSON.parse(body.toString("utf8")) as unknown;
  } catch {
    return undefined;
  }
}

function isJsonContentType(value: string | undefined): boolean {
  if (value === undefined) return false;
  const mediaType = value.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType === "application/json" || mediaType?.endsWith("+json") === true;
}
