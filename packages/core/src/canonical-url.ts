const trackingParameterPattern =
  /^(utm_.+|ref|ref_.+|aff|aff_.+|fbclid|gclid|mc_cid|mc_eid)$/i;
const sensitiveParameterNames = new Set([
  "authorization",
  "apikey",
  "accesstoken",
  "refreshtoken",
  "password",
  "secret",
  "sid",
  "session",
  "sessionid",
  "signature"
]);

function isSensitiveParameter(key: string): boolean {
  const normalized = key.toLocaleLowerCase("en").replace(/[^a-z0-9]/g, "");
  return (
    sensitiveParameterNames.has(normalized) ||
    normalized.endsWith("token") ||
    normalized.endsWith("secret") ||
    normalized.endsWith("password") ||
    normalized.includes("session")
  );
}

export function canonicalizeEventUrl(value: string): string {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new Error("Event URL must be a valid HTTP URL");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Event URL must use HTTP or HTTPS");
  }

  if (url.username || url.password) {
    throw new Error("Event URL must not contain credentials");
  }

  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    if (trackingParameterPattern.test(key) || isSensitiveParameter(key)) {
      url.searchParams.delete(key);
    }
  }
  url.searchParams.sort();

  return url.toString();
}
