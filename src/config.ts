import { readFileSync } from "node:fs";

export interface Config {
  apiUrl: string;
  contact?: string;
  botUser?: string;
  botPassword?: string;
  cacheTtlMs: number;
  cacheMax: number;
  cacheDir?: string;
}

const DAY_S = 24 * 60 * 60;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const ttlS = env.PCGW_CACHE_TTL ? Number(env.PCGW_CACHE_TTL) : DAY_S;
  if (!Number.isFinite(ttlS) || ttlS < 0) throw new Error("PCGW_CACHE_TTL must be a number of seconds (0 or more)");
  const botUser = env.PCGW_BOT_USER?.trim() || undefined;
  const botPassword = env.PCGW_BOT_PASSWORD || undefined;
  if (Boolean(botUser) !== Boolean(botPassword)) {
    throw new Error("Set both PCGW_BOT_USER and PCGW_BOT_PASSWORD, or neither");
  }
  return {
    apiUrl: "https://www.pcgamingwiki.com/w/api.php",
    contact: env.PCGW_CONTACT?.trim() || undefined,
    botUser,
    botPassword,
    cacheTtlMs: ttlS * 1000,
    cacheMax: 2000,
    cacheDir: env.PCGW_CACHE_DIR?.trim() || undefined,
  };
}

/** Package version, read from package.json (one level above both src/ and dist/). */
export const VERSION: string = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

/** MediaWiki-style User-Agent. Never a browser string or a crawler name. */
export function userAgent(cfg: Pick<Config, "contact">, version = VERSION): string {
  const contact = cfg.contact ? `; ${cfg.contact}` : "";
  return `pcgamingwiki-mcp/${version} (https://github.com/scdemanett/pcgamingwiki-mcp${contact}) node/${process.versions.node}`;
}
