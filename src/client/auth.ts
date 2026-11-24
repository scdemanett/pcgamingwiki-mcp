import { PcgwError } from "../errors.js";
import type { PcgwHttp } from "./http.js";

/**
 * Bot-password session for `cargoquery`. Credentials come from env, live only in
 * this object, and never appear in logs, errors or tool output. The session cookie
 * is held by PcgwHttp's in-memory jar.
 */
export class BotSession {
  private ready?: Promise<void>;

  constructor(
    private readonly http: PcgwHttp,
    private readonly user: string,
    private readonly password: string,
  ) {}

  /** Log in once; concurrent callers share the same attempt. */
  ensure(): Promise<void> {
    this.ready ??= this.login().catch((err) => {
      this.ready = undefined;
      throw err;
    });
    return this.ready;
  }

  /** Force a fresh login, e.g. after the session expired. */
  relogin(): Promise<void> {
    this.ready = undefined;
    return this.ensure();
  }

  private async login(): Promise<void> {
    // MediaWiki aborts action=login on a request that already carries a bot-password
    // session ("Cannot log in when using BotPasswordSessionProvider sessions"), so a
    // new login (after logout + login, a changed password or a relogin) starts clean.
    this.http.clearCookies();
    const tokenRes = await this.http.get({ action: "query", meta: "tokens", type: "login" }, { cache: false });
    const token: unknown = tokenRes.body?.query?.tokens?.logintoken;
    if (typeof token !== "string") throw new PcgwError("auth_failed", "PCGamingWiki did not return a login token.");
    const res = await this.http.post({ action: "login", lgname: this.user, lgpassword: this.password, lgtoken: token });
    const result: unknown = res.body?.login?.result;
    if (result !== "Success") {
      const reason = typeof res.body?.login?.reason === "string" ? ` ${res.body.login.reason}` : "";
      throw new PcgwError(
        "auth_failed",
        `Bot-password login failed (${String(result ?? "no result")}).${reason} Check PCGW_BOT_USER (format "User@BotName") and PCGW_BOT_PASSWORD.`,
      );
    }
  }
}
