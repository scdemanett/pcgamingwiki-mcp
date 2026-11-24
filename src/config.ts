import { readFileSync } from "node:fs";
import { configDir, envValue } from "./credentials.js";

export interface Config {
  apiUrl: string;
  contact?: string;
  /** Bot password from env vars. Wins over the credentials file written by `login`. */
  botUser?: string;
  botPassword?: string;
  /** Folder holding credentials.json from `pcgamingwiki-mcp login`. */
  configDir: string;
  /** PCGW_PREFER_CARGO=1: per-game tools read Cargo tables when logged in (default: wikitext). */
  preferCargo: boolean;
  cacheTtlMs: number;
  cacheMax: number;
  cacheDir?: string;
  /** Problems with the settings that didn't stop the server; logged at startup. */
  warnings: string[];
}

const DAY_S = 24 * 60 * 60;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const ttlS = env.PCGW_CACHE_TTL ? Number(env.PCGW_CACHE_TTL) : DAY_S;
  if (!Number.isFinite(ttlS) || ttlS < 0) throw new Error("PCGW_CACHE_TTL must be a number of seconds (0 or more)");
  const botUser = envValue(env, "PCGW_BOT_USER");
  const botPassword = envValue(env, "PCGW_BOT_PASSWORD", { trim: false });
  const warnings: string[] = [];
  // Not fatal: in the Desktop extension a half-filled setting would otherwise stop the
  // whole server. Ignore both and say so in the log.
  if (Boolean(botUser) !== Boolean(botPassword)) {
    warnings.push("Only one of PCGW_BOT_USER and PCGW_BOT_PASSWORD is set; ignoring both. Set both to enable cargo_query.");
  }
  const halfSet = warnings.length > 0;
  return {
    apiUrl: "https://www.pcgamingwiki.com/w/api.php",
    contact: envValue(env, "PCGW_CONTACT"),
    botUser: halfSet ? undefined : botUser,
    botPassword: halfSet ? undefined : botPassword,
    configDir: configDir(env),
    preferCargo: /^(1|true|yes)$/i.test(env.PCGW_PREFER_CARGO?.trim() ?? ""),
    cacheTtlMs: ttlS * 1000,
    cacheMax: 2000,
    cacheDir: env.PCGW_CACHE_DIR?.trim() || undefined,
    warnings,
  };
}

/** Set by scripts/bundle.mjs in the single-file bundle, which has no package.json beside it. */
declare const __PCGW_VERSION__: string | undefined;

/** Package version: baked into the bundle, else read from package.json (one level above src/ and dist/). */
export const VERSION: string = (() => {
  if (typeof __PCGW_VERSION__ === "string") return __PCGW_VERSION__;
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
