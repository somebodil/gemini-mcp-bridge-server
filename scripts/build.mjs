// Bundles src/cli.ts into dist/cli.js; the MCP SDK stays a dependency.

import { build } from "esbuild";
import { chmodSync, readFileSync, rmSync } from "node:fs";

const { version } = JSON.parse(readFileSync("package.json", "utf8"));
const hub = readFileSync("src/hub.ts", "utf8").match(/export const VERSION = "([^"]+)"/)?.[1];
if (hub !== version) throw new Error(`src/hub.ts has version ${hub}, package.json ${version}`);

rmSync("dist", { recursive: true, force: true });
await build({
  entryPoints: ["src/cli.ts"],
  outfile: "dist/cli.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  packages: "external",
  banner: { js: "#!/usr/bin/env node" },
  logLevel: "warning",
});
chmodSync("dist/cli.js", 0o755);
console.log(`built ${version}: dist/cli.js`);
