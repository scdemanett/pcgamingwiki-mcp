import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type Template, named, parse, positional, renderTextOf, toWikitext } from "./helpers.js";
import {
  extractFeatureTable,
  extractGameData,
  extractInfobox,
  parseDate,
  sectionWithChildren,
  splitSections,
} from "../src/wikitext/templates.js";

const FIXTURES = ["elden-ring", "skyrim-se", "half-life", "minecraft-java", "stardew-valley"] as const;
const wikitext = (name: string): string =>
  JSON.parse(readFileSync(new URL(`./fixtures/spike/parse-${name}.json`, import.meta.url), "utf8")).parse.wikitext;
const gameData = (name: string) => extractGameData(sectionWithChildren(splitSections(wikitext(name)), "Game data")!);

describe("parse()", () => {
  it.each(FIXTURES)("round-trips %s exactly", (name) => {
    const w = wikitext(name);
    expect(toWikitext(parse(w))).toBe(w);
  });

  it("does not split template args on | inside links, refs or nested templates", () => {
    const [t] = parse("{{T|a [[x|y]] b|<ref>{{R|u=1|v}}</ref>|{{N|p|q}}}}") as [Template];
    expect(positional(t)).toHaveLength(3);
  });

  it("names an arg by the first top-level = only", () => {
    const [t] = parse("{{T|url=https://x.test/?a=b|{{N|k=v}}}}") as [Template];
    expect(renderTextOf(named(t, "url"))).toBe("https://x.test/?a=b");
    expect(positional(t)).toHaveLength(1);
  });

  it("treats unclosed templates and links as text", () => {
    expect(parse("a {{T|b")).toEqual(["a {{T|b"]);
    expect(parse("a [[b|c")).toEqual(["a [[b|c"]);
  });

  it("normalizes template names (case of first letter, underscores)", () => {
    const [t] = parse("{{infobox_game}}") as [Template];
    expect(t.name).toBe("Infobox game");
  });
});

describe("extractGameData()", () => {
  it("reads multi-platform rows with {{P|…}} tokens (Half-Life)", () => {
    const gd = gameData("half-life");
    expect(gd.rows.map((r) => `${r.type}:${r.platform}`)).toEqual([
      "config:Windows",
      "config:Steam",
      "saves:Windows",
      "saves:OS X",
      "saves:Linux",
    ]);
    expect(gd.rows[0]!.paths[0]!.segments).toEqual([{ token: "hkcu" }, { text: "\\Software\\Valve\\Half-Life\\" }]);
    expect(gd.xdg).toBe(false);
    expect(gd.notes[0]).toEqual({ section: "Configuration file(s) location", text: "config.cfg is the main configuration file." });
  });

  it("keeps several tokens in one path (Elden Ring)", () => {
    const saves = gameData("elden-ring").rows.find((r) => r.type === "saves")!;
    expect(saves.paths[0]!.wikitext).toBe("{{p|appdata}}\\EldenRing\\{{p|uid}}\\");
    expect(saves.paths[0]!.segments.filter((s) => "token" in s)).toEqual([{ token: "appdata" }, { token: "uid" }]);
  });

  it("keeps store-specific rows, with an empty path list when the article has none (Skyrim SE)", () => {
    const rows = gameData("skyrim-se").rows.filter((r) => r.type === "saves");
    expect(rows.map((r) => r.platform)).toEqual(["GOG.com", "Microsoft Store", "Steam"]);
    expect(rows[1]!.paths).toEqual([]);
    expect(rows[0]!.paths[0]!.segments[0]).toEqual({ token: "userprofile\\documents" });
  });

  it("drops <ref> content from notes but keeps the sentence (Skyrim SE)", () => {
    const [note] = gameData("skyrim-se").notes;
    expect(note!.text).toBe(
      "Save data from the original game can be copied and used with Special Edition; however, save files that are using mods may not work.",
    );
  });

  it("reads XDG flag and lead-in notes (Stardew Valley)", () => {
    const gd = gameData("stardew-valley");
    expect(gd.xdg).toBe(true);
    expect(gd.rows.find((r) => r.type === "saves" && r.platform === "Linux")!.paths[0]!.wikitext).toBe(
      "{{p|xdgconfighome}}/StardewValley/Saves/",
    );
  });
});

