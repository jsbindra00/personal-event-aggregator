import { buildApp } from "./app.js";
import { resolveListenOptions } from "./config.js";
import { createProductionDependencies } from "./dependencies.js";

const dependencies = createProductionDependencies();
const app = buildApp(dependencies);

const { host, port } = resolveListenOptions(process.env);

await app.listen({ host, port });

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  dependencies.cancelActiveSearches();
  await app.close();
  await dependencies.close();
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
