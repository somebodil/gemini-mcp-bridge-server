// gemini-mcp-bridge-server: the local MCP server that the Gemini MCP Bridge extension talks to.

import { parseArgs } from "node:util";
import { defaultConfigPath, loadConfig, saveConfig } from "./config.ts";
import { listen } from "./http.ts";
import { Hub, VERSION } from "./hub.ts";

const HELP = `gemini-mcp-bridge-server ${VERSION}: your computer's tools for Gemini on the web, through the Gemini MCP Bridge extension

Usage: gemini-mcp-bridge-server [options]

  --port <n>       Port on 127.0.0.1 (default: from the config, 7341)
  --config <file>  Config file (default: ${defaultConfigPath()})
  --no-shell       Without the run_command tool
  --no-files       Without read_file, write_file, list_directory
  --new-token      Make a new token (the extension then needs the new one)
  -h, --help       This text
  -v, --version    The version

The config file also lists MCP servers to pass through, in the usual "mcpServers" shape:
  "mcpServers": { "playwright": { "command": "npx", "args": ["@playwright/mcp@latest"] } }
`;

function stamp(): string {
  return new Date().toTimeString().slice(0, 8);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      port: { type: "string" },
      config: { type: "string" },
      "no-shell": { type: "boolean" },
      "no-files": { type: "boolean" },
      "new-token": { type: "boolean" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
    strict: true,
  });
  if (values.help) return void process.stdout.write(HELP);
  if (values.version) return void process.stdout.write(`${VERSION}\n`);

  const path = values.config ?? defaultConfigPath();
  const { config, created } = loadConfig(path, { newToken: values["new-token"] });
  if (values.port) {
    const p = Number(values.port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error(`--port must be a number from 1 to 65535, not ${values.port}`);
    config.port = p;
  }
  const tools = { shell: config.tools.shell && !values["no-shell"], files: config.tools.files && !values["no-files"] };
  if (values["new-token"]) saveConfig(path, config);

  const log = (line: string) => process.stderr.write(`${stamp()} ${line}\n`);
  const hub = new Hub({ ...config, tools }, log);
  await hub.start();
  const http = await listen(hub, { port: config.port, token: config.token, log }).catch((e: NodeJS.ErrnoException) => {
    if (e.code === "EADDRINUSE") throw new Error(`Port ${config.port} is in use: is gemini-mcp-bridge-server already running? Another port: --port <n>`, { cause: e });
    throw e;
  });

  const names = (await hub.listTools()).map((t) => t.name);
  const out = [
    `gemini-mcp-bridge-server ${VERSION}`,
    `  URL:    http://127.0.0.1:${config.port}/mcp`,
    `  Token:  ${config.token}`,
    `  Config: ${path}${created ? " (new)" : ""}`,
    `  Tools:  ${names.length ? names.join(", ") : "none"}`,
    ...hub.status().filter((s) => !s.ok).map((s) => `  Not running yet: ${s.name}${s.error ? ` (${s.error})` : " (starting)"}`),
    "",
    "In Chrome: click the Gemini MCP Bridge icon > Settings, and enter the URL and the token.",
    "Leave this window open while you use Gemini; Ctrl+C stops the server.",
    "",
  ];
  process.stdout.write(out.join("\n"));

  const stop = async () => {
    http.close();
    await hub.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());
}

main().catch((e: unknown) => {
  process.stderr.write(`gemini-mcp-bridge-server: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
