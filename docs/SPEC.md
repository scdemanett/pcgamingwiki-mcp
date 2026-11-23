# pcgamingwiki-mcp: Read-only MCP server spec

As of 2026-11-22 · Steven Demanett (scdemanett)
Living copy of this spec: https://claude.ai/artifact/PWRjhBywdr2f3mosEzQ7db (this file is the repo's source of truth from here on)

## Summary and scope

`pcgamingwiki-mcp` is a free, MIT-licensed, read-only MCP server in TypeScript. It runs locally over stdio and gives agents structured PCGamingWiki data through the wiki's own MediaWiki and Cargo APIs. Each call fetches only what the agent asked for, with attribution in every response.

**In scope for v1**

- Look up games by title, Steam AppID or GOG ID
- Return infobox facts, save and config locations, cloud sync, video/input/audio/API feature tables, and article sections as wikitext or parsed text
- A guarded Cargo query tool for advanced use
- Distribution through npm (`npx pcgamingwiki-mcp`) and the GitHub repo `scdemanett/pcgamingwiki-mcp`

**Out of scope for v1**

- Any write: editing, uploads, talk pages
- Any login except an optional read-only bot password, used to unlock `cargoquery`
- A hosted or shared server
- Bulk export, mirroring, or any dataset beyond a per-user cache
- HTML scraping of article pages: the API only

## Compliance rules

These rules are hard requirements. The code enforces each one; none is just a README note.

