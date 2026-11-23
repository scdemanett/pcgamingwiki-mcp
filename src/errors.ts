export type ErrorCode =
  | "not_found"
  | "ambiguous"
  | "rate_limited"
  | "auth_required"
  | "auth_failed"
  | "forbidden"
  | "blocked_by_cloudflare"
  | "invalid_input"
  | "invalid_query"
  | "upstream_error";

/** An error an agent can act on. `details` must never hold credentials. */
export class PcgwError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "PcgwError";
  }
}
