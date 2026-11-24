import { PcgwError } from "../errors.js";
import type { CacheEntry, ResponseCache } from "./cache.js";
import { type Clock, type RequestQueue, realClock } from "./queue.js";

export type Params = Record<string, string | number | undefined>;

export interface HttpOptions {
  apiUrl: string;
  userAgent: string;
  queue: RequestQueue;
  cache: ResponseCache;
  fetch?: typeof globalThis.fetch;
  clock?: Clock;
  log?: (msg: string) => void;
}

export interface ApiResponse {
  body: any;
  fetchedAt: string;
  fromCache: boolean;
}

/** MediaWiki asks clients to back off when replication lag is high. One retry, capped wait. */
const MAXLAG_MAX_WAIT_MS = 10_000;

/**
 * HTTP client for api.php. Every request goes through the queue. Adds the User-Agent,
 * `maxlag`, JSON format; maps 429 / 403 / Cloudflare / API errors to PcgwError.
 * After a 403 or a Cloudflare challenge it refuses all further requests for the
 * life of the process: no retries, no workarounds.
 */
export class PcgwHttp {
  private readonly fetch: typeof globalThis.fetch;
  private readonly clock: Clock;
  private readonly cookies = new Map<string, string>();
  private blocked?: PcgwError;

  constructor(private readonly opts: HttpOptions) {
    this.fetch = opts.fetch ?? globalThis.fetch;
    this.clock = opts.clock ?? realClock;
  }

  /** GET, served from the cache when possible. */
  async get(params: Params, { cache = true }: { cache?: boolean } = {}): Promise<ApiResponse> {
    const url = this.buildUrl(params);
    if (cache) {
      const hit = await this.opts.cache.get(url);
      if (hit) return { ...hit, fromCache: true };
    }
    const body = await this.send("GET", url);
    const entry: CacheEntry = { body, fetchedAt: new Date(this.clock.now()).toISOString() };
    if (cache) await this.opts.cache.set(url, entry);
    return { ...entry, fromCache: false };
  }

  /** POST (login only). Never cached; the body is never logged. */
  async post(params: Params): Promise<ApiResponse> {
    const form = new URLSearchParams();
    for (const [k, v] of Object.entries(this.withDefaults(params))) if (v !== undefined) form.set(k, String(v));
    const body = await this.send("POST", this.opts.apiUrl, form);
    return { body, fetchedAt: new Date(this.clock.now()).toISOString(), fromCache: false };
  }

  /** Drop the session: later requests are anonymous until the next login. */
  clearCookies(): void {
    this.cookies.clear();
  }

  buildUrl(params: Params): string {
    const u = new URL(this.opts.apiUrl);
    for (const [k, v] of Object.entries(this.withDefaults(params))) if (v !== undefined) u.searchParams.set(k, String(v));
    return u.toString();
  }

  private withDefaults(params: Params): Params {
    return { ...params, format: "json", formatversion: 2, maxlag: 5 };
  }

  private async send(method: "GET" | "POST", url: string, form?: URLSearchParams, isRetry = false): Promise<any> {
    if (this.blocked) throw this.blocked;
    const res = await this.opts.queue.run(() =>
      this.fetch(url, {
        method,
        headers: {
          "User-Agent": this.opts.userAgent,
          Accept: "application/json",
          ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
          ...(this.cookies.size ? { Cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ") } : {}),
        },
        ...(form ? { body: form.toString() } : {}),
        redirect: "follow",
      }),
    );
    this.storeCookies(res);

    if (res.status === 429) {
      this.opts.queue.pause();
      const retry_after_s = Math.ceil(this.opts.queue.pausedForMs() / 1000);
      this.opts.log?.(`HTTP 429 from PCGamingWiki; pausing all requests for ${retry_after_s} s`);
      throw new PcgwError(
        "rate_limited",
        `PCGamingWiki returned HTTP 429 (rate limit). All requests are paused for ${retry_after_s} s.`,
        { retry_after_s },
      );
    }

    const contentType = res.headers.get("content-type") ?? "";
    const isJson = contentType.includes("json");
    const text = await res.text();

    if (isCloudflareChallenge(res, contentType, text)) {
      this.block(
        new PcgwError(
          "blocked_by_cloudflare",
          "PCGamingWiki's Cloudflare protection served a challenge page instead of API data. This server does not solve challenges or retry; requests from datacenter or cloud IPs are often challenged. Restart the server from a residential connection, or ask PCGW staff on Discord.",
          { status: res.status },
        ),
      );
    }
    if (res.status === 403) {
      this.block(
        new PcgwError(
          "forbidden",
          "PCGamingWiki returned HTTP 403: this User-Agent or IP is blocked. Set PCGW_CONTACT, check the IP, then restart the server. No further requests will be sent this session.",
          { status: 403 },
        ),
      );
    }
    if (!res.ok) {
      throw new PcgwError("upstream_error", `PCGamingWiki returned HTTP ${res.status}.`, { status: res.status });
    }
    if (!isJson) {
      throw new PcgwError("upstream_error", `PCGamingWiki returned ${contentType || "an unknown content type"} instead of JSON.`, {
        status: res.status,
      });
    }

    let body: any;
    try {
      body = JSON.parse(text);
    } catch {
      throw new PcgwError("upstream_error", "PCGamingWiki returned malformed JSON.");
    }

    const apiError = body?.error as { code?: string; info?: string } | undefined;
    if (apiError) {
      if (apiError.code === "maxlag" && !isRetry) {
        const wait = Math.min(Number(res.headers.get("retry-after") ?? 5) * 1000 || 5000, MAXLAG_MAX_WAIT_MS);
        await this.clock.sleep(wait);
        return this.send(method, url, form, true);
      }
      throw mapApiError(apiError);
    }
    return body;
  }

  private block(err: PcgwError): never {
    this.blocked = err;
    this.opts.log?.(`${err.code}: ${err.message}`);
    throw err;
  }

  private storeCookies(res: Response): void {
    const list = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
    for (const c of list) {
      const [pair] = c.split(";");
      const eq = pair?.indexOf("=") ?? -1;
      if (!pair || eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (/max-age=0|expires=thu, 01 jan 1970/i.test(c) || value === "deleted") this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }
}

function isCloudflareChallenge(res: Response, contentType: string, text: string): boolean {
  if (res.headers.get("cf-mitigated") === "challenge") return true;
  if (!contentType.includes("html")) return false;
  return /challenge-platform|cf-chl-|Just a moment\.\.\.|Attention Required! \| Cloudflare/i.test(text.slice(0, 20_000));
}

function mapApiError(e: { code?: string; info?: string }): PcgwError {
  const info = e.info ?? "unknown error";
  switch (e.code) {
    case "permissiondenied":
    case "readapidenied":
      return new PcgwError("auth_required", `PCGamingWiki refused the request: ${info}`, { api_code: e.code });
    case "missingtitle":
    case "nosuchpageid":
    case "invalidtitle":
      return new PcgwError("not_found", `PCGamingWiki: ${info}`, { api_code: e.code });
    default:
      return new PcgwError("upstream_error", `PCGamingWiki API error (${e.code ?? "unknown"}): ${info}`, { api_code: e.code });
  }
}
