# pcgamingwiki-mcp

Free, MIT-licensed, read-only MCP server (TypeScript, stdio) that gives agents structured PCGamingWiki data through the wiki's MediaWiki and Cargo APIs. The full design is in `docs/SPEC.md`: read it before writing code, and keep it current when a decision changes.

## Status

Milestones 1 (spike) and 2 (core) done: `search_games`, `resolve_game` and `get_game` work in both modes, behind the queue, cache and HTTP client in `src/client/`. Cargo mode is only tested on synthetic responses until we have a bot password. Next is milestone 3 (`get_save_locations`, `get_section`). Work through the remaining open questions with Steven as they come up.

## Non-negotiable rules

PCGW is a small, community-run wiki. These limits protect it and keep the project within its terms. Don't relax any of them without Steven's explicit OK.

- **Rate limit:** PCGW allows 60 requests a minute per IP; going over returns 429 and blocks the IP for 60 s. Our client caps at 50 a minute, one request at a time, and pauses everything 61 s after any 429. All requests go through `src/client/queue.ts`: no tool calls `fetch` directly.
- **This applies to you during development too.** Ad-hoc `curl` or scripts against pcgamingwiki.com must stay well under the limit (2 s between calls is a good habit). Record responses as test fixtures instead of re-fetching. Never run loops or bulk fetches against the live wiki.
- **User-Agent:** always `pcgamingwiki-mcp/<version> (https://github.com/scdemanett/pcgamingwiki-mcp; <contact>)`. Never a browser string or a crawler name (robots.txt blocks ClaudeBot, GPTBot and others).
- **Read-only:** no edit, upload or write endpoints. The only login is an optional bot password for `cargoquery`, read from env, never logged, never in tool output or fixtures.
- **No bulk data:** no crawl, sitemap walk, dump or export tool. robots.txt says `ai-train=no, use=reference`. Fetch per request; cache per user.
- **Attribution:** every tool response carries the page URL, history URL, `license: "CC BY-NC-SA 3.0"` and an attribution line. Content is NonCommercial and ShareAlike; the MIT licence covers only our code.
- **Stop on blocks:** on 403 or a Cloudflare challenge page, return a clear error. No retries, challenge solving, headless browsers or proxy tricks.
- **Cargo safety:** allow-listed tables only, at most 2 per join, `limit` ≤ 50, validated `where`.

## Current PCGW facts (Nov 2026)

- Cargo table `Infobox_game` is now `Game`. `VR_support` is now `VR`, and `Infobox_game_engine` is now `GameEngine`. Availability columns are now `Present`, `Past` and `Future`, plus one `<Store>_DRM` column per store (there is no `StoreKeys` column in `Availability`, per `cargofields`). Older blog posts and libraries use the old names.
- `cargoquery` needs a bot password plus `action=login` since the August 2026 migration. Without one, fall back to parsing wikitext.
- `action=idlookup` maps Steam and GOG IDs to page names. `opensearch` with `redirects=resolve` is case-insensitive, but `parse`'s `page` parameter is case-sensitive.
- PCGW's contact channel is Discord. API docs and changelog: https://www.pcgamingwiki.com/wiki/PCGamingWiki:API

## Stack and conventions

- Node 20+, TypeScript strict, ESM. `@modelcontextprotocol/sdk`, `zod`, `lru-cache`.
- One file per tool in `src/tools/`, zod schemas for input, shared envelope from `src/envelope.ts`.
- Tests: vitest on recorded fixtures; CI never touches the live wiki. `npm run smoke` is the only live test and is run by hand.
- Don't commit or push unless Steven asks.

## Related projects

- `scdemanett/claude-pcgamingwiki-skills`: the pcgamingwiki-editor and game-save-recon skills. Their knowledge of `{{Game data}}` and path templates is useful for the wikitext parser.
- SaveVault, Steven's app, consumes save paths through the Ludusavi manifest.
