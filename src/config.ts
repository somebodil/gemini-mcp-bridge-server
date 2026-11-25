// The server's settings file: port, token, which built-in tools are on, and the MCP servers to pass through.

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface StdioServer {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface HttpServer {
  url: string;
  headers?: Record<string, string>;
}

export type UpstreamConfig = (StdioServer | HttpServer) & { disabled?: boolean };

export interface Config {
  port: number;
  token: string;
  tools: { shell: boolean; files: boolean };
  /** Same shape as the "mcpServers" of other MCP clients, so that an existing list can be copied in. */
  mcpServers: Record<string, UpstreamConfig>;
}

export const DEFAULT_PORT = 7341;

export function defaultConfigPath(): string {
  if (process.platform === "win32") return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "gemini-mcp-bridge-server", "config.json");
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "gemini-mcp-bridge-server", "config.json");
}

export function newToken(): string {
  return randomBytes(24).toString("base64url");
}

/** Reads the file, filling what is missing; creates it (readable only by the user) on the first run. */
export function loadConfig(path: string, opts: { newToken?: boolean } = {}): { config: Config; created: boolean } {
  let raw: Partial<Config> = {};
  const created = !existsSync(path);
  if (!created) {
    try {
      raw = JSON.parse(readFileSync(path, "utf8")) as Partial<Config>;
    } catch (e) {
      throw new Error(`Cannot read ${path}: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
    }
  }
  const config: Config = {
    port: typeof raw.port === "number" ? raw.port : DEFAULT_PORT,
    token: typeof raw.token === "string" && raw.token.length >= 16 && !opts.newToken ? raw.token : newToken(),
    tools: { shell: raw.tools?.shell !== false, files: raw.tools?.files !== false },
    mcpServers: raw.mcpServers && typeof raw.mcpServers === "object" ? raw.mcpServers : {},
  };
  if (created || JSON.stringify(sortKeys(raw)) !== JSON.stringify(sortKeys(config))) saveConfig(path, config);
  return { config, created };
}

export function saveConfig(path: string, config: Config): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  if (process.platform !== "win32") chmodSync(path, 0o600);
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, sortKeys(x)]));
  return v;
}
