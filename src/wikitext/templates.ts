/**
 * PCGW template extractors (spike prototype). Turns parsed wikitext into the JSON
 * shapes the tools will return in wikitext mode.
 */
import { type Node, type Template, named, normalizeName, parse, positional, templates, textOf, toWikitext } from "./parse.js";
import { renderPathToken } from "./paths.js";

// ---------- text rendering ----------

/** Templates whose first positional arg is their visible text. */
const FIRST_ARG = new Set(["File", "Code", "Key", "Term", "Folder", "Mono"]);
/** Bullet/icon templates that render no text. */
const SILENT = new Set(["Ii", "Mm", "++", "--", "!!", "Image", "XDG", "Ref", "Cn", "Citation needed"]);

export interface RenderOptions {
  /** Keep `<ref>` content (as " [ref: …]"); dropped by default. */
  refs?: boolean;
}

/** Render nodes to plain text an agent can read. Unknown templates stay as wikitext. */
export function renderText(nodes: Node[], opts: RenderOptions = {}): string {
  const raw = nodes.map((n) => renderNode(n, opts)).join("");
  return raw
    .replace(/\[(https?:\/\/[^\s\]]+)(?:\s+([^\]]*))?\]/g, (_m, url: string, label?: string) => label || url)
    .replace(/'''''|'''|''/g, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?(code|small|sup|sub|span|div|u|s|i|b)(\s[^>]*)?>/gi, "")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

