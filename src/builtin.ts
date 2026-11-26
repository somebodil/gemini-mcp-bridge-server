// The tools the server has by itself: a shell and the file system of this computer.

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { appendFile, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { arch, homedir, platform, release, tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { message, oneLine, silent, type Logger } from "./log.ts";

const OUTPUT_LIMIT = 200_000;
const READ_LIMIT = 4 * 1024 * 1024;
const LIST_LIMIT = 1000;
/** Linux takes at most 128 KiB in one argument: a longer command line goes to bash as a script file. */
const ARG_BYTES = 100_000;
const WIN = process.platform === "win32";
/** The end word of the here-documents Gemini is shown: not a line of any file. */
const END_WORD = "GMB_EOF";

/**
 * bash on the PATH, or in its usual places. Gemini is told to write bash, and a command a user copies from a
 * terminal is bash too: the user's $SHELL may be zsh (macOS), and /bin/sh may be dash (Debian), where $'...',
 * [[ ]], {a,b} and <(...) do not work. A service gets no $SHELL at all.
 */
function findBash(): string | undefined {
  const dirs = [...(process.env.PATH ?? "").split(delimiter), "/bin", "/usr/bin", "/usr/local/bin", "/opt/homebrew/bin"];
  for (const dir of dirs) {
    if (!dir) continue;
    const path = join(dir, "bash");
    try {
      accessSync(path, constants.X_OK);
      return path;
    } catch {
      // not here
    }
  }
  return undefined;
}

const SHELL = WIN ? process.env.ComSpec || "cmd.exe" : (findBash() ?? (process.env.SHELL || "/bin/sh"));
/** True when run_command runs bash: then Gemini is told to write bash syntax only. */
export const RUNS_BASH = !WIN && /(^|\/)bash$/.test(SHELL);

/** The version of that bash, as [major, minor] ([0, 0] when it does not say): macOS has bash 3.2. */
function bashVersion(): [number, number] {
  try {
    const [major, minor] = execFileSync(SHELL, ["-c", 'echo "${BASH_VERSINFO[0]} ${BASH_VERSINFO[1]}"'], { encoding: "utf8", timeout: 5000 }).trim().split(" ").map(Number);
    return [major || 0, minor || 0];
  } catch {
    return [0, 0];
  }
}

type Switches = { shell: boolean; files: boolean };

/**
 * write_file only where run_command cannot write a file: without the shell, or without bash (cmd.exe on Windows).
 * With bash, a here-document writes it, and the file runs in the same call: one round instead of two.
 */
const writes = (tools: Switches) => tools.files && !(tools.shell && RUNS_BASH);

/** What Gemini needs to know to write paths and commands: the kind of computer, the home folder, the shell. */
export function systemNote(tools: Switches): string {
  const os = { darwin: "macOS", win32: "Windows", linux: "Linux" }[platform() as string] ?? platform();
  const lines = [`Computer: ${os} ${release()} (${arch()}).`, `Home folder: ${homedir()}.`];
  if (tools.files || tools.shell) lines[1] += " Relative paths in the tools start there; ~ works too.";
  if (tools.shell && RUNS_BASH) {
    const [major, minor] = bashVersion();
    lines.push(
      `run_command runs its "command" with ${SHELL} -c${major ? ` (bash ${major}.${minor})` : ""}, so "command" must be bash syntax only: a command line as typed in a bash terminal. ` +
        "Never run Python or the code of any other language as bash commands.",
      `run_command also writes files: a here-document whose end word is in single quotes writes each line as it is ($, backticks, backslashes and quotes too) until a line that is only the end word; cat >> adds to the end of a file. ` +
        "Code in another language goes into a file this way, and runs in the same command, for example:",
      `mkdir -p /tmp/job && cat > /tmp/job/main.py <<'${END_WORD}' && python3 /tmp/job/main.py`,
      'print("hello")',
      END_WORD,
    );
    // macOS keeps bash 3.2: what came with bash 4 fails there
    if (major && major < 4) lines.push("This bash is older than 4: ${var^^} and ${var,,}, associative arrays (declare -A), mapfile, |& and ** do not work in it.");
  } else if (tools.shell) lines.push(`run_command uses ${SHELL}.`);
  return lines.join("\n");
}

export function builtinTools(tools: Switches): Tool[] {
  const list: Tool[] = [];
  if (tools.shell)
    list.push({
      name: "run_command",
      description: RUNS_BASH
        ? `Run a bash command line on the user's computer (${SHELL} -c) and return its exit code and output. Bash syntax only: code of another language goes into a file with a here-document (cat > FILE <<'${END_WORD}'), which can run in the same command.`
        : `Run a command in the shell of the user's computer (${SHELL}) and return its exit code and output.`,
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string", description: RUNS_BASH ? "The command line, in bash syntax only." : "The command line." },
          cwd: { type: "string", description: "Folder to run in. Default: the home folder." },
          timeout_seconds: { type: "number", description: "Stop the command after this long. Default 60, at most 600." },
        },
        required: ["command"],
      },
    });
  if (tools.files)
    list.push({
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
    });
  if (writes(tools))
    list.push({
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
    });
  if (tools.files)
    list.push({
      name: "list_directory",
      description: "List the files and folders in a folder.",
      inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    });
  return list;
}

