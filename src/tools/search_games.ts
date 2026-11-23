import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type Envelope, envelope, historyUrl, searchSource, toolResult } from "../envelope.js";
import { READ_ONLY, type ToolContext, safely } from "./context.js";

export const searchGamesShape = {
  query: z.string().trim().min(1).max(200).describe("Game title or the start of one, any case"),
  limit: z.number().int().min(1).max(20).default(10).describe("Max results (1–20, default 10)"),
};

export interface SearchHit {
  title: string;
  page_id: number;
  url: string;
  history_url: string;
  redirect_from?: string;
}

export async function searchGames(ctx: ToolContext, args: { query: string; limit?: number }): Promise<Envelope<{ results: SearchHit[] }>> {
  const { hits, fetchedAt } = await ctx.api.prefixSearch(args.query, args.limit ?? 10);
  const results = hits.map((h) => ({ ...h, history_url: historyUrl(h.title) }));
  return envelope({ results }, "wikitext", searchSource(args.query, fetchedAt));
}

export function registerSearchGames(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "search_games",
    {
      title: "Search PCGamingWiki",
      description:
        "Find PCGamingWiki articles by title prefix (case-insensitive, follows redirects). Returns titles, page IDs and URLs. Use resolve_game or get_game next.",
      inputSchema: searchGamesShape,
      annotations: READ_ONLY,
    },
    (args) => safely(async () => toolResult(await searchGames(ctx, args))),
  );
}
