#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { createServer } from "./server.js";

// stdout carries the MCP protocol; all logging goes to stderr.
const log = (msg: string) => console.error(`[pcgamingwiki-mcp] ${msg}`);

async function main(): Promise<void> {
  const cfg = loadConfig();
  if (!cfg.contact) {
    log("PCGW_CONTACT is not set. PCGamingWiki asks API clients for contact info in the User-Agent; please set it (e.g. a URL or email).");
  }
  log(cfg.botUser ? "Bot password set: structured tools use Cargo." : "No bot password: structured tools parse wikitext.");
  const server = createServer(cfg, { log });
  await server.connect(new StdioServerTransport());
}

main().catch((err: unknown) => {
  log(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
