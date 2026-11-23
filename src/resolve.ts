import { z } from "zod";
import { type PcgwApi, cargoString } from "./api.js";
import { pageUrl } from "./envelope.js";
import { PcgwError } from "./errors.js";

const numericId = (what: string) =>
  z.union([z.string().regex(/^\d{1,12}$/, `${what} must be digits`), z.number().int().positive()]);

/** Shared input fields for every tool that takes a game. Exactly one must be set. */
export const gameRefShape = {
  title: z.string().min(1).max(255).optional().describe("Article title, any case, e.g. \"elden ring\". Redirects are followed."),
  steam_appid: numericId("steam_appid").optional().describe("Steam AppID, e.g. 1245620"),
  gog_id: numericId("gog_id").optional().describe("GOG.com product ID, e.g. 1453375253"),
  page_id: z.number().int().positive().optional().describe("PCGamingWiki page ID"),
};

export interface GameRef {
  title?: string;
  steam_appid?: string | number;
  gog_id?: string | number;
  page_id?: number;
}

export interface Candidate {
  title: string;
  url: string;
  page_id?: number;
}

export type Resolution =
  | { kind: "one"; title: string; page_id?: number; via: keyof GameRef }
  | { kind: "many"; candidates: Candidate[]; via: keyof GameRef };

export function checkRef(ref: GameRef): keyof GameRef {
  const set = (Object.keys(gameRefShape) as (keyof GameRef)[]).filter((k) => ref[k] !== undefined);
  if (set.length !== 1) {
    throw new PcgwError("invalid_input", "Give exactly one of title, steam_appid, gog_id or page_id.", { given: set });
  }
  return set[0]!;
}

const norm = (s: string) => s.replace(/_/g, " ").replace(/\s+/g, " ").trim().toLowerCase();

/**
 * Turn a game ref into an exact page title. Each underlying API call is cached,
 * so a ref resolves over the network once per cache TTL.
 */
export async function resolveRef(api: PcgwApi, ref: GameRef): Promise<Resolution> {
  const via = checkRef(ref);

  if (via === "title") {
    const want = norm(ref.title!);
    const { hits } = await api.prefixSearch(ref.title!.trim(), 10);
    const hit = hits.find((h) => norm(h.title) === want || (h.redirect_from && norm(h.redirect_from) === want));
    if (hit) return { kind: "one", title: hit.title, page_id: hit.page_id, via };
    throw new PcgwError("not_found", `No PCGamingWiki article is titled "${ref.title}".`, {
      suggestions: hits.slice(0, 5).map((h) => ({ title: h.title, url: h.url, page_id: h.page_id })),
    });
  }

  if (via === "page_id") {
    const p = await api.pageById(ref.page_id!);
    return { kind: "one", title: p.title, page_id: p.page_id, via };
  }

  const id = String(via === "steam_appid" ? ref.steam_appid : ref.gog_id);
  let candidates: Candidate[];
  if (api.hasCargo) {
    const column = via === "steam_appid" ? "Steam_AppID" : "GOGcom_ID";
    const { rows } = await api.cargo({
      tables: "Game",
      fields: "Game._pageName=Page,Game._pageID=PageID",
      where: `Game.${column} HOLDS ${cargoString(id)}`,
    });
    candidates = rows.filter((r) => r.Page).map((r) => ({ title: r.Page!, url: pageUrl(r.Page!), ...(r.PageID ? { page_id: Number(r.PageID) } : {}) }));
  } else {
    const titles = await api.idLookup(via === "steam_appid" ? "steamappid" : "gogid", id);
    candidates = titles.map((t) => ({ title: t, url: pageUrl(t) }));
  }
  const label = via === "steam_appid" ? "Steam AppID" : "GOG ID";
  if (candidates.length === 0) throw new PcgwError("not_found", `No PCGamingWiki article lists ${label} ${id}.`);
  if (candidates.length === 1) {
    const c = candidates[0]!;
    return { kind: "one", title: c.title, ...(c.page_id ? { page_id: c.page_id } : {}), via };
  }
  return { kind: "many", candidates, via };
}

/** For tools that need one page: turn `many` into an `ambiguous` error with candidates. */
export async function resolveOne(api: PcgwApi, ref: GameRef): Promise<{ title: string; page_id?: number }> {
  const r = await resolveRef(api, ref);
  if (r.kind === "many") {
    throw new PcgwError("ambiguous", `Several PCGamingWiki articles match that ${r.via}. Call again with one of their titles or page IDs.`, {
      candidates: r.candidates,
    });
  }
  return { title: r.title, ...(r.page_id ? { page_id: r.page_id } : {}) };
}
