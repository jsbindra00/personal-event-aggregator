import type { Page, Response } from "playwright-core";

export interface ObserveJsonPolicy {
  allowedHosts: readonly string[];
  maxBodyBytes: number;
  responseMatches(response: Response): boolean;
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
