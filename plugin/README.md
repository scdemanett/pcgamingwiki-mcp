# PCGamingWiki plugin

Read-only [PCGamingWiki](https://www.pcgamingwiki.com) data for Claude: game facts, save and config file locations, cloud save sync, the video, input, audio and API feature tables, any article section, and (with a PCGamingWiki bot password) guarded Cargo queries across many games.

This folder is generated from the [pcgamingwiki-mcp](https://github.com/scdemanett/pcgamingwiki-mcp) repository: `server/index.mjs` is the whole MCP server bundled into one file by `npm run bundle`. It needs Node.js 20 or later on your PATH. See the main README for the tools, settings and how the server treats PCGamingWiki.

**Data licence:** everything the server returns comes from PCGamingWiki contributors under [CC BY-NC-SA 3.0](https://creativecommons.org/licenses/by-nc-sa/3.0/). The code is [MIT](LICENSE). Not affiliated with PCGamingWiki.