describe("extractInfobox()", () => {
  it("splits rows, taxonomy and ID lists (Elden Ring)", () => {
    const ib = extractInfobox(parse(wikitext("elden-ring")))!;
    expect(ib.developers).toEqual([{ name: "FromSoftware" }]);
    expect(ib.publishers).toEqual([{ name: "Bandai Namco Entertainment" }, { name: "FromSoftware", note: "Japan" }]);
    expect(ib.release_dates).toEqual([{ platform: "Windows", date: { raw: "February 25, 2022", iso: "2022-02-25" } }]);
    expect(ib.steam_appid).toEqual(["1245620"]);
    expect(ib.steam_appid_side).toEqual(["2778580", "2778590"]);
    expect(ib.taxonomy.genres).toEqual(["Action", "RPG", "Open world"]);
    expect(ib.taxonomy.sports).toBeUndefined();
  });

  it("handles several platforms and engines (Minecraft: Java Edition)", () => {
    const ib = extractInfobox(parse(wikitext("minecraft-java")))!;
    expect(ib.engines.map((e) => e.name)).toEqual(["LWJGL", "Java"]);
    expect(ib.release_dates.map((r) => r.platform)).toEqual(["Windows", "OS X", "Linux"]);
    expect(ib.steam_appid).toEqual([]);
  });
});

describe("extractFeatureTable()", () => {
  it("pairs values with notes and drops empty fields", () => {
    const cloud = extractFeatureTable(parse(wikitext("skyrim-se")), "Save game cloud syncing")!;
    expect(cloud.steam_cloud).toEqual({ value: "true", notes: "Syncs up to 953.67 MB of saves online." });
    expect(cloud.origin).toBeUndefined();
  });

  it("renders links in notes as their label", () => {
    const video = extractFeatureTable(parse(wikitext("elden-ring")), "Video")!;
    expect(video.widescreen_resolution).toEqual({ value: "true", notes: "16:9. See Modifications to remove letterboxing." });
  });
});

describe("parseDate()", () => {
  it.each([
    ["February 25, 2022", "2022-02-25"],
    ["July 2016", "2016-07"],
    ["1998", "1998"],
    ["TBA", undefined],
  ])("%s → %s", (raw, iso) => {
    expect(parseDate(raw).iso).toBe(iso);
  });
});

describe("extractAvailability() and extractLanguages()", () => {
  it("reads DRM, OS, store-link labels and unavailable rows (Skyrim SE)", async () => {
    const { extractAvailability } = await import("../src/wikitext/templates.js");
    const rows = extractAvailability(parse(wikitext("skyrim-se")));
    expect(rows.find((r) => r.store === "GOG.com")).toMatchObject({ drm: ["DRM-free"], os: ["Windows"], state: "available", notes: "Anniversary Edition also available." });
    expect(rows.find((r) => r.store === "Microsoft Store")!.notes).toBe("Included with Xbox Game Pass\nAnniversary Edition also available.");
    expect(rows.filter((r) => r.state === "unavailable").map((r) => r.store)).toEqual(["Bethesda.net", "GamersGate"]);
  });

  it("flags fan translations and keeps notes as text", async () => {
    const { extractLanguages } = await import("../src/wikitext/templates.js");
    const langs = extractLanguages(parse(wikitext("skyrim-se")));
    expect(langs[0]).toEqual({ language: "English", interface: "true", audio: "true", subtitles: "true" });
    expect(langs.find((l) => l.language === "Belarusian")).toMatchObject({ fan: true, interface: "hackable" });
  });
});
