import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { PcgwApi } from "../api.js";
import { errorResult } from "../envelope.js";

export interface ToolContext {
  api: PcgwApi;
  now: () => Date;
}

/** Every tool is read-only and talks to an outside service. */
export const READ_ONLY = { readOnlyHint: true, openWorldHint: true, destructiveHint: false, idempotentHint: true } as const;

/** Run a tool body and turn any failure into an `isError` result with a code. */
export async function safely(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (err) {
    return errorResult(err);
  }
}
