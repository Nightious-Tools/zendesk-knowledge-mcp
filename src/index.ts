#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer, SERVER_NAME, SERVER_VERSION } from "./server.js";
import { Logger } from "./util/log.js";

async function main() {
  const { server, cfg } = createServer();
  const log = new Logger(cfg.logLevel);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info(`${SERVER_NAME} v${SERVER_VERSION} ready on stdio`, { locale: cfg.defaultLocale, cacheTtlS: cfg.cacheTtlS });
  const shutdown = async () => { await server.close().catch(() => {}); process.exit(0); };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  process.stderr.write(`fatal: ${e?.stack ?? e}\n`);
  process.exit(1);
});