function resolvePath(p: string): string {
  const s = p.trim();
  if (s === "~") return homedir();
  if (s.startsWith("~/") || s.startsWith("~\\")) return join(homedir(), s.slice(2));
  return isAbsolute(s) ? s : resolve(homedir(), s);
}

const text = (t: string, isError = false): CallToolResult => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });

/** What a value is, for an error message. */
function kind(v: unknown): string {
  if (v === undefined) return "nothing";
  if (v === null) return "null";
  if (Array.isArray(v)) return "an array";
  return typeof v === "object" ? "an object" : `a ${typeof v}`;
}

function required(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string") throw new Error(`"${key}" must be a string; it was ${kind(v)}.`);
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

/**
 * Runs a built-in tool; `name` is one of builtinTools(). Wrong arguments come back as an error result. Each step
 * is said in `log` before it is taken, so that a step that hangs is the last one there.
 */
export async function callBuiltin(name: string, args: Record<string, unknown>, signal?: AbortSignal, log: Logger = silent): Promise<CallToolResult> {
  try {
    switch (name) {
      case "run_command":
        return await runCommand(required(args, "command"), optional(args, "cwd"), int(args.timeout_seconds) ?? 60, signal, log);
      case "read_file": {
        const path = resolvePath(required(args, "path"));
        const offset = int(args.offset);
        const limit = int(args.limit);
        log.info(`reading ${path}${offset !== undefined || limit !== undefined ? ` (offset ${offset ?? 1}, limit ${limit ?? "none"})` : ""}`);
        return await readText(path, offset, limit);
      }
      case "write_file": {
        const path = resolvePath(required(args, "path"));
        const content = required(args, "content");
        const bytes = Buffer.byteLength(content);
        log.info(`creating the folders of ${path} if missing`);
        await mkdir(dirname(path), { recursive: true });
        log.info(`${args.append === true ? "appending" : "writing"} ${bytes} bytes to ${path}`);
        await (args.append === true ? appendFile : writeFile)(path, content);
        return text(`${args.append === true ? "Added" : "Wrote"} ${bytes} bytes to ${path}.`);
      }
      case "list_directory": {
        const path = resolvePath(required(args, "path"));
        log.info(`listing ${path}`);
        return await listDirectory(path);
      }
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
async function runCommand(command: string, cwd: string | undefined, timeoutSec: number, signal: AbortSignal | undefined, log: Logger): Promise<CallToolResult> {
  const dir = cwd ? resolvePath(cwd) : homedir();
  if (cwd && !(await stat(dir).catch(() => null))?.isDirectory()) return text(`The folder ${dir} does not exist.`, true);
  if (signal?.aborted) return text("Cancelled before it started.", true);
  const limitMs = Math.min(600, Math.max(1, timeoutSec)) * 1000;
  log.info(`running with ${SHELL} in ${dir}, time limit ${limitMs / 1000} s: ${oneLine(command, 200)}`);
  const bytes = Buffer.byteLength(command);
  const script = !WIN && bytes > ARG_BYTES ? join(await mkdtemp(join(tmpdir(), "gmb-command-")), "command.sh") : undefined;
  if (script) {
    log.info(`the command line has ${bytes} bytes, more than one argument may hold: it runs from ${script}`);
    await writeFile(script, command, { mode: 0o600 });
  }
  return new Promise((done) => {
    // cmd.exe /s /c strips the outer quotes: quoting the whole line keeps a quoted program path intact
    const child = spawn(SHELL, WIN ? ["/d", "/s", "/c", `"${command}"`] : script ? [script] : ["-c", command], {
      cwd: dir,
      detached: !WIN,
      windowsHide: true,
      windowsVerbatimArguments: WIN,
      stdio: ["ignore", "pipe", "pipe"],
    });
    running.add(child);
    if (child.pid) log.info(`started: process ${child.pid}`);
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
      if (script) void rm(dirname(script), { recursive: true, force: true }).catch((e: unknown) => log.warn(`could not delete ${script}: ${message(e)}`));
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
      log.warn(`${why === "time" ? `time limit of ${limitMs / 1000} s reached` : "cancelled"}: stopping process ${child.pid ?? "?"} and the processes it started`);
      killTree(child);
      // a process that left the group may keep the pipes open: answer anyway
      setTimeout(() => {
        if (!finished) log.warn("its output was still open 1 s after the stop (a process that left its group): answering without the rest");
        report(null, "SIGKILL");
      }, 1000);
    };
    const timer = setTimeout(() => stop("time"), limitMs);
    const onAbort = () => stop("cancel");
    signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", (e) => finish(text(`Could not start ${SHELL}: ${e.message}`, true)));
    // output still in the pipes arrives right after the exit; background processes may hold them for good
    child.on("exit", (code, sig) =>
      setTimeout(() => {
        if (!finished) log.info(`the shell exited (${code ?? sig}) but a process it started still holds its output: answering now`);
        report(code, sig);
      }, 200),
    );
    child.on("close", report);
  });
}
