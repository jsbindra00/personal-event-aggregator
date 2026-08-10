import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

interface CheckLocalModelOptions {
  environment?: Record<string, string | undefined>;
  fetch?: typeof globalThis.fetch;
  write?: (value: string) => void;
}

export async function checkLocalModel(
  options: CheckLocalModelOptions = {}
): Promise<boolean> {
  const environment = options.environment ?? process.env;
  const fetch = options.fetch ?? globalThis.fetch;
  const write = options.write ?? ((value: string) => process.stderr.write(value));
  const model = environment.EVENT_AGG_RELEVANCE_MODEL?.trim() || "gemma3:4b";

  let endpoint: URL;
  try {
    endpoint = localEndpoint(
      environment.EVENT_AGG_OLLAMA_URL ?? "http://127.0.0.1:11434"
    );
  } catch {
    write("Local model endpoint must use loopback HTTP\n");
    return false;
  }

  try {
    const response = await fetch(new URL("api/tags", endpoint), {
      signal: AbortSignal.timeout(3_000)
    });
    if (!response.ok) throw new Error("readiness failed");
    const payload = (await response.json()) as unknown;
    const names = modelNames(payload);
    if (!names.has(model)) {
      write(`Missing local model ${model}\nRun: ollama pull ${model}\n`);
      return false;
    }
    write(`Local model ${model} is ready\n`);
    return true;
  } catch {
    write("Ollama is not reachable on the configured loopback endpoint\n");
    return false;
  }
}

function localEndpoint(value: string): URL {
  const endpoint = new URL(value);
  if (
    endpoint.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname) ||
    endpoint.username !== "" ||
    endpoint.password !== ""
  ) {
    throw new TypeError("invalid local endpoint");
  }
  endpoint.pathname = "/";
  endpoint.search = "";
  endpoint.hash = "";
  return endpoint;
}

function modelNames(payload: unknown): Set<string> {
  if (typeof payload !== "object" || payload === null) return new Set();
  const models = (payload as { models?: unknown }).models;
  if (!Array.isArray(models)) return new Set();
  const names = new Set<string>();
  for (const candidate of models) {
    if (typeof candidate !== "object" || candidate === null) continue;
    const { name, model } = candidate as { name?: unknown; model?: unknown };
    if (typeof name === "string") names.add(name);
    if (typeof model === "string") names.add(model);
  }
  return names;
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  import.meta.url === pathToFileURL(resolve(invokedPath)).href
) {
  if (!(await checkLocalModel())) process.exitCode = 1;
}
