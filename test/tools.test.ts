import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { resolveRef } from "../src/resolve.js";
import { createApi, createServer } from "../src/server.js";
import type { ToolContext } from "../src/tools/context.js";
import { getGame } from "../src/tools/get_game.js";
import { resolveGame } from "../src/tools/resolve_game.js";
import { searchGames } from "../src/tools/search_games.js";
import { type Route, fakeFetch, fixtureRoutes, json, manualClock } from "./fake-fetch.js";

function anon(extra: Route[] = []) {
  const clock = manualClock();
  const fetch = fakeFetch([...extra, ...fixtureRoutes]);
  const api = createApi(loadConfig({}), { fetch, clock });
  const ctx: ToolContext = { api, now: () => new Date(clock.now()) };
  return { ctx, fetch };
}

const actions = (calls: { url: URL }[]) => calls.map((c) => c.url.searchParams.get("generator") ?? c.url.searchParams.get("action"));

describe("search_games", () => {
  it("returns titles, page IDs and URLs in one call, with attribution", async () => {
    const { ctx, fetch } = anon();
    const env = await searchGames(ctx, { query: "elden ring", limit: 10 });
    expect(env.data.results.map((r) => [r.title, r.page_id])).toEqual([
      ["Elden Ring", 146683],
      ["Elden Ring Nightreign", 200143],
    ]);
    expect(env.data.results[0]!.history_url).toBe("https://www.pcgamingwiki.com/w/index.php?title=Elden_Ring&action=history");
    expect(env.license).toBe("CC BY-NC-SA 3.0");
    expect(env.attribution).toMatch(/^Data from PCGamingWiki contributors, CC BY-NC-SA 3\.0: https:\/\/www\.pcgamingwiki\.com\//);
    expect(fetch.calls).toHaveLength(1);
  });

  it("reports which redirect matched", async () => {
    const { ctx } = anon();
    const env = await searchGames(ctx, { query: "skyrim" });
    expect(env.data.results[1]).toMatchObject({ title: "The Elder Scrolls V: Skyrim Special Edition", redirect_from: "Skyrim Special Edition" });
  });
});

describe("resolving game refs", () => {
  it("matches a title case-insensitively, or through a redirect", async () => {
    const { ctx } = anon();
    expect(await resolveRef(ctx.api, { title: "ELDEN RING" })).toEqual({ kind: "one", title: "Elden Ring", page_id: 146683, via: "title" });
    expect(await resolveRef(ctx.api, { title: "skyrim" })).toMatchObject({ kind: "one", title: "The Elder Scrolls V: Skyrim", page_id: 121 });
  });

  it("returns not_found with suggestions when only prefixes match", async () => {
    const { ctx } = anon();
    await expect(resolveRef(ctx.api, { title: "Elden" })).rejects.toMatchObject({ code: "not_found" });
  });

  it("requires exactly one ref", async () => {
    const { ctx, fetch } = anon();
    await expect(resolveRef(ctx.api, {})).rejects.toMatchObject({ code: "invalid_input" });
    await expect(resolveRef(ctx.api, { title: "x", steam_appid: 1 })).rejects.toMatchObject({ code: "invalid_input" });
    expect(fetch.calls).toHaveLength(0);
  });
});

describe("resolve_game (wikitext mode)", () => {
  it("resolves a title and lists every Steam/GOG ID, in 2 calls", async () => {
    const { ctx, fetch } = anon();
    const env = await resolveGame(ctx, { title: "elden ring" });
    expect(env.mode).toBe("wikitext");
    expect(env.data).toEqual({
      ambiguous: false,
      title: "Elden Ring",
      page_id: 146683,
      url: "https://www.pcgamingwiki.com/wiki/Elden_Ring",
      history_url: "https://www.pcgamingwiki.com/w/index.php?title=Elden_Ring&action=history",
      steam_appid: ["1245620"],
      steam_appid_side: ["2778580", "2778590"],
      gog_id: [],
      gog_id_side: [],
    });
    expect(env.source).toMatchObject({ title: "Elden Ring", page_id: 146683, url: "https://www.pcgamingwiki.com/wiki/Elden_Ring" });
    expect(actions(fetch.calls)).toEqual(["prefixsearch", "parse"]);
  });

  it("resolves a Steam AppID through idlookup", async () => {
    const { ctx, fetch } = anon();
    const env = await resolveGame(ctx, { steam_appid: "1245620" });
    expect(env.data).toMatchObject({ ambiguous: false, title: "Elden Ring" });
    expect(actions(fetch.calls)).toEqual(["idlookup", "parse"]);
  });

  it("resolves a GOG ID given as a number", async () => {
    const { ctx } = anon();
    const env = await resolveGame(ctx, { gog_id: 1453375253 });
    expect(env.data).toMatchObject({ ambiguous: false, title: "Stardew Valley", gog_id: ["1453375253"], steam_appid: ["413150"] });
  });

  it("resolves a page ID", async () => {
    const { ctx } = anon();
    expect((await resolveGame(ctx, { page_id: 146683 })).data).toMatchObject({ title: "Elden Ring", page_id: 146683 });
  });

  it("returns every page when one store ID matches several", async () => {
    const { ctx, fetch } = anon([
      (u) =>
        u.searchParams.get("value") === "7"
          ? json({ idlookup: [{ title: { Page: "Game" } }, { title: { Page: "Game: Deluxe Edition" } }] })
          : undefined,
    ]);
    const env = await resolveGame(ctx, { steam_appid: 7 });
    expect(env.data).toEqual({
      ambiguous: true,
      candidates: [
        { title: "Game", url: "https://www.pcgamingwiki.com/wiki/Game" },
        { title: "Game: Deluxe Edition", url: "https://www.pcgamingwiki.com/wiki/Game:_Deluxe_Edition" },
      ],
    });
    expect(fetch.calls).toHaveLength(1);
  });

  it("returns not_found for an unknown Steam AppID", async () => {
    const { ctx } = anon();
    await expect(resolveGame(ctx, { steam_appid: 999999999 })).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("get_game (wikitext mode)", () => {
  it("returns typed infobox facts plus availability and languages", async () => {
    const { ctx } = anon();
    const env = await getGame(ctx, { title: "Elden Ring", include: ["availability", "languages"] });
    const g = env.data;
    expect(g.developers).toEqual([{ name: "FromSoftware" }]);
    expect(g.release_dates[0]!.date.iso).toBe("2022-02-25");
    expect(g.taxonomy.modes).toEqual(["Singleplayer", "Multiplayer"]);
    expect(g.reception?.find((r) => r.aggregator === "Metacritic")?.score).toBe("94");
    expect(g.fields.hltb).toBe("68151");
    expect(g.availability?.find((a) => a.store === "Steam")).toEqual({
      store: "Steam",
      id: "1245620",
      drm: ["Steam"],
      notes: "Shadow of the Erdtree Edition and Shadow of the Erdtree Deluxe Edition also available.",
      os: ["Windows"],
      state: "available",
    });
    expect(g.languages?.[0]).toEqual({ language: "English", interface: "true", audio: "true", subtitles: "true" });
    expect(g.languages?.find((l) => l.fan)).toMatchObject({ language: "Arabic", interface: "hackable", fan: true });
  });

  it("leaves availability and languages out unless asked", async () => {
    const { ctx } = anon();
    const env = await getGame(ctx, { steam_appid: 1245620 });
    expect(env.data.availability).toBeUndefined();
    expect(env.data.languages).toBeUndefined();
  });

  it("reuses cached calls across tools", async () => {
    const { ctx, fetch } = anon();
    await resolveGame(ctx, { title: "elden ring" });
    await getGame(ctx, { title: "Elden Ring" });
    await getGame(ctx, { page_id: 146683, include: ["languages"] });
    expect(actions(fetch.calls)).toEqual(["prefixsearch", "parse", "prefixsearch", "query"]);
  });

  it("turns several matches into an ambiguous error", async () => {
    const { ctx } = anon([(u) => (u.searchParams.get("value") === "7" ? json({ idlookup: [{ title: { Page: "A" } }, { title: { Page: "B" } }] }) : undefined)]);
    await expect(getGame(ctx, { steam_appid: 7 })).rejects.toMatchObject({ code: "ambiguous", details: { candidates: [{ title: "A" }, { title: "B" }] } });
  });
});

/**
 * Cargo mode. These responses are SYNTHETIC: we have no bot password yet, so they
 * follow the documented cargoquery format (aliases come back with `_` as spaces).
 * Replace with recordings once a bot password is available.
 */
describe("get_game (Cargo mode, synthetic responses)", () => {
  function cargo() {
    const clock = manualClock();
    const fetch = fakeFetch([
      (u) => (u.searchParams.get("meta") === "tokens" ? json({ query: { tokens: { logintoken: "t" } } }) : undefined),
      (_u, c) => (c.method === "POST" ? json({ login: { result: "Success" } }) : undefined),
      (u) => {
        if (u.searchParams.get("action") !== "cargoquery") return;
        const table = u.searchParams.get("tables");
        if (table === "Game")
          return json({
            cargoquery: [
              {
                title: {
                  Page: "Elden Ring",
                  PageID: "146683",
                  Developers: "Company:FromSoftware",
                  Publishers: "Company:Bandai Namco Entertainment,Company:FromSoftware",
                  Engines: "",
                  "Steam AppID": "1245620,2778580,2778590",
                  "GOGcom ID": "",
                  "Released Windows": "2022-02-25",
                  Genres: "Action,RPG,Open world",
                  "Art styles": "Stylized",
                  Series: "Elden Ring",
                  License: "commercial",
                  Wikipedia: "Elden Ring &amp; more",
                },
              },
            ],
          });
        if (table === "Availability")
          return json({ cargoquery: [{ title: { Present: "Steam,GOG.com", Past: "Origin", Future: "", "Steam DRM": "Steam", "GOGcom DRM": "DRM-free" } }] });
        if (table === "L10n")
          return json({ cargoquery: [{ title: { Language: "English", Interface: "true", Audio: "true", Subtitles: "true", Notes: "[[Foo|Bar]] notes", Status: "" } }] });
      },
      ...fixtureRoutes,
    ]);
    const api = createApi(loadConfig({ PCGW_BOT_USER: "Tester@mcp", PCGW_BOT_PASSWORD: "pw" }), { fetch, clock });
    return { ctx: { api, now: () => new Date(clock.now()) } satisfies ToolContext, fetch };
  }

  it("maps Game columns into the shared shape", async () => {
    const { ctx, fetch } = cargo();
    const env = await getGame(ctx, { title: "elden ring", include: ["availability", "languages"] });
    expect(env.mode).toBe("cargo");
    expect(env.data).toMatchObject({
      title: "Elden Ring",
      page_id: 146683,
      developers: [{ name: "FromSoftware" }],
      publishers: [{ name: "Bandai Namco Entertainment" }, { name: "FromSoftware" }],
      engines: [],
      release_dates: [{ platform: "Windows", date: { raw: "2022-02-25", iso: "2022-02-25" } }],
      taxonomy: { genres: ["Action", "RPG", "Open world"], art_styles: ["Stylized"], series: ["Elden Ring"] },
      steam_appid: ["1245620", "2778580", "2778590"],
      gog_id: [],
      fields: { license: "commercial", wikipedia: "Elden Ring & more" },
      availability: [
        { store: "Steam", drm: ["Steam"], state: "available" },
        { store: "GOG.com", drm: ["DRM-free"], state: "available" },
        { store: "Origin", drm: [], state: "unavailable" },
      ],
      languages: [{ language: "English", interface: "true", audio: "true", subtitles: "true", notes: "Bar notes" }],
    });
    const game = fetch.calls.find((c) => c.url.searchParams.get("tables") === "Game")!;
    expect(game.url.searchParams.get("where")).toBe('Game._pageName="Elden Ring"');
    expect(Number(game.url.searchParams.get("limit"))).toBeLessThanOrEqual(50);
  });

  it("resolves Steam AppIDs with Cargo HOLDS", async () => {
    const { ctx, fetch } = cargo();
    await getGame(ctx, { steam_appid: 1245620 }).catch(() => undefined);
    const first = fetch.calls.find((c) => c.url.searchParams.get("action") === "cargoquery")!;
    expect(first.url.searchParams.get("where")).toBe('Game.Steam_AppID HOLDS "1245620"');
  });
});

describe("MCP server", () => {
  async function connect() {
    const fetch = fakeFetch(fixtureRoutes);
    const server = createServer(loadConfig({}), { fetch, clock: manualClock() });
    const client = new Client({ name: "test", version: "0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    return client;
  }

  it("lists the five read-only tools", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["get_game", "get_save_locations", "get_section", "resolve_game", "search_games"]);
    for (const t of tools) expect(t.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: true });
  });

  it("returns the envelope as JSON text", async () => {
    const client = await connect();
    const res = await client.callTool({ name: "get_game", arguments: { title: "elden ring" } });
    expect(res.isError).toBeFalsy();
    const env = JSON.parse((res.content as { text: string }[])[0]!.text);
    expect(env).toMatchObject({ mode: "wikitext", license: "CC BY-NC-SA 3.0", source: { title: "Elden Ring" }, data: { title: "Elden Ring" } });
  });

  it("returns errors as isError results with a code", async () => {
    const client = await connect();
    const res = await client.callTool({ name: "resolve_game", arguments: { title: "x", page_id: 1 } });
    expect(res.isError).toBe(true);
    expect(JSON.parse((res.content as { text: string }[])[0]!.text)).toMatchObject({ error: { code: "invalid_input" } });
  });
});
