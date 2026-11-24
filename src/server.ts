import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PcgwApi } from "./api.js";
import { BotSession } from "./client/auth.js";
import { ResponseCache } from "./client/cache.js";
import { PcgwHttp } from "./client/http.js";
import { type Clock, DEFAULT_QUEUE, RequestQueue, realClock } from "./client/queue.js";
import { type Config, VERSION, userAgent } from "./config.js";
import { readCredentialsFile } from "./credentials.js";
import type { ToolContext } from "./tools/context.js";
import { registerCargoQuery } from "./tools/cargo_query.js";
import { registerGetFeatures } from "./tools/get_features.js";
import { registerGetGame } from "./tools/get_game.js";
import { registerGetSaveLocations } from "./tools/get_save_locations.js";
import { registerGetSection } from "./tools/get_section.js";
import { registerResolveGame } from "./tools/resolve_game.js";
import { registerSearchGames } from "./tools/search_games.js";

export interface ServerDeps {
  fetch?: typeof globalThis.fetch;
  clock?: Clock;
  log?: (msg: string) => void;
}

/** Build the API stack. Everything network-bound shares one queue and one cache. */
export function createApi(cfg: Config, deps: ServerDeps = {}): PcgwApi {
  const clock = deps.clock ?? realClock;
  const http = new PcgwHttp({
    apiUrl: cfg.apiUrl,
    userAgent: userAgent(cfg),
    queue: new RequestQueue(DEFAULT_QUEUE, clock),
    cache: new ResponseCache({ ttlMs: cfg.cacheTtlMs, max: cfg.cacheMax, ...(cfg.cacheDir ? { dir: cfg.cacheDir } : {}), now: clock.now }),
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    clock,
    ...(deps.log ? { log: deps.log } : {}),
  });
  return new PcgwApi(http, sessionProvider(cfg, http), { preferCargo: cfg.preferCargo });
}

/**
 * Bot password from env, else from the file `pcgamingwiki-mcp login` writes. Read on
 * every Cargo call, so logging in or out takes effect without a restart. A session is
 * reused while the credentials stay the same.
 */
function sessionProvider(cfg: Config, http: PcgwHttp): () => BotSession | undefined {
  let cached: { user: string; password: string; session: BotSession } | undefined;
  return () => {
    const creds =
      cfg.botUser && cfg.botPassword ? { user: cfg.botUser, password: cfg.botPassword } : readCredentialsFile({ PCGW_CONFIG_DIR: cfg.configDir });
    if (!creds) {
      // Logged out: stop sending the old session with later requests.
      if (cached) http.clearCookies();
      return (cached = undefined);
    }
    if (cached?.user !== creds.user || cached.password !== creds.password) {
      cached = { ...creds, session: new BotSession(http, creds.user, creds.password) };
    }
    return cached.session;
  };
}

export function createServer(cfg: Config, deps: ServerDeps = {}): McpServer {
  const server = new McpServer(
    { name: "pcgamingwiki-mcp", version: VERSION },
    {
      instructions:
        "Read-only access to PCGamingWiki. Data is CC BY-NC-SA 3.0: when you repeat it, keep the attribution line from each response. Prefer resolve_game once, then pass its exact title or page_id to other tools.",
    },
  );
  const ctx: ToolContext = { api: createApi(cfg, deps), now: () => new Date((deps.clock ?? realClock).now()) };
  registerSearchGames(server, ctx);
  registerResolveGame(server, ctx);
  registerGetGame(server, ctx);
  registerGetSaveLocations(server, ctx);
  registerGetSection(server, ctx);
  registerGetFeatures(server, ctx);
  // Always listed: without a bot password it explains how to log in.
  registerCargoQuery(server, ctx);
  return server;
}
