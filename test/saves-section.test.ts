import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { createApi } from "../src/server.js";
import type { ToolContext } from "../src/tools/context.js";
import { getGame } from "../src/tools/get_game.js";
import { getSaveLocationsTool } from "../src/tools/get_save_locations.js";
import { MAX_SECTION_CHARS, getSection } from "../src/tools/get_section.js";
import { renderPathToken } from "../src/wikitext/paths.js";
import { type Route, fakeFetch, fixture, fixtureRoutes, json, manualClock, testEnv } from "./fake-fetch.js";

/**
 * Prefix-search answers for titles we only have parse recordings for. SYNTHETIC but
 * shaped like the recorded prefixsearch responses, with real titles and page IDs.
 */
const syntheticSearch: Route = (u) => {
  if (u.searchParams.get("generator") !== "prefixsearch") return;
  const pages: Record<string, [number, string]> = {
    "half-life": [467, "Half-Life"],
    "the elder scrolls v: skyrim special edition": [33359, "The Elder Scrolls V: Skyrim Special Edition"],
    "stardew valley": [31535, "Stardew Valley"],
  };
  const hit = pages[u.searchParams.get("gpssearch")!.toLowerCase()];
  if (!hit) return;
  return json({
    batchcomplete: true,
    query: { pages: [{ pageid: hit[0], ns: 0, title: hit[1], index: 1, fullurl: `https://www.pcgamingwiki.com/wiki/${hit[1].replace(/ /g, "_")}` }] },
  });
};

const parseSkyrim: Route = (u) =>
  u.searchParams.get("page") === "The Elder Scrolls V: Skyrim Special Edition" ? json(fixture("parse-skyrim-se")) : undefined;

function anon(extra: Route[] = []) {
  const clock = manualClock();
  const fetch = fakeFetch([...extra, syntheticSearch, parseSkyrim, ...fixtureRoutes]);
  const ctx: ToolContext = { api: createApi(loadConfig(testEnv()), { fetch, clock }), now: () => new Date(clock.now()) };
  return { ctx, fetch };
}

describe("path tokens", () => {
  it.each([
    ["appdata", "%APPDATA%"],
    ["USERPROFILE\\Documents", "%USERPROFILE%\\Documents"],
    ["userprofile\\appdata\\locallow", "%USERPROFILE%\\AppData\\LocalLow"],
    ["osxhome", "$HOME"],
    ["xdgconfighome", "$XDG_CONFIG_HOME"],
    ["game", "<path-to-game>"],
    ["hkcu", "HKEY_CURRENT_USER"],
    ["nonsense", "{{p|nonsense}}"],
  ])("%s → %s (as Module:Cargo/gamePaths stores it)", (token, rendered) => {
    expect(renderPathToken(token)).toBe(rendered);
  });
});

