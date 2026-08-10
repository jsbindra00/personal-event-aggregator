export interface ListenOptions {
  host: string;
  port: number;
}

export function resolveListenOptions(
  environment: Record<string, string | undefined>
): ListenOptions {
  const host = environment.EVENT_AGG_HOST?.trim() || "127.0.0.1";
  const port = Number(environment.EVENT_AGG_PORT ?? 4317);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("Event aggregator port must be an integer from 1 to 65535");
  }
  return { host, port };
}

