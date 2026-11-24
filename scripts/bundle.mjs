// Bundles the server and its dependencies into one file, plugin/server/index.mjs.
// The Claude Code plugin runs it straight from the git checkout (plugins get no build
// step), and the Claude Desktop extension packs it. Committed; CI checks it's current.
import { copyFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

await build({
  entryPoints: [join(root, "src", "index.ts")],
  outfile: join(root, "plugin", "server", "index.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  minify: true,
  legalComments: "eof",
  define: { __PCGW_VERSION__: JSON.stringify(version) },
  // Some dependencies are CommonJS and call require(); give the ESM bundle one.
  banner: { js: 'import { createRequire as __pcgwCreateRequire } from "node:module";\nconst require = __pcgwCreateRequire(import.meta.url);' },
  logLevel: "warning",
});
// The plugin is installed without the rest of the repo, so it carries its own licence.
copyFileSync(join(root, "LICENSE"), join(root, "plugin", "LICENSE"));
console.log(`Bundled pcgamingwiki-mcp ${version} into plugin/server/index.mjs`);
