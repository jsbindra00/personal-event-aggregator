import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createProductionDependencies } from "@event-agg/server/dependencies";

import { buildEventMcpServer } from "./server.js";

const dependencies = createProductionDependencies();
const server = buildEventMcpServer(dependencies);
const transport = new StdioServerTransport();

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  dependencies.cancelActiveSearches();
  await server.close();
  await dependencies.close();
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

await server.connect(transport);
