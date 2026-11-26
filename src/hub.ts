// All tools of the server in one list: the built-in ones, then those of each MCP server in the config, whose
// names get the server's name in front ("playwright__browser_navigate").

import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ToolListChangedNotificationSchema, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";
import pkg from "../package.json" with { type: "json" };
import { builtinTools, callBuiltin, systemNote } from "./builtin.ts";
import type { Config, UpstreamConfig } from "./config.ts";

export const VERSION = pkg.version;
const SEPARATOR = "__";
const CALL_TIMEOUT_MS = 30 * 60 * 1000;
const CONNECT_TIMEOUT_MS = 20_000;
/** A server that keeps failing is started again after 0.25 s, 0.5 s, 1 s ... up to this. */
const MAX_BACKOFF_MS = 30_000;
/** A connection that lasted this long counts as healthy: the next failure starts the backoff over. */
const HEALTHY_MS = 30_000;
/** How long the start waits for the pass-through servers before it reports; slower ones join later. */
const START_WAIT_MS = 5_000;

type Log = (line: string) => void;

class Upstream {
  readonly name: string;
  private readonly cfg: UpstreamConfig;
  private readonly log: Log;
  private client: Client | undefined;
  /** The client being connected, so that close() can stop a server that is still starting. */
  private pending: Client | undefined;
  private closed = false;
  private starting: Promise<void> | undefined;
  private failures = 0;
  private failedAt = 0;
  private connectedAt = 0;
  /** The last tools the server listed; kept while it restarts, so that a call reaches it again. */
  tools: Tool[] = [];
  instructions = "";
  error = "";

  constructor(name: string, cfg: UpstreamConfig, log: Log) {
    this.name = name;
    this.cfg = cfg;
    this.log = log;
  }

  get ok(): boolean {
    return this.client !== undefined;
  }

  /** Connects when not connected; after failures, waits longer each time before trying again. */
  ensure(): Promise<void> {
    if (this.client || this.closed) return Promise.resolve();
    const backoff = this.failures ? Math.min(MAX_BACKOFF_MS, 250 * 2 ** (this.failures - 1)) : 0;
    if (Date.now() - this.failedAt < backoff) return Promise.resolve();
    return (this.starting ??= this.start().finally(() => (this.starting = undefined)));
  }

  /** `lostConnection`: it ran and stopped (a long healthy run starts the backoff over); else it could not start. */
  private failed(lostConnection: boolean): void {
    this.failures = lostConnection && Date.now() - this.connectedAt > HEALTHY_MS ? 1 : this.failures + 1;
    this.failedAt = Date.now();
  }

  private async start(): Promise<void> {
    const client = new Client({ name: "gemini-mcp-bridge-server", version: VERSION });
    this.pending = client;
    try {
      let transport: StdioClientTransport | StreamableHTTPClientTransport;
      if ("url" in this.cfg) {
        transport = new StreamableHTTPClientTransport(new URL(this.cfg.url), { requestInit: { headers: this.cfg.headers ?? {} } });
      } else {
        // the SDK adds a minimal environment (PATH, HOME ...) to `env`
        const stdio = new StdioClientTransport({ command: this.cfg.command, args: this.cfg.args, env: this.cfg.env, cwd: this.cfg.cwd, stderr: "pipe" });
        // whole lines: a chunk of the pipe may end in the middle of one
        if (stdio.stderr) createInterface({ input: stdio.stderr as Readable }).on("line", (line) => line.trim() && this.log(`[${this.name}] ${line}`));
        transport = stdio;
      }
      client.onclose = () => {
        if (this.client !== client) return;
        this.client = undefined;
        this.error = "disconnected";
        this.failed(true);
        if (!this.closed) this.log(`[${this.name}] disconnected`);
      };
      await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
      client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
        this.tools = await this.listAll(client).catch(() => this.tools);
      });
      this.tools = await this.listAll(client);
      if (this.closed) throw new Error("closed");
      this.instructions = client.getInstructions() ?? "";
      this.client = client;
      this.connectedAt = Date.now();
      this.error = "";
      this.log(`[${this.name}] connected: ${this.tools.length} tools`);
    } catch (e) {
      this.failed(false);
      this.error = e instanceof Error ? e.message : String(e);
      if (!this.closed) this.log(`[${this.name}] cannot start: ${this.error}`);
      await client.close().catch(() => undefined);
    } finally {
      if (this.pending === client) this.pending = undefined;
    }
  }

  private async listAll(client: Client): Promise<Tool[]> {
    const all: Tool[] = [];
    let cursor: string | undefined;
    do {
      const r = await client.listTools(cursor ? { cursor } : {});
      all.push(...r.tools);
      cursor = r.nextCursor;
    } while (cursor);
    return all;
  }

  async call(tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<CallToolResult> {
    await this.ensure();
    if (!this.client) throw new Error(`The MCP server "${this.name}" is not running: ${this.error || "starting"}`);
    return (await this.client.callTool({ name: tool, arguments: args }, undefined, { timeout: CALL_TIMEOUT_MS, resetTimeoutOnProgress: true, signal })) as CallToolResult;
  }

  async close(): Promise<void> {
    this.closed = true;
    const clients = [this.client, this.pending].filter((c) => c !== undefined);
    this.client = undefined;
    this.pending = undefined;
    // closing the client closes its transport, which ends the server's process
    await Promise.all(clients.map((c) => c.close().catch(() => undefined)));
  }
}

