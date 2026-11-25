// The tools the server has by itself: a shell and the file system of this computer.

import { spawn } from "node:child_process";
import { appendFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { arch, homedir, platform, release } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { Tool, CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export const OUTPUT_LIMIT = 200_000;
const READ_LIMIT = 4 * 1024 * 1024;
const LIST_LIMIT = 1000;

const SHELL = process.platform === "win32" ? process.env.ComSpec || "cmd.exe" : process.env.SHELL || "/bin/sh";

/** What Gemini needs to know to write paths and commands: the kind of computer, the home folder, the shell. */
export function systemNote(): string {
  const os = { darwin: "macOS", win32: "Windows", linux: "Linux" }[platform() as string] ?? platform();
  return [
    `Computer: ${os} ${release()} (${arch()}).`,
    `Home folder: ${homedir()}. Relative paths in the tools start there; ~ works too.`,
    `run_command uses ${SHELL}.`,
  ].join("\n");
}

export function builtinTools(opts: { shell: boolean; files: boolean }): Tool[] {
  const tools: Tool[] = [];
  if (opts.shell)
    tools.push({
      name: "run_command",
      description: `Run a command in the shell of the user's computer (${SHELL}) and return its exit code and output.`,
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string", description: "The command line." },
          cwd: { type: "string", description: "Folder to run in. Default: the home folder." },
          timeout_seconds: { type: "number", description: "Stop the command after this long. Default 60, at most 600." },
        },
        required: ["command"],
      },
    });
  if (opts.files)
    tools.push(
      {
        name: "read_file",
        description: "Read a text file.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string" },
            offset: { type: "integer", description: "First line to read, from 1." },
            limit: { type: "integer", description: "Number of lines to read." },
          },
          required: ["path"],
        },
      },
      {
        name: "write_file",
        description: "Write a text file, replacing it, or add to its end. Missing folders are created.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string" },
            content: { type: "string" },
            append: { type: "boolean", description: "Add to the end instead of replacing." },
          },
          required: ["path", "content"],
        },
      },
      {
        name: "list_directory",
        description: "List the files and folders in a folder.",
        inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      },
    );
  return tools;
}

export function resolvePath(p: string): string {
  const s = p.trim();
  if (s === "~") return homedir();
  if (s.startsWith("~/") || s.startsWith("~\\")) return join(homedir(), s.slice(2));
  return isAbsolute(s) ? s : resolve(homedir(), s);
}

const text = (t: string, isError = false): CallToolResult => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });

function str(args: Record<string, unknown>, key: string, required = true): string | undefined {
  const v = args[key];
  if (typeof v === "string") return v;
  if (v === undefined && !required) return undefined;
  throw new Error(`"${key}" must be a string.`);
}

