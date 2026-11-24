import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ALLOWLIST_DATE, CARGO_TABLES } from "../cargo/allowlist.js";
import { MAX_LIMIT, MAX_TABLES, PAGE_ALIAS, buildCargoQuery } from "../cargo/builder.js";
import { type Envelope, type Source, envelope, historyUrl, pageUrl, toolResult } from "../envelope.js";
import { READ_ONLY, type ToolContext, safely } from "./context.js";

// Plain comma-separated strings, not string-or-array unions: clients such as the MCP
// Inspector can only offer a raw JSON editor for a union.
const commaList = z.string().trim().min(1).max(1000);

export const cargoQueryShape = {
  tables: commaList.describe(`1–${MAX_TABLES} allowed tables, comma-separated, e.g. "Game" or "Game, GameData"`),
  fields: commaList.describe('Comma-separated fields as Table.Field or Field, optionally =Alias, e.g. "Game.Developers, Game.Released=Date"'),
  where: z
    .string()
    .max(500)
    .optional()
    .describe('Filter, e.g. Game.Steam_AppID HOLDS "1245620" or Game.Genres HOLDS "RPG" AND Game.Released > "2020". List fields need HOLDS. No functions or subqueries.'),
  join_on: z.string().max(200).optional().describe("Required for two tables, e.g. Game._pageID=GameData._pageID"),
  order_by: z.string().max(200).optional().describe("Up to 3 fields, each optionally ASC or DESC"),
  limit: z.number().int().min(1).max(MAX_LIMIT).optional().describe(`Rows to return (1–${MAX_LIMIT}, default 20)`),
};

export type CargoQueryArgs = {
  tables: string | string[];
  fields: string | string[];
  where?: string;
  join_on?: string;
  order_by?: string;
  limit?: number;
};

export interface CargoQueryRow {
  page: string;
  url: string;
  history_url: string;
  fields: Record<string, string>;
}

export async function cargoQuery(ctx: ToolContext, args: CargoQueryArgs): Promise<Envelope<{ rows: CargoQueryRow[]; query: Record<string, string | number> }>> {
  const built = buildCargoQuery(args);
  const { rows, fetchedAt } = await ctx.api.cargo(built.params, built.params.limit);
  const out = rows.map((r) => {
    const { [PAGE_ALIAS]: page = "", ...fields } = r;
    return { page, url: pageUrl(page), history_url: historyUrl(page), fields };
  });
  const special = new URL("https://www.pcgamingwiki.com/wiki/Special:CargoQuery");
  for (const [k, v] of Object.entries(built.params)) if (v !== undefined) special.searchParams.set(k, String(v));
  const source: Source = { title: "Cargo query", url: special.toString(), retrieved_at: fetchedAt || ctx.now().toISOString() };
  return envelope({ rows: out, query: built.params }, "cargo", source);
}

export function registerCargoQuery(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "cargo_query",
    {
      title: "Query PCGamingWiki's Cargo tables",
      description: `Advanced: run a read-only Cargo query across PCGamingWiki's structured data. Needs a PCGamingWiki bot password: if it returns auth_required, ask the user to run \`npx pcgamingwiki-mcp login\` in a terminal, then try again (no restart needed). Tables allowed: ${Object.keys(CARGO_TABLES).join(", ")} (schema as of ${ALLOWLIST_DATE}). At most ${MAX_TABLES} tables (joined with join_on) and ${MAX_LIMIT} rows. Each row comes with its article URL. Prefer get_game, get_save_locations and get_features for a single game.`,
      inputSchema: cargoQueryShape,
      annotations: READ_ONLY,
    },
    (args) => safely(async () => toolResult(await cargoQuery(ctx, args))),
  );
}
