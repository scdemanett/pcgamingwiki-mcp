import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { CARGO_TABLES, FEATURE_GROUPS } from "../src/cargo/allowlist.js";
import { type CargoQueryInput, buildCargoQuery } from "../src/cargo/builder.js";
import { matchByName, parseCargoStore } from "../src/cargo/template-columns.js";
import { loadConfig } from "../src/config.js";
import { createApi, createServer } from "../src/server.js";
import type { ToolContext } from "../src/tools/context.js";
import { cargoQuery } from "../src/tools/cargo_query.js";
import { getFeaturesTool } from "../src/tools/get_features.js";
import { type Route, fakeFetch, fixtureRoutes, json, manualClock, testEnv } from "./fake-fetch.js";

const templateSource = (title: string): string => {
  const body = JSON.parse(readFileSync(new URL("./fixtures/templates/feature-templates.json", import.meta.url), "utf8"));
  return body.query.pages.find((p: { title: string }) => p.title === `Template:${title}`).revisions[0].slots.main.content;
};

describe("template → Cargo column mapping", () => {
  it("reads plain, fallback and #var columns from #cargo_store (Video, Input)", () => {
    const video = parseCargoStore(templateSource("Video"))!;
    expect(video.table).toBe("Video");
    expect(video.columns).toMatchObject({ Field_of_view: "fov", Borderless_fullscreen_windowed: "borderless windowed", Upscaling: "upscaling tech", "4K_Ultra_HD": "4k ultra hd" });
    const input = parseCargoStore(templateSource("Input"))!;
    expect(Object.keys(input.columns).length).toBeGreaterThan(50);
    expect(input.columns).toMatchObject({ Playstation_controller_support: "playstation controllers", Controller_support_level: null });
  });

  it("falls back to name matching when a template has no #cargo_store (Middleware)", () => {
    expect(parseCargoStore(templateSource("Middleware"))).toBeUndefined();
    expect(matchByName(templateSource("Middleware"), "Middleware", ["Physics", "Removed_Physics"]).columns).toEqual({ Physics: "physics", Removed_Physics: null });
  });

  it("generated allowlist: every feature column exists, internal tables excluded", () => {
    for (const g of Object.values(FEATURE_GROUPS)) for (const c of Object.keys(g.columns)) expect(CARGO_TABLES[g.table]![c], `${g.table}.${c}`).toBeDefined();
    expect(Object.keys(CARGO_TABLES).some((t) => t.startsWith("PCGW_") || t.startsWith("_"))).toBe(false);
    expect(CARGO_TABLES.Game!.Steam_AppID).toEqual({ type: "String", list: "," });
  });
});

