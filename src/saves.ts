import { type PcgwApi, cargoString } from "./api.js";
import type { Mode } from "./envelope.js";
import { parse } from "./wikitext/parse.js";
import { type FeatureValue, type PathSegment, extractFeatureTable, extractGameData, sectionWithChildren, splitSections } from "./wikitext/templates.js";

export interface SavePath {
  /** Rendered as PCGW stores it in Cargo, e.g. `%APPDATA%\EldenRing\<user-id>\`. */
  path: string;
  /** Wikitext mode only: the path as written, e.g. `{{p|appdata}}\EldenRing\{{p|uid}}\`. */
  wikitext?: string;
  /** Wikitext mode only: literal text and `{{p|…}}` tokens, for tools that map tokens themselves. */
  segments?: PathSegment[];
}

export interface PlatformLocations {
  saves: SavePath[];
  config: SavePath[];
}

export interface SaveLocations {
  /** Platform or store as written on the wiki ("Windows", "OS X", "Steam", "GOG.com"…). */
  platforms: Record<string, PlatformLocations>;
  /** Every platform the article lists, before any `platform` filter. */
  platforms_available: string[];
  /** Cloud save sync per client, keyed steam, gog_galaxy, epic_games_launcher, ea_app, ubisoft_connect, xbox, icloud, discord, onedrive. */
  cloud: Record<string, FeatureValue>;
  /** Notes under the Game data headings. Wikitext mode, or Cargo mode with `raw`. */
  notes?: { section: string; text: string }[];
  /** Whether the Linux version follows the XDG base-directory spec, when stated. */
  xdg?: boolean;
  /** The Game data section's wikitext, when `raw` was asked for. */
  wikitext?: string;
}

export interface SaveOptions {
  platform?: string;
  raw?: boolean;
}

export interface SaveResult {
  data: SaveLocations;
  mode: Mode;
  page_id?: number;
  retrievedAt: string;
}

export async function getSaveLocations(api: PcgwApi, title: string, opts: SaveOptions = {}): Promise<SaveResult> {
  const result = api.hasCargo ? await cargoSaves(api, title, opts) : await wikitextSaves(api, title, opts);
  return { ...result, data: filterPlatform(result.data, opts.platform) };
}

// ---------- wikitext mode ----------

interface PageGameData {
  rows: { type: "saves" | "config"; platform: string; paths: SavePath[] }[];
  notes: { section: string; text: string }[];
  xdg?: boolean;
  cloud: Record<string, FeatureValue>;
  wikitext: string;
}

function readPage(wikitext: string): PageGameData {
  const section = sectionWithChildren(splitSections(wikitext), "Game data", wikitext) ?? "";
  const gd = extractGameData(section);
  return {
    rows: gd.rows.map((r) => ({ type: r.type, platform: r.platform, paths: r.paths })),
    notes: gd.notes,
    ...(gd.xdg !== undefined ? { xdg: gd.xdg } : {}),
    cloud: canonicalCloud(extractFeatureTable(parse(wikitext), "Save game cloud syncing") ?? {}),
    wikitext: section.trim(),
  };
}

async function wikitextSaves(api: PcgwApi, title: string, opts: SaveOptions): Promise<SaveResult> {
  const page = await api.parsePage(title);
  const gd = readPage(page.wikitext);
  return {
    data: {
      ...group(gd.rows),
      cloud: gd.cloud,
      notes: gd.notes,
      ...(gd.xdg !== undefined ? { xdg: gd.xdg } : {}),
      ...(opts.raw ? { wikitext: gd.wikitext } : {}),
    },
    mode: "wikitext",
    page_id: page.page_id,
    retrievedAt: page.fetchedAt,
  };
}

// ---------- Cargo mode ----------

const CLOUD_COLUMNS = ["Discord", "Epic_Games_Launcher", "GOG_Galaxy", "EA_app", "iCloud", "OneDrive", "Steam", "Ubisoft_Connect", "Xbox"];

