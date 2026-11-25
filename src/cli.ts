// gemini-mcp-bridge-server: the local MCP server that the Gemini MCP Bridge extension talks to.

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { defaultConfigPath, loadConfig, saveConfig } from "./config.ts";
import { listen } from "./http.ts";
import { Hub, VERSION } from "./hub.ts";
import { fromNpxCache, install, logPath, NAME, uninstall } from "./service.ts";

const HELP = `${NAME} ${VERSION}: your computer's tools for Gemini on the web, through the Gemini MCP Bridge extension

Usage:
  ${NAME} [options]                     Start the server
  ${NAME} token [--config <file>]       Show the URL and the token for the extension
  ${NAME} install-service [options]     Start the server whenever you log in (and now)
  ${NAME} uninstall-service             Stop doing that

Options:
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

function parse() {
  return parseArgs({
    allowPositionals: true,
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
}

function port(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const p = Number(value);
  if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error(`--port must be a number from 1 to 65535, not ${value}`);
  return p;
}

async function main(): Promise<void> {
  const { values, positionals } = parse();
  const command = positionals[0] ?? "serve";
  if (values.help) return void process.stdout.write(HELP);
  if (values.version) return void process.stdout.write(`${VERSION}\n`);
  const path = values.config ?? defaultConfigPath();

  if (command === "token") {
    const { config } = loadConfig(path);
    process.stdout.write(`URL:   http://127.0.0.1:${port(values.port, config.port)}/mcp\nToken: ${config.token}\n`);
    return;
  }
  if (command === "uninstall-service") {
    process.stdout.write(`${uninstall().join("\n")}\n`);
    return;
  }
  if (command === "install-service") {
    const script = realpathSync(fileURLToPath(import.meta.url));
    if (fromNpxCache(script)) {
      throw new Error(`npx runs ${NAME} from a cache that npm may clean. Install it first, then install the service:\n  npm install -g ${NAME}\n  ${NAME} install-service`);
    }
    // the port and the tools go into the config, so that `token` and a later manual start agree with the service
    const { config } = loadConfig(path, { newToken: values["new-token"] });
    config.port = port(values.port, config.port);
    if (values["no-shell"]) config.tools.shell = false;
    if (values["no-files"]) config.tools.files = false;
    saveConfig(path, config);
    const lines = install({ command: [process.execPath, script, "--config", path], log: logPath() });
    process.stdout.write(`${lines.join("\n")}\n\nFor the extension's options:\n`);
    process.stdout.write(`  URL:   http://127.0.0.1:${config.port}/mcp\n  Token: ${config.token}\n`);
    return;
  }
  if (command !== "serve") throw new Error(`Unknown command: ${command}. See ${NAME} --help`);

  const { config, created } = loadConfig(path, { newToken: values["new-token"] });
  config.port = port(values.port, config.port);
  const tools = { shell: config.tools.shell && !values["no-shell"], files: config.tools.files && !values["no-files"] };
  if (values["new-token"]) saveConfig(path, config);

  const log = (line: string) => process.stderr.write(`${stamp()} ${line}\n`);
  const hub = new Hub({ ...config, tools }, log);
  await hub.start();
  const http = await listen(hub, { port: config.port, token: config.token, log }).catch((e: NodeJS.ErrnoException) => {
    if (e.code === "EADDRINUSE") throw new Error(`Port ${config.port} is in use: is ${NAME} already running (perhaps as a service)? Another port: --port <n>`, { cause: e });
    throw e;
  });

  const names = (await hub.listTools()).map((t) => t.name);
  // the token goes only to a terminal: as a service, the output ends in a log file
  const token = process.stdout.isTTY ? config.token : `(not printed here; run: ${NAME} token)`;
  const out = [
    `${NAME} ${VERSION}`,
    `  URL:    http://127.0.0.1:${config.port}/mcp`,
    `  Token:  ${token}`,
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
  process.stderr.write(`${NAME}: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
