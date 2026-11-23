/**
 * `pcgamingwiki-mcp login | logout | status`: manage the bot password outside the
 * MCP session, so it never passes through the AI model or the chat transcript.
 */
import { PcgwApi } from "./api.js";
import { BotSession } from "./client/auth.js";
import { ResponseCache } from "./client/cache.js";
import { PcgwHttp } from "./client/http.js";
import { type Clock, DEFAULT_QUEUE, RequestQueue, realClock } from "./client/queue.js";
import { loadConfig, userAgent } from "./config.js";
import { credentialsPath, currentCredentials, deleteCredentialsFile, envCredentials, writeCredentialsFile } from "./credentials.js";
import { PcgwError } from "./errors.js";

export interface CliIO {
  ask(question: string, opts?: { hidden?: boolean }): Promise<string>;
  out(message: string): void;
}

export interface CliDeps {
  fetch?: typeof globalThis.fetch;
  clock?: Clock;
}

const BOT_PASSWORDS_URL = "https://www.pcgamingwiki.com/wiki/Special:BotPasswords";

const HELP = `pcgamingwiki-mcp: read-only MCP server for PCGamingWiki

Usage:
  pcgamingwiki-mcp           run the MCP server over stdio (what MCP clients do)
  pcgamingwiki-mcp login     save a PCGamingWiki bot password, enabling cargo_query
  pcgamingwiki-mcp logout    delete the saved bot password
  pcgamingwiki-mcp status    show whether a bot password is set, and where from`;

export async function runCli(command: string, io: CliIO, env: NodeJS.ProcessEnv = process.env, deps: CliDeps = {}): Promise<number> {
  switch (command) {
    case "login":
      return login(io, env, deps);
    case "logout":
      return logout(io, env);
    case "status":
      return status(io, env);
    case "help":
    case "--help":
    case "-h":
      io.out(HELP);
      return 0;
    default:
      io.out(`Unknown command "${command}".\n\n${HELP}`);
      return 1;
  }
}

async function login(io: CliIO, env: NodeJS.ProcessEnv, deps: CliDeps): Promise<number> {
  io.out(
    [
      "This saves a PCGamingWiki bot password so the server can run Cargo queries (cargo_query).",
      `Create one at ${BOT_PASSWORDS_URL} with the grant`,
      '"Create, query and delete data through the Cargo extension" (this server only reads).',
      "",
    ].join("\n"),
  );
  const user = (await io.ask("Bot user name (YourName@BotName): ")).trim();
  if (!/^[^@\s][^@]*@[^@\s]+$/.test(user)) {
    io.out('That should look like "YourName@BotName", as shown on Special:BotPasswords. Nothing saved.');
    return 1;
  }
  const password = (await io.ask("Bot password (input hidden): ", { hidden: true })).trim();
  if (!password) {
    io.out("No password given. Nothing saved.");
    return 1;
  }

  io.out("Checking with PCGamingWiki…");
  try {
    await verify(user, password, env, deps);
  } catch (err) {
    const e = err instanceof PcgwError ? err : new PcgwError("upstream_error", err instanceof Error ? err.message : String(err));
    io.out(
      e.code === "auth_required"
        ? `Logged in, but this bot password can't run Cargo queries. Edit it at ${BOT_PASSWORDS_URL} and tick the Cargo grant. Nothing saved.`
        : `${e.message}\nNothing saved.`,
    );
    return 1;
  }

  const path = writeCredentialsFile({ user, password }, env);
  io.out(`Logged in as ${user}. Saved to ${path} (readable by your user account only).`);
  io.out("cargo_query works from the next call; no restart needed.");
  if (envCredentials(env)) io.out("Note: PCGW_BOT_USER/PCGW_BOT_PASSWORD are set in this environment and take precedence over the saved login.");
  return 0;
}

/** Log in (2 requests) and run one tiny Cargo query (1 request) to prove the grant works. */
async function verify(user: string, password: string, env: NodeJS.ProcessEnv, deps: CliDeps): Promise<void> {
  const cfg = loadConfig({ ...env, PCGW_BOT_USER: "", PCGW_BOT_PASSWORD: "" });
  const clock = deps.clock ?? realClock;
  const http = new PcgwHttp({
    apiUrl: cfg.apiUrl,
    userAgent: userAgent(cfg),
    queue: new RequestQueue(DEFAULT_QUEUE, clock),
    cache: new ResponseCache({ ttlMs: 0, max: 1 }),
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    clock,
  });
  const session = new BotSession(http, user, password);
  await session.ensure();
  await new PcgwApi(http, session).cargo({ tables: "Game", fields: "Game._pageName=Page", where: 'Game._pageName="Half-Life"' }, 1);
}

function logout(io: CliIO, env: NodeJS.ProcessEnv): number {
  const existed = deleteCredentialsFile(env);
  io.out(existed ? `Deleted ${credentialsPath(env)}.` : "No saved login to delete.");
  if (existed) io.out(`To revoke the bot password itself, remove it at ${BOT_PASSWORDS_URL}.`);
  if (envCredentials(env)) io.out("PCGW_BOT_USER/PCGW_BOT_PASSWORD are still set in this environment.");
  return 0;
}

function status(io: CliIO, env: NodeJS.ProcessEnv): number {
  const current = currentCredentials(env);
  if (!current) {
    io.out("No bot password set. cargo_query is unavailable; run `pcgamingwiki-mcp login` to enable it.");
  } else {
    const where = current.source === "env" ? "PCGW_BOT_USER/PCGW_BOT_PASSWORD env vars" : credentialsPath(env);
    io.out(`Bot password set for ${current.creds.user} (from ${where}). Not checked against PCGamingWiki; run login again to re-check.`);
  }
  return 0;
}
