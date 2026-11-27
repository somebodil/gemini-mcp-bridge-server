// local-mcp-bridge-server: the local MCP server that the Gemini MCP Bridge extension talks to.

import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { stopAllCommands } from "./builtin.ts";
import { defaultConfigPath, loadConfig, takeOverFormerConfig, validPort } from "./config.ts";
import { listen } from "./http.ts";
import { Hub, VERSION } from "./hub.ts";
import { consoleLogger } from "./log.ts";
import { FORMER_NAME, NAME } from "./name.ts";
import { perfLogPath, showPerf } from "./perf.ts";

const HELP = `${NAME} ${VERSION}: your computer's tools for chats on the web, through the Gemini MCP Bridge extension

Usage:
  ${NAME} [options]                     Start the server
  ${NAME} token [--config <file>]       Show the URL and the token for the extension
  ${NAME} perf-log [--config <file>]    Show the extension's performance log (an option of the extension)

Options:
  --port <n>       Port (default: from the config, 7341)
  --config <file>  Config file (default: ${defaultConfigPath()})
  --no-shell       Without the run_command tool
  --no-files       Without read_file, list_directory (and write_file, there without bash or the shell)
  --new-token      Make a new token (the extension then needs the new one)
  -h, --help       This text
  -v, --version    The version

While it runs, it writes each request to stdout as it comes: the call and its arguments, each step of the
work, and the reply; WARN and ERROR lines when something goes wrong.

The config file also lists MCP servers to pass through, in the usual "mcpServers" shape:
  "mcpServers": { "playwright": { "command": "npx", "args": ["@playwright/mcp@latest"] } }

Until 0.6.0 its name was ${FORMER_NAME}: without --config, the first start (or token) copies that name's config
file (the token, the port, the servers).
`;

function port(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const p = Number(value);
  if (!validPort(p)) throw new Error(`--port must be a number from 1 to 65535, not ${value}`);
  return p;
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
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
  const command = positionals[0] ?? "serve";
  if (values.help) return void process.stdout.write(HELP);
  if (values.version) return void process.stdout.write(`${VERSION}\n`);
  const path = values.config ? resolve(values.config) : defaultConfigPath();
  if (command === "perf-log") return void process.stdout.write(showPerf(perfLogPath(path)));
  // the first command that reads the default config takes over the file of the former name
  const copied = values.config ? undefined : takeOverFormerConfig(path);

  if (command === "token") {
    const { config } = loadConfig(path);
    return void process.stdout.write(`URL:   http://127.0.0.1:${config.port}/mcp\nToken: ${config.token}\n`);
  }
  if (command !== "serve") throw new Error(`Unknown command: ${command}. See ${NAME} --help`);

  const { config, created } = loadConfig(path, { newToken: values["new-token"] });
  const listenPort = port(values.port, config.port);
  const tools = { shell: config.tools.shell && !values["no-shell"], files: config.tools.files && !values["no-files"] };
  const log = consoleLogger();
  // a console closed under the server: the server goes on without its log
  process.stdout.on("error", () => undefined);
  // a mistake of the server's own is said at once; one request's failure never ends the server (http.ts)
  process.on("unhandledRejection", (e) => log.error(`unexpected failure: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`));
  process.on("uncaughtExceptionMonitor", (e) => log.error(`the server stops on an error of its own: ${e.stack ?? e.message}`));
  // the folder npx was started in: commands start there, and relative paths ($HOME stays the home folder)
  const work = process.cwd();
  const hub = new Hub({ ...config, tools }, log, work);
  // the port first: a second instance learns at once that it is taken
  const perfLog = perfLogPath(path);
  const http = await listen(hub, { port: listenPort, token: config.token, log, perfLog }).catch(async (e: NodeJS.ErrnoException) => {
    await hub.close();
    if (e.code === "EADDRINUSE") throw new Error(`Port ${listenPort} is in use: is ${NAME} already running in another window? Another port: --port <n>`, { cause: e });
    throw e;
  });
  let stopping = false;
  const stop = async () => {
    // a second Ctrl+C does not wait for the first
    if (stopping) process.exit(1);
    stopping = true;
    log.info("stopping");
    stopAllCommands();
    http.close();
    await hub.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());

  await hub.start();
  const names = hub.listTools().map((t) => t.name);
  // the token goes only to a terminal, not into a file or a pipe the output is sent to
  const token = process.stdout.isTTY ? config.token : `(not printed here; run: ${NAME} token)`;
  const out = [
    `${NAME} ${VERSION}`,
    `  URL:    http://127.0.0.1:${listenPort}/mcp`,
    `  Token:  ${token}`,
    `  Config: ${path}${created ? " (new)" : copied ? ` (copied from ${copied})` : ""}`,
    `  Perf:   ${perfLog} (when the extension's performance log is on)`,
    `  Folder: ${work} (the working folder: commands start here, and relative paths)`,
    `  Tools:  ${names.length ? names.join(", ") : "none"}`,
    ...hub.notRunning().map((s) => `  Not running yet: ${s.name}${s.error ? ` (${s.error})` : " (starting)"}`),
    "",
    "In Chrome: click the Gemini MCP Bridge icon > Settings, and enter the URL and the token.",
    "From another computer, or through a forwarded port: the same URL with that address and port.",
    "Leave this window open while you use the extension; Ctrl+C stops the server.",
    "Each request is written below as it comes: the call, each step of the work, and the reply (WARN and ERROR when something goes wrong).",
    "",
  ];
  process.stdout.write(out.join("\n"));
}

main().catch((e: unknown) => {
  process.stderr.write(`${NAME}: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
