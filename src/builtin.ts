// The tools the server has by itself: a shell and the file system of this computer.

import { spawn, type ChildProcess } from "node:child_process";
import { appendFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { arch, homedir, platform, release } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";

const OUTPUT_LIMIT = 200_000;
const READ_LIMIT = 4 * 1024 * 1024;
const LIST_LIMIT = 1000;
const WIN = process.platform === "win32";
const SHELL = WIN ? process.env.ComSpec || "cmd.exe" : process.env.SHELL || "/bin/sh";

type Switches = { shell: boolean; files: boolean };

/** What Gemini needs to know to write paths and commands: the kind of computer, the home folder, the shell. */
export function systemNote(tools: Switches): string {
  const os = { darwin: "macOS", win32: "Windows", linux: "Linux" }[platform() as string] ?? platform();
  const lines = [`Computer: ${os} ${release()} (${arch()}).`, `Home folder: ${homedir()}.`];
  if (tools.files || tools.shell) lines[1] += " Relative paths in the tools start there; ~ works too.";
  if (tools.shell) lines.push(`run_command uses ${SHELL}.`);
  return lines.join("\n");
}

export function builtinTools(tools: Switches): Tool[] {
  const list: Tool[] = [];
  if (tools.shell)
    list.push({
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
  if (tools.files)
    list.push(
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
  return list;
}

function resolvePath(p: string): string {
  const s = p.trim();
  if (s === "~") return homedir();
  if (s.startsWith("~/") || s.startsWith("~\\")) return join(homedir(), s.slice(2));
  return isAbsolute(s) ? s : resolve(homedir(), s);
}

const text = (t: string, isError = false): CallToolResult => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });

function required(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string") throw new Error(`"${key}" must be a string.`);
  return v;
}

function optional(args: Record<string, unknown>, key: string): string | undefined {
  return args[key] === undefined ? undefined : required(args, key);
}

/** A whole number, also when Gemini writes it as a string ("5"). */
function int(v: unknown): number | undefined {
  const n = typeof v === "string" && v.trim() ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? Math.floor(n) : undefined;
}

/** Runs a built-in tool; `name` is one of builtinTools(). Wrong arguments come back as an error result. */
export async function callBuiltin(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<CallToolResult> {
  try {
    switch (name) {
      case "run_command":
        return await runCommand(required(args, "command"), optional(args, "cwd"), int(args.timeout_seconds) ?? 60, signal);
      case "read_file":
        return await readText(resolvePath(required(args, "path")), int(args.offset), int(args.limit));
      case "write_file": {
        const path = resolvePath(required(args, "path"));
        const content = required(args, "content");
        await mkdir(dirname(path), { recursive: true });
        await (args.append === true ? appendFile : writeFile)(path, content);
        return text(`${args.append === true ? "Added" : "Wrote"} ${Buffer.byteLength(content)} bytes to ${path}.`);
      }
      case "list_directory":
        return await listDirectory(resolvePath(required(args, "path")));
      default:
        return text(`Unknown tool: ${name}`, true);
    }
  } catch (e) {
    return text(e instanceof Error ? e.message : String(e), true);
  }
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
  // the newline that ends the last line does not start another one
  const lines = content.endsWith("\n") ? content.slice(0, -1).split("\n") : content.split("\n");
  if (limit !== undefined && limit < 1) return text('"limit" must be 1 or more.', true);
  const from = Math.max(1, offset ?? 1);
  if (from > lines.length) return text(`${path} has ${lines.length} lines; there is no line ${from}.`, true);
  const to = limit === undefined ? lines.length : Math.min(lines.length, from + limit - 1);
  return text(`[lines ${from}-${to} of ${lines.length}]\n${lines.slice(from - 1, to).join("\n")}`);
}

async function listDirectory(path: string): Promise<CallToolResult> {
  const entries = await readdir(path, { withFileTypes: true });
  const shown = entries.slice(0, LIST_LIMIT);
  // a link is listed as what it points to
  const infos = await Promise.all(shown.map((e) => (e.isDirectory() ? Promise.resolve(undefined) : stat(join(path, e.name)).catch(() => null))));
  const rows = shown.map((e, i) => {
    const info = infos[i];
    const link = e.isSymbolicLink() ? " (link)" : "";
    if (e.isDirectory() || info?.isDirectory()) return { dir: true, line: `[DIR]  ${e.name}/${link}` };
    if (info === null) return { dir: false, line: `[LINK] ${e.name} (broken)` };
    return { dir: false, line: `[FILE] ${e.name} (${info?.size ?? 0} bytes)${link}` };
  });
  rows.sort((a, b) => Number(b.dir) - Number(a.dir) || a.line.localeCompare(b.line));
  const lines = rows.map((r) => r.line);
  if (entries.length > LIST_LIMIT) lines.push(`... and ${entries.length - LIST_LIMIT} more`);
  return text(lines.length ? `${path}\n${lines.join("\n")}` : `${path} is empty.`);
}

/** Commands that run now: the server stops them when it stops (they run in their own process group). */
const running = new Set<ChildProcess>();

function killTree(child: ChildProcess): void {
  if (!child.pid) return;
  try {
    if (WIN) spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }).on("error", () => undefined);
    else process.kill(-child.pid, "SIGKILL");
  } catch {
    // already gone
  }
}

export function stopAllCommands(): void {
  for (const child of running) killTree(child);
  running.clear();
}

/**
 * Runs one command line. The result is ready when the shell exits, not when every process holding its output
 * does: a command may leave something running in the background (`server &`), which must not hold the answer.
 */
async function runCommand(command: string, cwd: string | undefined, timeoutSec: number, signal?: AbortSignal): Promise<CallToolResult> {
  const dir = cwd ? resolvePath(cwd) : homedir();
  if (cwd && !(await stat(dir).catch(() => null))?.isDirectory()) return text(`The folder ${dir} does not exist.`, true);
  if (signal?.aborted) return text("Cancelled before it started.", true);
  const limitMs = Math.min(600, Math.max(1, timeoutSec)) * 1000;
  return new Promise((done) => {
    // cmd.exe /s /c strips the outer quotes: quoting the whole line keeps a quoted program path intact
    const child = spawn(SHELL, WIN ? ["/d", "/s", "/c", `"${command}"`] : ["-c", command], {
      cwd: dir,
      detached: !WIN,
      windowsHide: true,
      windowsVerbatimArguments: WIN,
      stdio: ["ignore", "pipe", "pipe"],
    });
    running.add(child);
    let out = "";
    let err = "";
    let total = 0;
    let stopped: "" | "time" | "cancel" = "";
    let finished = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    const take = (cur: string, chunk: string) => {
      total += chunk.length;
      return cur.length < OUTPUT_LIMIT ? cur + chunk : cur;
    };
    child.stdout.on("data", (c: string) => (out = take(out, c)));
    child.stderr.on("data", (c: string) => (err = take(err, c)));
    const finish = (result: CallToolResult) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      running.delete(child);
      child.stdout.destroy();
      child.stderr.destroy();
      done(result);
    };
    const report = (code: number | null, sig: NodeJS.Signals | null) => {
      const cut = (s: string) => (s.length > OUTPUT_LIMIT ? `${s.slice(0, OUTPUT_LIMIT)}\n...[output cut at ${OUTPUT_LIMIT} of ${total} characters]` : s);
      const head =
        stopped === "time" ? `Stopped after ${limitMs / 1000} s (time limit).` : stopped === "cancel" ? "Stopped: the call was cancelled." : `exit code: ${code ?? sig}`;
      const parts = [head];
      if (out) parts.push(`--- stdout ---\n${cut(out).replace(/\n$/, "")}`);
      if (err) parts.push(`--- stderr ---\n${cut(err).replace(/\n$/, "")}`);
      if (!out && !err) parts.push("(no output)");
      finish(text(parts.join("\n"), stopped !== ""));
    };
    const stop = (why: "time" | "cancel") => {
      stopped = why;
      killTree(child);
      // a process that left the group may keep the pipes open: answer anyway
      setTimeout(() => report(null, "SIGKILL"), 1000);
    };
    const timer = setTimeout(() => stop("time"), limitMs);
    const onAbort = () => stop("cancel");
    signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", (e) => finish(text(`Could not start ${SHELL}: ${e.message}`, true)));
    // output still in the pipes arrives right after the exit; background processes may hold them for good
    child.on("exit", (code, sig) => setTimeout(() => report(code, sig), 200));
    child.on("close", report);
  });
}
