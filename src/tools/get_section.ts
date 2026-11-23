import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type Envelope, envelope, pageSource, toolResult } from "../envelope.js";
import { PcgwError } from "../errors.js";
import { type GameRef, checkRef, gameRefShape, resolveOne } from "../resolve.js";
import { renderSection } from "../wikitext/render.js";
import { sectionContent, splitSections } from "../wikitext/templates.js";
import { READ_ONLY, type ToolContext, safely } from "./context.js";

/** Keeps one response a sensible size; the agent can ask for a subsection instead. */
export const MAX_SECTION_CHARS = 40_000;

export const getSectionShape = {
  ...gameRefShape,
  section: z
    .union([z.string().trim().min(1).max(200), z.number().int().min(0).max(500)])
    .optional()
    .describe("Heading text (any case, e.g. \"Game data\", \"Video\") or index from the heading list. Omit to list the headings."),
  format: z.enum(["text", "wikitext"]).default("text").describe("text (readable, templates rendered) or wikitext (as written)"),
};

export interface SectionHeading {
  index: number;
  level: number;
  heading: string;
}

export type SectionData =
  | { sections: SectionHeading[] }
  | { index: number; heading: string; level: number; format: "text" | "wikitext"; content: string; truncated?: true };

export async function getSection(
  ctx: ToolContext,
  args: GameRef & { section?: string | number; format?: "text" | "wikitext" },
): Promise<Envelope<SectionData>> {
  const { section, format = "text", ...ref } = args;
  checkRef(ref);
  const page = await ctx.api.parsePage((await resolveOne(ctx.api, ref)).title);
  const sections = splitSections(page.wikitext);
  const headings: SectionHeading[] = sections.map((s, index) => ({ index, level: s.level, heading: index === 0 ? "(lead)" : s.heading }));
  const source = pageSource(page.title, page.fetchedAt, page.page_id);
  // Sections always come from the article itself, so this tool is wikitext mode in both modes.
  if (section === undefined) return envelope({ sections: headings }, "wikitext", source);

  const index = findSection(sections, section);
  if (index === undefined) {
    throw new PcgwError("not_found", `"${page.title}" has no section "${section}".`, { sections: headings });
  }
  const raw = sectionContent(page.wikitext, sections, index)!.trim();
  let content = format === "text" ? renderSection(raw) : raw;
  const truncated = content.length > MAX_SECTION_CHARS;
  if (truncated) content = `${content.slice(0, MAX_SECTION_CHARS)}\n…`;
  return envelope(
    { index, heading: headings[index]!.heading, level: sections[index]!.level, format, content, ...(truncated ? { truncated: true as const } : {}) },
    "wikitext",
    source,
  );
}

function findSection(sections: ReturnType<typeof splitSections>, want: string | number): number | undefined {
  if (typeof want === "number") return want < sections.length ? want : undefined;
  const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  const target = norm(want);
  const exact = sections.findIndex((s, i) => i > 0 && norm(s.heading) === target);
  if (exact !== -1) return exact;
  if (target === "(lead)" || target === "lead") return 0;
  if (/^\d+$/.test(target) && Number(target) < sections.length) return Number(target);
  return undefined;
}

export function registerGetSection(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "get_section",
    {
      title: "Get an article section",
      description:
        "One section of a PCGamingWiki article (with its subsections), as readable text or raw wikitext. Omit `section` to list the headings with their indexes. Good for fixes, issues, modifications and anything the structured tools don't cover. Takes exactly one of title, steam_appid, gog_id or page_id.",
      inputSchema: getSectionShape,
      annotations: READ_ONLY,
    },
    (args) => safely(async () => toolResult(await getSection(ctx, args))),
  );
}
