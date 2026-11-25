import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
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
import { Hub, VERSION } from "./hub.ts";

const TOKEN = "test-token-0123456789abcdef";
const WIN = process.platform === "win32";
/** A command line that runs JavaScript with this node, the same under sh and cmd.exe (no " $ ` > in `js`). */
const node = (js: string) => `"${process.execPath}" -e "${js}"`;
const UPSTREAM = join(import.meta.dirname, "..", "test", "upstream.mjs");
const upstream = (env: Record<string, string> = {}) => ({ command: process.execPath, args: [UPSTREAM], env });
const dir = mkdtempSync(join(tmpdir(), "gmbs-test-"));
let http: HttpServer;
let hub: Hub;
let url: string;

function config(extra: Partial<Config> = {}): Config {
  return { port: 7341, token: TOKEN, tools: { shell: true, files: true }, mcpServers: { up: upstream() }, ...extra };
}

before(async () => {
  writeFileSync(join(dir, "hello.txt"), "line1\nline2\nline3\n");
  hub = new Hub(config());
  await hub.start();
  http = await listen(hub, { port: 0, token: TOKEN });
  url = `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`;
});

after(async () => {
  http.closeAllConnections();
  http.close();
  await hub.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A hub of its own for one test, closed even when the test fails (its child processes would keep the run alive). */
async function withHub(cfg: Config, fn: (h: Hub) => void | Promise<void>, start = true): Promise<void> {
  const h = new Hub(cfg);
  try {
    if (start) await h.start();
    await fn(h);
  } finally {
    await h.close();
  }
}

async function connect(token = TOKEN, to = url): Promise<Client> {
  const c = new Client({ name: "test", version: "1.0.0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(to), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  return c;
}

const textOf = (r: CallToolResult) =>
  r.content
    .filter((x) => x.type === "text")
    .map((x) => x.text)
    .join("\n");

async function call(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const c = await connect();
  try {
    const r = (await c.callTool({ name, arguments: args })) as CallToolResult;
    return { text: textOf(r), isError: r.isError === true };
  } finally {
    await c.close();
  }
}

describe("tools", () => {
  it("lists the built-in tools and the pass-through ones, with instructions about the computer", async () => {
    const c = await connect();
    assert.equal(c.getServerVersion()?.name, "gemini-mcp-bridge-server");
    assert.equal(c.getServerVersion()?.version, VERSION);
    assert.match(c.getInstructions() ?? "", /Home folder: .*Relative paths in the tools start there/);
    assert.match(c.getInstructions() ?? "", /run_command uses /);
    assert.match(c.getInstructions() ?? "", /Tools named up__\*: Adds numbers\./);
    const names = (await c.listTools()).tools.map((t) => t.name);
    assert.deepEqual(names, ["run_command", "read_file", "write_file", "list_directory", "up__add"]);
    await c.close();
  });

  it("leaves out the tools turned off, and does not tell Gemini about them", async () => {
    const h = new Hub(config({ tools: { shell: false, files: true }, mcpServers: { off: { ...upstream(), disabled: true } } }));
    assert.deepEqual(
      h.listTools().map((t) => t.name),
      ["read_file", "write_file", "list_directory"],
    );
    assert.doesNotMatch(h.instructions(), /run_command/);
    const r = await h.callTool("run_command", { command: "echo no" });
    assert.equal(r.isError, true);
    assert.match(textOf(r), /Unknown tool: run_command/);
    assert.doesNotMatch(new Hub(config({ tools: { shell: false, files: false }, mcpServers: {} })).instructions(), /Relative paths/);
  });

  it("reads, writes and lists files", async () => {
    assert.match((await call("list_directory", { path: dir })).text, /\[FILE\] hello\.txt \(18 bytes\)/);
    assert.equal((await call("read_file", { path: join(dir, "hello.txt"), offset: 2, limit: 1 })).text, "[lines 2-2 of 3]\nline2");
    assert.equal((await call("read_file", { path: join(dir, "hello.txt"), offset: "3" })).text, "[lines 3-3 of 3]\nline3");
    await call("write_file", { path: join(dir, "sub", "new.txt"), content: "hi" });
    await call("write_file", { path: join(dir, "sub", "new.txt"), content: "!", append: true });
    assert.equal(readFileSync(join(dir, "sub", "new.txt"), "utf8"), "hi!");
  });

  it("explains what it cannot read", async () => {
    const f = join(dir, "hello.txt");
    assert.match((await call("read_file", { path: join(dir, "nope.txt") })).text, /ENOENT/);
    assert.match((await call("read_file", { path: dir })).text, /is a folder; use list_directory/);
    assert.match((await call("read_file", {})).text, /"path" must be a string/);
    assert.match((await call("read_file", { path: f, offset: 9 })).text, /has 3 lines; there is no line 9/);
    assert.match((await call("read_file", { path: f, limit: 0 })).text, /"limit" must be 1 or more/);
    writeFileSync(join(dir, "bin.dat"), Buffer.from([1, 0, 2]));
    assert.match((await call("read_file", { path: join(dir, "bin.dat") })).text, /is a binary file \(3 bytes\)/);
    writeFileSync(join(dir, "big.txt"), "");
    truncateSync(join(dir, "big.txt"), 5 * 1024 * 1024);
    assert.match((await call("read_file", { path: join(dir, "big.txt") })).text, /files over 4194304 bytes are not read/);
  });

  it("lists links as what they point to, and long folders in part", async () => {
    const d = join(dir, "links");
    mkdirSync(join(d, "real"), { recursive: true });
    writeFileSync(join(d, "f.txt"), "abc");
    if (!WIN) {
      symlinkSync(join(d, "real"), join(d, "to-dir"));
      symlinkSync(join(d, "f.txt"), join(d, "to-file"));
      symlinkSync(join(d, "missing"), join(d, "broken"));
    }
    const listing = (await call("list_directory", { path: d })).text.split("\n").slice(1);
    const expected = WIN
      ? ["[DIR]  real/", "[FILE] f.txt (3 bytes)"]
      : ["[DIR]  real/", "[DIR]  to-dir/ (link)", "[FILE] f.txt (3 bytes)", "[FILE] to-file (3 bytes) (link)", "[LINK] broken (broken)"];
    assert.deepEqual(listing, expected);
    const many = join(dir, "many");
    mkdirSync(many);
    for (let i = 0; i < 1005; i++) writeFileSync(join(many, `f${String(i).padStart(4, "0")}`), "");
    const out = (await call("list_directory", { path: many })).text.split("\n");
    assert.equal(out.length, 1 + 1000 + 1);
    assert.equal(out.at(-1), "... and 5 more");
  });

  it("runs commands, with exit code, time limit and cut output", async () => {
    const r = await call("run_command", { command: node("console.log('out');console.error('err');process.exit(3)"), cwd: dir });
    assert.equal(r.text, "exit code: 3\n--- stdout ---\nout\n--- stderr ---\nerr");
    const slow = await call("run_command", { command: node("setTimeout(function(){},5000)"), timeout_seconds: "1" });
    assert.equal(slow.isError, true);
    assert.match(slow.text, /Stopped after 1 s/);
    const long = await call("run_command", { command: node("process.stdout.write('x'.repeat(250000))") });
    assert.match(long.text, /\.\.\.\[output cut at 200000 of 250000 characters\]$/);
    assert.match((await call("run_command", { command: "echo hi", cwd: join(dir, "nope") })).text, /The folder .*nope does not exist\./);
  });

  it("passes calls through to the stdio server", async () => {
    assert.equal((await call("up__add", { a: 2, b: 40 })).text, "42");
    const bad = await call("nope__x", {});
    assert.equal(bad.isError, true);
    assert.match(bad.text, /Unknown tool/);
  });
});

describe("hard cases", () => {
  it("answers when the shell exits, even if it left something running", async () => {
    const started = Date.now();
    const bg = node("setTimeout(function(){},5000)");
    const r = await call("run_command", { command: WIN ? `start /b "" ${bg} & echo started` : `${bg} & echo started`, timeout_seconds: 5 });
    assert.match(r.text, /^exit code: 0\n--- stdout ---\nstarted\r?$/);
    assert.ok(Date.now() - started < 3000, `took ${Date.now() - started} ms`);
  });

  it("keeps multibyte output whole across pipe chunks", async () => {
    const r = await call("run_command", { command: node("process.stdout.write('한'.repeat(60000))") });
    assert.ok(!r.text.includes("�"));
    assert.equal((r.text.match(/한/g) ?? []).length, 60000);
  });

  it("stops a command when the call is cancelled", async () => {
    const h = new Hub(config({ mcpServers: {} }));
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 300);
    const started = Date.now();
    const r = await h.callTool("run_command", { command: node("setTimeout(function(){},20000)") }, ctrl.signal);
    assert.equal(r.isError, true);
    assert.match(textOf(r), /cancelled/);
    assert.ok(Date.now() - started < 3000);
  });

  it("refuses to read a FIFO", { skip: WIN && "no FIFOs on Windows" }, async () => {
    const fifo = join(dir, "fifo");
    execFileSync("mkfifo", [fifo]);
    const r = await call("read_file", { path: fifo });
    assert.equal(r.isError, true);
    assert.match(r.text, /not a regular file/);
  });

  it("lists the built-in tools at once while a pass-through server hangs", async () => {
    // a server that never answers, but ends with its stdin
    const stuck = { command: process.execPath, args: ["-e", "process.stdin.resume().on('end', () => process.exit())"] };
    await withHub(
      config({ mcpServers: { stuck } }),
      (h) => {
        const started = Date.now();
        assert.deepEqual(
          h.listTools().map((t) => t.name),
          ["run_command", "read_file", "write_file", "list_directory"],
        );
        assert.ok(Date.now() - started < 1000);
      },
      false,
    );
  });

  it("routes by the exact name when server names contain the separator", async () => {
    await withHub(config({ mcpServers: { a: upstream({ UP_PREFIX: "a:" }), a__b: upstream({ UP_PREFIX: "a__b:" }) } }), async (h) => {
      const names = h.listTools().map((t) => t.name);
      assert.ok(names.includes("a__add") && names.includes("a__b__add"), names.join(","));
      assert.equal(textOf(await h.callTool("a__b__add", { a: 1, b: 2 })), "a__b:3");
      assert.equal(textOf(await h.callTool("a__add", { a: 1, b: 2 })), "a:3");
    });
  });

  it("starts a pass-through server again after it died, keeping its tools listed", async () => {
    await withHub(config({ mcpServers: { d: upstream({ UP_DIE: "1" }) } }), async (h) => {
      assert.equal(textOf(await h.callTool("d__die", {})), "bye");
      await new Promise((r) => setTimeout(r, 400));
      assert.ok(
        h.listTools().some((t) => t.name === "d__add"),
        "still listed while it restarts",
      );
      assert.equal(textOf(await h.callTool("d__add", { a: 1, b: 2 })), "3");
    });
  });

  it("passes calls through to a Streamable HTTP server, with its headers", async () => {
    const remoteHub = new Hub(config({ tools: { shell: false, files: true }, mcpServers: {} }));
    const remote = await listen(remoteHub, { port: 0, token: "remote-token-0123456789" });
    const remoteUrl = `http://127.0.0.1:${(remote.address() as AddressInfo).port}/mcp`;
    const h = new Hub(
      config({
        mcpServers: {
          remote: { url: remoteUrl, headers: { Authorization: "Bearer remote-token-0123456789" } },
          wrong: { url: remoteUrl, headers: { Authorization: "Bearer nope" } },
        },
      }),
    );
    try {
      await h.start();
      assert.ok(h.listTools().some((t) => t.name === "remote__read_file"));
      assert.equal(textOf(await h.callTool("remote__read_file", { path: join(dir, "hello.txt"), limit: 1 })), "[lines 1-1 of 3]\nline1");
      const wrong = h.notRunning().find((s) => s.name === "wrong");
      assert.match(wrong?.error ?? "", /Missing or wrong token/);
    } finally {
      await h.close();
      remote.closeAllConnections();
      remote.close();
    }
  });
});

describe("HTTP", () => {
  const post = (headers: Record<string, string>, body: string | Buffer = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }), signal?: AbortSignal) =>
    fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, body, signal });
  const auth = { authorization: `Bearer ${TOKEN}` };

  it("refuses a request without the right token", async () => {
    assert.equal((await post({})).status, 401);
    assert.equal((await post({ authorization: "Bearer wrong" })).status, 401);
    await assert.rejects(connect("wrong"));
  });

  it("refuses web pages' origins, even with the token", async () => {
    assert.equal((await post({ ...auth, origin: "https://evil.example" })).status, 403);
    assert.equal((await post({ ...auth, origin: "null" })).status, 403);
  });

  it("refuses a foreign Host (DNS rebinding)", async () => {
    const status = await new Promise<number>((resolve) => {
      const port = new URL(url).port;
      const req = request({ host: "127.0.0.1", port, path: "/mcp", method: "POST", headers: { host: `evil.example:${port}`, ...auth } }, (res) => resolve(res.statusCode ?? 0));
      req.end("{}");
    });
    assert.equal(status, 403);
  });

  it("answers bad bodies, other methods and paths", async () => {
    assert.equal((await post(auth, "{not json")).status, 400);
    assert.equal((await post(auth, Buffer.alloc(9 * 1024 * 1024, 32))).status, 413);
    assert.equal((await fetch(url, { headers: auth })).status, 405);
    assert.equal((await fetch(url.replace("/mcp", "/other"))).status, 404);
    const home = await fetch(url.replace("/mcp", "/"));
    assert.equal(home.status, 200);
    assert.match(await home.text(), /is running/);
  });

  it("accepts the extension's origin", async () => {
    assert.equal((await post({ ...auth, origin: "chrome-extension://abcdefghijklmnop" })).status, 200);
  });

  it("stops a command when the extension drops the request", async () => {
    const marker = join(dir, "marker.txt");
    const js = `setTimeout(function(){require('fs').writeFileSync(process.argv[1],'x')},1500)`;
    const ctrl = new AbortController();
    const req = post(auth, JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "run_command", arguments: { command: `${node(js)} "${marker}"` } } }), ctrl.signal);
    setTimeout(() => ctrl.abort(), 300);
    await assert.rejects(req);
    await new Promise((r) => setTimeout(r, 2000));
    assert.equal(existsSync(marker), false, "the command was stopped before it wrote");
  });
});