describe("buildCargoQuery()", () => {
  const ok = (q: CargoQueryInput) => buildCargoQuery(q).params;
  const bad = (q: CargoQueryInput) => expect(() => buildCargoQuery(q)).toThrow(expect.objectContaining({ code: "invalid_query" }));

  it("qualifies fields, adds the page alias and a default limit", () => {
    expect(ok({ tables: "game", fields: ["Developers", "Game.Released=Date"], where: 'Steam_AppID HOLDS "1245620"' })).toEqual({
      tables: "Game",
      fields: "Game.Developers=Developers,Game.Released=Date,Game._pageName=PCGWPage",
      where: 'Game.Steam_AppID HOLDS "1245620"',
      limit: 20,
    });
  });

  it("aliases fields that start with a digit or underscore", () => {
    expect(ok({ tables: "Video", fields: "4K_Ultra_HD,_pageID" }).fields).toBe("Video.4K_Ultra_HD=f_4K_Ultra_HD,Video._pageID=pageID,Video._pageName=PCGWPage");
  });

  it("joins two tables on a validated join_on", () => {
    expect(
      ok({ tables: ["Game", "GameData"], fields: ["Game._pageName=Title", "GameData.Paths"], join_on: "game._pageID = gamedata._pageID", where: 'GameData.Platform = "Linux"', limit: 50 }),
    ).toMatchObject({ tables: "Game,GameData", join_on: "Game._pageID=GameData._pageID", where: 'GameData.Platform = "Linux"', limit: 50 });
  });

  it("rebuilds where from tokens: canonical names, double-quoted strings, keywords upper-cased", () => {
    expect(ok({ tables: "Game", fields: "Genres", where: "genres holds 'RPG' and (released >= '2020' or Series IS NOT NULL)" }).where).toBe(
      'Game.Genres HOLDS "RPG" AND (Game.Released >= "2020" OR Game.Series IS NOT NULL)',
    );
    expect(ok({ tables: "Game", fields: "Genres", where: 'Developers HOLDS "a\\"b"' }).where).toBe('Game.Developers HOLDS "a\\"b"');
    expect(ok({ tables: "Game", fields: "Genres", where: "Steam_AppID HOLDS LIKE \"12%\"" }).where).toBe('Game.Steam_AppID HOLDS LIKE "12%"');
  });

  it("reads columns that start with digits as fields, not numbers", () => {
    expect(ok({ tables: "Video", fields: "120_FPS", where: '120_FPS = "false" OR 60_FPS != "true" AND 4K_Ultra_HD = "hackable"' }).where).toBe(
      'Video.120_FPS = "false" OR Video.60_FPS != "true" AND Video.4K_Ultra_HD = "hackable"',
    );
    expect(ok({ tables: "Game", fields: "Developers", where: "Steam_AppID > 1200 AND Steam_AppID < 12.5" }).where).toBe("Game.Steam_AppID > 1200 AND Game.Steam_AppID < 12.5");
  });

  it.each([
    ['Steam_AppID HOLDS "1"; DROP TABLE Game', "semicolon"],
    ['Steam_AppID HOLDS "1" -- comment', "line comment"],
    ['Steam_AppID HOLDS "1" /* x */', "block comment"],
    ['Steam_AppID HOLDS "1" # x', "hash comment"],
    ["`Game`.Steam_AppID = 1", "backtick"],
    ['Steam_AppID IN (SELECT _pageName FROM PCGW_Users)', "subquery"],
    ['Steam_AppID HOLDS "1" UNION SELECT 1', "union"],
    ["LOWER(Developers) = \"x\"", "function call"],
    ["Developers(1)", "field called like a function"],
    ["SLEEP(5) = 0", "sleep"],
    ["1 = 1", "no field"],
    ['Developers = "x" AND ((((((Genres = "y"))))))', "too deep"],
    ['(Developers = "x"', "unbalanced ("],
    ['Developers = "x")', "unbalanced )"],
    ['Developers = "unterminated', "unterminated string"],
    ['Developers = "a\nb"', "newline in string"],
    ["Developers = @x", "odd character"],
    ["PCGW_Users.name = 'x'", "other table"],
    ["Game.Password = 'x'", "unknown field"],
    ['Developers = "' + "x".repeat(600) + '"', "too long"],
  ])("rejects where %j (%s)", (where) => bad({ tables: "Game", fields: "Developers", where }));

  it("rejects tables, fields and options outside the rules", () => {
    bad({ tables: "PCGW_Users", fields: "x" });
    bad({ tables: "_pageData", fields: "x" });
    bad({ tables: "Game,GameData,Cloud", fields: "Game.Developers" });
    bad({ tables: "Game,Game", fields: "Developers" });
    bad({ tables: "Game=G", fields: "Developers" });
    bad({ tables: "Game", fields: [] });
    bad({ tables: "Game", fields: "Developers=bad alias" });
    bad({ tables: "Game", fields: "Developers=PCGWPage" });
    bad({ tables: "Game", fields: "Developers,Publishers=Developers" });
    bad({ tables: "Game", fields: "COUNT(*)" });
    bad({ tables: ["Game", "GameData"], fields: "Game.Developers" }); // no join_on
    bad({ tables: ["Game", "GameData"], fields: "_pageID", join_on: "Game._pageID=GameData._pageID" }); // ambiguous
    bad({ tables: ["Game", "GameData"], fields: "Paths", join_on: "Game._pageID=Game._pageName" });
    bad({ tables: "Game", fields: "Developers", join_on: "Game._pageID=GameData._pageID" });
    bad({ tables: "Game", fields: "Developers", limit: 51 });
    bad({ tables: "Game", fields: "Developers", limit: 0 });
    bad({ tables: "Game", fields: "Developers", order_by: "Released DESC, Genres, Series, Modes" });
    bad({ tables: "Game", fields: "Developers", order_by: "Released; DROP" });
  });

  it("names the bad field and lists what's allowed", () => {
    try {
      buildCargoQuery({ tables: "Audio", fields: "Volume" });
      expect.unreachable();
    } catch (e) {
      expect(e).toMatchObject({ code: "invalid_query", details: { ref: "Volume", allowed: expect.arrayContaining(["Subtitles", "_pageName"]) } });
    }
  });
});

