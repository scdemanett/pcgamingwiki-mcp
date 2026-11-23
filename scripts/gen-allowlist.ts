/**
 * Regenerates src/cargo/allowlist.ts from PCGW's live Cargo schema and feature templates.
 *
 * Run by hand before a release, never in CI:   npm run gen-allowlist
 * Rebuild from the saved responses only (no network):   npm run gen-allowlist -- --from-fixtures
 *
 * Live mode makes about 16 requests (cargotables, cargofields per table, one query for
 * all feature template sources) through the same queue as the server, 3 s apart.
 * It works anonymously and saves every raw response under test/fixtures/.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { type StoreMapping, matchByName, parseCargoStore } from "../src/cargo/template-columns.js";
import { ResponseCache } from "../src/client/cache.js";
import { PcgwHttp } from "../src/client/http.js";
import { DEFAULT_QUEUE, RequestQueue, realClock } from "../src/client/queue.js";
import { loadConfig, userAgent } from "../src/config.js";

/** Tables v1 exposes (docs/SPEC.md, "Cargo tables v1 allows"). Internal PCGW_* and _pageData stay out. */
const WANTED = ["Game", "GameData", "Cloud", "Video", "Input", "Audio", "API", "Middleware", "VR", "Availability", "Multiplayer", "L10n", "Engine", "Company"];
/** get_features groups: Cargo table and the article template that stores into it. */
const GROUPS: Record<string, { table: string; template: string }> = {
  video: { table: "Video", template: "Video" },
  input: { table: "Input", template: "Input" },
  audio: { table: "Audio", template: "Audio" },
  api: { table: "API", template: "API" },
  middleware: { table: "Middleware", template: "Middleware" },
  vr: { table: "VR", template: "VR support" },
  multiplayer: { table: "Multiplayer", template: "Network/Multiplayer" },
};
const GAP_MS = 3000;
const FIELDS_DIR = "test/fixtures/cargofields";
const TEMPLATES_FIXTURE = "test/fixtures/templates/feature-templates.json";
const offline = process.argv.includes("--from-fixtures");

type FieldsBody = { cargofields?: Record<string, { type: string; isList?: boolean; delimiter?: string }> };
type TemplatesBody = { query?: { pages?: { title: string; revisions?: { slots: { main: { content: string } } }[] }[] } };

