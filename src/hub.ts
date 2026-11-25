// All tools of the server in one list: the built-in ones, then those of each MCP server in the config, whose
// names get the server's name in front ("playwright__browser_navigate").

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ToolListChangedNotificationSchema, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { builtinTools, callBuiltin, systemNote } from "./builtin.ts";
import type { Config, UpstreamConfig } from "./config.ts";

export const VERSION = "0.1.0";
export const SEPARATOR = "__";
const CALL_TIMEOUT_MS = 30 * 60 * 1000;
const CONNECT_TIMEOUT_MS = 20_000;
const RETRY_AFTER_MS = 10_000;
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
  private failedAt = 0;
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

  /** Connects when not connected; after a failure, waits a little before trying again. */
  ensure(): Promise<void> {
    if (this.client || this.closed) return Promise.resolve();
    if (Date.now() - this.failedAt < RETRY_AFTER_MS) return Promise.resolve();
    return (this.starting ??= this.start().finally(() => (this.starting = undefined)));
  }

  private async start(): Promise<void> {
    const client = new Client({ name: "gemini-mcp-bridge-server", version: VERSION });
    this.pending = client;
    try {
      const transport =
        "url" in this.cfg
          ? new StreamableHTTPClientTransport(new URL(this.cfg.url), { requestInit: { headers: this.cfg.headers ?? {} } })
          : new StdioClientTransport({
              command: this.cfg.command,
              args: this.cfg.args ?? [],
              env: { ...getDefaultEnvironment(), ...(this.cfg.env ?? {}) },
              cwd: this.cfg.cwd,
              stderr: "pipe",
            });
      if (transport instanceof StdioClientTransport) {
        transport.stderr?.on("data", (c: Buffer) => {
          for (const line of c.toString("utf8").split("\n")) if (line.trim()) this.log(`[${this.name}] ${line}`);
        });
      }
      client.onclose = () => {
        if (this.client === client) {
          this.client = undefined;
          this.tools = [];
          this.error = "disconnected";
          this.log(`[${this.name}] disconnected`);
        }
      };
      await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
      client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
        this.tools = await this.listAll(client).catch(() => this.tools);
      });
      this.tools = await this.listAll(client);
      if (this.closed) throw new Error("closed");
      this.instructions = client.getInstructions() ?? "";
      this.client = client;
      this.error = "";
      this.log(`[${this.name}] connected: ${this.tools.length} tools`);
    } catch (e) {
      this.failedAt = Date.now();
      this.error = e instanceof Error ? e.message : String(e);
      this.log(`[${this.name}] cannot start: ${this.error}`);
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
    const clients = [this.client, this.pending];
    this.client = undefined;
    this.pending = undefined;
    // closing the client closes its transport, which ends the server's process
    await Promise.all(clients.filter((c) => c !== undefined).map((c) => c.close().catch(() => undefined)));
  }
}

export class Hub {
  private readonly config: Config;
  private readonly upstreams: Upstream[];
  private readonly log: Log;

  constructor(config: Config, log: Log = () => undefined) {
    this.config = config;
    this.log = log;
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
  listTools(): Promise<Tool[]> {
    for (const u of this.upstreams) void u.ensure();
    return Promise.resolve([...builtinTools(this.config.tools), ...this.passThrough().map((p) => ({ ...p.tool, name: p.name }))]);
  }

  private passThrough(): { name: string; upstream: Upstream; tool: Tool }[] {
    return this.upstreams.flatMap((u) => u.tools.map((t) => ({ name: `${u.name}${SEPARATOR}${t.name}`, upstream: u, tool: t })));
  }

  instructions(): string {
    const parts = [systemNote()];
    for (const u of this.upstreams) if (u.ok && u.instructions.trim()) parts.push(`Tools named ${u.name}${SEPARATOR}*: ${u.instructions.trim()}`);
    return parts.join("\n");
  }

  status(): { name: string; ok: boolean; tools: number; error: string }[] {
    return this.upstreams.map((u) => ({ name: u.name, ok: u.ok, tools: u.tools.length, error: u.error }));
  }

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<CallToolResult> {
    const started = Date.now();
    let result: CallToolResult;
    try {
      result = await this.route(name, args, signal);
    } catch (e) {
      result = { content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }], isError: true };
    }
    this.log(`call ${name} ${short(args)} → ${result.isError ? "error" : "ok"} (${Date.now() - started} ms)`);
    return result;
  }

  private async route(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<CallToolResult> {
    const builtin = builtinTools(this.config.tools).some((t) => t.name === name) ? await callBuiltin(name, args, signal) : undefined;
    if (builtin) return builtin;
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
