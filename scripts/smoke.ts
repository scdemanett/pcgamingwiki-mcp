/**
 * Live smoke test against the real PCGamingWiki API. Run by hand before a release,
 * never in CI:   npm run build && npm run smoke
 *
 * Starts the built server (dist/index.js) over stdio, makes ~9 tool calls 2 s apart
 * (about 9 API requests, since repeats hit the cache; 3 more with a bot password),
 * checks each response's shape, and stops at once on a rate-limit or block error.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const GAP_MS = 2000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const STOP_CODES = new Set(["rate_limited", "forbidden", "blocked_by_cloudflare"]);

type Json = any;
interface Check {
  name: string;
  tool: string;
  args: Record<string, unknown>;
  expectError?: string;
  verify?: (data: Json, env: Json) => string | undefined;
}

const hasBot = Boolean(process.env.PCGW_BOT_USER && process.env.PCGW_BOT_PASSWORD);

const checks: Check[] = [
  {
    name: "search by title prefix",
    tool: "search_games",
    args: { query: "elden ring", limit: 5 },
    verify: (d) => (d.results?.[0]?.title === "Elden Ring" && d.results[0].page_id ? undefined : "first result isn't Elden Ring with a page ID"),
  },
  {
    name: "resolve a Steam AppID",
    tool: "resolve_game",
    args: { steam_appid: 1245620 },
    verify: (d) => (d.title === "Elden Ring" && d.steam_appid?.includes("1245620") ? undefined : "didn't resolve to Elden Ring"),
  },
  {
    name: "game facts with availability",
    tool: "get_game",
    args: { title: "Elden Ring", include: ["availability"] },
    verify: (d) =>
      d.developers?.some((x: Json) => /FromSoftware/.test(x.name)) && d.availability?.some((a: Json) => a.store === "Steam") ? undefined : "missing developer or Steam availability",
  },
  {
    name: "save locations",
    tool: "get_save_locations",
    args: { steam_appid: 1245620 },
    verify: (d) => (/^%APPDATA%\\EldenRing\\/.test(d.platforms?.Windows?.saves?.[0]?.path ?? "") ? undefined : "Windows save path isn't under %APPDATA%\\EldenRing"),
  },
  {
    name: "video features",
    tool: "get_features",
    args: { steam_appid: 1245620, groups: ["video"] },
    verify: (d) => (d.video && Object.keys(d.video).length > 5 ? undefined : "video table empty"),
  },
  {
    name: "section as text",
    tool: "get_section",
    args: { title: "Elden Ring", section: "Game data" },
    verify: (d) => (/Saves \(Windows\): %APPDATA%/.test(d.content ?? "") ? undefined : "Game data text lacks the Windows save line"),
  },
  {
    name: "resolve a GOG ID",
    tool: "resolve_game",
    args: { gog_id: 1453375253 },
    verify: (d) => (d.title === "Stardew Valley" ? undefined : "didn't resolve to Stardew Valley"),
  },
  {
    name: "save locations by page ID, Linux only",
    tool: "get_save_locations",
    args: { page_id: 31535, platform: "linux" },
    verify: (d) => (Object.keys(d.platforms ?? {}).join() === "Linux" ? undefined : `expected only Linux, got ${Object.keys(d.platforms ?? {}).join()}`),
  },
  { name: "unknown title is not_found", tool: "get_game", args: { title: "Zzzq No Such Game Xyzzy" }, expectError: "not_found" },
  ...(hasBot
    ? [
        {
          name: "cargo_query (bot password)",
          tool: "cargo_query",
          args: { tables: "Game", fields: ["Developers", "Released"], where: 'Steam_AppID HOLDS "1245620"', limit: 5 },
          verify: (d: Json) => (d.rows?.[0]?.page === "Elden Ring" ? undefined : "no Elden Ring row"),
        },
      ]
    : []),
];

async function main(): Promise<number> {
  const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === "string"));
  const transport = new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"], env, stderr: "inherit" });
  const client = new Client({ name: "pcgamingwiki-mcp-smoke", version: "0" });
  await client.connect(transport);
  const { tools } = await client.listTools();
  console.log(`Server lists ${tools.length} tools: ${tools.map((t) => t.name).join(", ")}`);

  let failures = 0;
  for (const [i, c] of checks.entries()) {
    if (i > 0) await sleep(GAP_MS);
    const res = await client.callTool({ name: c.tool, arguments: c.args });
    const body: Json = JSON.parse((res.content as { text: string }[])[0]?.text ?? "{}");
    let problem: string | undefined;
    if (res.isError) {
      const code = body.error?.code;
      if (code !== c.expectError) problem = `error ${code}: ${body.error?.message}`;
      if (STOP_CODES.has(code)) {
        console.log(`FAIL  ${c.name}: ${problem}\nStopping: PCGamingWiki is limiting or blocking this client.`);
        await client.close();
        return 1;
      }
    } else if (c.expectError) {
      problem = `expected ${c.expectError}, got a result`;
    } else {
      if (body.license !== "CC BY-NC-SA 3.0" || !body.attribution || !body.source?.url) problem = "envelope missing licence, attribution or source";
      problem ??= c.verify?.(body.data, body);
    }
    console.log(`${problem ? "FAIL" : "ok  "}  ${c.name}${problem ? `: ${problem}` : body.mode ? ` (${body.mode})` : ""}`);
    if (problem) failures++;
  }
  await client.close();
  console.log(failures ? `${failures} of ${checks.length} checks failed` : `All ${checks.length} checks passed`);
  return failures ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
