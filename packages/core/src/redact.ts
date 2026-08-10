const redacted = "[REDACTED]";
const redactedEmail = "[REDACTED_EMAIL]";
const circular = "[Circular]";
const embeddedHeaderPattern = new RegExp(
  `\\b(?:${[
    "authorization",
    "proxy-authorization",
    "cookie",
    "set" + "-cookie"
  ].join("|")})\\s*:\\s*[^\\r\\n]+`,
  "gi"
);
const embeddedAssignmentPattern = new RegExp(
  `\\b(?:${[
    "s(?:id)",
    "session(?:id)?",
    "access_token",
    "refresh_token",
    "c" + "srf",
    "x" + "srf"
  ].join("|")})\\s*=\\s*[^\\s;,]+`,
  "gi"
);

const sensitiveKeys = new Set([
  "authorization",
  "proxyauthorization",
  "cookie",
  "setcookie",
  "apikey",
  "accesskey",
  "password",
  "passwd",
  "secret",
  "clientsecret",
  "sid",
  "session",
  "sessionid",
  "refreshtoken",
  "accesstoken"
]);

function normalizedKey(key: string): string {
  return key.toLocaleLowerCase("en").replace(/[^a-z0-9]/g, "");
}

function isSensitiveKey(key: string): boolean {
  const normalized = normalizedKey(key);
  return (
    sensitiveKeys.has(normalized) ||
    normalized.includes("csrf") ||
    normalized.includes("xsrf") ||
    normalized.endsWith("token") ||
    normalized.endsWith("secret") ||
    normalized.endsWith("password")
  );
}

function sanitizeInlineText(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, redacted)
    .replace(/\bBasic\s+[A-Za-z0-9._~+/=-]+/gi, redacted)
    .replace(embeddedHeaderPattern, redacted)
    .replace(
      /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
      redactedEmail
    )
    .replace(embeddedAssignmentPattern, redacted);
}

function sanitizeUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return sanitizeInlineText(value);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return sanitizeInlineText(value);
  }

  url.username = "";
  url.password = "";
  for (const key of [...url.searchParams.keys()]) {
    if (isSensitiveKey(key)) {
      url.searchParams.delete(key);
      continue;
    }
    const values = url.searchParams.getAll(key).map(sanitizeInlineText);
    url.searchParams.delete(key);
    for (const safeValue of values) url.searchParams.append(key, safeValue);
  }
  if (url.hash) url.hash = sanitizeInlineText(url.hash);
  return url.toString();
}

function sanitizeText(value: string): string {
  const withoutSensitiveUrls = value.replace(
    /https?:\/\/[^\s<>"'`]+/gi,
    (candidate) => sanitizeUrl(candidate)
  );
  return sanitizeInlineText(withoutSensitiveUrls);
}

function redactValue(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    return /^https?:\/\//i.test(value) ? sanitizeUrl(value) : sanitizeText(value);
  }
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "undefined") return "[Undefined]";
  if (typeof value === "function") return "[Function]";
  if (typeof value === "symbol") return value.toString();
  if (seen.has(value)) return circular;
  seen.add(value);

  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, seen));
  }
  if (value instanceof Map) {
    return [...value.entries()].map(([key, item]) => [
      redactValue(key, seen),
      redactValue(item, seen)
    ]);
  }
  if (value instanceof Set) {
    return [...value].map((item) => redactValue(item, seen));
  }

  const output: Record<string, unknown> = {};
  if (value instanceof Error) {
    output.name = sanitizeText(value.name);
    output.message = sanitizeText(value.message);
  }
  for (const [key, item] of Object.entries(value)) {
    output[key] = isSensitiveKey(key) ? redacted : redactValue(item, seen);
  }
  return output;
}

/** Produces a JSON-serializable diagnostic value with credentials and PII removed. */
export function redactDiagnostic(value: unknown): unknown {
  return redactValue(value, new WeakSet());
}
