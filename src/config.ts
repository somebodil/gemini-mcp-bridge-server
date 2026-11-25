// The server's settings file: port, token, which built-in tools are on, and the MCP servers to pass through.

import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type UpstreamConfig = (
  | { command: string; args?: string[]; env?: Record<string, string>; cwd?: string }
  | { url: string; headers?: Record<string, string> }
) & { disabled?: boolean };

export interface Config {
  port: number;
  token: string;
  tools: { shell: boolean; files: boolean };
  /** Same shape as the "mcpServers" of other MCP clients, so that an existing list can be copied in. */
  mcpServers: Record<string, UpstreamConfig>;
}

const DEFAULT_PORT = 7341;
const NAME = "gemini-mcp-bridge-server";

export function defaultConfigPath(): string {
  if (process.platform === "win32") return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), NAME, "config.json");
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), NAME, "config.json");
}

export function validPort(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 65535;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Checks what the user wrote, and says where it is wrong: a server must not start on a guess. */
function check(raw: Record<string, unknown>, path: string): void {
  const bad = (what: string) => {
    throw new Error(`${path}: ${what}`);
  };
  if (raw.port !== undefined && !validPort(raw.port)) bad(`"port" must be a number from 1 to 65535, not ${JSON.stringify(raw.port)}`);
  if (raw.token !== undefined && typeof raw.token !== "string") bad('"token" must be a string');
  if (raw.tools !== undefined) {
    if (!isRecord(raw.tools)) bad('"tools" must be an object like {"shell": true, "files": true}');
    for (const k of ["shell", "files"]) {
      const v = (raw.tools as Record<string, unknown>)[k];
      if (v !== undefined && typeof v !== "boolean") bad(`"tools.${k}" must be true or false`);
    }
  }
  if (raw.mcpServers !== undefined) {
    if (!isRecord(raw.mcpServers)) bad('"mcpServers" must be an object of named servers');
    for (const [name, s] of Object.entries(raw.mcpServers as Record<string, unknown>)) {
      if (!isRecord(s)) bad(`"mcpServers.${name}" must be an object`);
      const entry = s as Record<string, unknown>;
      if (typeof entry.command !== "string" && typeof entry.url !== "string") bad(`"mcpServers.${name}" needs "command" (a program to start) or "url"`);
      if (entry.args !== undefined && !(Array.isArray(entry.args) && entry.args.every((a) => typeof a === "string"))) bad(`"mcpServers.${name}.args" must be a list of strings`);
    }
  }
}

/**
 * Reads the file, filling in what is missing. The file is written only on the first run or with a new token;
 * keys the server does not know (notes, "$schema") stay in it. Only its owner may read it.
 */
export function loadConfig(path: string, opts: { newToken?: boolean } = {}): { config: Config; created: boolean; raw: Record<string, unknown> } {
  const created = !existsSync(path);
  let raw: Record<string, unknown> = {};
  if (!created) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (!isRecord(parsed)) throw new Error("the file must hold one JSON object");
      raw = parsed;
    } catch (e) {
      throw new Error(`Cannot read ${path}: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
    }
    check(raw, path);
  }
  const tools = (raw.tools ?? {}) as Partial<Config["tools"]>;
  const keepToken = typeof raw.token === "string" && raw.token.length >= 16 && !opts.newToken;
  const config: Config = {
    port: (raw.port as number | undefined) ?? DEFAULT_PORT,
    token: keepToken ? (raw.token as string) : randomBytes(24).toString("base64url"),
    tools: { shell: tools.shell !== false, files: tools.files !== false },
    mcpServers: (raw.mcpServers ?? {}) as Config["mcpServers"],
  };
  if (created || !keepToken) saveConfig(path, { ...raw, ...config });
  else if (process.platform !== "win32" && (statSync(path).mode & 0o077) !== 0) chmodSync(path, 0o600);
  return { config, created, raw };
}

export function saveConfig(path: string, config: Config & Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  if (process.platform !== "win32") chmodSync(path, 0o600);
}
