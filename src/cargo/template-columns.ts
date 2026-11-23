/**
 * Reads a PCGW template's `{{#cargo_store: _table=X |Column=… }}` call and works out
 * which template parameter fills each Cargo column. Used by scripts/gen-allowlist.ts.
 *
 * - `|Field_of_view={{{fov|}}}` → `fov`
 * - `|SteamVR={{{steamvr|{{{htc vive|}}}}}}` → `steamvr` (the first parameter wins)
 * - `|Upscaling={{#var:upscaling tech|}}` → `upscaling tech` if the template has that parameter
 * - anything else (computed values) → null
 */
export interface StoreMapping {
  table: string;
  /** Cargo column → template parameter (null when computed). */
  columns: Record<string, string | null>;
}

export function parseCargoStore(source: string): StoreMapping | undefined {
  const start = source.search(/\{\{\s*#cargo_store\s*:/i);
  if (start === -1) return undefined;
  const block = source.slice(start, matchingClose(source, start));
  const table = /_table\s*=\s*([A-Za-z0-9_]+)/.exec(block)?.[1];
  if (!table) return undefined;
  const params = new Set([...source.matchAll(/\{\{\{\s*([^|{}]+?)\s*\|/g)].map((m) => m[1]!.toLowerCase()));
  const columns: Record<string, string | null> = {};
  for (const m of block.matchAll(/^\s*\|\s*([A-Za-z0-9_]+)\s*=(.*)$/gm)) {
    const [, column, expr] = m as unknown as [string, string, string];
    if (column === "_table") continue;
    const param = /\{\{\{\s*([^|{}]+?)\s*\|/.exec(expr)?.[1]?.toLowerCase();
    if (param) {
      columns[column] = param;
      continue;
    }
    const v = /\{\{\s*#var\s*:\s*([^|{}]+?)\s*(\||\}\})/i.exec(expr)?.[1]?.toLowerCase();
    columns[column] = v && params.has(v) ? v : null;
  }
  return { table, columns };
}

/**
 * Column ↔ parameter by name, for templates that store into Cargo some other way
 * (e.g. Template:Middleware): `Physics` ↔ `physics`, `Field_of_view` ↔ `field of view`.
 */
export function matchByName(source: string, table: string, columns: string[]): StoreMapping {
  const params = new Set([...source.matchAll(/\{\{\{\s*([^|{}]+?)\s*\|/g)].map((m) => m[1]!.toLowerCase()));
  return {
    table,
    columns: Object.fromEntries(columns.map((c) => [c, params.has(c.replace(/_/g, " ").toLowerCase()) ? c.replace(/_/g, " ").toLowerCase() : null])),
  };
}

/** Index just past the `}}` that closes the `{{` at `start`. `{{{…}}}` parameters count as units. */
function matchingClose(s: string, start: number): number {
  let depth = 0;
  for (let i = start; i < s.length - 1; i++) {
    if (s.startsWith("{{{", i) || s.startsWith("}}}", i)) {
      i += 2;
      continue;
    }
    if (s[i] === "{" && s[i + 1] === "{") {
      depth++;
      i++;
    } else if (s[i] === "}" && s[i + 1] === "}") {
      depth--;
      i++;
      if (depth === 0) return i + 1;
    }
  }
  return s.length;
}
