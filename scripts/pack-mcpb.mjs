// Builds the Claude Desktop extension: build/pcgamingwiki-mcp-<version>.mcpb.
// Run through `npm run pack:mcpb`, which bundles the server first. The extension holds
// only the manifest, the icon and the single-file bundle (no node_modules). No network use except
// npx fetching the mcpb CLI; nothing is sent to PCGamingWiki.
import { execSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MCPB = "npx -y @anthropic-ai/mcpb@2.1.2";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => JSON.parse(readFileSync(join(root, f), "utf8"));
const run = (cmd) => execSync(cmd, { cwd: root, stdio: "inherit" });

const { version } = read("package.json");
for (const f of ["manifest.json", "plugin/.claude-plugin/plugin.json"]) {
  if (read(f).version !== version) {
    console.error(`${f} has version ${read(f).version}, but package.json has ${version}. Bump them together.`);
    process.exit(1);
  }
}

const stage = join(root, "build", "mcpb");
const out = join(root, "build", `pcgamingwiki-mcp-${version}.mcpb`);
rmSync(join(root, "build"), { recursive: true, force: true });
mkdirSync(join(stage, "server"), { recursive: true });
for (const f of ["manifest.json", "README.md", "LICENSE"]) cpSync(join(root, f), join(stage, f));
cpSync(join(root, "plugin", "server", "index.mjs"), join(stage, "server", "index.mjs"));
cpSync(join(root, "assets", "icon.png"), join(stage, "icon.png"));

run(`${MCPB} validate "${join(stage, "manifest.json")}"`);
run(`${MCPB} pack "${stage}" "${out}"`);
console.log(`\nBuilt ${out}`);
