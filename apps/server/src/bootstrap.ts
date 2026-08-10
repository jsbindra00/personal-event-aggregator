import { redactDiagnostic } from "@event-agg/core";

import { buildApp } from "./app.js";
import { resolveListenOptions } from "./config.js";
import {
  createProductionDependencies,
  type ProductionDependencies
} from "./dependencies.js";

function writeDiagnostic(event: string, detail: unknown = {}): void {
  const record = redactDiagnostic({
    timestamp: new Date().toISOString(),
    event,
    detail
  });
  process.stderr.write(`${JSON.stringify(record)}\n`);
}

async function closeDependencies(
  dependencies: ProductionDependencies | undefined
): Promise<void> {
  if (!dependencies) return;
  try {
    await dependencies.close();
  } catch (error) {
    writeDiagnostic("server.dependencies_close_failed", { error });
  }
}

async function main(): Promise<void> {
  let dependencies: ProductionDependencies | undefined;
  try {
    dependencies = createProductionDependencies({
      diagnostic: (value) => writeDiagnostic("connector.diagnostic", value)
    });
    const app = buildApp(dependencies);
    const { host, port } = resolveListenOptions(process.env);
    await app.listen({ host, port });
    writeDiagnostic("server.started", { host, port });

    let shuttingDown = false;
    const shutdown = async (signal: string): Promise<void> => {
      if (shuttingDown) return;
      shuttingDown = true;
      writeDiagnostic("server.stopping", { signal });
      dependencies?.cancelActiveSearches();
      try {
        await app.close();
      } catch (error) {
        writeDiagnostic("server.http_close_failed", { error });
      }
      await closeDependencies(dependencies);
      writeDiagnostic("server.stopped");
    };

    process.once("SIGINT", () => void shutdown("SIGINT"));
    process.once("SIGTERM", () => void shutdown("SIGTERM"));
  } catch (error) {
    writeDiagnostic("server.start_failed", { error });
    await closeDependencies(dependencies);
    process.exitCode = 1;
  }
}

await main();