describe("config file", () => {
  const cfg = (name: string, content?: unknown) => {
    const p = join(dir, "cfg", name);
    mkdirSync(join(dir, "cfg"), { recursive: true });
    if (content !== undefined) writeFileSync(p, typeof content === "string" ? content : JSON.stringify(content));
    return p;
  };

  it("is created with a token, readable only by the user, and kept", () => {
    const path = cfg("new.json");
    const a = loadConfig(path);
    assert.equal(a.created, true);
    assert.ok(a.config.token.length >= 24);
    if (!WIN) assert.equal(statSync(path).mode & 0o777, 0o600);
    const b = loadConfig(path);
    assert.equal(b.created, false);
    assert.equal(b.config.token, a.config.token);
    assert.notEqual(loadConfig(path, { newToken: true }).config.token, a.config.token);
  });

  it("keeps keys it does not know, and is not rewritten when nothing changed", () => {
    const path = cfg("keep.json", { $schema: "x", note: "mine", token: "a-token-of-enough-length", port: 8000 });
    const before = readFileSync(path, "utf8");
    assert.equal(loadConfig(path).config.port, 8000);
    assert.equal(readFileSync(path, "utf8"), before, "untouched");
    loadConfig(path, { newToken: true });
    const after = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    assert.equal(after.note, "mine");
    assert.equal(after.$schema, "x");
    assert.equal(after.port, 8000);
  });

  it("replaces a short token, and closes a file others can read", { skip: WIN && "no file modes on Windows" }, () => {
    const path = cfg("short.json", { token: "short" });
    chmodSync(path, 0o644);
    const t = loadConfig(path).config.token;
    assert.ok(t.length >= 24);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    const open = cfg("open.json", { token: "a-token-of-enough-length" });
    chmodSync(open, 0o644);
    loadConfig(open);
    assert.equal(statSync(open).mode & 0o777, 0o600);
  });

  it("says what is wrong instead of guessing", () => {
    const wrong = (content: unknown, msg: RegExp) => assert.throws(() => loadConfig(cfg("bad.json", content)), msg);
    wrong("{not json", /Cannot read .*bad\.json/);
    wrong([], /one JSON object/);
    wrong({ port: "8000" }, /"port" must be a number from 1 to 65535, not "8000"/);
    wrong({ port: 0 }, /"port" must be a number/);
    wrong({ tools: { shell: "yes" } }, /"tools\.shell" must be true or false/);
    wrong({ mcpServers: [] }, /"mcpServers" must be an object/);
    wrong({ mcpServers: { x: null } }, /"mcpServers\.x" must be an object/);
    wrong({ mcpServers: { x: { args: [] } } }, /"mcpServers\.x" needs "command"/);
    wrong({ mcpServers: { x: { command: "a", args: "b" } } }, /"mcpServers\.x\.args" must be a list of strings/);
  });
});

