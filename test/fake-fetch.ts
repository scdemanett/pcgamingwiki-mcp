import { readFileSync } from "node:fs";
import type { Clock } from "../src/client/queue.js";

export const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/spike/${name}.json`, import.meta.url), "utf8"));

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

export interface Call {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body?: string;
}

export type Route = (url: URL, call: Call) => Response | undefined;

/** A fetch that answers only from routes; anything unrouted fails the test (no live network). */
export function fakeFetch(routes: Route[]): typeof globalThis.fetch & { calls: Call[] } {
  const calls: Call[] = [];
  const fn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const call: Call = {
      method: init?.method ?? "GET",
      url,
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
      ...(typeof init?.body === "string" ? { body: init.body } : {}),
    };
    calls.push(call);
    for (const r of routes) {
      const res = r(url, call);
      if (res) return res;
    }
    throw new Error(`Unexpected request in test: ${call.method} ${url.search}`);
  };
  return Object.assign(fn as typeof globalThis.fetch, { calls });
}

/** Routes that serve the recorded spike fixtures. */
export const fixtureRoutes: Route[] = [
  (u) => {
    if (u.searchParams.get("generator") !== "prefixsearch") return;
    const file = { "elden ring": "prefixsearch-elden-ring", skyrim: "prefixsearch-skyrim" }[u.searchParams.get("gpssearch")!.toLowerCase()];
    return file ? json(fixture(file)) : json({ batchcomplete: true });
  },
  (u) => {
    if (u.searchParams.get("action") !== "parse") return;
    const file = {
      "Elden Ring": "parse-elden-ring",
      "Stardew Valley": "parse-stardew-valley",
      "Half-Life": "parse-half-life",
    }[u.searchParams.get("page")!];
    return json(fixture(file ?? "parse-case-mismatch"));
  },
  (u) => {
    if (u.searchParams.get("action") !== "idlookup") return;
    const key = `${u.searchParams.get("field")}:${u.searchParams.get("value")}`;
    const file = { "steamappid:1245620": "idlookup-steam-1245620", "gogid:1453375253": "idlookup-gog-1453375253" }[key];
    return json(fixture(file ?? "idlookup-steam-missing"));
  },
  (u) => (u.searchParams.get("pageids") === "146683" ? json(fixture("info-pageid-146683")) : undefined),
];

/** Manual clock: sleep advances time instantly. */
export function manualClock(start = 1_700_000_000_000): Clock & { t: number } {
  const c = {
    t: start,
    now: () => c.t,
    sleep: async (ms: number) => {
      c.t += ms;
    },
  };
  return c;
}

/**
 * Env for loadConfig in tests: points the credentials folder at a path that never
 * exists, so a real `pcgamingwiki-mcp login` on the dev machine can't leak in.
 */
export const testEnv = (): NodeJS.ProcessEnv => ({ PCGW_CONFIG_DIR: `${process.cwd()}/test/.no-such-config-dir` });