describe("get_features (wikitext mode)", () => {
  function anon() {
    const clock = manualClock();
    const fetch = fakeFetch(fixtureRoutes);
    return { ctx: { api: createApi(loadConfig(testEnv()), { fetch, clock }), now: () => new Date(clock.now()) } satisfies ToolContext, fetch };
  }

  it("keys values by template parameter and keeps notes (Elden Ring video)", async () => {
    const env = await getFeaturesTool(anon().ctx, { title: "Elden Ring", groups: ["video"] });
    expect(env.mode).toBe("wikitext");
    expect(Object.keys(env.data)).toEqual(["video"]);
    expect(env.data.video).toMatchObject({
      widescreen_resolution: { value: "true", notes: "16:9. See Modifications to remove letterboxing." },
      fov: { value: "hackable", notes: "See Modifications." },
      "4k_ultra_hd": { value: "true" },
      "60_fps": { value: "true" },
      upscaling: { value: "false" },
    });
    expect(env.data.video!.wsgf_link).toBeUndefined(); // empty on the page
  });

  it("returns every group by default, null where the article has no table (Stardew Valley)", async () => {
    const { ctx, fetch } = anon();
    const env = await getFeaturesTool(ctx, { gog_id: 1453375253 });
    expect(Object.keys(env.data)).toEqual(["video", "input", "audio", "api", "middleware", "vr", "multiplayer"]);
    expect(env.data.middleware).toBeNull();
    expect(env.data.vr).toBeNull();
    expect(Object.keys(env.data.multiplayer!).length).toBeGreaterThan(0);
    expect(fetch.calls).toHaveLength(2); // idlookup + parse, whatever the number of groups
  });
});