describe("get_save_locations (wikitext mode)", () => {
  it("renders paths the way Cargo stores them and keeps the token segments (Elden Ring)", async () => {
    const { ctx } = anon();
    const env = await getSaveLocationsTool(ctx, { title: "Elden Ring" });
    expect(env.mode).toBe("wikitext");
    expect(env.data.platforms_available).toEqual(["Windows"]);
    expect(env.data.platforms.Windows!.saves).toEqual([
      {
        path: "%APPDATA%\\EldenRing\\<user-id>\\",
        wikitext: "{{p|appdata}}\\EldenRing\\{{p|uid}}\\",
        segments: [{ token: "appdata" }, { text: "\\EldenRing\\" }, { token: "uid" }, { text: "\\" }],
      },
    ]);
    expect(env.data.platforms.Windows!.config[0]!.path).toBe("%APPDATA%\\EldenRing\\GraphicsConfig.xml");
    expect(env.data.cloud).toEqual({ steam: { value: "true" } });
    expect(env.data.wikitext).toBeUndefined();
    expect(env.source).toMatchObject({ title: "Elden Ring", page_id: 146683 });
  });

  it("groups several platforms, registry paths, notes and the XDG flag (Half-Life)", async () => {
    const { ctx } = anon();
    const d = (await getSaveLocationsTool(ctx, { title: "half-life" })).data;
    expect(Object.keys(d.platforms)).toEqual(["Windows", "Steam", "OS X", "Linux"]);
    expect(d.platforms.Windows!.config[0]!.path).toBe("HKEY_CURRENT_USER\\Software\\Valve\\Half-Life\\");
    expect(d.platforms.Linux!.saves[0]!.path).toBe("<path-to-game>/valve/SAVE/");
    expect(d.platforms.Steam).toEqual({ saves: [], config: [expect.objectContaining({ path: "<path-to-game>/valve/*.cfg" })] });
    expect(d.xdg).toBe(false);
    expect(d.notes?.[0]?.text).toBe("config.cfg is the main configuration file.");
  });

  it("keeps stores with no path, and maps cloud keys to client names (Skyrim SE)", async () => {
    const { ctx } = anon();
    const d = (await getSaveLocationsTool(ctx, { title: "The Elder Scrolls V: Skyrim Special Edition" })).data;
    expect(d.platforms["Microsoft Store"]).toEqual({ saves: [], config: [] });
    expect(d.platforms.Steam!.saves[0]!.path).toBe("%USERPROFILE%\\Documents\\My Games\\Skyrim Special Edition\\Saves\\");
    expect(d.cloud).toEqual({
      epic_games_launcher: { value: "true" },
      gog_galaxy: { value: "true", notes: "Syncs up to 700 MB of saves online." },
      steam: { value: "true", notes: "Syncs up to 953.67 MB of saves online." },
      xbox: { value: "false" },
    });
  });

  it.each([
    ["mac", ["OS X"]],
    ["LINUX", ["Linux"]],
    ["windows", ["Windows"]],
    ["ps5", []],
  ])("filters platform %s → %j, still listing all platforms", async (platform, keys) => {
    const { ctx } = anon();
    const d = (await getSaveLocationsTool(ctx, { gog_id: 1453375253, platform })).data;
    expect(Object.keys(d.platforms)).toEqual(keys);
    expect(d.platforms_available).toEqual(["Windows", "OS X", "Linux"]);
  });

  it("matches store aliases (gog → GOG.com)", async () => {
    const { ctx } = anon();
    const d = (await getSaveLocationsTool(ctx, { title: "The Elder Scrolls V: Skyrim Special Edition", platform: "gog" })).data;
    expect(Object.keys(d.platforms)).toEqual(["GOG.com"]);
  });

  it("returns the section's wikitext with raw: true", async () => {
    const { ctx } = anon();
    const d = (await getSaveLocationsTool(ctx, { title: "Stardew Valley", raw: true })).data;
    expect(d.wikitext).toMatch(/^\{\{Image\|Stardew Valley General Settings\.png/);
    expect(d.wikitext).toContain("{{Game data/saves|Linux|{{p|xdgconfighome}}/StardewValley/Saves/}}");
    expect(d.wikitext).not.toContain("==Video==");
  });

  it("shares cached calls with get_game", async () => {
    const { ctx, fetch } = anon();
    await getGame(ctx, { steam_appid: 1245620 });
    await getSaveLocationsTool(ctx, { steam_appid: 1245620 });
    expect(fetch.calls.map((c) => c.url.searchParams.get("action"))).toEqual(["idlookup", "parse"]);
  });
});

/**
 * Cargo mode, on SYNTHETIC responses (no bot password to record with yet). The path
 * strings match what wikitext mode renders for the same article, which is the point:
 * both modes should return identical paths.
 */
describe("get_save_locations (Cargo mode, synthetic responses)", () => {
  function cargo() {
    const clock = manualClock();
    const fetch = fakeFetch([
      (u) => (u.searchParams.get("meta") === "tokens" ? json({ query: { tokens: { logintoken: "t" } } }) : undefined),
      (_u, c) => (c.method === "POST" ? json({ login: { result: "Success" } }) : undefined),
      (u) => {
        if (u.searchParams.get("action") !== "cargoquery") return;
        if (u.searchParams.get("tables") === "GameData")
          return json({
            cargoquery: [
              { title: { Type: "Config", Platform: "Windows", Paths: "%APPDATA%\\EldenRing\\GraphicsConfig.xml", PageID: "146683" } },
              { title: { Type: "Saves", Platform: "Windows", Paths: "%APPDATA%\\EldenRing\\<user-id>\\, %APPDATA%\\EldenRing\\Backup\\", PageID: "146683" } },
            ],
          });
        if (u.searchParams.get("tables") === "Cloud") return json({ cargoquery: [{ title: { Steam: "true", "GOG Galaxy": "false", Xbox: "" } }] });
      },
      ...fixtureRoutes,
    ]);
    const ctx: ToolContext = {
      api: createApi(loadConfig({ ...testEnv(), PCGW_BOT_USER: "Tester@mcp", PCGW_BOT_PASSWORD: "pw", PCGW_PREFER_CARGO: "1" }), { fetch, clock }),
      now: () => new Date(clock.now()),
    };
    return { ctx, fetch };
  }

  it("groups GameData rows, splits path lists and reads Cloud columns", async () => {
    const { ctx, fetch } = cargo();
    const env = await getSaveLocationsTool(ctx, { title: "elden ring" });
    expect(env.mode).toBe("cargo");
    expect(env.data).toEqual({
      platforms: {
        Windows: {
          config: [{ path: "%APPDATA%\\EldenRing\\GraphicsConfig.xml" }],
          saves: [{ path: "%APPDATA%\\EldenRing\\<user-id>\\" }, { path: "%APPDATA%\\EldenRing\\Backup\\" }],
        },
      },
      platforms_available: ["Windows"],
      cloud: { steam: { value: "true" }, gog_galaxy: { value: "false" } },
    });
    expect(fetch.calls.some((c) => c.url.searchParams.get("action") === "parse")).toBe(false);
    const gd = fetch.calls.find((c) => c.url.searchParams.get("tables") === "GameData")!;
    expect(gd.url.searchParams.get("where")).toBe('GameData._pageName="Elden Ring"');
  });

  it("returns the same path strings as wikitext mode", async () => {
    const cargoEnv = await getSaveLocationsTool(cargo().ctx, { title: "elden ring" });
    const wikiEnv = await getSaveLocationsTool(anon().ctx, { title: "elden ring" });
    expect(wikiEnv.data.platforms.Windows!.config.map((p) => p.path)).toEqual(cargoEnv.data.platforms.Windows!.config.map((p) => p.path));
    expect(wikiEnv.data.platforms.Windows!.saves[0]!.path).toBe(cargoEnv.data.platforms.Windows!.saves[0]!.path);
  });

  it("adds notes and wikitext from the article with raw: true", async () => {
    const { ctx, fetch } = cargo();
    const d = (await getSaveLocationsTool(ctx, { title: "elden ring", raw: true })).data;
    expect(d.wikitext).toContain("{{Game data/saves|Windows|{{p|appdata}}\\EldenRing\\{{p|uid}}\\}}");
    expect(d.notes).toEqual([]);
    expect(fetch.calls.filter((c) => c.url.searchParams.get("action") === "parse")).toHaveLength(1);
  });
});

describe("get_section", () => {
  it("lists headings with indexes when no section is given", async () => {
    const { ctx } = anon();
    const env = await getSection(ctx, { title: "Elden Ring" });
    const data = env.data as { sections: { index: number; level: number; heading: string }[] };
    expect(data.sections[0]).toEqual({ index: 0, level: 0, heading: "(lead)" });
    expect(data.sections).toContainEqual(expect.objectContaining({ level: 2, heading: "Game data" }));
    expect(data.sections).toContainEqual(expect.objectContaining({ level: 3, heading: "Save game cloud syncing" }));
    expect(env.mode).toBe("wikitext");
  });

  it("renders a section and its subsections as text, matching headings in any case", async () => {
    const { ctx } = anon();
    const data = (await getSection(ctx, { title: "half-life", section: "GAME DATA" })).data as { content: string; heading: string; level: number };
    expect(data.heading).toBe("Game data");
    expect(data.level).toBe(2);
    expect(data.content).toContain("### Configuration file(s) location");
    expect(data.content).toContain("- Config (Windows): HKEY_CURRENT_USER\\Software\\Valve\\Half-Life\\");
    expect(data.content).toContain("- Saves (OS X): <path-to-game>/valve/SAVE/");
    expect(data.content).toContain("- config.cfg is the main configuration file.");
    expect(data.content).toContain("- steam cloud: true");
    expect(data.content).not.toContain("{{");
    expect(data.content).not.toContain("# Video");
  });

  it("renders feature tables as key: value (notes) lines", async () => {
    const { ctx } = anon();
    const data = (await getSection(ctx, { title: "Elden Ring", section: "Video" })).data as { content: string };
    expect(data.content).toContain("- widescreen resolution: true (16:9. See Modifications to remove letterboxing.)");
    expect(data.content).toContain("- vsync: always on");
  });

  it("returns wikitext exactly as written, by index", async () => {
    const { ctx } = anon();
    const list = (await getSection(ctx, { title: "Elden Ring" })).data as { sections: { index: number; heading: string }[] };
    const idx = list.sections.find((s) => s.heading === "Game data")!.index;
    const data = (await getSection(ctx, { title: "Elden Ring", section: idx, format: "wikitext" })).data as { content: string };
    expect(data.content.startsWith("===Configuration file(s) location===\n{{Game data|")).toBe(true);
    expect(data.content).toContain("===[[Glossary:Save game cloud syncing|Save game cloud syncing]]===");
    expect(data.content).not.toContain("==Video==");
  });

  it("renders the lead's infobox readably", async () => {
    const { ctx } = anon();
    const data = (await getSection(ctx, { title: "Elden Ring", section: 0 })).data as { content: string; heading: string };
    expect(data.heading).toBe("(lead)");
    expect(data.content).toMatch(/^Infobox game:\n- cover: Elden Ring - cover\.jpg\n- developers: FromSoftware\n/);
  });

  it("returns not_found with the heading list for an unknown section", async () => {
    const { ctx } = anon();
    await expect(getSection(ctx, { title: "Elden Ring", section: "Multiplayer cheats" })).rejects.toMatchObject({
      code: "not_found",
      details: { sections: expect.arrayContaining([expect.objectContaining({ heading: "Video" })]) },
    });
    await expect(getSection(ctx, { title: "Elden Ring", section: 999 })).rejects.toMatchObject({ code: "not_found" });
  });

  it("truncates very long sections and says so", async () => {
    const big = `==Essay==\n${"word ".repeat(MAX_SECTION_CHARS / 2)}`;
    const { ctx } = anon([
      (u) =>
        u.searchParams.get("page") === "Half-Life"
          ? json({ parse: { title: "Half-Life", pageid: 467, wikitext: big } })
          : undefined,
    ]);
    const data = (await getSection(ctx, { title: "half-life", section: "Essay", format: "wikitext" })).data as { content: string; truncated?: boolean };
    expect(data.truncated).toBe(true);
    expect(data.content.length).toBeLessThanOrEqual(MAX_SECTION_CHARS + 2);
  });
});
