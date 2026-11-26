// Runs the built dist/cli.js the way users do, on the Node version at hand (CI runs it on the oldest one
// package.json allows): --version, token, then a real start and an MCP tools/list over HTTP.

import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cli = "dist/cli.js";
const dir = mkdtempSync(join(tmpdir(), "gmbs-smoke-"));
const config = join(dir, "config.json");
const fail = (msg) => {
  rmSync(dir, { recursive: true, force: true });
  console.error(`smoke: ${msg}`);
  process.exit(1);
};

const { name, version } = JSON.parse(readFileSync("package.json", "utf8"));
const printed = execFileSync(process.execPath, [cli, "--version"], { encoding: "utf8" }).trim();
if (printed !== version) fail(`--version printed ${printed}, package.json has ${version}`);
const token = execFileSync(process.execPath, [cli, "token", "--config", config], { encoding: "utf8" }).match(/Token: (\S+)/)?.[1];
if (!token) fail("token printed no token");

const port = 40000 + Math.floor(Math.random() * 20000);
const server = spawn(process.execPath, [cli, "--config", config, "--port", String(port)], { stdio: ["ignore", "pipe", "inherit"] });
await new Promise((resolve, reject) => {
  let out = "";
  server.stdout.on("data", (c) => {
    out += c;
    if (out.includes("Tools:")) resolve();
  });
  server.on("exit", (code) => reject(new Error(`the server exited with ${code}`)));
  setTimeout(() => reject(new Error("the server did not start within 15 s")), 15000);
}).catch((e) => fail(e.message));

const headers = { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` };
const rpc = async (method, params = {}) => {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  return (await res.json()).result;
};
const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "1" } });
const tools = (await rpc("tools/list")).tools.map((t) => t.name);
server.kill("SIGTERM");
rmSync(dir, { recursive: true, force: true });
if (init?.serverInfo?.name !== name) fail(`initialize answered ${JSON.stringify(init)}`);
// write_file only without bash (cmd.exe on Windows): elsewhere run_command writes files
const expected = process.platform === "win32" ? "run_command,read_file,write_file,list_directory" : "run_command,read_file,list_directory";
if (tools.join(",") !== expected) fail(`tools/list answered ${tools.join(",")}`);
console.log(`smoke: ${version} on Node ${process.versions.node}: --version, token, start, tools/list all fine`);
