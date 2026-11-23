/**
 * Safe Cargo query builder for the `cargo_query` tool.
 *
 * Cargo turns these parameters into SQL on PCGW's database, so nothing from the
 * agent is passed through as written. Tables and fields must be on the generated
 * allowlist; `where` is tokenized, every identifier checked, and the clause rebuilt
 * from the tokens. No functions, subqueries, comments, semicolons or aliases on tables.
 */
import { PcgwError } from "../errors.js";
import { CARGO_TABLES } from "./allowlist.js";

export const MAX_TABLES = 2;
export const MAX_LIMIT = 50;
export const DEFAULT_LIMIT = 20;
const MAX_FIELDS = 30;
const MAX_WHERE = 500;
const MAX_ORDER = 3;
const MAX_DEPTH = 5;
/** Alias we add to every query so each row can carry its page URL. */
export const PAGE_ALIAS = "PCGWPage";
const PAGE_FIELDS = ["_pageName", "_pageID", "_pageTitle"];
const KEYWORDS = new Set(["AND", "OR", "NOT", "LIKE", "HOLDS", "IN", "IS", "NULL", "BETWEEN"]);
const ALIAS_RE = /^[A-Za-z][A-Za-z0-9_]{0,40}$/;

export interface CargoQueryInput {
  tables: string | string[];
  fields: string | string[];
  where?: string;
  join_on?: string;
  order_by?: string;
  limit?: number;
}

export interface BuiltQuery {
  params: { tables: string; fields: string; where?: string; join_on?: string; order_by?: string; limit: number };
  tables: string[];
}

const invalid = (message: string, details: Record<string, unknown> = {}) => new PcgwError("invalid_query", message, details);
const list = (v: string | string[]) => (Array.isArray(v) ? v : v.split(",")).map((s) => s.trim()).filter(Boolean);

export function buildCargoQuery(input: CargoQueryInput): BuiltQuery {
  const tables = resolveTables(list(input.tables));
  const fields = buildFields(list(input.fields), tables);
  const params: BuiltQuery["params"] = { tables: tables.join(","), fields, limit: checkLimit(input.limit) };

  if (tables.length === 2) {
    if (!input.join_on?.trim()) throw invalid("Two tables need join_on, e.g. Game._pageID=GameData._pageID.", { field: "join_on" });
    params.join_on = buildJoin(input.join_on, tables);
  } else if (input.join_on?.trim()) {
    throw invalid("join_on only applies when querying two tables.", { field: "join_on" });
  }
  if (input.where?.trim()) params.where = buildWhere(input.where, tables);
  if (input.order_by?.trim()) params.order_by = buildOrder(input.order_by, tables);
  return { params, tables };
}

function resolveTables(names: string[]): string[] {
  if (names.length === 0) throw invalid("Give at least one table.", { field: "tables" });
  if (names.length > MAX_TABLES) throw invalid(`At most ${MAX_TABLES} tables per query.`, { field: "tables" });
  const out = names.map((n) => {
    const hit = Object.keys(CARGO_TABLES).find((t) => t.toLowerCase() === n.toLowerCase());
    if (!hit) throw invalid(`Table "${n}" isn't allowed.`, { field: "tables", table: n, allowed: Object.keys(CARGO_TABLES) });
    return hit;
  });
  if (new Set(out).size !== out.length) throw invalid("The same table appears twice.", { field: "tables" });
  return out;
}

interface FieldRef {
  table: string;
  field: string;
}

/** `Table.Field` or `Field` (unqualified only when exactly one table has it). */
function resolveField(ref: string, tables: string[], where: string): FieldRef {
  const m = /^(?:([A-Za-z_][A-Za-z0-9_]*)\.)?([A-Za-z0-9_]+)$/.exec(ref.trim());
  if (!m) throw invalid(`"${ref}" isn't a field name.`, { field: where });
  const [, qual, name] = m as unknown as [string, string | undefined, string];
  const candidates = qual ? tables.filter((t) => t.toLowerCase() === qual.toLowerCase()) : tables;
  if (qual && candidates.length === 0) throw invalid(`"${ref}" names a table that isn't in this query.`, { field: where, ref });
  const hits: FieldRef[] = [];
  for (const t of candidates) {
    const page = PAGE_FIELDS.find((p) => p.toLowerCase() === name.toLowerCase());
    if (page) hits.push({ table: t, field: page });
    else {
      const f = Object.keys(CARGO_TABLES[t]!).find((k) => k.toLowerCase() === name.toLowerCase());
      if (f) hits.push({ table: t, field: f });
    }
  }
  if (hits.length === 0) {
    const t = candidates.length === 1 ? candidates[0]! : undefined;
    throw invalid(`Unknown field "${ref}".`, { field: where, ref, ...(t ? { allowed: [...PAGE_FIELDS, ...Object.keys(CARGO_TABLES[t]!)] } : {}) });
  }
  if (hits.length > 1) throw invalid(`"${ref}" is in both tables; write it as Table.${name}.`, { field: where, ref });
  return hits[0]!;
}

const qualified = (r: FieldRef) => `${r.table}.${r.field}`;
/** Aliases must start with a letter (fields like 4K_Ultra_HD don't). */
const defaultAlias = (r: FieldRef) => (r.field.startsWith("_") ? r.field.slice(1) : /^[A-Za-z]/.test(r.field) ? r.field : `f_${r.field}`);

