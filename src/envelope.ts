import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { PcgwError } from "./errors.js";

export const LICENSE = "CC BY-NC-SA 3.0";
const WIKI = "https://www.pcgamingwiki.com";

export type Mode = "cargo" | "wikitext";

export interface Source {
  title: string;
  url: string;
  /** Omitted only for multi-page results (search), where each item carries its own. */
  history_url?: string;
  page_id?: number;
  retrieved_at: string;
}

export interface Envelope<T> {
  data: T;
  mode: Mode;
  source: Source;
  license: typeof LICENSE;
  attribution: string;
}

/** MediaWiki-style title encoding (wfUrlencode): spaces → `_`, keeps `:/,;@$!*()~`. */
function encodeTitle(title: string): string {
  return encodeURIComponent(title.replace(/ /g, "_")).replace(/%(3A|2F|2C|3B|40|24)/gi, (m) => decodeURIComponent(m));
}

export const pageUrl = (title: string): string => `${WIKI}/wiki/${encodeTitle(title)}`;
export const historyUrl = (title: string): string => `${WIKI}/w/index.php?title=${encodeTitle(title)}&action=history`;

export function pageSource(title: string, retrievedAt: string, pageId?: number): Source {
  return {
    title,
    url: pageUrl(title),
    history_url: historyUrl(title),
    ...(pageId !== undefined ? { page_id: pageId } : {}),
    retrieved_at: retrievedAt,
  };
}

export function envelope<T>(data: T, mode: Mode, source: Source): Envelope<T> {
  return {
    data,
    mode,
    source,
    license: LICENSE,
    attribution: `Data from PCGamingWiki contributors, ${LICENSE}: ${source.url}`,
  };
}

export function toolResult<T>(env: Envelope<T>): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(env, null, 2) }] };
}

export function errorResult(err: unknown): CallToolResult {
  const e =
    err instanceof PcgwError
      ? err
      : new PcgwError("upstream_error", err instanceof Error ? err.message : "Unexpected error");
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify({ error: { code: e.code, message: e.message, ...e.details } }, null, 2) }],
  };
}

/** Source for results that span several pages; each item carries its own URLs. */
export function searchSource(query: string, retrievedAt: string): Source {
  return {
    title: `Search: ${query}`,
    url: `${WIKI}/w/index.php?search=${encodeURIComponent(query)}`,
    retrieved_at: retrievedAt,
  };
}
