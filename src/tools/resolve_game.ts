import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type Envelope, envelope, historyUrl, pageSource, pageUrl, searchSource, toolResult } from "../envelope.js";
import { getGameInfo } from "../game.js";
import { type Candidate, type GameRef, gameRefShape, resolveRef } from "../resolve.js";
import { READ_ONLY, type ToolContext, safely } from "./context.js";

export type ResolveData =
  | {
      ambiguous: false;
      title: string;
      page_id?: number;
      url: string;
      history_url: string;
      steam_appid: string[];
      steam_appid_side?: string[];
      gog_id: string[];
      gog_id_side?: string[];
    }
  | { ambiguous: true; candidates: Candidate[] };

export async function resolveGame(ctx: ToolContext, ref: GameRef): Promise<Envelope<ResolveData>> {
  const r = await resolveRef(ctx.api, ref);
  const mode = ctx.api.hasCargo ? "cargo" : "wikitext";
  if (r.kind === "many") {
    const label = `${r.via} ${String(ref[r.via])}`;
    return envelope({ ambiguous: true, candidates: r.candidates }, mode, searchSource(label, ctx.now().toISOString()));
  }
  const { info, mode: infoMode, retrievedAt } = await getGameInfo(ctx.api, r);
  const page_id = info.page_id ?? r.page_id;
  const data: ResolveData = {
    ambiguous: false,
    title: info.title,
    ...(page_id !== undefined ? { page_id } : {}),
    url: pageUrl(info.title),
    history_url: historyUrl(info.title),
    steam_appid: info.steam_appid,
    ...(info.steam_appid_side ? { steam_appid_side: info.steam_appid_side } : {}),
    gog_id: info.gog_id,
    ...(info.gog_id_side ? { gog_id_side: info.gog_id_side } : {}),
  };
  return envelope(data, infoMode, pageSource(info.title, retrievedAt, page_id));
}

export function registerResolveGame(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "resolve_game",
    {
      title: "Resolve a game",
      description:
        "Map exactly one of title, steam_appid, gog_id or page_id to the PCGamingWiki article: exact title, page ID, URL and every Steam/GOG ID on the page. One store ID can match several pages (editions, DLC); then all are returned with ambiguous: true.",
      inputSchema: gameRefShape,
      annotations: READ_ONLY,
    },
    (args) => safely(async () => toolResult(await resolveGame(ctx, args))),
  );
}
