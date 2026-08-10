const trackingParameterPattern = /^(utm_.+|ref|ref_.+|fbclid|gclid|mc_cid|mc_eid)$/i;

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
    if (trackingParameterPattern.test(key)) {
      url.searchParams.delete(key);
    }
  }
  url.searchParams.sort();

  return url.toString();
}

