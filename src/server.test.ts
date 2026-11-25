import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { request, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { loadConfig, type Config } from "./config.ts";
import { listen } from "./http.ts";
import { Hub } from "./hub.ts";

const TOKEN = "test-token-0123456789abcdef";
const dir = mkdtempSync(join(tmpdir(), "gmbs-test-"));
let http: HttpServer;
let hub: Hub;
let url: string;

function config(extra: Partial<Config> = {}): Config {
  return {
    port: 0,
    token: TOKEN,
    tools: { shell: true, files: true },
    mcpServers: { up: { command: process.execPath, args: [join(import.meta.dirname, "..", "test", "upstream.mjs")] } },
    ...extra,
  };
}

before(async () => {
  writeFileSync(join(dir, "hello.txt"), "line1\nline2\nline3\n");
  hub = new Hub(config());
  await hub.start();
  http = await listen(hub, { port: 0, token: TOKEN });
  url = `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`;
});

after(async () => {
  http.close();
  await hub.close();
  rmSync(dir, { recursive: true, force: true });
});

async function connect(token = TOKEN): Promise<Client> {
  const c = new Client({ name: "test", version: "1.0.0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  return c;
}

async function call(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const c = await connect();
  try {
    const r = (await c.callTool({ name, arguments: args })) as CallToolResult;
    const text = r.content
      .filter((x) => x.type === "text")
      .map((x) => x.text)
      .join("\n");
    return { text, isError: r.isError === true };
  } finally {
    await c.close();
  }
}

describe("tools", () => {
  it("lists the built-in tools and the pass-through ones, with instructions about the computer", async () => {
    const c = await connect();
    assert.equal(c.getServerVersion()?.name, "gemini-mcp-bridge-server");
    assert.match(c.getInstructions() ?? "", /Home folder: /);
    assert.match(c.getInstructions() ?? "", /Tools named up__\*: Adds numbers\./);
    const names = (await c.listTools()).tools.map((t) => t.name);
    assert.deepEqual(names, ["run_command", "read_file", "write_file", "list_directory", "up__add"]);
    await c.close();
  });

  it("leaves out the tools turned off", async () => {
    const h = new Hub(config({ tools: { shell: false, files: true }, mcpServers: {} }));
    assert.deepEqual(
      (await h.listTools()).map((t) => t.name),
      ["read_file", "write_file", "list_directory"],
    );
    const r = await h.callTool("run_command", { command: "echo no" });
    assert.equal(r.isError, true);
    assert.match(JSON.stringify(r.content), /Unknown tool: run_command/);
  });

  it("reads, writes and lists files", async () => {
    assert.match((await call("list_directory", { path: dir })).text, /\[FILE\] hello\.txt \(18 bytes\)/);
    assert.equal((await call("read_file", { path: join(dir, "hello.txt"), offset: 2, limit: 1 })).text, "[lines 2-2 of 4]\nline2");
    await call("write_file", { path: join(dir, "sub", "new.txt"), content: "hi" });
    await call("write_file", { path: join(dir, "sub", "new.txt"), content: "!", append: true });
    assert.equal(readFileSync(join(dir, "sub", "new.txt"), "utf8"), "hi!");
    assert.equal((await call("read_file", { path: join(dir, "nope.txt") })).isError, true);
    assert.equal((await call("read_file", { path: dir })).isError, true);
    assert.equal((await call("read_file", {})).isError, true);
  });

  it("runs commands, with exit code and time limit", async () => {
    assert.equal((await call("run_command", { command: "echo out; echo err >&2; exit 3", cwd: dir })).text, "exit code: 3\n--- stdout ---\nout\n--- stderr ---\nerr");
    const slow = await call("run_command", { command: "sleep 5", timeout_seconds: 1 });
    assert.equal(slow.isError, true);
    assert.match(slow.text, /Stopped after 1 s/);
  });

  it("passes calls through to the stdio server", async () => {
    assert.equal((await call("up__add", { a: 2, b: 40 })).text, "42");
    const bad = await call("nope__x", {});
    assert.equal(bad.isError, true);
    assert.match(bad.text, /Unknown tool/);
  });
});

describe("hard cases", () => {
  const upstream = (env: Record<string, string> = {}) => ({ command: process.execPath, args: [join(import.meta.dirname, "..", "test", "upstream.mjs")], env });

  it("answers when the shell exits, even if it left something running", async () => {
    const started = Date.now();
    const r = await call("run_command", { command: "sleep 30 & echo started", timeout_seconds: 5 });
    assert.equal(r.text, "exit code: 0\n--- stdout ---\nstarted");
    assert.ok(Date.now() - started < 3000, `took ${Date.now() - started} ms`);
  });

  it("keeps multibyte output whole across pipe chunks", async () => {
    const r = await call("run_command", { command: `node -e "process.stdout.write('한'.repeat(60000))"` });
    assert.ok(!r.text.includes("\uFFFD"));
    assert.equal((r.text.match(/한/g) ?? []).length, 60000);
  });

  it("stops a command when the call is cancelled", async () => {
    const h = new Hub(config({ mcpServers: {} }));
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 300);
    const started = Date.now();
    const r = await h.callTool("run_command", { command: "sleep 20" }, ctrl.signal);
    assert.equal(r.isError, true);
    assert.match(JSON.stringify(r.content), /cancelled/);
    assert.ok(Date.now() - started < 3000);
  });

  it("refuses to read a FIFO", async () => {
    if (process.platform === "win32") return;
    const fifo = join(dir, "fifo");
    const { execFileSync } = await import("node:child_process");
    execFileSync("mkfifo", [fifo]);
    const r = await call("read_file", { path: fifo });
    assert.equal(r.isError, true);
    assert.match(r.text, /not a regular file/);
  });

  it("lists the built-in tools at once while a pass-through server hangs", async () => {
    const h = new Hub(config({ mcpServers: { stuck: { command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"] } } }));
    const started = Date.now();
    const names = (await h.listTools()).map((t) => t.name);
    assert.deepEqual(names, ["run_command", "read_file", "write_file", "list_directory"]);
    assert.ok(Date.now() - started < 1000);
    await h.close();
  });

  it("routes by the exact name when server names contain the separator", async () => {
    const h = new Hub(config({ mcpServers: { a: upstream({ UP_PREFIX: "a:" }), a__b: upstream({ UP_PREFIX: "a__b:" }) } }));
    await h.start();
    const names = (await h.listTools()).map((t) => t.name);
    assert.ok(names.includes("a__add") && names.includes("a__b__add"), names.join(","));
    assert.match(JSON.stringify((await h.callTool("a__b__add", { a: 1, b: 2 })).content), /a__b:3/);
    assert.match(JSON.stringify((await h.callTool("a__add", { a: 1, b: 2 })).content), /"a:3"/);
    await h.close();
  });
});

describe("refuses", () => {
  const post = (headers: Record<string, string>) =>
    fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });

  it("a request without the right token", async () => {
    assert.equal((await post({})).status, 401);
    assert.equal((await post({ authorization: "Bearer wrong" })).status, 401);
    await assert.rejects(connect("wrong"));
  });

  it("a web page's origin, even with the token", async () => {
    assert.equal((await post({ authorization: `Bearer ${TOKEN}`, origin: "https://evil.example" })).status, 403);
  });

  it("a foreign Host (DNS rebinding)", async () => {
    const status = await new Promise<number>((resolve) => {
      const port = new URL(url).port;
      const req = request({ host: "127.0.0.1", port, path: "/mcp", method: "POST", headers: { host: `evil.example:${port}`, authorization: `Bearer ${TOKEN}` } }, (res) =>
        resolve(res.statusCode ?? 0),
      );
      req.end("{}");
    });
    assert.equal(status, 403);
  });

  it("other methods and paths", async () => {
    assert.equal((await fetch(url, { headers: { authorization: `Bearer ${TOKEN}` } })).status, 405);
    assert.equal((await fetch(url.replace("/mcp", "/other"))).status, 404);
  });

  it("but accepts the extension's origin", async () => {
    assert.equal((await post({ authorization: `Bearer ${TOKEN}`, origin: "chrome-extension://abcdefghijklmnop" })).status, 200);
  });
});

describe("config file", () => {
  it("is created with a token, readable only by the user, and kept", () => {
    const path = join(dir, "cfg", "config.json");
    const a = loadConfig(path);
    assert.equal(a.created, true);
    assert.ok(a.config.token.length >= 24);
    if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o777, 0o600);
    const b = loadConfig(path);
    assert.equal(b.created, false);
    assert.equal(b.config.token, a.config.token);
    assert.notEqual(loadConfig(path, { newToken: true }).config.token, a.config.token);
  });
});
