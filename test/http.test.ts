import { describe, expect, it } from "vitest";
import { ResponseCache } from "../src/client/cache.js";
import { PcgwHttp } from "../src/client/http.js";
import { DEFAULT_QUEUE, RequestQueue } from "../src/client/queue.js";
import { userAgent } from "../src/config.js";
import { type Route, fakeFetch, json, manualClock } from "./fake-fetch.js";

function setup(routes: Route[]) {
  const clock = manualClock();
  const fetch = fakeFetch(routes);
  const queue = new RequestQueue(DEFAULT_QUEUE, clock);
  const http = new PcgwHttp({
    apiUrl: "https://www.pcgamingwiki.com/w/api.php",
    userAgent: userAgent({ contact: "test@example.invalid" }, "1.2.3"),
    queue,
    cache: new ResponseCache({ ttlMs: 60_000, max: 10, now: clock.now }),
    fetch,
    clock,
  });
  return { http, fetch, clock, queue };
}

const ok: Route = () => json({ ok: true });
const html = (status: number, body: string, headers: Record<string, string> = {}): Route => () =>
  new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", ...headers } });

describe("PcgwHttp", () => {
  it("sends our User-Agent, JSON format and maxlag=5", async () => {
    const { http, fetch } = setup([ok]);
    await http.get({ action: "query", meta: "siteinfo" });
    const call = fetch.calls[0]!;
    expect(call.headers["User-Agent"]).toMatch(
      /^pcgamingwiki-mcp\/1\.2\.3 \(https:\/\/github\.com\/scdemanett\/pcgamingwiki-mcp; test@example\.invalid\) node\//,
    );
    expect(call.url.searchParams.get("maxlag")).toBe("5");
    expect(call.url.searchParams.get("format")).toBe("json");
    expect(call.url.searchParams.get("formatversion")).toBe("2");
  });

  it("serves repeat GETs from the cache until the TTL passes", async () => {
    const { http, fetch, clock } = setup([ok]);
    const a = await http.get({ action: "x" });
    const b = await http.get({ action: "x" });
    expect(fetch.calls).toHaveLength(1);
    expect(a.fromCache).toBe(false);
    expect(b.fromCache).toBe(true);
    expect(b.fetchedAt).toBe(a.fetchedAt);
    clock.t += 60_001;
    await http.get({ action: "x" });
    expect(fetch.calls).toHaveLength(2);
  });

  it("on 429 pauses everything for 61 s without retrying", async () => {
    const { http, fetch, clock } = setup([() => json({}, 429)]);
    await expect(http.get({ action: "a" })).rejects.toMatchObject({ code: "rate_limited", details: { retry_after_s: 61 } });
    await expect(http.get({ action: "b" })).rejects.toMatchObject({ code: "rate_limited" });
    expect(fetch.calls).toHaveLength(1);
    clock.t += 61_000;
    await expect(http.get({ action: "c" })).rejects.toMatchObject({ code: "rate_limited" });
    expect(fetch.calls).toHaveLength(2);
  });

  it("on 403 returns forbidden and sends nothing else this session", async () => {
    const { http, fetch } = setup([html(403, "<html>Forbidden</html>")]);
    await expect(http.get({ action: "a" })).rejects.toMatchObject({ code: "forbidden" });
    await expect(http.get({ action: "b" })).rejects.toMatchObject({ code: "forbidden" });
    expect(fetch.calls).toHaveLength(1);
  });

  it("detects a Cloudflare challenge page and stops", async () => {
    const { http, fetch } = setup([html(403, "<title>Just a moment...</title><script src=/cdn-cgi/challenge-platform/x>")]);
    await expect(http.get({ action: "a" })).rejects.toMatchObject({ code: "blocked_by_cloudflare" });
    await expect(http.get({ action: "b" })).rejects.toMatchObject({ code: "blocked_by_cloudflare" });
    expect(fetch.calls).toHaveLength(1);
  });

  it("detects the cf-mitigated header even on a 200", async () => {
    const { http } = setup([html(200, "<html></html>", { "cf-mitigated": "challenge" })]);
    await expect(http.get({ action: "a" })).rejects.toMatchObject({ code: "blocked_by_cloudflare" });
  });

  it("maps API errors inside HTTP 200 bodies and does not cache them", async () => {
    const { http, fetch } = setup([() => json({ error: { code: "permissiondenied", info: "You don't have permission to run arbitrary Cargo queries." } })]);
    await expect(http.get({ action: "cargoquery" })).rejects.toMatchObject({ code: "auth_required", details: { api_code: "permissiondenied" } });
    await expect(http.get({ action: "cargoquery" })).rejects.toMatchObject({ code: "auth_required" });
    expect(fetch.calls).toHaveLength(2);
  });

  it("maps missingtitle to not_found", async () => {
    const { http } = setup([() => json({ error: { code: "missingtitle", info: "The page you specified doesn't exist." } })]);
    await expect(http.get({ action: "parse", page: "elden ring" })).rejects.toMatchObject({ code: "not_found" });
  });

  it("retries once on maxlag after Retry-After, capped", async () => {
    let n = 0;
    const { http, fetch, clock } = setup([() => (n++ === 0 ? json({ error: { code: "maxlag", info: "lagged" } }, 200, { "retry-after": "3" }) : json({ ok: 1 }))]);
    const t0 = clock.t;
    await expect(http.get({ action: "x" })).resolves.toMatchObject({ body: { ok: 1 } });
    expect(fetch.calls).toHaveLength(2);
    expect(clock.t - t0).toBe(3000);
  });

  it("gives up after a second maxlag", async () => {
    const { http, fetch } = setup([() => json({ error: { code: "maxlag", info: "lagged" } }, 200, { "retry-after": "60" })]);
    await expect(http.get({ action: "x" })).rejects.toMatchObject({ code: "upstream_error", details: { api_code: "maxlag" } });
    expect(fetch.calls).toHaveLength(2);
  });

  it("treats non-JSON 200s and 5xx as upstream_error without blocking", async () => {
    let n = 0;
    const { http } = setup([() => (n++ === 0 ? new Response("<html>oops</html>", { headers: { "content-type": "text/html" } }) : json({}, 502))]);
    await expect(http.get({ action: "a" })).rejects.toMatchObject({ code: "upstream_error" });
    await expect(http.get({ action: "b" })).rejects.toMatchObject({ code: "upstream_error", details: { status: 502 } });
  });
});
