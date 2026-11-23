/**
 * Plain-text rendering of a whole article section for `get_section format=text`.
 * Block templates (Game data, feature tables, Availability, L10n, Fixbox…) become
 * readable lines; headings become Markdown-style `##` lines; the rest goes through
 * renderText.
 */
import { type Node, type Template, named, parse, positional, templates, toWikitext } from "./parse.js";
import { extractAvailability, extractGameData, extractLanguages, renderText } from "./templates.js";

export function renderSection(wikitext: string): string {
  // PCGW's bullet/icon templates at line start ({{ii}}, {{mm}}, {{++}}, {{--}}, {{!!}}) become "- ".
  const bulleted = wikitext.replace(/^[ \t]*\{\{\s*(ii|mm|\+\+|--|!!)\s*\}\}[ \t]*/gim, "- ");
  const nodes = parse(bulleted).map((n): Node => {
    if (typeof n === "string" || n.type !== "template") return n;
    const block = renderBlock(n);
    return block === undefined ? n : `\n${block}\n`;
  });
  return renderText(nodes)
    .replace(/^(={2,6})[ \t]*(.+?)[ \t]*\1[ \t]*$/gm, (_m, eq: string, h: string) => `${"#".repeat(eq.length)} ${h}`)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function renderBlock(t: Template): string | undefined {
  switch (t.name) {
    case "Game data": {
      const gd = extractGameData(toWikitext([t]));
      return gd.rows
        .map((r) => `- ${r.type === "saves" ? "Saves" : "Config"} (${r.platform}): ${r.paths.map((p) => p.path).join("; ") || "(no path given)"}`)
        .join("\n");
    }
    case "Availability":
      return extractAvailability([t])
        .map((a) => {
          const bits = [a.drm.length ? `DRM: ${a.drm.join(", ")}` : "", a.os.length ? `OS: ${a.os.join(", ")}` : "", a.state === "unavailable" ? "no longer sold" : ""].filter(Boolean);
          return `- ${a.store}${bits.length ? ` (${bits.join("; ")})` : ""}${a.notes ? ` — ${a.notes.replace(/\s*\n\s*/g, " ")}` : ""}`;
        })
        .join("\n");
    case "L10n":
      return extractLanguages(templatesOf(t))
        .map((l) => {
          const bits = (["interface", "audio", "subtitles"] as const).filter((k) => l[k]).map((k) => `${k} ${l[k]}`);
          return `- ${l.language}${l.fan ? " (fan translation)" : ""}: ${bits.join(", ")}${l.notes ? ` — ${l.notes}` : ""}`;
        })
        .join("\n");
    default:
      return namedTable(t);
  }
}

const templatesOf = (t: Template): Node[] => [...templates([t])];

/**
 * Generic `|key = value` / `|key notes = …` table (Video, Input, Audio, API,
 * System requirements, Fixbox, Infobox game…). Only used when most args are named.
 */
function namedTable(t: Template): string | undefined {
  const namedArgs = t.args.filter((a) => a.name !== undefined);
  if (namedArgs.length < 2 || namedArgs.length < positional(t).length) return undefined;
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const a of namedArgs) {
    const key = a.name!;
    if (seen.has(key) || key.endsWith(" notes")) continue;
    seen.add(key);
    const value = dropSharedLabel(renderText(a.value).replace(/\n\s*\n/g, "\n"));
    const notesNodes = named(t, `${key} notes`);
    const notes = notesNodes ? renderText(notesNodes) : "";
    if (!value && !notes) continue;
    const multiline = value.includes("\n");
    lines.push(`- ${key}:${multiline ? "\n" + indent(value) : ` ${value}`}${notes ? ` (${notes.replace(/\n/g, " ")})` : ""}`);
  }
  return [`${t.name}:`, ...lines].join("\n");
}

/** "developer: A\ndeveloper: B" → "A\nB" (infobox rows repeat their kind on every line). */
function dropSharedLabel(value: string): string {
  const lines = value.split("\n");
  const label = /^([a-z][a-z ]*): /.exec(lines[0] ?? "")?.[1];
  if (!label || !lines.every((l) => l.startsWith(`${label}: `))) return value;
  return lines.map((l) => l.slice(label.length + 2)).join("\n");
}

const indent = (s: string) =>
  s
    .split("\n")
    .map((l) => `  ${l}`)
    .join("\n");
