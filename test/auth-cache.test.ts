import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PcgwApi } from "../src/api.js";
import { BotSession } from "../src/client/auth.js";
import { ResponseCache } from "../src/client/cache.js";
import { PcgwHttp } from "../src/client/http.js";
import { DEFAULT_QUEUE, RequestQueue } from "../src/client/queue.js";
import { type Route, fakeFetch, json, manualClock } from "./fake-fetch.js";

const PASSWORD = "s3cret-bot-password-value";

/** Synthetic login endpoints (no recording: we have no bot password to record with). */
function loginRoutes(result = "Success"): Route[] {
  return [
    (u) =>
      u.searchParams.get("meta") === "tokens"
        ? new Response(JSON.stringify({ batchcomplete: true, query: { tokens: { logintoken: "tok+\\" } } }), {
            headers: { "content-type": "application/json", "set-cookie": "pcgw_session=abc123; path=/; HttpOnly" },
          })
        : undefined,
    (_u, c) =>
      c.method === "POST"
        ? new Response(JSON.stringify({ login: { result, ...(result === "Success" ? { lgusername: "Tester" } : { reason: "Incorrect username or password entered." }) } }), {
            headers: { "content-type": "application/json", "set-cookie": "pcgwUserName=Tester; path=/" },
          })
        : undefined,
  ];
}

function setup(routes: Route[]) {
  const clock = manualClock();
  const fetch = fakeFetch(routes);
  const http = new PcgwHttp({
    apiUrl: "https://www.pcgamingwiki.com/w/api.php",
    userAgent: "pcgamingwiki-mcp/test",
    queue: new RequestQueue(DEFAULT_QUEUE, clock),
    cache: new ResponseCache({ ttlMs: 60_000, max: 10, now: clock.now }),
    fetch,
    clock,
  });
  const session = new BotSession(http, "Tester@mcp", PASSWORD);
  return { http, fetch, session, api: new PcgwApi(http, session) };
}

describe("BotSession", () => {
  it("logs in with a token over POST and reuses the session cookie", async () => {
    const { session, fetch } = setup(loginRoutes());
    await session.ensure();
    await session.ensure();
    expect(fetch.calls).toHaveLength(2);
    const post = fetch.calls[1]!;
    expect(post.method).toBe("POST");
    expect(post.url.search).not.toContain(PASSWORD); // credentials only in the body
    const form = new URLSearchParams(post.body);
    expect(form.get("action")).toBe("login");
    expect(form.get("lgname")).toBe("Tester@mcp");
    expect(form.get("lgpassword")).toBe(PASSWORD);
    expect(form.get("lgtoken")).toBe("tok+\\");
    expect(post.headers.Cookie).toBe("pcgw_session=abc123");
  });

  it("fails with auth_failed and never echoes the password", async () => {
    const { session } = setup(loginRoutes("Failed"));
    const err = (await session.ensure().then(
      () => undefined,
      (e: unknown) => e,
    )) as Error & { code: string };
    expect(err.code).toBe("auth_failed");
    expect(JSON.stringify({ m: err.message, d: (err as unknown as { details: unknown }).details })).not.toContain(PASSWORD);
  });

  it("logs in again once when a Cargo query says the session expired", async () => {
    let cargoCalls = 0;
    const { api, fetch } = setup([
      ...loginRoutes(),
      (u) => {
        if (u.searchParams.get("action") !== "cargoquery") return;
        return cargoCalls++ === 0
          ? json({ error: { code: "permissiondenied", info: "no" } })
          : json({ cargoquery: [{ title: { Page: "Elden Ring", "Steam AppID": "1245620" } }] });
      },
    ]);
    const { rows } = await api.cargo({ tables: "Game", fields: "Game._pageName=Page,Game.Steam_AppID=Steam_AppID" });
    expect(rows).toEqual([{ Page: "Elden Ring", Steam_AppID: "1245620" }]);
    expect(fetch.calls.map((c) => c.url.searchParams.get("action") ?? c.method)).toEqual(["query", "POST", "cargoquery", "query", "POST", "cargoquery"]);
  });
});

describe("ResponseCache", () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("expires entries after the TTL", async () => {
    let now = 0;
    const cache = new ResponseCache({ ttlMs: 1000, max: 10, now: () => now });
    await cache.set("k", { body: 1, fetchedAt: "t" });
    now = 999;
    expect(await cache.get("k")).toEqual({ body: 1, fetchedAt: "t" });
    now = 1001;
    expect(await cache.get("k")).toBeUndefined();
  });

  it("persists to disk with the same TTL, keyed by hash", async () => {
    dir = await mkdtemp(join(tmpdir(), "pcgw-cache-"));
    let now = 0;
    await new ResponseCache({ ttlMs: 1000, max: 10, dir, now: () => now }).set("https://x/?a=1", { body: { a: 1 }, fetchedAt: "t" });
    const files = await readdir(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^[0-9a-f]{64}\.json$/);
    expect(await readFile(join(dir, files[0]!), "utf8")).toContain('"key":"https://x/?a=1"');
    const fresh = new ResponseCache({ ttlMs: 1000, max: 10, dir, now: () => now });
    expect(await fresh.get("https://x/?a=1")).toEqual({ body: { a: 1 }, fetchedAt: "t" });
    now = 1001;
    expect(await new ResponseCache({ ttlMs: 1000, max: 10, dir, now: () => now }).get("https://x/?a=1")).toBeUndefined();
  });

  it("is a no-op when the TTL is 0", async () => {
    const cache = new ResponseCache({ ttlMs: 0, max: 10 });
    await cache.set("k", { body: 1, fetchedAt: "t" });
    expect(await cache.get("k")).toBeUndefined();
  });
});