/** Cargo mode, on SYNTHETIC responses (no bot password to record with yet). */
describe("Cargo mode (synthetic responses)", () => {
  function cargo(extra: Route[] = []) {
    const clock = manualClock();
    const fetch = fakeFetch([
      (u) => (u.searchParams.get("meta") === "tokens" ? json({ query: { tokens: { logintoken: "t" } } }) : undefined),
      (_u, c) => (c.method === "POST" ? json({ login: { result: "Success" } }) : undefined),
      ...extra,
      ...fixtureRoutes,
    ]);
    const cfg = loadConfig({ ...testEnv(), PCGW_BOT_USER: "Tester@mcp", PCGW_BOT_PASSWORD: "pw", PCGW_PREFER_CARGO: "1" });
    return { ctx: { api: createApi(cfg, { fetch, clock }), now: () => new Date(clock.now()) } satisfies ToolContext, fetch, cfg };
  }
  const cargoCalls = (fetch: { calls: { url: URL }[] }) => fetch.calls.filter((c) => c.url.searchParams.get("action") === "cargoquery");

  it("cargo_query returns digit-leading fields under their real names", async () => {
    // Row shape as PCGW returned it live on 24 Nov 2026.
    const { ctx, fetch } = cargo([
      (u) =>
        u.searchParams.get("action") === "cargoquery"
          ? json({ cargoquery: [{ title: { Game: "007 Legends", f_60_FPS: "true", f_120_FPS: "false", PCGWPage: "007 Legends" } }] })
          : undefined,
    ]);
    const env = await cargoQuery(ctx, { tables: "Video", fields: "_pageName=Game, 60_FPS, 120_FPS", where: '120_FPS = "false"' });
    expect(cargoCalls(fetch)[0]!.url.searchParams.get("fields")).toBe("Video._pageName=Game,Video.60_FPS=f_60_FPS,Video.120_FPS=f_120_FPS,Video._pageName=PCGWPage");
    expect(env.data.rows[0]).toMatchObject({ page: "007 Legends", fields: { Game: "007 Legends", "60_FPS": "true", "120_FPS": "false" } });
  });

  it("get_features maps aliased columns back to template parameter names, one call per group", async () => {
    const cols = Object.keys(FEATURE_GROUPS.video.columns);
    const at = (c: string) => `f${cols.indexOf(c)}`;
    const { ctx, fetch } = cargo([
      (u) => {
        if (u.searchParams.get("action") !== "cargoquery") return;
        if (u.searchParams.get("tables") === "Video")
          return json({ cargoquery: [{ title: { [at("Field_of_view")]: "hackable", [at("4K_Ultra_HD")]: "true", [at("Upscaling")]: "DLSS,FSR 2", [at("HDR")]: "", PageID: "146683" } }] });
        return json({ cargoquery: [] });
      },
    ]);
    const env = await getFeaturesTool(ctx, { title: "elden ring", groups: ["video", "vr"] });
    expect(env.mode).toBe("cargo");
    expect(env.data).toEqual({ video: { fov: { value: "hackable" }, "4k_ultra_hd": { value: "true" }, upscaling_tech: { value: "DLSS,FSR 2" } }, vr: null });
    expect(env.source.page_id).toBe(146683);
    const calls = cargoCalls(fetch);
    expect(calls.map((c) => c.url.searchParams.get("tables"))).toEqual(["Video", "VR"]);
    expect(calls[0]!.url.searchParams.get("fields")).toMatch(/^Video\.WSGF_Link=f0,.*Video\._pageID=PageID$/);
  });

  it("cargo_query runs the validated query and attaches page URLs", async () => {
    const { ctx, fetch } = cargo([
      (u) =>
        u.searchParams.get("action") === "cargoquery"
          ? json({ cargoquery: [{ title: { Developers: "Company:FromSoftware", Date: "2022-02-25", PCGWPage: "Elden Ring" } }] })
          : undefined,
    ]);
    const env = await cargoQuery(ctx, { tables: "Game", fields: ["Developers", "Released=Date"], where: 'Genres HOLDS "RPG"', order_by: "Released DESC", limit: 5 });
    expect(env.mode).toBe("cargo");
    expect(env.data.rows).toEqual([
      {
        page: "Elden Ring",
        url: "https://www.pcgamingwiki.com/wiki/Elden_Ring",
        history_url: "https://www.pcgamingwiki.com/w/index.php?title=Elden_Ring&action=history",
        fields: { Developers: "Company:FromSoftware", Date: "2022-02-25" },
      },
    ]);
    const q = cargoCalls(fetch)[0]!.url.searchParams;
    expect(q.get("where")).toBe('Game.Genres HOLDS "RPG"');
    expect(q.get("order_by")).toBe("Game.Released DESC");
    expect(q.get("limit")).toBe("5");
    expect(env.source.url).toMatch(/^https:\/\/www\.pcgamingwiki\.com\/wiki\/Special:CargoQuery\?tables=Game&/);
    expect(env.license).toBe("CC BY-NC-SA 3.0");
  });

  it("cargo_query sends nothing when validation fails", async () => {
    const { ctx, fetch } = cargo();
    await expect(cargoQuery(ctx, { tables: "Game", fields: "Developers", where: "1=1; DROP TABLE Game" })).rejects.toMatchObject({ code: "invalid_query" });
    expect(fetch.calls).toHaveLength(0);
  });

  it("lists cargo_query with a bot password too", async () => {
    const { cfg } = cargo();
    const server = createServer(cfg, { fetch: fakeFetch([]), clock: manualClock() });
    const client = new Client({ name: "t", version: "0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain("cargo_query");
    expect(names).toHaveLength(7);
  });
});