describe("command line", () => {
  const CLI = join(import.meta.dirname, "cli.ts");
  const run = (args: string[]) =>
    new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
      const p = spawn(process.execPath, [CLI, ...args]);
      let out = "";
      let err = "";
      p.stdout.on("data", (c: Buffer) => (out += c.toString()));
      p.stderr.on("data", (c: Buffer) => (err += c.toString()));
      p.on("close", (code) => resolve({ code, out, err }));
    });
  const path = join(dir, "cli", "config.json");

  it("prints its version and help", async () => {
    assert.equal((await run(["--version"])).out.trim(), VERSION);
    assert.match((await run(["--help"])).out, /Usage:[\s\S]*install-service/);
  });

  it("shows the URL and token of the config", async () => {
    const r = await run(["token", "--config", path]);
    const saved = JSON.parse(readFileSync(path, "utf8")) as { token: string };
    assert.equal(r.out, `URL:   http://127.0.0.1:7341/mcp\nToken: ${saved.token}\n`);
  });

  it("refuses bad input with a message and exit code 1", async () => {
    for (const [args, msg] of [
      [["--port", "abc"], /--port must be a number from 1 to 65535, not abc/],
      [["--port", "0"], /--port must be a number/],
      [["frobnicate"], /Unknown command: frobnicate/],
      [["--frobnicate"], /Unknown option '--frobnicate'/],
    ] as const) {
      const r = await run([...args, "--config", path]);
      assert.equal(r.code, 1, args.join(" "));
      assert.match(r.err, msg);
    }
  });

  it("serves on the given port without saving it, also with a new token", async () => {
    const before = JSON.parse(readFileSync(path, "utf8")) as { port: number; token: string };
    const p = spawn(process.execPath, [CLI, "--config", path, "--port", "47123", "--new-token"]);
    const out = await new Promise<string>((resolve) => {
      let s = "";
      p.stdout.on("data", (c: Buffer) => {
        s += c.toString();
        if (s.includes("Tools:")) resolve(s);
      });
    });
    p.kill("SIGINT");
    await new Promise((r) => p.on("close", r));
    assert.match(out, /URL: {4}http:\/\/127\.0\.0\.1:47123\/mcp/);
    assert.match(out, /Token: {2}\(not printed here; run: gemini-mcp-bridge-server token\)/, "no terminal: no token");
    const after = JSON.parse(readFileSync(path, "utf8")) as { port: number; token: string };
    assert.equal(after.port, before.port);
    assert.notEqual(after.token, before.token);
  });
});