export async function callBuiltin(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<CallToolResult | undefined> {
  try {
    switch (name) {
      case "run_command":
        return await runCommand(str(args, "command") as string, str(args, "cwd", false), typeof args.timeout_seconds === "number" ? args.timeout_seconds : 60, signal);
      case "read_file":
        return await readText(resolvePath(str(args, "path") as string), num(args.offset), num(args.limit));
      case "write_file": {
        const path = resolvePath(str(args, "path") as string);
        const content = str(args, "content") as string;
        await mkdir(dirname(path), { recursive: true });
        if (args.append === true) await appendFile(path, content);
        else await writeFile(path, content);
        return text(`${args.append === true ? "Added" : "Wrote"} ${Buffer.byteLength(content)} bytes to ${path}.`);
      }
      case "list_directory":
        return await listDirectory(resolvePath(str(args, "path") as string));
      default:
        return undefined;
    }
  } catch (e) {
    return text(e instanceof Error ? e.message : String(e), true);
  }
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : undefined;
}

async function readText(path: string, offset?: number, limit?: number): Promise<CallToolResult> {
  const info = await stat(path);
  if (info.isDirectory()) return text(`${path} is a folder; use list_directory.`, true);
  // a FIFO or a device has no size and may never end
  if (!info.isFile()) return text(`${path} is not a regular file.`, true);
  if (info.size > READ_LIMIT) return text(`${path} has ${info.size} bytes; files over ${READ_LIMIT} bytes are not read. Use run_command (head, tail, grep).`, true);
  const buf = await readFile(path);
  if (buf.subarray(0, 8192).includes(0)) return text(`${path} is a binary file (${info.size} bytes).`, true);
  const content = buf.toString("utf8");
  if (offset === undefined && limit === undefined) return text(content);
  const lines = content.split("\n");
  const from = Math.max(1, offset ?? 1);
  const to = limit === undefined ? lines.length : Math.min(lines.length, from + Math.max(0, limit) - 1);
  return text(`[lines ${from}-${to} of ${lines.length}]\n${lines.slice(from - 1, to).join("\n")}`);
}

async function listDirectory(path: string): Promise<CallToolResult> {
  const entries = await readdir(path, { withFileTypes: true });
  entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
  const lines: string[] = [];
  for (const e of entries.slice(0, LIST_LIMIT)) {
    if (e.isDirectory()) lines.push(`[DIR]  ${e.name}/`);
    else {
      let size = "";
      try {
        size = ` (${(await stat(join(path, e.name))).size} bytes)`;
      } catch {
        // a broken link
      }
      lines.push(`[FILE] ${e.name}${size}`);
    }
  }
  if (entries.length > LIST_LIMIT) lines.push(`... and ${entries.length - LIST_LIMIT} more`);
  return text(lines.length ? `${path}\n${lines.join("\n")}` : `${path} is empty.`);
}

/**
 * Runs one command line. The result is ready when the shell exits, not when every process holding its output
 * does: a command may leave something running in the background (`server &`), which must not hold the answer.
 */
function runCommand(command: string, cwd: string | undefined, timeoutSec: number, signal?: AbortSignal): Promise<CallToolResult> {
  const limitMs = Math.min(600, Math.max(1, timeoutSec)) * 1000;
  return new Promise((done) => {
    if (signal?.aborted) return done(text("Cancelled before it started.", true));
    const win = process.platform === "win32";
    // cmd.exe /s /c strips the outer quotes: quoting the whole line keeps a quoted program path intact
    const child = spawn(SHELL, win ? ["/d", "/s", "/c", `"${command}"`] : ["-c", command], {
      cwd: cwd ? resolvePath(cwd) : homedir(),
      env: process.env,
      detached: !win,
      windowsHide: true,
      windowsVerbatimArguments: win,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    let stopped: "" | "time" | "cancel" = "";
    let finished = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c: string) => (out = out.length < OUTPUT_LIMIT ? out + c : out));
    child.stderr.on("data", (c: string) => (err = err.length < OUTPUT_LIMIT ? err + c : err));
    const kill = () => {
      try {
        if (win && child.pid) spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
        else if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        // already gone
      }
    };
    const finish = (code: number | null, sig: NodeJS.Signals | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      child.stdout.destroy();
      child.stderr.destroy();
      const cut = (s: string) => (s.length > OUTPUT_LIMIT ? `${s.slice(0, OUTPUT_LIMIT)}\n...[output cut at ${OUTPUT_LIMIT} characters]` : s);
      const head =
        stopped === "time" ? `Stopped after ${limitMs / 1000} s (time limit).` : stopped === "cancel" ? "Stopped: the call was cancelled." : `exit code: ${code ?? sig}`;
      const parts = [head];
      if (out) parts.push(`--- stdout ---\n${cut(out).replace(/\n$/, "")}`);
      if (err) parts.push(`--- stderr ---\n${cut(err).replace(/\n$/, "")}`);
      if (!out && !err) parts.push("(no output)");
      done(text(parts.join("\n"), stopped !== ""));
    };
    const stop = (why: "time" | "cancel") => {
      stopped = why;
      kill();
      // a process that left the group may keep the pipes open: answer anyway
      setTimeout(() => finish(null, "SIGKILL"), 1000);
    };
    const timer = setTimeout(() => stop("time"), limitMs);
    const onAbort = () => stop("cancel");
    signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", (e) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      done(text(`Could not start ${SHELL}: ${e.message}`, true));
    });
    // output still in the pipes arrives right after the exit; background processes may hold them for good
    child.on("exit", (code, sig) => setTimeout(() => finish(code, sig), 200));
    child.on("close", (code, sig) => finish(code, sig));
  });
}
