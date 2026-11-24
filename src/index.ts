#!/usr/bin/env node
import { createInterface } from "node:readline";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { type CliIO, runCli } from "./cli.js";
import { loadConfig } from "./config.js";
import { currentCredentials } from "./credentials.js";
import { createServer } from "./server.js";

// In server mode stdout carries the MCP protocol; all logging goes to stderr.
const log = (msg: string) => console.error(`[pcgamingwiki-mcp] ${msg}`);

async function serve(): Promise<void> {
  const cfg = loadConfig();
  for (const w of cfg.warnings) log(w);
  if (!cfg.contact) {
    log("PCGW_CONTACT is not set. PCGamingWiki asks API clients for contact info in the User-Agent; please set it (e.g. a URL or email).");
  }
  const creds = currentCredentials();
  log(
    creds
      ? `Bot password for ${creds.creds.user} (${creds.source === "env" ? "env vars" : "saved login"}): cargo_query enabled${cfg.preferCargo ? "; per-game tools read Cargo" : ""}.`
      : "No bot password: cargo_query will ask the user to log in (extension settings or `npx pcgamingwiki-mcp login`).",
  );
  const server = createServer(cfg, { log });
  await server.connect(new StdioServerTransport());
}

/** Terminal prompts for the CLI commands. Hidden input never echoes the password. */
const terminal: CliIO = {
  out: (message) => console.log(message),
  ask: (question, opts = {}) =>
    new Promise((resolve, reject) => {
      if (!process.stdin.isTTY) {
        reject(new Error("Run this command in an interactive terminal."));
        return;
      }
      const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
      if (opts.hidden) {
        const internal = rl as unknown as { _writeToOutput: (s: string) => void };
        const write = internal._writeToOutput.bind(rl);
        internal._writeToOutput = (s: string) => {
          if (s.includes(question)) write(question);
        };
      }
      rl.question(question, (answer) => {
        rl.close();
        if (opts.hidden) process.stdout.write("\n");
        resolve(answer);
      });
    }),
};

const command = process.argv[2];
const run = command ? runCli(command, terminal).then((code) => process.exit(code)) : serve();
run.catch((err: unknown) => {
  log(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
