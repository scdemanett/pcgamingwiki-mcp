import { type PcgwApi, cargoString } from "./api.js";
import { FEATURE_GROUPS } from "./cargo/allowlist.js";
import type { Mode } from "./envelope.js";
import { named, parse } from "./wikitext/parse.js";
import { findTemplate, renderText } from "./wikitext/templates.js";

export type FeatureGroupName = keyof typeof FEATURE_GROUPS;
export const FEATURE_GROUP_NAMES = Object.keys(FEATURE_GROUPS) as FeatureGroupName[];

export interface Feature {
  /** As written on the wiki: true, false, limited, hackable, n/a, unknown, always on, a list… */
  value: string;
  /** Wikitext mode only (Cargo stores no notes). */
  notes?: string;
}

/**
 * One object per group, keyed by the article template's parameter names with spaces as
 * `_` (`widescreen_resolution`, `fov`, `60_fps`) in both modes. Columns the template
 * computes (e.g. `controller_support_level`) only exist in Cargo mode, under their
 * lowercased column name. A group is null when the article has no such table.
 */
export type Features = Partial<Record<FeatureGroupName, Record<string, Feature> | null>>;

export interface FeaturesResult {
  data: Features;
  mode: Mode;
  page_id?: number;
  retrievedAt: string;
}

const key = (param: string) => param.trim().replace(/\s+/g, "_");

export async function getFeatures(api: PcgwApi, title: string, groups: FeatureGroupName[]): Promise<FeaturesResult> {
  return api.hasCargo ? cargoFeatures(api, title, groups) : wikitextFeatures(api, title, groups);
}

async function wikitextFeatures(api: PcgwApi, title: string, groups: FeatureGroupName[]): Promise<FeaturesResult> {
  const page = await api.parsePage(title);
  const nodes = parse(page.wikitext);
  const data: Features = {};
  for (const g of groups) {
    const t = findTemplate(nodes, FEATURE_GROUPS[g].template);
    if (!t) {
      data[g] = null;
      continue;
    }
    const out: Record<string, Feature> = {};
    for (const a of t.args) {
      if (a.name === undefined || a.name.endsWith(" notes")) continue;
      const value = renderText(a.value);
      const notesNodes = named(t, `${a.name} notes`);
      const notes = notesNodes ? renderText(notesNodes) : "";
      if (value || notes) out[key(a.name)] = { value, ...(notes ? { notes } : {}) };
    }
    data[g] = out;
  }
  return { data, mode: "wikitext", page_id: page.page_id, retrievedAt: page.fetchedAt };
}

/** One Cargo call per group. Columns are aliased f0, f1… since some start with digits (4K_Ultra_HD). */
async function cargoFeatures(api: PcgwApi, title: string, groups: FeatureGroupName[]): Promise<FeaturesResult> {
  const data: Features = {};
  let retrievedAt = "";
  let pageId: number | undefined;
  for (const g of groups) {
    const { table, columns } = FEATURE_GROUPS[g];
    const cols = Object.keys(columns);
    const fields = [...cols.map((c, i) => `${table}.${c}=f${i}`), `${table}._pageID=PageID`].join(",");
    const { rows, fetchedAt } = await api.cargo({ tables: table, fields, where: `${table}._pageName=${cargoString(title)}` }, 1);
    retrievedAt ||= fetchedAt;
    const row = rows[0];
    if (!row) {
      data[g] = null;
      continue;
    }
    if (row.PageID) pageId ??= Number(row.PageID);
    const out: Record<string, Feature> = {};
    cols.forEach((c, i) => {
      const v = row[`f${i}`];
      if (v) out[key((columns as Record<string, string | null>)[c] ?? c.toLowerCase())] = { value: v };
    });
    data[g] = out;
  }
  return { data, mode: "cargo", ...(pageId !== undefined ? { page_id: pageId } : {}), retrievedAt };
}
