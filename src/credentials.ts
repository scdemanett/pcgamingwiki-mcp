import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** A PCGW bot password: `user` is `YourName@BotName`. */
export interface BotCredentials {
  user: string;
  password: string;
}

export type CredentialSource = "env" | "file";

/**
 * Per-user config folder:
 * Windows %APPDATA%\pcgamingwiki-mcp, macOS ~/Library/Application Support/pcgamingwiki-mcp,
 * elsewhere $XDG_CONFIG_HOME/pcgamingwiki-mcp (default ~/.config). PCGW_CONFIG_DIR overrides it.
 */
export function configDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (env.PCGW_CONFIG_DIR?.trim()) return env.PCGW_CONFIG_DIR.trim();
  if (platform === "win32") return join(env.APPDATA || join(homedir(), "AppData", "Roaming"), "pcgamingwiki-mcp");
  if (platform === "darwin") return join(homedir(), "Library", "Application Support", "pcgamingwiki-mcp");
  return join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "pcgamingwiki-mcp");
}

export const credentialsPath = (env: NodeJS.ProcessEnv = process.env): string => join(configDir(env), "credentials.json");

/** Bot credentials from env vars, if both are set. */
export function envCredentials(env: NodeJS.ProcessEnv = process.env): BotCredentials | undefined {
  const user = env.PCGW_BOT_USER?.trim();
  const password = env.PCGW_BOT_PASSWORD;
  return user && password ? { user, password } : undefined;
}

/** Bot credentials saved by `pcgamingwiki-mcp login`, if any. Never throws. */
export function readCredentialsFile(env: NodeJS.ProcessEnv = process.env): BotCredentials | undefined {
  try {
    const raw = JSON.parse(readFileSync(credentialsPath(env), "utf8")) as Partial<BotCredentials>;
    return typeof raw.user === "string" && raw.user && typeof raw.password === "string" && raw.password
      ? { user: raw.user, password: raw.password }
      : undefined;
  } catch {
    return undefined;
  }
}

/** Env vars win over the saved file, so a client config can always override a login. */
export function currentCredentials(env: NodeJS.ProcessEnv = process.env): { creds: BotCredentials; source: CredentialSource } | undefined {
  const fromEnv = envCredentials(env);
  if (fromEnv) return { creds: fromEnv, source: "env" };
  const fromFile = readCredentialsFile(env);
  return fromFile ? { creds: fromFile, source: "file" } : undefined;
}

/** Save credentials readable by the current user only (owner-only modes on macOS/Linux). */
export function writeCredentialsFile(creds: BotCredentials, env: NodeJS.ProcessEnv = process.env): string {
  const dir = configDir(env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = credentialsPath(env);
  writeFileSync(path, JSON.stringify({ user: creds.user, password: creds.password }, null, 2) + "\n", { mode: 0o600 });
  try {
    chmodSync(path, 0o600); // in case the file already existed with wider permissions
  } catch {
    // Windows ignores POSIX modes; the file lives in the user's own profile folder.
  }
  return path;
}

/** Delete saved credentials. Returns whether a file was there. */
export function deleteCredentialsFile(env: NodeJS.ProcessEnv = process.env): boolean {
  const path = credentialsPath(env);
  const existed = readCredentialsFile(env) !== undefined;
  rmSync(path, { force: true });
  return existed;
}
