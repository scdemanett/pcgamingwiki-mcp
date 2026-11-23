import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PcgwApi } from "./api.js";
import { BotSession } from "./client/auth.js";
import { ResponseCache } from "./client/cache.js";
import { PcgwHttp } from "./client/http.js";
import { type Clock, DEFAULT_QUEUE, RequestQueue, realClock } from "./client/queue.js";
import { type Config, VERSION, userAgent } from "./config.js";
import type { ToolContext } from "./tools/context.js";
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
  const session = cfg.botUser && cfg.botPassword ? new BotSession(http, cfg.botUser, cfg.botPassword) : undefined;
  return new PcgwApi(http, session);
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
  return server;
}
