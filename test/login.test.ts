import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LOGIN_HINT } from "../src/api.js";
import { type CliIO, runCli } from "../src/cli.js";
import { loadConfig } from "../src/config.js";
import {
  configDir,
  credentialsPath,
  currentCredentials,
  deleteCredentialsFile,
  readCredentialsFile,
  writeCredentialsFile,
} from "../src/credentials.js";
import { createApi } from "../src/server.js";
import type { ToolContext } from "../src/tools/context.js";
import { cargoQuery } from "../src/tools/cargo_query.js";
import { getGame } from "../src/tools/get_game.js";
import { type Route, fakeFetch, fixtureRoutes, json, manualClock } from "./fake-fetch.js";

const PASSWORD = "abcdefghijklmnopqrstuvwxyz123456";
let dir: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pcgw-login-"));
  env = { PCGW_CONFIG_DIR: dir };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Synthetic login + cargoquery endpoints (no real bot password to record with). */
function pcgw(opts: { login?: "Success" | "Failed"; cargo?: "ok" | "denied" } = {}): Route[] {
  return [
    (u) => (u.searchParams.get("meta") === "tokens" ? json({ query: { tokens: { logintoken: "tok" } } }) : undefined),
    (_u, c) =>
      c.method === "POST"
        ? json({ login: opts.login === "Failed" ? { result: "Failed", reason: "Incorrect username or password entered." } : { result: "Success" } })
        : undefined,
    (u) =>
      u.searchParams.get("action") === "cargoquery"
        ? opts.cargo === "denied"
          ? json({ error: { code: "permissiondenied", info: "You don't have permission to run arbitrary Cargo queries." } })
          : json({ cargoquery: [{ title: { Page: "Half-Life", Developers: "Company:Valve Corporation", PCGWPage: "Half-Life" } }] })
        : undefined,
  ];
}

function io(answers: string[]): CliIO & { lines: string[]; hiddenAsked: boolean[] } {
  const lines: string[] = [];
  const hiddenAsked: boolean[] = [];
  return {
    lines,
    hiddenAsked,
    out: (m) => void lines.push(m),
    ask: async (_q, o) => {
      hiddenAsked.push(Boolean(o?.hidden));
      return answers.shift() ?? "";
    },
  };
}

describe("credentials file", () => {
  it("writes, reads and deletes, owner-only on POSIX", () => {
    expect(readCredentialsFile(env)).toBeUndefined();
    const path = writeCredentialsFile({ user: "Me@mcp", password: PASSWORD }, env);
    expect(path).toBe(join(dir, "credentials.json"));
    expect(readCredentialsFile(env)).toEqual({ user: "Me@mcp", password: PASSWORD });
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(deleteCredentialsFile(env)).toBe(true);
    expect(existsSync(path)).toBe(false);
    expect(deleteCredentialsFile(env)).toBe(false);
  });

  it("lets env vars override the file, and ignores a broken file", () => {
    writeCredentialsFile({ user: "File@mcp", password: "f" }, env);
    expect(currentCredentials(env)).toEqual({ creds: { user: "File@mcp", password: "f" }, source: "file" });
    expect(currentCredentials({ ...env, PCGW_BOT_USER: "Env@mcp", PCGW_BOT_PASSWORD: "e" })).toEqual({ creds: { user: "Env@mcp", password: "e" }, source: "env" });
    writeFileSync(credentialsPath(env), "{not json");
    expect(currentCredentials(env)).toBeUndefined();
  });

  it("uses the platform's per-user config folder", () => {
    expect(configDir({ APPDATA: "C:\\Users\\me\\AppData\\Roaming" }, "win32")).toBe(join("C:\\Users\\me\\AppData\\Roaming", "pcgamingwiki-mcp"));
    expect(configDir({ XDG_CONFIG_HOME: "/home/me/.cfg" }, "linux")).toBe(join("/home/me/.cfg", "pcgamingwiki-mcp"));
    expect(configDir({ PCGW_CONFIG_DIR: "/custom" }, "linux")).toBe("/custom");
  });
});

