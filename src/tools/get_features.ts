import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type Envelope, envelope, pageSource, toolResult } from "../envelope.js";
import { FEATURE_GROUP_NAMES, type FeatureGroupName, type Features, getFeatures } from "../features.js";
import { type GameRef, checkRef, gameRefShape, resolveOne } from "../resolve.js";
import { READ_ONLY, type ToolContext, safely } from "./context.js";

export const getFeaturesShape = {
  ...gameRefShape,
  groups: z
    .array(z.enum(FEATURE_GROUP_NAMES as [FeatureGroupName, ...FeatureGroupName[]]))
    .min(1)
    .max(FEATURE_GROUP_NAMES.length)
    .optional()
    .describe("Which tables: video, input, audio, api, middleware, vr, multiplayer. Default all (in Cargo mode each group is one request, so ask only for what you need)."),
};

export async function getFeaturesTool(ctx: ToolContext, args: GameRef & { groups?: FeatureGroupName[] }): Promise<Envelope<Features>> {
  const { groups, ...ref } = args;
  checkRef(ref);
  const page = await resolveOne(ctx.api, ref);
  const res = await getFeatures(ctx.api, page.title, [...new Set(groups ?? FEATURE_GROUP_NAMES)]);
  return envelope(res.data, res.mode, pageSource(page.title, res.retrievedAt, res.page_id ?? page.page_id));
}

export function registerGetFeatures(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "get_features",
    {
      title: "Get PC feature tables",
      description:
        "PCGamingWiki's feature tables for one game: video (widescreen, ultrawide, FOV, HDR, frame rate, upscaling…), input (remapping, controllers, prompts), audio, api (Direct3D/Vulkan versions, 64-bit, ARM), middleware, vr and multiplayer. Values are as on the wiki (true, false, limited, hackable, n/a, unknown…), with notes in wikitext mode. A group is null when the article has no such table. Takes exactly one of title, steam_appid, gog_id or page_id.",
      inputSchema: getFeaturesShape,
      annotations: READ_ONLY,
    },
    (args) => safely(async () => toolResult(await getFeaturesTool(ctx, args))),
  );
}
