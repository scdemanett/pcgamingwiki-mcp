import type { BotSession } from "./client/auth.js";
import type { Params, PcgwHttp } from "./client/http.js";
import { PcgwError } from "./errors.js";

export interface PageHit {
  title: string;
  page_id: number;
  url: string;
  /** Set when the query matched a redirect title, e.g. "Skyrim Special Edition". */
  redirect_from?: string;
}

export interface ParsedPage {
  title: string;
  page_id: number;
  revid?: number;
  wikitext: string;
  fetchedAt: string;
}

export type CargoRow = Record<string, string>;

const CARGO_PAGE_SIZE = 50;

/** Typed wrappers for the api.php modules we use. All traffic goes through PcgwHttp. */
export class PcgwApi {
  constructor(
    private readonly http: PcgwHttp,
    private readonly session?: BotSession,
  ) {}

  get hasCargo(): boolean {
    return this.session !== undefined;
  }

  /** Case-insensitive prefix search that resolves redirects and returns page IDs, in one call. */
  async prefixSearch(query: string, limit: number): Promise<{ hits: PageHit[]; fetchedAt: string }> {
    const res = await this.http.get({
      action: "query",
      generator: "prefixsearch",
      gpssearch: query,
      gpslimit: limit,
      prop: "info",
      inprop: "url",
      redirects: 1,
    });
    const q = res.body?.query ?? {};
    const redirects = new Map<number, string>();
    for (const r of (q.redirects ?? []) as { index: number; from: string }[]) redirects.set(r.index, r.from);
    const pages = ((q.pages ?? []) as { index: number; pageid: number; title: string; fullurl: string; missing?: boolean }[])
      .filter((p) => !p.missing)
      .sort((a, b) => a.index - b.index);
    return {
      hits: pages.map((p) => ({
        title: p.title,
        page_id: p.pageid,
        url: p.fullurl,
        ...(redirects.has(p.index) ? { redirect_from: redirects.get(p.index)! } : {}),
      })),
      fetchedAt: res.fetchedAt,
    };
  }

  /** Steam AppID or GOG ID → page titles. Several pages can share one ID. */
  async idLookup(field: "steamappid" | "gogid", value: string): Promise<string[]> {
    const res = await this.http.get({ action: "idlookup", field, value });
    return ((res.body?.idlookup ?? []) as { title?: { Page?: string } }[])
      .map((r) => r.title?.Page)
      .filter((t): t is string => typeof t === "string");
  }

  async pageById(pageId: number): Promise<{ title: string; page_id: number; fetchedAt: string }> {
    const res = await this.http.get({ action: "query", prop: "info", inprop: "url", pageids: pageId });
    const page = res.body?.query?.pages?.[0];
    if (!page || page.missing || page.invalid || page.ns !== 0) {
      throw new PcgwError("not_found", `No PCGamingWiki article has page ID ${pageId}.`);
    }
    return { title: page.title, page_id: page.pageid, fetchedAt: res.fetchedAt };
  }

  /** Whole-article wikitext. `title` must be exact (parse is case-sensitive). */
  async parsePage(title: string): Promise<ParsedPage> {
    const res = await this.http.get({ action: "parse", page: title, redirects: 1, prop: "wikitext|revid" });
    const p = res.body?.parse;
    if (!p || typeof p.wikitext !== "string") throw new PcgwError("upstream_error", `PCGamingWiki returned no wikitext for "${title}".`);
    return {
      title: p.title,
      page_id: p.pageid,
      ...(typeof p.revid === "number" ? { revid: p.revid } : {}),
      wikitext: p.wikitext,
      fetchedAt: res.fetchedAt,
    };
  }

  /**
   * Internal Cargo query (fixed queries built by our code, not user input).
   * Pages through results 50 rows at a time, up to `maxRows`.
   */
  async cargo(params: Params, maxRows = CARGO_PAGE_SIZE): Promise<{ rows: CargoRow[]; fetchedAt: string }> {
    if (!this.session) throw new PcgwError("auth_required", "Cargo queries need a PCGamingWiki bot password (PCGW_BOT_USER, PCGW_BOT_PASSWORD).");
    await this.session.ensure();
    const rows: CargoRow[] = [];
    let fetchedAt = "";
    for (let offset = 0; offset < maxRows; offset += CARGO_PAGE_SIZE) {
      const page = { action: "cargoquery", ...params, limit: Math.min(CARGO_PAGE_SIZE, maxRows - offset), offset };
      let res;
      try {
        res = await this.http.get(page);
      } catch (err) {
        // Session expired: log in again once, then retry (errors are never cached).
        if (!(err instanceof PcgwError) || err.code !== "auth_required") throw err;
        await this.session.relogin();
        res = await this.http.get(page);
      }
      fetchedAt ||= res.fetchedAt;
      const batch = ((res.body?.cargoquery ?? []) as { title: Record<string, unknown> }[]).map((r) => normalizeRow(r.title));
      rows.push(...batch);
      if (batch.length < page.limit) break;
    }
    return { rows, fetchedAt };
  }
}

/** Cargo returns field aliases with `_` turned into spaces; values may be HTML-escaped. */
function normalizeRow(raw: Record<string, unknown>): CargoRow {
  const out: CargoRow = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v === null || v === undefined) continue;
    out[k.replace(/ /g, "_")] = decodeEntities(String(v));
  }
  return out;
}

export function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** Quote a value for a Cargo `where` clause built by our own code. */
export function cargoString(value: string): string {
  if (/[\n\r]/.test(value)) throw new PcgwError("invalid_input", "Value must be a single line.");
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