function renderNode(n: Node, opts: RenderOptions): string {
  if (typeof n === "string") return n;
  switch (n.type) {
    case "comment":
      return "";
    case "tag":
      if (n.name === "ref") return opts.refs && n.inner.length ? ` [ref: ${renderText(n.inner, opts)}]` : "";
      return renderText(n.inner, opts);
    case "link": {
      const last = n.parts[n.parts.length - 1];
      if (last) return renderText(last, opts);
      const target = renderText(n.target, opts).replace(/^:/, "");
      return target.replace(/^(Glossary|Company|Series|Engine|Category):/i, "").replace(/#.*/, (h) => (target.startsWith("#") ? h.slice(1) : ""));
    }
    case "template":
      return renderTemplate(n, opts);
  }
}

function renderTemplate(t: Template, opts: RenderOptions): string {
  const pos = positional(t);
  if (SILENT.has(t.name)) return "";
  if (FIRST_ARG.has(t.name)) return pos[0] ? renderText(pos[0], opts) : "";
  if (t.name === "W") return renderText(pos[1] ?? pos[0] ?? [], opts);
  if (t.name === "!") return "|";
  // {{store link|Store|id|Label}} → Label; {{Store feature|Xbox Game Pass}} → Xbox Game Pass
  if (t.name === "Store link") return renderText(pos[2] ?? pos[0] ?? [], opts);
  if (t.name === "Store feature") return renderText(pos[0] ?? [], opts);
  if (t.name === "P" || t.name === "Path") return renderPathToken(textOf(pos[0] ?? []));
  // Same output Module:Cargo/gamePaths gives, so paths match Cargo mode.
  if (t.name === "LocalizedPath") return `<Localized ${renderText(pos[0] ?? [], opts)}>`;
  if (t.name.startsWith("Infobox game/row/")) {
    const kind = t.name.slice("Infobox game/row/".length).replace(/^taxonomy\//, "");
    const parts = pos.map((v) => renderText(v, opts)).filter(Boolean);
    return parts.length ? `${kind}: ${parts.join(", ")}\n` : "";
  }
  if (t.name.startsWith("Glossary:")) return t.name.slice("Glossary:".length);
  if (/^Refurl$|^Refcheck$|^Refsnip$/.test(t.name)) {
    const title = named(t, "title");
    const url = named(t, "url");
    return title ? renderText(title, opts) : url ? renderText(url, opts) : "";
  }
  return toWikitext([t]);
}


// ---------- sections ----------

export interface Section {
  level: number;
  /** Heading as plain text ("" for the lead). */
  heading: string;
  /** Wikitext of the section body, excluding subsections. */
  body: string;
  /** Offset of the heading line (0 for the lead). */
  start: number;
  /** Offset where the body starts, just after the heading line. */
  bodyStart: number;
  /** Offset where the body ends (the next heading, or the end of the text). */
  bodyEnd: number;
}

/** Split wikitext on `==Heading==` lines. Index 0 is the lead (level 0, heading ""). */
export function splitSections(wikitext: string): Section[] {
  const out: Section[] = [];
  const re = /^(={2,6})[ \t]*(.+?)[ \t]*\1[ \t]*$/gm;
  let last = 0;
  let current: Section = { level: 0, heading: "", body: "", start: 0, bodyStart: 0, bodyEnd: 0 };
  const close = (end: number) => {
    current.bodyEnd = end;
    current.body = wikitext.slice(last, end);
    out.push(current);
  };
  for (let m = re.exec(wikitext); m; m = re.exec(wikitext)) {
    close(m.index);
    last = m.index + m[0].length;
    current = { level: m[1]!.length, heading: renderText(parse(m[2]!)), body: "", start: m.index, bodyStart: last, bodyEnd: 0 };
  }
  close(wikitext.length);
  return out;
}

/**
 * Section `index`'s body plus all of its subsections, sliced from the original
 * wikitext (subsection headings kept as written). Index 0 is the lead alone.
 */
export function sectionContent(wikitext: string, sections: Section[], index: number): string | undefined {
  const s = sections[index];
  if (!s) return undefined;
  let end = s.bodyEnd;
  if (index > 0) for (let j = index + 1; j < sections.length && sections[j]!.level > s.level; j++) end = sections[j]!.bodyEnd;
  return wikitext.slice(s.bodyStart, end);
}

/** A section's body plus all of its subsections, found by heading text (case-insensitive). */
export function sectionWithChildren(sections: Section[], heading: string, wikitext?: string): string | undefined {
  const i = sections.findIndex((s) => s.level > 0 && s.heading.toLowerCase() === heading.toLowerCase());
  if (i === -1) return undefined;
  if (wikitext !== undefined) return sectionContent(wikitext, sections, i);
  const level = sections[i]!.level;
  let text = sections[i]!.body;
  for (let j = i + 1; j < sections.length && sections[j]!.level > level; j++) {
    const sub = sections[j]!;
    text += `${"=".repeat(sub.level)}${sub.heading}${"=".repeat(sub.level)}${sub.body}`;
  }
  return text;
}

// ---------- Infobox game ----------

export interface DateValue {
  raw: string;
  iso?: string;
}

export interface Infobox {
  developers: { name: string; note?: string }[];
  publishers: { name: string; note?: string }[];
  engines: { name: string; build?: string }[];
  release_dates: { platform: string; date: DateValue }[];
  reception: { aggregator: string; id: string; score: string }[];
  taxonomy: Record<string, string[]>;
  steam_appid: string[];
  steam_appid_side: string[];
  gogcom_id: string[];
  gogcom_id_side: string[];
  /** Every other non-empty field as plain text. */
  fields: Record<string, string>;
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

export function parseDate(raw: string): DateValue {
  const s = raw.trim();
  let m = /^([A-Za-z]+) (\d{1,2}), (\d{4})$/.exec(s);
  if (m) {
    const mi = MONTHS.indexOf(m[1]!.toLowerCase());
    if (mi >= 0) return { raw: s, iso: `${m[3]}-${String(mi + 1).padStart(2, "0")}-${m[2]!.padStart(2, "0")}` };
  }
  m = /^([A-Za-z]+) (\d{4})$/.exec(s);
  if (m) {
    const mi = MONTHS.indexOf(m[1]!.toLowerCase());
    if (mi >= 0) return { raw: s, iso: `${m[2]}-${String(mi + 1).padStart(2, "0")}` };
  }
  if (/^\d{4}$/.test(s)) return { raw: s, iso: s };
  return { raw: s };
}

const splitList = (s: string): string[] =>
  s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

export function findTemplate(nodes: Node[], name: string): Template | undefined {
  const want = normalizeName(name);
  for (const t of templates(nodes)) if (t.name === want) return t;
  return undefined;
}

export function extractInfobox(nodes: Node[]): Infobox | undefined {
  const box = findTemplate(nodes, "Infobox game");
  if (!box) return undefined;
  const info: Infobox = {
    developers: [],
    publishers: [],
    engines: [],
    release_dates: [],
    reception: [],
    taxonomy: {},
    steam_appid: [],
    steam_appid_side: [],
    gogcom_id: [],
    gogcom_id_side: [],
    fields: {},
  };
  const txt = (n?: Node[]) => (n ? renderText(n) : "");
  for (const arg of box.args) {
    if (arg.name === undefined) continue;
    for (const row of templates(arg.value)) {
      const p = positional(row).map((v) => txt(v));
      const kind = row.name.replace(/^Infobox game\/row\//, "");
      if (kind === row.name) continue;
      if (kind === "developer") info.developers.push({ name: p[0] ?? "", ...(p[1] ? { note: p[1] } : {}) });
      else if (kind === "publisher") info.publishers.push({ name: p[0] ?? "", ...(p[1] ? { note: p[1] } : {}) });
      else if (kind === "engine") info.engines.push({ name: p[0] ?? "", ...(named(row, "build") ? { build: txt(named(row, "build")) } : {}) });
      else if (kind === "date") info.release_dates.push({ platform: p[0] ?? "", date: parseDate(p[1] ?? "") });
      else if (kind === "reception") info.reception.push({ aggregator: p[0] ?? "", id: p[1] ?? "", score: p[2] ?? "" });
      else if (kind.startsWith("taxonomy/")) {
        const list = splitList(p[0] ?? "");
        if (list.length) info.taxonomy[kind.slice("taxonomy/".length).replace(/ /g, "_")] = list;
      }
    }
    const key = arg.name.replace(/\s+/g, "_");
    const plain = txt(arg.value);
    if (key === "steam_appid") info.steam_appid = splitList(plain);
    else if (key === "steam_appid_side") info.steam_appid_side = splitList(plain);
    else if (key === "gogcom_id") info.gogcom_id = splitList(plain);
    else if (key === "gogcom_id_side") info.gogcom_id_side = splitList(plain);
    else if (!["developers", "publishers", "engines", "release_dates", "reception", "taxonomy"].includes(key) && plain)
      info.fields[key] = plain;
  }
  return info;
}

// ---------- Game data ----------

export type PathSegment = { text: string } | { token: string };

export interface GameDataPath {
  /** Rendered as PCGW stores it in Cargo, e.g. `%APPDATA%\EldenRing\`. */
  path: string;
  /** Path as wikitext, e.g. `{{p|appdata}}\EldenRing\`. */
  wikitext: string;
  segments: PathSegment[];
}

export interface GameDataRow {
  type: "config" | "saves";
  platform: string;
  paths: GameDataPath[];
}

export interface GameData {
  rows: GameDataRow[];
  /** `{{ii}}`/`{{mm}}` notes, per subsection heading. */
  notes: { section: string; text: string }[];
  /** `{{XDG|true}}` and similar flags, when present. */
  xdg?: boolean;
}

function pathSegments(nodes: Node[]): PathSegment[] {
  const segs: PathSegment[] = [];
  for (const n of nodes) {
    if (typeof n === "string") {
      if (n) segs.push({ text: n });
    } else if (n.type === "template" && n.name === "P") {
      segs.push({ token: textOf(positional(n)[0] ?? []).trim().toLowerCase() });
    } else if (n.type !== "comment") {
      const text = renderText([n]);
      if (text) segs.push({ text });
    }
  }
  // Trim surrounding whitespace off the outer text segments.
  const first = segs[0];
  if (first && "text" in first) first.text = first.text.trimStart();
  const last = segs[segs.length - 1];
  if (last && "text" in last) last.text = last.text.trimEnd();
  return segs.filter((s) => !("text" in s) || s.text !== "");
}

export function renderSegments(segments: PathSegment[]): string {
  return segments.map((s) => ("token" in s ? renderPathToken(s.token) : s.text)).join("");
}

/** Extract Game data rows and notes from the `Game data` section's wikitext. */
export function extractGameData(sectionWikitext: string): GameData {
  const out: GameData = { rows: [], notes: [] };
  for (const sub of splitSections(sectionWikitext)) {
    const nodes = parse(sub.body);
    for (const t of templates(nodes)) {
      const m = /^Game data\/(config|saves)$/i.exec(t.name);
      if (m) {
        const [platform, ...pathArgs] = positional(t);
        const paths = pathArgs
          .map((v) => {
            const segments = pathSegments(v);
            return { path: renderSegments(segments), wikitext: toWikitext(v).trim(), segments };
          })
          .filter((p) => p.wikitext !== "");
        out.rows.push({ type: m[1]!.toLowerCase() as "config" | "saves", platform: renderText(platform ?? []), paths });
      } else if (t.name === "XDG") {
        const v = renderText(positional(t)[0] ?? []).toLowerCase();
        if (v === "true" || v === "false") out.xdg = v === "true";
      }
    }
    // Notes are lines that start with a bullet template.
    for (const line of sub.body.split("\n")) {
      if (/^\s*\{\{\s*(ii|mm|\+\+|--|!!)\s*\}\}/i.test(line)) {
        const text = renderText(parse(line));
        if (text) out.notes.push({ section: sub.heading, text });
      }
    }
  }
  return out;
}

// ---------- key/value feature templates (Video, Input, Audio, API, Save game cloud syncing…) ----------

export interface FeatureValue {
  value: string;
  notes?: string;
  /** Extra sub-fields such as `upscaling tech`. */
  extra?: Record<string, string>;
}

/**
 * Generic extractor for PCGW's `|thing = value` / `|thing notes = …` tables.
 * Empty values are dropped so agents only see what the article states.
 */
export function extractFeatureTable(nodes: Node[], templateName: string): Record<string, FeatureValue> | undefined {
  const t = findTemplate(nodes, templateName);
  if (!t) return undefined;
  const values = new Map<string, string>();
  for (const a of t.args) if (a.name !== undefined) values.set(a.name, renderText(a.value));
  const out: Record<string, FeatureValue> = {};
  for (const [k, v] of values) {
    if (/ notes$/.test(k)) continue;
    // Sub-fields like "upscaling tech" belong to "upscaling" when that key exists.
    const base = k.split(" ").slice(0, -1).join(" ");
    if (base && values.has(base) && !/ notes$/.test(k)) continue;
    const notes = values.get(`${k} notes`);
    const extra: Record<string, string> = {};
    for (const [k2, v2] of values) if (k2.startsWith(`${k} `) && !k2.endsWith(" notes") && v2) extra[k2.slice(k.length + 1)] = v2;
    if (!v && !notes && !Object.keys(extra).length) continue;
    out[k.replace(/\s+/g, "_")] = { value: v, ...(notes ? { notes } : {}), ...(Object.keys(extra).length ? { extra } : {}) };
  }
  return out;
}

// ---------- Availability ----------

export interface AvailabilityEntry {
  store: string;
  /** Store-specific product ID, when the article gives one. */
  id?: string;
  drm: string[];
  notes?: string;
  keys?: string;
  os: string[];
  state: "available" | "unavailable";
}

/** `{{Availability/row| store | id | DRM | notes | keys | OS | state }}` */
export function extractAvailability(nodes: Node[]): AvailabilityEntry[] {
  const out: AvailabilityEntry[] = [];
  for (const t of templates(nodes)) {
    if (t.name !== "Availability/row") continue;
    const [store = "", id = "", drm = "", notes = "", keys = "", os = "", state = ""] = positional(t).map((v) => renderText(v));
    if (!store) continue;
    out.push({
      store,
      ...(id ? { id } : {}),
      drm: splitList(drm),
      ...(notes ? { notes } : {}),
      ...(keys ? { keys } : {}),
      os: splitList(os),
      state: state.toLowerCase() === "unavailable" ? "unavailable" : "available",
    });
  }
  return out;
}

// ---------- Localizations ----------

export interface LanguageEntry {
  language: string;
  interface?: string;
  audio?: string;
  subtitles?: string;
  notes?: string;
  /** True for fan translations. */
  fan?: boolean;
}

/** `{{L10n/switch |language= |interface= |audio= |subtitles= |notes= |fan= }}` */
export function extractLanguages(nodes: Node[]): LanguageEntry[] {
  const out: LanguageEntry[] = [];
  for (const t of templates(nodes)) {
    if (t.name !== "L10n/switch") continue;
    const get = (k: string) => {
      const v = named(t, k);
      return v ? renderText(v) : "";
    };
    const language = get("language");
    if (!language) continue;
    const entry: LanguageEntry = { language };
    for (const k of ["interface", "audio", "subtitles", "notes"] as const) {
      const v = get(k);
      if (v) entry[k] = v;
    }
    if (get("fan").toLowerCase() === "true") entry.fan = true;
    out.push(entry);
  }
  return out;
}