function buildFields(items: string[], tables: string[]): string {
  if (items.length === 0) throw invalid("Give at least one field.", { field: "fields" });
  if (items.length > MAX_FIELDS) throw invalid(`At most ${MAX_FIELDS} fields.`, { field: "fields" });
  const aliases = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const eq = item.indexOf("=");
    const ref = resolveField(eq === -1 ? item : item.slice(0, eq), tables, "fields");
    const alias = eq === -1 ? defaultAlias(ref) : item.slice(eq + 1).trim();
    if (!ALIAS_RE.test(alias)) throw invalid(`Alias "${alias}" must be letters, digits and _ (starting with a letter).`, { field: "fields" });
    if (alias === PAGE_ALIAS || aliases.has(alias.toLowerCase())) throw invalid(`Alias "${alias}" is used twice or reserved.`, { field: "fields" });
    aliases.add(alias.toLowerCase());
    out.push(`${qualified(ref)}=${alias}`);
  }
  out.push(`${tables[0]}._pageName=${PAGE_ALIAS}`);
  return out.join(",");
}

function buildJoin(join: string, tables: string[]): string {
  const parts = join.split("=");
  if (parts.length !== 2) throw invalid("join_on must be one Table.field=Table.field pair.", { field: "join_on" });
  const a = resolveField(parts[0]!, tables, "join_on");
  const b = resolveField(parts[1]!, tables, "join_on");
  if (a.table === b.table) throw invalid("join_on must link the two tables.", { field: "join_on" });
  return `${qualified(a)}=${qualified(b)}`;
}

function buildOrder(order: string, tables: string[]): string {
  const items = list(order);
  if (items.length > MAX_ORDER) throw invalid(`At most ${MAX_ORDER} order_by fields.`, { field: "order_by" });
  return items
    .map((item) => {
      const m = /^(\S+)(?:\s+(ASC|DESC))?$/i.exec(item);
      if (!m) throw invalid(`order_by item "${item}" must be a field, optionally followed by ASC or DESC.`, { field: "order_by" });
      return `${qualified(resolveField(m[1]!, tables, "order_by"))}${m[2] ? ` ${m[2].toUpperCase()}` : ""}`;
    })
    .join(",");
}

function checkLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw invalid(`limit must be 1–${MAX_LIMIT}.`, { field: "limit" });
  return limit;
}

// ---------- where ----------

type Token =
  | { kind: "field"; ref: FieldRef }
  | { kind: "keyword"; value: string }
  | { kind: "string"; value: string }
  | { kind: "number"; value: string }
  | { kind: "op"; value: string }
  | { kind: "punct"; value: "(" | ")" | "," };

export function buildWhere(where: string, tables: string[]): string {
  if (where.length > MAX_WHERE) throw invalid(`where is limited to ${MAX_WHERE} characters.`, { field: "where" });
  for (const [bad, what] of [[";", "semicolons"], ["--", "comments"], ["/*", "comments"], ["#", "comments"], ["`", "backticks"]] as const) {
    if (where.includes(bad)) throw invalid(`where can't contain ${what}.`, { field: "where" });
  }
  const tokens = tokenize(where, tables);
  let depth = 0;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.kind === "punct" && t.value === "(") {
      const prev = tokens[i - 1];
      if (prev?.kind === "field") throw invalid("where can't call functions.", { field: "where" });
      if (++depth > MAX_DEPTH) throw invalid("where is nested too deeply.", { field: "where" });
    } else if (t.kind === "punct" && t.value === ")") {
      if (--depth < 0) throw invalid("where has an unmatched ).", { field: "where" });
    }
  }
  if (depth !== 0) throw invalid("where has an unmatched (.", { field: "where" });
  if (!tokens.some((t) => t.kind === "field")) throw invalid("where must test at least one field.", { field: "where" });
  return tokens.map(render).join(" ").replace(/\( /g, "(").replace(/ \)/g, ")").replace(/ ,/g, ",");
}

function tokenize(src: string, tables: string[]): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      let value = "";
      let j = i + 1;
      for (; j < src.length && src[j] !== c; j++) {
        if (src[j] === "\\" && j + 1 < src.length) value += src[++j];
        else if (src[j] === "\n" || src[j] === "\r") throw invalid("Strings in where must be on one line.", { field: "where" });
        else value += src[j];
      }
      if (j >= src.length) throw invalid("where has an unterminated string.", { field: "where" });
      out.push({ kind: "string", value });
      i = j + 1;
      continue;
    }
    // Not followed by a word character: otherwise "120_FPS" backtracks to the number 12.
    const num = /^-?\d+(\.\d+)?(?![A-Za-z0-9_.])/.exec(src.slice(i));
    if (num) {
      out.push({ kind: "number", value: num[0] });
      i += num[0].length;
      continue;
    }
    const op = /^(<=|>=|<>|!=|=|<|>)/.exec(src.slice(i));
    if (op) {
      out.push({ kind: "op", value: op[0] });
      i += op[0].length;
      continue;
    }
    if (c === "(" || c === ")" || c === ",") {
      out.push({ kind: "punct", value: c });
      i++;
      continue;
    }
    const id = /^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)?/.exec(src.slice(i));
    if (id) {
      const word = id[0];
      if (!word.includes(".") && KEYWORDS.has(word.toUpperCase())) out.push({ kind: "keyword", value: word.toUpperCase() });
      else out.push({ kind: "field", ref: resolveField(word, tables, "where") });
      i += word.length;
      continue;
    }
    throw invalid(`where can't contain "${c}".`, { field: "where" });
  }
  return out;
}

function render(t: Token): string {
  switch (t.kind) {
    case "field":
      return qualified(t.ref);
    case "string":
      return `"${t.value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    default:
      return t.value;
  }
}