export class Hub {
  private readonly builtin: Tool[];
  private readonly builtinNames: Set<string>;
  private readonly note: string;
  private readonly upstreams: Upstream[];
  private readonly log: Log;

  constructor(config: Config, log: Log = () => undefined) {
    this.log = log;
    this.builtin = builtinTools(config.tools);
    this.builtinNames = new Set(this.builtin.map((t) => t.name));
    this.note = systemNote(config.tools);
    this.upstreams = Object.entries(config.mcpServers)
      .filter(([, c]) => !c.disabled)
      .map(([name, c]) => new Upstream(name, c, log));
  }

  /** Starts the pass-through servers; waits a few seconds for them, so that the first report is complete. */
  async start(): Promise<void> {
    const all = Promise.all(this.upstreams.map((u) => u.ensure()));
    await Promise.race([all, new Promise((r) => setTimeout(r, START_WAIT_MS).unref())]);
  }

  /** The tools there are now. A pass-through server that is (re)starting is not waited for: it joins the list once it runs. */
  listTools(): Tool[] {
    for (const u of this.upstreams) void u.ensure();
    return [...this.builtin, ...this.passThrough().map((p) => ({ ...p.tool, name: p.name }))];
  }

  private passThrough(): { name: string; upstream: Upstream; tool: Tool }[] {
    return this.upstreams.flatMap((u) => u.tools.map((t) => ({ name: `${u.name}${SEPARATOR}${t.name}`, upstream: u, tool: t })));
  }

  instructions(): string {
    const parts = [this.note];
    for (const u of this.upstreams) if (u.ok && u.instructions.trim()) parts.push(`Tools named ${u.name}${SEPARATOR}*: ${u.instructions.trim()}`);
    return parts.join("\n");
  }

  /** The pass-through servers that are not running, for the start report. */
  notRunning(): { name: string; error: string }[] {
    return this.upstreams.filter((u) => !u.ok).map((u) => ({ name: u.name, error: u.error }));
  }

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<CallToolResult> {
    const started = Date.now();
    let result: CallToolResult;
    try {
      result = await this.route(name, args, signal);
    } catch (e) {
      result = { content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }], isError: true };
    }
    const ms = Date.now() - started;
    // a failure shows its message too, so the console tells why without opening the page
    this.log(`call ${name} ${short(args)} → ${result.isError ? `error: ${errorText(result)}` : "ok"} (${ms} ms)`);
    return result;
  }

  private async route(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<CallToolResult> {
    if (this.builtinNames.has(name)) return await callBuiltin(name, args, signal);
    // by the exact exposed name: server names may contain the separator too
    const p = this.passThrough().find((x) => x.name === name);
    if (!p) throw new Error(`Unknown tool: ${name}`);
    return await p.upstream.call(p.tool.name, args, signal);
  }

  async close(): Promise<void> {
    await Promise.all(this.upstreams.map((u) => u.close()));
  }
}

function short(args: Record<string, unknown>): string {
  const s = JSON.stringify(args);
  return s.length > 160 ? `${s.slice(0, 157)}...` : s;
}

/** The text of an error result on one line, cut to 300 characters. */
function errorText(result: CallToolResult): string {
  const parts = Array.isArray(result.content) ? result.content : [];
  const s = parts
    .map((c) => (c.type === "text" ? c.text : `[${c.type}]`))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  if (!s) return "(no message)";
  return s.length > 300 ? `${s.slice(0, 297)}...` : s;
}
