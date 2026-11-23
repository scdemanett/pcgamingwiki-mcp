import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type Envelope, envelope, pageSource, toolResult } from "../envelope.js";
import { type GameRef, checkRef, gameRefShape, resolveOne } from "../resolve.js";
import { type SaveLocations, getSaveLocations } from "../saves.js";
import { READ_ONLY, type ToolContext, safely } from "./context.js";

export const getSaveLocationsShape = {
  ...gameRefShape,
  platform: z
    .string()
    .trim()
    .min(1)
    .max(50)
    .optional()
    .describe("Only this platform or store, e.g. Windows, Linux, mac, Steam, GOG.com, Microsoft Store"),
  raw: z.boolean().optional().describe("Also return the Game data section's wikitext (and notes in Cargo mode)"),
};

export async function getSaveLocationsTool(
  ctx: ToolContext,
  args: GameRef & { platform?: string; raw?: boolean },
): Promise<Envelope<SaveLocations>> {
  const { platform, raw, ...ref } = args;
  checkRef(ref);
  const page = await resolveOne(ctx.api, ref);
  const res = await getSaveLocations(ctx.api, page.title, { ...(platform ? { platform } : {}), ...(raw ? { raw } : {}) });
  return envelope(res.data, res.mode, pageSource(page.title, res.retrievedAt, res.page_id ?? page.page_id));
}

export function registerGetSaveLocations(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "get_save_locations",
    {
      title: "Get save and config locations",
      description:
        "Where a game keeps its saves and config files, per platform/store, plus cloud save sync per client and the article's notes. Paths use PCGW's placeholders: %APPDATA%, %USERPROFILE%\\Documents, $HOME, $XDG_CONFIG_HOME, <path-to-game>, <user-id>, <Steam-folder>, HKEY_CURRENT_USER… Wikitext mode also returns each path's {{p|token}} segments. Takes exactly one of title, steam_appid, gog_id or page_id.",
      inputSchema: getSaveLocationsShape,
      annotations: READ_ONLY,
    },
    (args) => safely(async () => toolResult(await getSaveLocationsTool(ctx, args))),
  );
}