| Rule | Source | How the server enforces it |
| --- | --- | --- |
| Stay under 60 requests a minute per IP | [API page](https://www.pcgamingwiki.com/wiki/PCGamingWiki:API): over the limit returns HTTP 429 and blocks the IP for 60 s | Sliding-window limit of 50 request starts in any rolling 60 s (a token bucket could burst past 60 across a window edge), leaving headroom for anything else on the same IP. One request at a time. On any 429, every request is refused with `rate_limited` for 61 s, with no retry before that. `maxlag=5` on every call, with one retry after at most 10 s |
| Cache on our side | API page asks clients to index or cache as much as they can, at least for a while | 24 h TTL by default. In-memory LRU, plus an optional disk cache (`PCGW_CACHE_DIR`, off by default). Each tool resolves an ID once and reuses it |
| Identify the client | API page: custom User-Agent with contact info, in MediaWiki format; generic agents may get 403 or bans | `pcgamingwiki-mcp/<version> (https://github.com/scdemanett/pcgamingwiki-mcp; <PCGW_CONTACT>) node/<version>`. Without `PCGW_CONTACT` the server still runs, but logs a warning at startup |
| Authenticate for Cargo | API page: `cargoquery` needs a bot password and `action=login` since the August 2026 migration | Optional `PCGW_BOT_USER` and `PCGW_BOT_PASSWORD` from env only. Never logged or returned. Without them, Cargo-backed tools fall back to parsing wikitext |
| Attribute every result | Content licence CC BY-NC-SA 3.0 | Every response carries `source.url`, `source.history_url`, `license` and a ready-to-repeat attribution line |
| Non-commercial only | Same licence | README and package metadata say the data is CC BY-NC-SA. The MIT licence covers only the code. No paid tier or hosted version |
| Share-alike on derived data | Same licence | README tells users that anything they publish from the output carries CC BY-NC-SA |
| Reference use, no training | robots.txt `Content-Signal: search=yes, ai-train=no, use=reference` | Fetch per request only. No crawl, sitemap walk, dump, or "export all" tool. The disk cache holds only what this user looked up |
| Don't impersonate blocked crawlers | robots.txt blocks ClaudeBot, GPTBot, anthropic-ai and others | Own User-Agent; never a crawler name or a browser string |
| Bound expensive queries | Cargo runs SQL on the wiki's database | Allow-listed tables only. Max 2 tables per join, `limit` capped at 50 rows. Validated `where` clauses |
| Stop on blocks | API page: 403 means a blocked agent or IP; datacenter requests from a cloud workspace got a Cloudflare challenge | On 403 or a Cloudflare challenge page, return a clear error and stop: the client refuses every further request until the server restarts. No retries, no challenge solving, no proxy rotation |

PCGW's contact channel is Discord. Before the public release, ask PCGW staff there for a go-ahead, and link the thread from the README.

## Data sources

Everything comes from `https://www.pcgamingwiki.com/w/api.php`. `action=idlookup` resolves Steam and GOG IDs to page names, so the redirect API (`/api/appid.php`, `/api/gog.php`) isn't needed.

**Endpoints used**

- `action=cargoquery`: structured fields. Needs a bot password with the Cargo grant
- `action=cargofields&table=…`: a table's field list and delimiters. Works anonymously, so `gen-allowlist` needs no login
- `action=idlookup&field=steamappid|gogid&value=…`: Steam AppID or GOG ID to page names
- `action=query&generator=prefixsearch&prop=info&inprop=url&redirects=1`: case-insensitive title search that resolves redirects and returns page IDs and URLs in one call (used instead of `opensearch`, which returns no IDs)
- `action=parse&redirects=1&prop=wikitext|revid`: the whole article's wikitext, cached and shared by every tool. `page` is case-sensitive, so titles are resolved with `prefixsearch` first
- `action=query&prop=info&pageids=…`: page ID to title
- `action=login` + `meta=tokens&type=login`: bot-password session, only when credentials are set

**Two modes.** With a bot password, the structured tools use Cargo: one call per lookup, typed fields. Without one, they fetch the article's wikitext and parse its templates (`Infobox game`, `Game data`, `Video` and others). The parser is needed either way for sections Cargo doesn't hold, so anonymous mode costs little extra code. Every response says which mode produced it (`"mode": "cargo" | "wikitext"`).

**Cargo tables v1 allows** (live schema, checked 22 Nov 2026 on [Special:CargoTables](https://www.pcgamingwiki.com/wiki/Special:CargoTables))

| Table | Rows | What it gives | Used by |
| --- | --- | --- | --- |
| Game | 56,115 | Infobox: developers, publishers, engines, release dates, Steam_AppID, GOGcom_ID, genres, series, monetization | `resolve_game`, `get_game` |
| GameData | 33,156 | `Paths`, `Type` (Saves / Config), `Platform` | `get_save_locations` |
| Cloud | 51,819 | Save cloud sync per store | `get_save_locations` |
| Video | 55,890 | Widescreen, ultrawide, HDR, frame rate, FOV and similar | `get_features` |
| Input | 55,738 | Remapping, controller support, prompts | `get_features` |
| Audio | 55,644 | Audio settings and subtitles | `get_features` |
| API | 54,524 | Direct3D, Vulkan, OpenGL, 64-bit, ARM | `get_features` |
| Middleware | 54,362 | Physics, audio, anti-cheat and similar middleware | `get_features` |
| VR | 6,047 | VR headset and control support | `get_features` |
| Availability | 55,234 | Stores and DRM | `get_game` |
| Multiplayer | 14,321 | Local, LAN and online modes | `get_features` |
| L10n | 204,137 | Languages: UI, audio, subtitles | `get_game` (opt-in) |
| Engine, Company | 622 / 6,259 | Engine and company pages | `cargo_query` only |

Internal tables (`PCGW_*`) and `_pageData` stay blocked.

`Game` fields (44): Cover, Cover_URL, Developers, Porters_PC_booter, Porters_DOS, Porters_Windows_3x, Porters_Windows, Porters_Mac_OS, Porters_OS_X, Porters_Linux, Publishers, Engines, Available_on, Release_State, Released (dates, `;`-delimited), Released_PC_booter, Released_DOS, Released_Windows_3x, Released_Windows, Released_Mac_OS, Released_OS_X, Released_Linux, Wrappers, Wrappers_Windows_3x, Wrappers_Windows, Wrappers_OS_X, Wrappers_Linux, Monetization, Microtransactions, Modes, Pacing, Perspectives, Controls, Genres, Sports, Vehicles, Art_styles, Themes, Series, Steam_AppID, GOGcom_ID, StrategyWiki, Wikipedia, License. List fields are `,`-delimited unless noted.

**Schema traps to handle**

- `Infobox_game` was renamed `Game` on 25 Aug 2026, along with `Infobox_game_engine` → `GameEngine` and `VR_support` → `VR`. Use the new names only.
- On 30 Aug 2026, `Availability` columns were renamed (`Available_from` → `Present`, `Available_from_historically` → `Past`, `Available_from_future` → `Future`), and store keys moved to `StoreKeys`. `cargofields` (22 Nov 2026) shows `Availability` has no `StoreKeys` column, only `Present`/`Past`/`Future` and one `<Store>_DRM` list per store (`Steam_DRM`, `GOGcom_DRM`…). Whether `StoreKeys` is its own table is unchecked.
- Cargo matching is case-insensitive again (since 21 Sep 2026) unless a query uses `BINARY`.
- Fields starting with `_` (`_pageName`, `_pageID`) must be aliased in `fields` (e.g. `Game._pageName=Page`).
- List fields (`Steam_AppID`, `Developers`) need `HOLDS` in `where`, not `=`.
- `Released` is a list of dates separated by `;`, while most lists use `,`. Split by the delimiter each field declares.
- `GameData.Paths` holds rendered paths (`%LOCALAPPDATA%\anyway`), not the `{{p|…}}` template form. [Module:Cargo/gamePaths](https://www.pcgamingwiki.com/wiki/Module:Cargo/gamePaths) does the rendering: each token becomes a fixed string (`appdata` → `%APPDATA%`, `userprofile\documents` → `%USERPROFILE%\Documents`, `osxhome`/`linuxhome` → `$HOME`, `game` → `<path-to-game>`, `uid` → `<user-id>`, `hkcu` → `HKEY_CURRENT_USER`…), `{{LocalizedPath|x}}` → `<Localized x>`, `{{code|x}}` → `x`, and refs are dropped. `src/wikitext/paths.ts` copies that table so wikitext mode returns identical strings. A row's paths are joined with `, ` into a `,`-delimited list, so a path containing a comma can't round-trip through Cargo. Rows with no path aren't stored at all.
- `GameData.Type` is `Saves` or `Config`; `GameData.Platform` is the template's first arg as written (`Windows`, `OS X`, `Steam`, `GOG.com`…), the same as in wikitext.
- `Cloud` has one column per client (`Discord`, `Epic_Games_Launcher`, `GOG_Galaxy`, `EA_app`, `iCloud`, `OneDrive`, `Steam`, `Ubisoft_Connect`, `Xbox`) and no notes; the wikitext template has notes and uses different keys (`steam cloud`, `xbox cloud`, `origin`).
- PCGW changes its schema without warning. Generate the allowlist from `Special:CargoTables` with a script, and check the [API changelog](https://www.pcgamingwiki.com/wiki/PCGamingWiki:API) before each release.

**Reference queries from the API page**

```
# Game fields by Steam AppID
action=cargoquery&tables=Game&fields=Game._pageName=Page,Game.Developers,Game.Released,Game.Cover_URL&where=Game.Steam_AppID HOLDS "1245620"
# Join Game + GameData for save/config paths
action=cargoquery&tables=Game,GameData&fields=GameData.Type=Type,GameData.Platform=Platform,GameData.Paths=Paths&join_on=Game._pageID=GameData._pageID&where=Game.Steam_AppID HOLDS "1245620"
# Title search, resolving redirects
action=opensearch&search=DRAGON QUEST VII Reimagined&redirects=resolve
# Wikitext by exact (case-sensitive) title
action=parse&redirects=1&prop=wikitext&page=Dragon Quest VII Reimagined
```

## Tools

Seven tools, all marked `readOnlyHint: true` and `openWorldHint: true`. Every response shares one envelope, so agents always get attribution:

```json
{
  "data": { },
  "mode": "cargo",
  "source": { "title": "Elden Ring", "url": "https://www.pcgamingwiki.com/wiki/Elden_Ring", "history_url": "https://www.pcgamingwiki.com/w/index.php?title=Elden_Ring&action=history", "page_id": 12345, "retrieved_at": "2026-11-22T22:30:00Z" },
  "license": "CC BY-NC-SA 3.0",
  "attribution": "Data from PCGamingWiki contributors, CC BY-NC-SA 3.0: https://www.pcgamingwiki.com/wiki/Elden_Ring"
}
```

| Tool | Input | Returns | Calls (Cargo mode) |
| --- | --- | --- | --- |
| `search_games` | `query` (string), `limit` (1–20, default 10) | Titles, page IDs, URLs | 1 |
| `resolve_game` | exactly one of `title`, `steam_appid`, `gog_id`, `page_id` | Page title, ID, URL, plus all Steam/GOG IDs on the page. One Steam ID can match several pages (DLC, editions): returns them all, flagged `ambiguous` | 1 |
| `get_game` | game ref*, `include` (any of `availability`, `languages`) | Infobox fields as typed JSON: lists split, dates ISO | 1–3 |
| `get_save_locations` | game ref*, `platform` (optional filter), `raw` (bool) | Save and config paths grouped by platform and type, cloud sync per store, plus the Game data section's wikitext when `raw` | 2–3 |
| `get_features` | game ref*, `groups` (any of `video`, `input`, `audio`, `api`, `middleware`, `vr`, `multiplayer`) | One object per group: raw field values plus notes | 1 per group |
| `get_section` | game ref*, `section` (heading text or index), `format` (`wikitext` or `text`) | The section's content. Lists headings when the name doesn't match | 1–2 |
| `cargo_query` | `tables` (1–2 allowed), `fields`, `where`, `join_on`, `order_by`, `limit` (≤ 50) | Raw rows, each with its page URL | 1 |

*Game ref = `title`, `steam_appid`, `gog_id` or `page_id`. A non-title ref resolves through `idlookup` (or Cargo when authenticated) first, and that resolution is cached.

`cargo_query` needs a bot password and is not registered when none is set. The other six tools work in both modes; anonymous mode usually takes 2 calls (resolve, then parse).

**Errors** come back as tool results with `isError: true` and a code the agent can act on: `not_found` (title misses include `suggestions`), `ambiguous` (with candidates), `rate_limited` (with `retry_after_s`), `auth_required`, `auth_failed`, `forbidden` (HTTP 403: check the User-Agent and IP), `blocked_by_cloudflare`, `invalid_input` (e.g. not exactly one game ref), `invalid_query` (names the field or table), `upstream_error`.

**Response details settled in milestone 2**

- Multi-page results (`search_games`, an ambiguous `resolve_game`) carry a `source` without `history_url` or `page_id`; each item has its own `url` and `history_url` instead.
- Both modes return one `GameInfo` shape. Some fields only wikitext mode can fill, and they're absent in Cargo mode: `steam_appid_side`/`gog_id_side` (Cargo merges side IDs into `steam_appid`), `reception`, developer and publisher notes, and availability IDs, notes and OS. Only Cargo mode reports `future` availability and a language `status`.
- Anonymous calls: `search_games` 1; `resolve_game` and `get_game` 2 (`prefixsearch` or `idlookup`, then `parse`). Every underlying response is cached, so a second tool on the same game usually costs 0–1 calls.

**Settled in milestone 3**

- `get_save_locations` returns `platforms: { <platform>: { saves: [], config: [] } }` plus `platforms_available` (all platforms, before the `platform` filter), `cloud` keyed by client (`steam`, `gog_galaxy`, `epic_games_launcher`, `ea_app`, `ubisoft_connect`, `xbox`, `icloud`, `discord`, `onedrive`), and `notes`/`xdg`. Each path has `path` (rendered as Cargo stores it) in both modes; wikitext mode adds `wikitext` and `segments` (`{text}` / `{token}`), which is what a Ludusavi mapping would start from.
- The `platform` filter ignores case and punctuation and knows common aliases (`mac` → OS X, `gog` → GOG.com, `epic`, `xbox`/`msstore` → Microsoft Store, `ea`/`origin`, `ubisoft`/`uplay`).
- Mode differences: Cargo mode has no notes, XDG flag or cloud notes, and omits stores whose rows have no path. `raw: true` adds the section's wikitext, and in Cargo mode it also fetches the article for notes (one extra call).
- `get_section` reads the article in both modes (so it always reports `mode: "wikitext"`). Without `section` it lists `{index, level, heading}`; index 0 is the lead. A section includes its subsections. `format: "text"` (default) turns Game data, Availability, L10n and `|key = value` tables into `- key: value (notes)` lines and headings into `##`; `wikitext` is sliced from the article as written. Output is capped at 40,000 characters, with `truncated: true`. Indexes count the headings written in the article, not ones added by templates, so they can differ from MediaWiki's own section numbers.

**Resources (optional, v1.1):** `pcgw://schema/{table}` for a table's field list, and `pcgw://page/{title}` for whole-page wikitext.

## Architecture

```
Agent (MCP client) ── stdio
  └─ Tool layer: 7 read-only tools, zod input checks, response envelope
       ├─ Cargo query builder: allow-listed tables, validated where, ≤2 tables, ≤50 rows (needs bot password)
       └─ Section fetch + wikitext parser: one section per call, templates → JSON
            └─ Cache: LRU, 24 h TTL, optional disk cache (a hit skips the network)
                 └─ Request queue + HTTP client: ≤50 req/min, one at a time, 61 s pause on 429,
                    own User-Agent, bot-password session, stop on 403/Cloudflare
                      └─ PCGamingWiki api.php: cargoquery, idlookup, opensearch, parse, info, login
```

All compliance limits sit in the queue and HTTP client, so no tool can bypass them. The cache is keyed by the full request URL (minus credentials) and holds entries 24 h by default (`PCGW_CACHE_TTL`), up to 2,000. With `PCGW_CACHE_DIR` set it also persists to disk with the same TTL. The bot-password session lives in memory only and logs in again if it expires.

## Repo, packaging and testing

Node 20+, TypeScript, ESM, published to npm as `pcgamingwiki-mcp`.

```
src/
  index.ts          # stdio entry, registers tools
  config.ts         # env: PCGW_CONTACT, PCGW_BOT_USER, PCGW_BOT_PASSWORD, PCGW_CACHE_TTL, PCGW_CACHE_DIR
  client/
    http.ts         # fetch, User-Agent, maxlag, retries, 403/Cloudflare detection
    queue.ts        # one at a time, 50/min token bucket, 61 s pause on 429
    auth.ts         # bot-password login, in-memory session cookie
    cache.ts        # LRU with TTL, optional disk persistence
  cargo/
    allowlist.ts    # tables, fields, delimiters (generated from Special:CargoTables)
    builder.ts      # safe query builder + where validator
  wikitext/
    templates.ts    # parses Infobox game, Game data, Video and other templates
  tools/            # one file per tool, zod input schemas
  envelope.ts       # source / license / attribution / mode
scripts/
  gen-allowlist.ts  # regenerates cargo/allowlist.ts (run by hand, respects rate limit)
test/
  fixtures/         # recorded API responses
  *.test.ts
```

**Dependencies:** `@modelcontextprotocol/sdk`, `zod`, `lru-cache`, and `wikiparser-node` or a small template parser of our own. Template parsing is the riskiest part; prototype it before deciding.

**Testing**

- Unit tests run on recorded fixtures, so CI never touches PCGW
- Query builder tests cover injection attempts: `;`, comments, subqueries, tables not on the list
- Queue tests cover the token bucket and the 61 s pause after a 429 (fake timers)
- An `npm run smoke` script makes about 10 live calls with a 2 s gap, run by hand before each release
- Check with MCP Inspector, then Claude Desktop and Claude Code

**Install docs:** Claude Desktop config JSON, `claude mcp add pcgamingwiki -- npx -y pcgamingwiki-mcp`, and a generic stdio snippet. README sections: what it does, compliance rules, data licence vs code licence, env vars, bot-password setup.

**Release:** GitHub Actions runs lint, typecheck and tests on every PR. Tagged releases publish to npm with provenance.

## Open questions

- [x] Does a home connection get API responses, or the Cloudflare challenge a cloud workspace got? **Yes, real JSON** (HTTP 200 through Cloudflare, no challenge), 22 Nov 2026. See Spike results.
- [x] Which endpoints besides `cargoquery` need login now? **Only `cargoquery`.** `opensearch`, `idlookup`, `parse`, `query&prop=info` and `paraminfo` all work anonymously.
- [ ] Is there a narrower grant than "Create, query and delete data through the Cargo extension"? A read-only tool shouldn't ask users for create and delete rights. Ask PCGW on Discord.
- [x] What is `cargoquery`'s maximum `limit` on PCGW? **500** (5,000 with `apihighlimits`), default 50, per `paraminfo`. Our cap of 50 is well under.
- [ ] Is PCGW staff OK with the tool? Ask on Discord before release, and note any limits they give.
- [ ] Should `get_save_locations` also output Ludusavi-style placeholders (`<winLocalAppData>`), for SaveVault and game-save-recon? Or leave that to the skills?

## Spike results (22 Nov 2026)

12 live calls from a home connection, at least 3 s apart, all recorded in `test/fixtures/spike/`. No 429s, no challenges.

**API behaviour**

- Errors come back as **HTTP 200** with an `error` object, so `http.ts` must check the body, not just the status. Seen so far: `cargoquery` anonymously → `error.code: "permissiondenied"` (map to `auth_required`); `parse` with a wrong-case title → `error.code: "missingtitle"` (map to `not_found`).
- `idlookup` takes `field` (`steamappid` or `gogid`) and `value`. It returns `{"idlookup":[{"title":{"Page":"Elden Ring"}}]}`: an array (so several pages can match: handle `ambiguous`) of titles only, with no page ID.
- `parse` returns `pageid` and the canonical `title` alongside the wikitext, and the page URL follows from the title. So anonymous lookups are 2 calls (`idlookup` or `opensearch`, then `parse`), and `query&prop=info` is only needed when we want `touched`/`lastrevid` for cache keys.
- `parse&page=` is confirmed case-sensitive (`elden ring` → `missingtitle`); `opensearch` returns the right case.

**Template parser: decision is our own parser, not `wikiparser-node`.** `src/wikitext/parse.ts` (~250 lines, no dependencies) handles nested templates, links, `<ref>` and `<nowiki>` as opaque, comments, and named-arg detection by the first top-level `=`. It round-trips all 5 test articles byte for byte (Elden Ring, Skyrim Special Edition, Half-Life, Minecraft: Java Edition, Stardew Valley). `src/wikitext/templates.ts` extracts `Infobox game`, `Game data`, `Save game cloud syncing` and the key/value feature tables. Covered by `test/wikitext.test.ts` (22 tests). `wikiparser-node` wasn't tried; it would add a large dependency for features we don't need.

**Wikitext facts the parser has to handle**

- Template names vary in case (`{{P|game}}` and `{{p|game}}`); names are normalized MediaWiki-style.
- Path tokens can carry a subpath: `{{p|userprofile\Documents}}`. Game data rows can have an empty path (Skyrim SE's Microsoft Store row) and store names as the platform (`GOG.com`, `Steam`, `Microsoft Store`).
- Useful notes sit after the templates as `{{ii}}`/`{{mm}}` lines, often with `<ref>`s inside; `{{XDG|true}}` flags Linux XDG compliance.
- Wikitext template names didn't change with the Cargo renames: it's still `{{VR support}}` (Cargo table `VR`) and `{{Network/Multiplayer}}` (Cargo table `Multiplayer`).
- Wikitext mode returns paths as `{{p|token}}` segments, while Cargo `GameData.Paths` holds rendered paths. Milestone 3 needs a token → rendered mapping so both modes return the same shape; we can't check Cargo's exact rendering until we have a bot password.

**Dev note:** Git Bash's bundled curl 8.8 (Schannel) fails with error 43 before sending anything; use `C:\Windows\System32\curl.exe` for ad-hoc calls on Windows. Node's `fetch` is unaffected.

## Milestones

1. **Spike (half a day): done 22 Nov 2026, see Spike results.** the Cloudflare and anonymous-endpoint checks above, plus a template-parser prototype on 5 tricky articles
2. **Core (2 days): done 22 Nov 2026.** HTTP client with rate limit and 429 pause, cache, optional bot-password login, envelope, `search_games`, `resolve_game`, `get_game` in both modes. 65 fixture tests; one live `get_game` call through the built server confirmed Node's `fetch` isn't challenged. **Cargo mode is tested only on synthetic responses** (we have no bot password yet): record real `cargoquery` and login responses as fixtures once we do, and check the alias-key format (`Steam AppID` vs `Steam_AppID`) and the `Company:`/`Engine:` prefixes the mapper strips.
3. **Game data (1 day): done 22 Nov 2026.** `get_save_locations` (both modes, same path strings) and `get_section` (text or wikitext). 93 fixture tests; checked live on Hollow Knight, an article with no fixture. Cargo mode again only on synthetic responses.
4. **Features and Cargo (1 day):** `get_features`, `cargo_query` with allowlist and validator
5. **Ship (half a day):** README with bot-password setup steps, Inspector and Claude checks, staff go-ahead, npm 0.1.0
