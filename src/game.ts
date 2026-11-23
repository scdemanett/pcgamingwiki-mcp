import { type CargoRow, type PcgwApi, cargoString } from "./api.js";
import type { Mode } from "./envelope.js";
import { parse } from "./wikitext/parse.js";
import {
  type AvailabilityEntry,
  type DateValue,
  type LanguageEntry,
  extractAvailability,
  extractInfobox,
  extractLanguages,
  parseDate,
  renderText,
} from "./wikitext/templates.js";

/** One shape for both modes. Fields only one mode can fill are optional and say so. */
export interface GameInfo {
  title: string;
  page_id?: number;
  developers: { name: string; note?: string }[];
  publishers: { name: string; note?: string }[];
  engines: { name: string; build?: string }[];
  release_dates: { platform: string; date: DateValue }[];
  taxonomy: Record<string, string[]>;
  steam_appid: string[];
  /** Wikitext mode only: side IDs (DLC, soundtracks). Cargo merges them into `steam_appid`. */
  steam_appid_side?: string[];
  gog_id: string[];
  /** Wikitext mode only. */
  gog_id_side?: string[];
  /** Wikitext mode only: review scores. */
  reception?: { aggregator: string; id: string; score: string }[];
  /** Other infobox fields: cover, license, wikipedia, strategywiki, official_site, hltb… */
  fields: Record<string, string>;
  availability?: Availability[];
  languages?: Language[];
}

export type Availability = Partial<Omit<AvailabilityEntry, "state">> & { store: string; drm: string[]; state: "available" | "unavailable" | "future" };
export type Language = LanguageEntry & { status?: string };

export type Include = "availability" | "languages";

export interface GameResult {
  info: GameInfo;
  mode: Mode;
  retrievedAt: string;
}

export async function getGameInfo(api: PcgwApi, page: { title: string; page_id?: number }, include: Include[] = []): Promise<GameResult> {
  return api.hasCargo ? cargoGameInfo(api, page.title, include) : wikitextGameInfo(api, page.title, include);
}

// ---------- wikitext mode ----------

async function wikitextGameInfo(api: PcgwApi, title: string, include: Include[]): Promise<GameResult> {
  const page = await api.parsePage(title);
  const nodes = parse(page.wikitext);
  const box = extractInfobox(nodes);
  const info: GameInfo = {
    title: page.title,
    page_id: page.page_id,
    developers: box?.developers ?? [],
    publishers: box?.publishers ?? [],
    engines: box?.engines ?? [],
    release_dates: box?.release_dates ?? [],
    taxonomy: box?.taxonomy ?? {},
    steam_appid: box?.steam_appid ?? [],
    steam_appid_side: box?.steam_appid_side ?? [],
    gog_id: box?.gogcom_id ?? [],
    gog_id_side: box?.gogcom_id_side ?? [],
    reception: box?.reception ?? [],
    fields: box?.fields ?? {},
  };
  if (include.includes("availability")) info.availability = extractAvailability(nodes);
  if (include.includes("languages")) info.languages = extractLanguages(nodes);
  return { info, mode: "wikitext", retrievedAt: page.fetchedAt };
}

// ---------- Cargo mode ----------

const RELEASE_PLATFORMS: Record<string, string> = {
  PC_booter: "PC booter",
  DOS: "DOS",
  Windows_3x: "Windows 3.x",
  Windows: "Windows",
  Mac_OS: "Mac OS",
  OS_X: "OS X",
  Linux: "Linux",
};
const TAXONOMY = ["Monetization", "Microtransactions", "Modes", "Pacing", "Perspectives", "Controls", "Genres", "Sports", "Vehicles", "Art_styles", "Themes", "Series"];
const OTHER = ["Cover", "Cover_URL", "Available_on", "Release_State", "Wrappers", "StrategyWiki", "Wikipedia", "License"];
const GAME_FIELDS = [
  "Game._pageName=Page",
  "Game._pageID=PageID",
  "Game.Developers=Developers",
  "Game.Publishers=Publishers",
  "Game.Engines=Engines",
  "Game.Steam_AppID=Steam_AppID",
  "Game.GOGcom_ID=GOGcom_ID",
  ...Object.keys(RELEASE_PLATFORMS).map((p) => `Game.Released_${p}=Released_${p}`),
  ...TAXONOMY.map((f) => `Game.${f}=${f}`),
  ...OTHER.map((f) => `Game.${f}=${f}`),
].join(",");

const list = (s: string | undefined, delim = ","): string[] =>
  (s ?? "")
    .split(delim)
    .map((x) => x.trim())
    .filter(Boolean);