async function cargoSaves(api: PcgwApi, title: string, opts: SaveOptions): Promise<SaveResult> {
  const where = (t: string) => `${t}._pageName=${cargoString(title)}`;
  const gameData = await api.cargo(
    { tables: "GameData", fields: "GameData.Type=Type,GameData.Platform=Platform,GameData.Paths=Paths,GameData._pageID=PageID", where: where("GameData") },
    100,
  );
  const cloud = await api.cargo({ tables: "Cloud", fields: CLOUD_COLUMNS.map((c) => `Cloud.${c}=${c}`).join(","), where: where("Cloud") }, 1);

  const rows = gameData.rows.map((r) => ({
    type: (r.Type ?? "").toLowerCase().startsWith("config") ? ("config" as const) : ("saves" as const),
    platform: r.Platform ?? "",
    // Module:Cargo/gamePaths joins a row's paths with ", " into a `,`-delimited list.
    paths: (r.Paths ?? "")
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean)
      .map((path) => ({ path })),
  }));
  const cloudRow = cloud.rows[0] ?? {};
  const cloudData: Record<string, FeatureValue> = {};
  for (const c of CLOUD_COLUMNS) if (cloudRow[c]) cloudData[c.toLowerCase()] = { value: cloudRow[c]! };

  const data: SaveLocations = { ...group(rows), cloud: cloudData };
  if (opts.raw) {
    // Notes, the XDG flag and raw wikitext aren't in Cargo; one extra call for the article.
    const page = readPage((await api.parsePage(title)).wikitext);
    data.notes = page.notes;
    if (page.xdg !== undefined) data.xdg = page.xdg;
    data.wikitext = page.wikitext;
  }
  const pageId = gameData.rows[0]?.PageID;
  return {
    data,
    mode: "cargo",
    ...(pageId ? { page_id: Number(pageId) } : {}),
    retrievedAt: gameData.fetchedAt || cloud.fetchedAt,
  };
}

// ---------- shared ----------

function group(rows: PageGameData["rows"]): Pick<SaveLocations, "platforms" | "platforms_available"> {
  const platforms: Record<string, PlatformLocations> = {};
  for (const r of rows) {
    const p = (platforms[r.platform] ??= { saves: [], config: [] });
    p[r.type].push(...r.paths);
  }
  return { platforms, platforms_available: Object.keys(platforms) };
}

/** Wikitext keys (`steam cloud`, `origin`…) and Cargo columns map to one set of names. */
const CLOUD_ALIASES: Record<string, string> = { steam_cloud: "steam", xbox_cloud: "xbox", origin: "ea_app", uplay: "ubisoft_connect" };

function canonicalCloud(table: Record<string, FeatureValue>): Record<string, FeatureValue> {
  const out: Record<string, FeatureValue> = {};
  for (const [k, v] of Object.entries(table)) out[CLOUD_ALIASES[k] ?? k] = v;
  return out;
}

const platformKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const PLATFORM_ALIASES: Record<string, string> = {
  mac: "osx",
  macos: "osx",
  macosx: "osx",
  gog: "gogcom",
  galaxy: "gogcom",
  epic: "epicgameslauncher",
  epicgamesstore: "epicgameslauncher",
  egs: "epicgameslauncher",
  microsoft: "microsoftstore",
  msstore: "microsoftstore",
  xbox: "microsoftstore",
  ubisoft: "ubisoftconnect",
  uplay: "ubisoftconnect",
  ea: "eaapp",
  origin: "eaapp",
  win: "windows",
};

/** Keep only the platforms matching `platform` (case- and punctuation-insensitive, common aliases). */
function filterPlatform(data: SaveLocations, platform?: string): SaveLocations {
  if (!platform) return data;
  const want = platformKey(platform);
  const target = PLATFORM_ALIASES[want] ?? want;
  const platforms = Object.fromEntries(Object.entries(data.platforms).filter(([name]) => platformKey(name) === target));
  return { ...data, platforms };
}
