import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type Envelope, envelope, pageSource, toolResult } from "../envelope.js";
import { type GameInfo, type Include, getGameInfo } from "../game.js";
import { type GameRef, checkRef, gameRefShape, resolveOne } from "../resolve.js";
import { READ_ONLY, type ToolContext, safely } from "./context.js";

export const getGameShape = {
  ...gameRefShape,
  include: z
    .array(z.enum(["availability", "languages"]))
    .max(2)
    .optional()
    .describe("Extra data: availability (stores, DRM), languages (UI/audio/subtitles per language)"),
};

export async function getGame(ctx: ToolContext, args: GameRef & { include?: Include[] }): Promise<Envelope<GameInfo>> {
  const { include, ...ref } = args;
  checkRef(ref);
  const page = await resolveOne(ctx.api, ref);
  const { info, mode, retrievedAt } = await getGameInfo(ctx.api, page, [...new Set(include ?? [])]);
  return envelope(info, mode, pageSource(info.title, retrievedAt, info.page_id ?? page.page_id));
}

export function registerGetGame(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "get_game",
    {
      title: "Get game facts",
      description:
        "Infobox facts for one game as typed JSON: developers, publishers, engines, release dates (ISO when parseable), taxonomy (genres, modes, series…), Steam/GOG IDs and links. Optionally store availability and languages. Takes exactly one of title, steam_appid, gog_id or page_id.",
      inputSchema: getGameShape,
      annotations: READ_ONLY,
    },
    (args) => safely(async () => toolResult(await getGame(ctx, args))),
  );
}
