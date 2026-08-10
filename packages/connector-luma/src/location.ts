import {
  requestBoundedText,
  type DirectRequestPolicy
} from "@event-agg/connector-common";
import { parse, type DefaultTreeAdapterTypes } from "parse5";
import { z } from "zod";

const DISCOVER_URL = "https://luma.com/discover";
const HTML_POLICY: DirectRequestPolicy = {
  method: "GET",
  allowedHosts: ["luma.com"],
  allowedPath: (pathname) =>
    pathname === "/discover" || /^\/[a-z0-9-]+$/.test(pathname),
  maxBodyBytes: 2_000_000,
  timeoutMs: 20_000
};

const placeDataSchema = z.object({
  props: z.object({
    pageProps: z.object({
      initialData: z.object({
        kind: z.literal("discover-place"),
        data: z.object({
          place: z.object({
            api_id: z.string().startsWith("discplace-"),
            name: z.string().min(1),
            timezone: z.string().min(1)
          }).passthrough()
        }).passthrough()
      }).passthrough()
    }).passthrough()
  }).passthrough()
}).passthrough();

export interface LumaPlace {
  name: string;
  cityUrl: string;
  placeId: string;
  timeZone: string;
}

export class LumaLocationError extends Error {
  readonly code = "contract_drift" as const;

  constructor(options: { cause?: unknown } = {}) {
    super("Luma's discovery page changed", options);
    this.name = "LumaLocationError";
  }
}

export async function resolveLumaPlace(
  locationText: string,
  fetch: typeof globalThis.fetch = globalThis.fetch,
  signal: AbortSignal
): Promise<LumaPlace | null> {
  signal.throwIfAborted();
  const discover = await requestBoundedText(
    { url: DISCOVER_URL, fetch },
    HTML_POLICY,
    signal
  );
  const cityUrl = selectCityUrl(discover, locationText);
  if (cityUrl === null) return null;
  const city = await requestBoundedText(
    { url: cityUrl, fetch },
    HTML_POLICY,
    signal
  );
  return parseDiscoverPlace(city, cityUrl);
}

function selectCityUrl(html: string, locationText: string): string | null {
  const components = locationText
    .split(",")
    .map(normalizeLocation)
    .filter((component) => component.length > 1);
  if (components.length === 0) return null;

  let best: { url: string; score: number } | null = null;
  for (const node of walk(parse(html))) {
    if (node.tagName !== "a") continue;
    const href = node.attrs.find((attribute) => attribute.name === "href")?.value;
    if (href === undefined) continue;
    let url: URL;
    try {
      url = new URL(href, DISCOVER_URL);
    } catch {
      continue;
    }
    if (
      url.protocol !== "https:" ||
      url.hostname !== "luma.com" ||
      !/^\/[a-z0-9-]+$/.test(url.pathname) ||
      url.searchParams.get("k") !== "p"
    ) {
      continue;
    }
    const slug = normalizeLocation(url.pathname.slice(1));
    const text = normalizeLocation(textContent(node));
    const score = Math.max(
      ...components.map((component) => {
        if (slug === component) return 100;
        if (text === component || text.startsWith(`${component} `)) return 90;
        if (component.includes(slug) || text.includes(component)) return 50;
        return 0;
      })
    );
    if (score > 0 && (best === null || score > best.score)) {
      best = { url: url.href, score };
    }
  }
  return best?.url ?? null;
}

function parseDiscoverPlace(html: string, cityUrl: string): LumaPlace {
  for (const node of walk(parse(html))) {
    if (node.tagName !== "script") continue;
    const id = node.attrs.find((attribute) => attribute.name === "id")?.value;
    if (id !== "__NEXT_DATA__") continue;
    try {
      const payload = placeDataSchema.parse(JSON.parse(textContent(node)));
      const place = payload.props.pageProps.initialData.data.place;
      return {
        name: place.name,
        cityUrl,
        placeId: place.api_id,
        timeZone: place.timezone
      };
    } catch (error) {
      throw new LumaLocationError({ cause: error });
    }
  }
  throw new LumaLocationError();
}

function* walk(
  node: DefaultTreeAdapterTypes.Node
): Iterable<DefaultTreeAdapterTypes.Element> {
  if ("tagName" in node) yield node;
  if ("childNodes" in node) {
    for (const child of node.childNodes) yield* walk(child);
  }
}

function textContent(node: DefaultTreeAdapterTypes.Node): string {
  if ("value" in node) return node.value;
  if (!("childNodes" in node)) return "";
  return node.childNodes.map(textContent).join("");
}

function normalizeLocation(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
