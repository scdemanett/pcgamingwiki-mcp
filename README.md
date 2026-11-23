# pcgamingwiki-mcp

A free, read-only [MCP](https://modelcontextprotocol.io) server that gives AI agents structured data from [PCGamingWiki](https://www.pcgamingwiki.com): game facts, save and config file locations, cloud sync, and the video, input, audio and API feature tables. It runs locally over stdio and talks only to PCGamingWiki's own API, one request at a time and well under its rate limit.

> **Data licence.** Everything this server returns comes from PCGamingWiki contributors under [CC BY-NC-SA 3.0](https://creativecommons.org/licenses/by-nc-sa/3.0/): credit PCGamingWiki, non-commercial use only, and share anything you publish from it under the same licence. Every response includes the page URL and an attribution line to repeat. The MIT licence covers only this project's code.

## Tools

| Tool | What it does |
| --- | --- |
| `search_games` | Find articles by title prefix (case-insensitive, follows redirects). Titles, page IDs, URLs. |
| `resolve_game` | Map a title, Steam AppID, GOG ID or page ID to the article, with every Steam/GOG ID on it. Flags store IDs that match several pages. |
| `get_game` | Infobox facts: developers, publishers, engines, release dates, genres and other taxonomy, store IDs. Optionally store availability and languages. |
| `get_save_locations` | Save and config paths per platform and store, cloud save sync per client, and the article's notes. Filter by platform. |
| `get_features` | Feature tables: video (widescreen, ultrawide, FOV, HDR, frame rate…), input, audio, API (Direct3D/Vulkan, 64-bit, ARM), middleware, VR, multiplayer. |
| `get_section` | Any article section (fixes, issues, mods…) as readable text or wikitext, or the list of headings. |
| `cargo_query` | Advanced, needs a bot password: guarded queries over PCGamingWiki's Cargo tables. |

Every tool that takes a game accepts exactly one of `title`, `steam_appid`, `gog_id` or `page_id`. Every response has the same envelope:

```json
{
  "data": { "...": "..." },
  "mode": "wikitext",
  "source": {
    "title": "Elden Ring",
    "url": "https://www.pcgamingwiki.com/wiki/Elden_Ring",
    "history_url": "https://www.pcgamingwiki.com/w/index.php?title=Elden_Ring&action=history",
    "page_id": 146683,
    "retrieved_at": "2026-11-22T22:30:00.000Z"
  },
  "license": "CC BY-NC-SA 3.0",
  "attribution": "Data from PCGamingWiki contributors, CC BY-NC-SA 3.0: https://www.pcgamingwiki.com/wiki/Elden_Ring"
}
```

Save paths use PCGamingWiki's own placeholders, exactly as the wiki stores them: `%APPDATA%\EldenRing\<user-id>\`, `%USERPROFILE%\Documents\My Games\…`, `$HOME/.config/…`, `$XDG_CONFIG_HOME/…`, `<path-to-game>`, `HKEY_CURRENT_USER\…`. Without a bot password, each path also comes with its `{{p|token}}` parts, for tools that want to map them to their own placeholders.

Errors come back as tool results with `isError: true` and a code: `not_found` (with suggestions), `ambiguous` (with candidates), `rate_limited` (with `retry_after_s`), `auth_required`, `auth_failed`, `forbidden`, `blocked_by_cloudflare`, `invalid_input`, `invalid_query` or `upstream_error`.

## Install

Needs Node.js 20 or later. Please set `PCGW_CONTACT` to a way to reach you (an email address or a URL). PCGamingWiki asks API clients to include contact details in their User-Agent.

**Claude Code**

```sh
claude mcp add pcgamingwiki -e PCGW_CONTACT=you@example.com -- npx -y pcgamingwiki-mcp
```

**Claude Desktop** (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "pcgamingwiki": {
      "command": "npx",
      "args": ["-y", "pcgamingwiki-mcp"],
      "env": { "PCGW_CONTACT": "you@example.com" }
    }
  }
}
```

On Windows, if Claude Desktop can't find `npx`, use `"command": "cmd"` and `"args": ["/c", "npx", "-y", "pcgamingwiki-mcp"]`.

**Any other MCP client:** run `npx -y pcgamingwiki-mcp` as a stdio server.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PCGW_CONTACT` | none (warning at startup) | Contact info added to the User-Agent |
| `PCGW_BOT_USER` | none | Bot-password user name, `YourName@BotName`. Overrides a saved login |
| `PCGW_BOT_PASSWORD` | none | Bot password. Never logged or returned |
| `PCGW_PREFER_CARGO` | off | `1`: when logged in, `get_game`, `get_save_locations` and `get_features` read Cargo tables instead of wikitext (experimental) |
| `PCGW_CONFIG_DIR` | per-user config folder | Where `login` saves the bot password |
| `PCGW_CACHE_TTL` | `86400` | Seconds to cache each API response (0 turns caching off) |
| `PCGW_CACHE_DIR` | none (memory only) | Folder for a persistent cache of what you've looked up |

### Without a bot password (default)

All tools except `cargo_query` work. They read each article's wikitext and parse its templates, so responses include the wiki's notes. Responses say `"mode": "wikitext"`.
### Logging in for `cargo_query` (optional)

`cargo_query` answers questions across many games at once ("games whose frame rate is capped at 60", "RPGs released since 2020 with ultrawide support"). Since August 2026 PCGamingWiki only allows its Cargo query API to logged-in clients, so this one tool needs a PCGamingWiki bot password. Without one, it returns `auth_required` with these instructions, and every other tool works as usual.

1. Log in to PCGamingWiki (create an account if you need one).
2. Open [Special:BotPasswords](https://www.pcgamingwiki.com/wiki/Special:BotPasswords), type a bot name such as `mcp`, and click **Create**.
3. Under grants, tick **Create, query and delete data through the Cargo extension**. That's the only grant `cargoquery` accepts today. This server never creates or deletes anything, but you may prefer a separate PCGamingWiki account for it.
4. Click **Create** and copy the password shown. It's displayed only once.
5. In a terminal, run:

   ```sh
   npx pcgamingwiki-mcp login
   ```

   Enter `YourName@mcp` and the password (typing is hidden). The command logs in, runs one small Cargo query to check the grant, and only then saves the login to your user config folder (`%APPDATA%\pcgamingwiki-mcp` on Windows, `~/Library/Application Support/pcgamingwiki-mcp` on macOS, `~/.config/pcgamingwiki-mcp` elsewhere), readable by your account only. A running server picks it up on the next call; no restart needed.

`npx pcgamingwiki-mcp status` shows whether a login is saved, and `npx pcgamingwiki-mcp logout` deletes it. To revoke the bot password itself, remove it on Special:BotPasswords. You can also set `PCGW_BOT_USER` and `PCGW_BOT_PASSWORD` in your MCP client config instead; env vars win over a saved login.

The password never goes through the AI model or the chat: it's typed into your terminal, used only for `action=login`, and never logged or returned. Logging in only enables `cargo_query`. The per-game tools keep reading wikitext, which includes the editors' notes. Set `PCGW_PREFER_CARGO=1` if you want them to read Cargo tables instead (experimental).

## How it treats PCGamingWiki

PCGamingWiki is a small, community-run wiki. The server enforces these rules in code, below the tools, so no tool can bypass them:

- **Rate limit:** PCGamingWiki allows 60 requests a minute per IP, and blocks the IP for 60 s beyond that. This server sends one request at a time and at most 50 in any rolling minute. After any HTTP 429 it refuses every request for 61 s instead of retrying.
- **Caching:** each response is cached for 24 h, so asking a second tool about the same game usually costs nothing.
- **Identification:** a User-Agent of the form `pcgamingwiki-mcp/<version> (https://github.com/scdemanett/pcgamingwiki-mcp; <PCGW_CONTACT>) node/<version>`, never a browser or crawler string.
- **Stops when blocked:** on HTTP 403 or a Cloudflare challenge it returns an error and sends nothing more until restarted. No retries, no challenge solving, no proxies.
- **Read-only, reference use:** no edits, uploads or other writes, and no crawling, dumps or bulk export. PCGamingWiki's robots.txt says `ai-train=no, use=reference`. `cargo_query` is limited to allow-listed tables, two-table joins, 50 rows and validated filters, with no paging.

## Development

```sh
npm install
npm test            # unit tests on recorded API responses; never touches the live wiki
npm run typecheck
npm run build
```

- `npm run smoke` makes about 10 live requests through the built server, 2 s apart. Run it by hand before a release, not in CI.
- `npm run gen-allowlist` regenerates `src/cargo/allowlist.ts` from PCGamingWiki's live Cargo schema (about 16 requests, 3 s apart). Run it before a release, because PCGamingWiki renames tables and columns without notice. `npm run gen-allowlist -- --from-fixtures` rebuilds it offline from the saved responses.

When working against the live wiki by hand, keep at least 2 s between requests and save responses as test fixtures instead of fetching again. The design and its decisions are in [docs/SPEC.md](docs/SPEC.md).

**Known gaps:** Cargo mode is tested only on synthetic responses so far. The structured fields differ a little between modes (notes and some extra fields only in wikitext mode; computed fields and future availability only in Cargo mode). See the spec for details.

## Licence

Code: [MIT](LICENSE). Data returned by the server: [CC BY-NC-SA 3.0](https://creativecommons.org/licenses/by-nc-sa/3.0/), from PCGamingWiki contributors. This project isn't affiliated with PCGamingWiki.