const stripNs = (s: string) => s.replace(/^(Company|Engine|Series):/, "");

async function cargoGameInfo(api: PcgwApi, title: string, include: Include[]): Promise<GameResult> {
  const where = `Game._pageName=${cargoString(title)}`;
  const { rows, fetchedAt } = await api.cargo({ tables: "Game", fields: GAME_FIELDS, where }, 1);
  const row: CargoRow = rows[0] ?? {};
  const info: GameInfo = {
    title: row.Page ?? title,
    ...(row.PageID ? { page_id: Number(row.PageID) } : {}),
    developers: list(row.Developers).map((n) => ({ name: stripNs(n) })),
    publishers: list(row.Publishers).map((n) => ({ name: stripNs(n) })),
    engines: list(row.Engines).map((n) => ({ name: stripNs(n) })),
    release_dates: Object.entries(RELEASE_PLATFORMS)
      .filter(([k]) => row[`Released_${k}`])
      .map(([k, platform]) => ({ platform, date: cargoDate(row[`Released_${k}`]!) })),
    taxonomy: Object.fromEntries(TAXONOMY.map((f): [string, string[]] => [f.toLowerCase(), list(row[f])]).filter(([, v]) => v.length > 0)),
    steam_appid: list(row.Steam_AppID),
    gog_id: list(row.GOGcom_ID),
    fields: Object.fromEntries(OTHER.filter((f) => row[f]).map((f) => [f.toLowerCase(), row[f]!])),
  };
  if (include.includes("availability")) info.availability = await cargoAvailability(api, title);
  if (include.includes("languages")) info.languages = await cargoLanguages(api, title);
  return { info, mode: "cargo", retrievedAt: fetchedAt };
}

function cargoDate(raw: string): DateValue {
  return /^\d{4}(-\d{2}(-\d{2})?)?$/.test(raw) ? { raw, iso: raw } : parseDate(raw);
}

const storeKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

async function cargoAvailability(api: PcgwApi, title: string): Promise<Availability[]> {
  // `Availability.*` isn't allowed in Cargo; ask for the state lists and every DRM column.
  const { rows } = await api.cargo(
    { tables: "Availability", fields: AVAILABILITY_FIELDS, where: `Availability._pageName=${cargoString(title)}` },
    1,
  );
  const row = rows[0];
  if (!row) return [];
  const drmByStore = new Map<string, string[]>();
  for (const [k, v] of Object.entries(row)) if (k.endsWith("_DRM")) drmByStore.set(storeKey(k.slice(0, -4)), list(v));
  const out: Availability[] = [];
  for (const [col, state] of [["Present", "available"], ["Past", "unavailable"], ["Future", "future"]] as const) {
    for (const store of list(row[col])) out.push({ store, drm: drmByStore.get(storeKey(store)) ?? [], state });
  }
  return out;
}

const DRM_COLUMNS = [
  "Uses", "Removed", "Retail", "Developer_website", "Publisher_website", "Official_website", "Amazon_US", "Amazon_UK", "Amazon_FR",
  "Amazon_IT", "Amazon_DE", "Amazon_ES", "Amazon_JP", "Battlenet", "Bethesdanet", "Discord", "EA_app", "Epic_Games_Store", "GamersGate",
  "Gamesplanet", "GOGcom", "Green_Man_Gaming", "Humble_Store", "itchio", "Mac_App_Store", "Meta_Store", "Microsoft_Store", "Steam",
  "Twitch", "Ubisoft_Store", "Viveport", "Zoom_Platform",
];
const AVAILABILITY_FIELDS = ["Present", "Past", "Future", ...DRM_COLUMNS.map((c) => `${c}_DRM`)].map((f) => `Availability.${f}=${f}`).join(",");

async function cargoLanguages(api: PcgwApi, title: string): Promise<Language[]> {
  const { rows } = await api.cargo(
    {
      tables: "L10n",
      fields: "L10n.Language=Language,L10n.Status=Status,L10n.Interface=Interface,L10n.Audio=Audio,L10n.Subtitles=Subtitles,L10n.Notes=Notes",
      where: `L10n._pageName=${cargoString(title)}`,
    },
    200,
  );
  return rows
    .filter((r) => r.Language)
    .map((r) => {
      const notes = r.Notes ? renderText(parse(r.Notes)) : "";
      return {
        language: r.Language!,
        ...(r.Interface ? { interface: r.Interface } : {}),
        ...(r.Audio ? { audio: r.Audio } : {}),
        ...(r.Subtitles ? { subtitles: r.Subtitles } : {}),
        ...(notes ? { notes } : {}),
        ...(r.Status ? { status: r.Status } : {}),
      };
    });
}