describe("pcgamingwiki-mcp login", () => {
  it("verifies the login and the Cargo grant, then saves; the password never appears in output", async () => {
    const fetch = fakeFetch(pcgw());
    const term = io(["Me@mcp", PASSWORD]);
    expect(await runCli("login", term, env, { fetch, clock: manualClock() })).toBe(0);
    expect(term.hiddenAsked).toEqual([false, true]);
    expect(readCredentialsFile(env)).toEqual({ user: "Me@mcp", password: PASSWORD });
    expect(fetch.calls.map((c) => c.url.searchParams.get("action") ?? c.method)).toEqual(["query", "POST", "cargoquery"]);
    expect(term.lines.join("\n")).toContain("Logged in as Me@mcp");
    expect(term.lines.join("\n")).not.toContain(PASSWORD);
  });

  it("rejects a user name without @BotName before sending anything", async () => {
    const fetch = fakeFetch(pcgw());
    const term = io(["Me", PASSWORD]);
    expect(await runCli("login", term, env, { fetch })).toBe(1);
    expect(fetch.calls).toHaveLength(0);
    expect(readCredentialsFile(env)).toBeUndefined();
  });

  it("saves nothing when the password is wrong", async () => {
    const term = io(["Me@mcp", "wrong"]);
    expect(await runCli("login", term, env, { fetch: fakeFetch(pcgw({ login: "Failed" })), clock: manualClock() })).toBe(1);
    expect(readCredentialsFile(env)).toBeUndefined();
    expect(term.lines.join("\n")).toMatch(/login failed \(Failed\)/i);
  });

  it("saves nothing when the bot password lacks the Cargo grant", async () => {
    const term = io(["Me@mcp", PASSWORD]);
    expect(await runCli("login", term, env, { fetch: fakeFetch(pcgw({ cargo: "denied" })), clock: manualClock() })).toBe(1);
    expect(readCredentialsFile(env)).toBeUndefined();
    expect(term.lines.join("\n")).toContain("can't run Cargo queries");
  });

  it("status and logout report without revealing the password", async () => {
    const term = io([]);
    await runCli("status", term, env);
    expect(term.lines.at(-1)).toContain("No bot password set");
    writeCredentialsFile({ user: "Me@mcp", password: PASSWORD }, env);
    await runCli("status", term, env);
    expect(term.lines.at(-1)).toContain("Bot password set for Me@mcp");
    await runCli("logout", term, env);
    expect(readCredentialsFile(env)).toBeUndefined();
    expect(term.lines.join("\n")).not.toContain(PASSWORD);
    expect(await runCli("bogus", term, env)).toBe(1);
  });
});

describe("login without restarting the server", () => {
  function server(extra: NodeJS.ProcessEnv = {}) {
    const clock = manualClock();
    const fetch = fakeFetch([...pcgw(), ...fixtureRoutes]);
    const ctx: ToolContext = { api: createApi(loadConfig({ ...env, ...extra }), { fetch, clock }), now: () => new Date(clock.now()) };
    return { ctx, fetch };
  }
  const query = { tables: "Game", fields: "Developers", where: 'Developers HOLDS "Company:Valve Corporation"' };

  it("cargo_query asks for a login, works once one is saved, and stops after logout", async () => {
    const { ctx, fetch } = server();
    await expect(cargoQuery(ctx, query)).rejects.toMatchObject({ code: "auth_required", message: LOGIN_HINT });
    expect(fetch.calls).toHaveLength(0);

    writeCredentialsFile({ user: "Me@mcp", password: PASSWORD }, env);
    const env1 = await cargoQuery(ctx, query);
    expect(env1.data.rows[0]!.page).toBe("Half-Life");

    deleteCredentialsFile(env);
    await expect(cargoQuery(ctx, query)).rejects.toMatchObject({ code: "auth_required" });
  });

  it("logs in cleanly after a logout and a new login, as MediaWiki refuses action=login on a logged-in session", async () => {
    const clock = manualClock();
    // Like MediaWiki: a successful login sets a session cookie, and a login request
    // that still carries it is aborted.
    const fetch = fakeFetch([
      (_u, c) => {
        if (c.method !== "POST") return;
        return (c.headers.Cookie ?? "").includes("pcgwBotSession")
          ? json({ login: { result: "Aborted", reason: "Cannot log in when using MediaWiki\\Session\\BotPasswordSessionProvider sessions." } })
          : json({ login: { result: "Success" } }, 200, { "set-cookie": "pcgwBotSession=abc; path=/; HttpOnly" });
      },
      ...pcgw(),
      ...fixtureRoutes,
    ]);
    const ctx: ToolContext = { api: createApi(loadConfig(env), { fetch, clock }), now: () => new Date(clock.now()) };

    writeCredentialsFile({ user: "Me@mcp", password: PASSWORD }, env);
    await cargoQuery(ctx, query);
    expect(fetch.calls.at(-1)!.headers.Cookie).toContain("pcgwBotSession");

    deleteCredentialsFile(env);
    await expect(cargoQuery(ctx, query)).rejects.toMatchObject({ code: "auth_required" });
    await getGame(ctx, { title: "Elden Ring" });
    expect(fetch.calls.at(-1)!.headers.Cookie).toBeUndefined(); // logged out: no session sent

    writeCredentialsFile({ user: "Me@mcp", password: PASSWORD }, env);
    expect((await cargoQuery(ctx, query)).data.rows[0]!.page).toBe("Half-Life");
  });

  it("keeps per-game tools in wikitext mode after login unless PCGW_PREFER_CARGO is set", async () => {
    writeCredentialsFile({ user: "Me@mcp", password: PASSWORD }, env);
    const { ctx } = server();
    expect(ctx.api.canQueryCargo).toBe(true);
    expect(ctx.api.hasCargo).toBe(false);
    expect((await getGame(ctx, { title: "Elden Ring" })).mode).toBe("wikitext");
    expect(server({ PCGW_PREFER_CARGO: "1" }).ctx.api.hasCargo).toBe(true);
  });

  it("never writes the password into the response cache", async () => {
    const cacheDir = join(dir, "cache");
    writeCredentialsFile({ user: "Me@mcp", password: PASSWORD }, env);
    const { ctx } = server({ PCGW_CACHE_DIR: cacheDir });
    await cargoQuery(ctx, query);
    const { readdirSync } = await import("node:fs");
    const files = readdirSync(cacheDir);
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) expect(readFileSync(join(cacheDir, f), "utf8")).not.toContain(PASSWORD);
  });
});