const cfg = loadConfig();
const http = new PcgwHttp({
  apiUrl: cfg.apiUrl,
  userAgent: userAgent(cfg),
  queue: new RequestQueue(DEFAULT_QUEUE, realClock),
  cache: new ResponseCache({ ttlMs: 0, max: 1 }),
  log: (m) => console.error(m),
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const readJson = async <T>(path: string): Promise<T> => JSON.parse(await readFile(path, "utf8")) as T;

async function liveTables(): Promise<string[]> {
  const res = await http.get({ action: "cargotables" }, { cache: false });
  const live = new Set<string>((res.body?.cargotables ?? []) as string[]);
  for (const t of WANTED.filter((t) => !live.has(t))) {
    const near = [...live].filter((l) => l.toLowerCase().includes(t.toLowerCase())).join(", ") || "none";
    console.error(`WARNING: table ${t} not on PCGW (similar: ${near}); skipped`);
  }
  return WANTED.filter((t) => live.has(t));
}

async function fields(table: string): Promise<FieldsBody> {
  if (offline) return readJson<FieldsBody>(`${FIELDS_DIR}/${table}.json`);
  await sleep(GAP_MS);
  const body = (await http.get({ action: "cargofields", table }, { cache: false })).body as FieldsBody;
  await writeFile(`${FIELDS_DIR}/${table}.json`, JSON.stringify(body, null, 1) + "\n");
  return body;
}

async function templateSources(): Promise<Map<string, string>> {
  let body: TemplatesBody;
  if (offline) body = await readJson<TemplatesBody>(TEMPLATES_FIXTURE);
  else {
    await sleep(GAP_MS);
    const titles = Object.values(GROUPS).map((g) => `Template:${g.template}`).join("|");
    body = (await http.get({ action: "query", prop: "revisions", rvprop: "content", rvslots: "main", titles, redirects: 1 }, { cache: false })).body as TemplatesBody;
    await writeFile(TEMPLATES_FIXTURE, JSON.stringify(body) + "\n");
  }
  return new Map((body.query?.pages ?? []).map((p) => [p.title.replace(/^Template:/, ""), p.revisions?.[0]?.slots.main.content ?? ""]));
}

async function main(): Promise<void> {
  await mkdir(FIELDS_DIR, { recursive: true });
  await mkdir("test/fixtures/templates", { recursive: true });
  const tables = offline ? WANTED : await liveTables();

  const schema: Record<string, Record<string, { type: string; list?: string }>> = {};
  for (const table of tables) {
    const f = (await fields(table)).cargofields ?? {};
    schema[table] = Object.fromEntries(Object.entries(f).map(([name, v]) => [name, { type: v.type, ...(v.isList ? { list: v.delimiter ?? "," } : {}) }]));
    console.error(`${table}: ${Object.keys(f).length} fields`);
  }

  const sources = await templateSources();
  const groups: Record<string, { table: string; template: string; columns: StoreMapping["columns"] }> = {};
  for (const [group, { table, template }] of Object.entries(GROUPS)) {
    const source = sources.get(template) ?? "";
    if (!source) throw new Error(`Template:${template} not found`);
    let mapping = parseCargoStore(source);
    if (mapping && mapping.table !== table) throw new Error(`Template:${template} stores into ${mapping.table}, expected ${table}`);
    if (!mapping) {
      console.error(`WARNING: Template:${template} has no #cargo_store; matching ${table} columns to parameters by name`);
      mapping = matchByName(source, table, Object.keys(schema[table] ?? {}));
    }
    // Cargo silently drops columns the table doesn't declare; so do we, loudly.
    const unknown = Object.keys(mapping.columns).filter((c) => !schema[table]?.[c]);
    if (unknown.length) {
      console.error(`WARNING: Template:${template} stores columns ${table} doesn't declare (Cargo drops them): ${unknown.join(", ")}`);
      for (const c of unknown) delete mapping.columns[c];
    }
    groups[group] = { table, template, columns: mapping.columns };
    const computed = Object.entries(mapping.columns).filter(([, p]) => p === null).map(([c]) => c);
    console.error(`${group}: ${Object.keys(mapping.columns).length} columns${computed.length ? `, computed: ${computed.join(", ")}` : ""}`);
  }

  const date = new Date().toISOString().slice(0, 10);
  const out = `// GENERATED by scripts/gen-allowlist.ts on ${date} from PCGW's cargofields API and feature
// template sources. Do not edit by hand. Re-run before each release: PCGW renames tables
// and columns without warning.

export interface CargoField {
  /** Cargo type: String, Page, Date, Integer, Wikitext, URL, File… */
  type: string;
  /** Delimiter, when the field is a list (use HOLDS in where clauses). */
  list?: string;
}

export interface FeatureGroup {
  table: string;
  /** Article template that stores into \`table\`. */
  template: string;
  /** Cargo column → template parameter that fills it (null when the template computes it). */
  columns: Readonly<Record<string, string | null>>;
}

export const ALLOWLIST_DATE = ${JSON.stringify(date)};

export const CARGO_TABLES: Readonly<Record<string, Readonly<Record<string, CargoField>>>> = ${JSON.stringify(schema, null, 2)};

export const FEATURE_GROUPS = ${JSON.stringify(groups, null, 2)} as const satisfies Readonly<Record<string, FeatureGroup>>;
`;
  await writeFile("src/cargo/allowlist.ts", out);
  console.error(`Wrote src/cargo/allowlist.ts (${Object.keys(schema).length} tables, ${Object.keys(groups).length} feature groups)`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
