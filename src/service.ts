// Starting the server when the user logs in: a LaunchAgent on macOS, a systemd user service on Linux, a hidden
// script in the Startup folder on Windows. None needs administrator rights.
//
// Each file is for one system and keeps that system's path style, whatever system builds it (the tests build all
// three everywhere).

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, posix, win32 } from "node:path";
import { FORMER_NAME, NAME } from "./name.ts";

const label = (name: string) => `io.github.somebodil.${name}`;
export const LABEL = label(NAME);

export interface ServiceSpec {
  /** The program and its arguments: node, the script, its options (absolute paths). */
  command: string[];
  /** The PATH the server runs with: the installer's, so that `npx` and the user's tools are found. */
  path: string;
  /** Where the output goes (macOS and Windows; systemd keeps it in the journal). */
  log: string;
}

export interface ServiceFile {
  path: string;
  content: string;
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export const agentPath = (home = homedir(), name = NAME) => posix.join(home, "Library", "LaunchAgents", `${label(name)}.plist`);
export const unitPath = (home = homedir(), name = NAME) => posix.join(process.env.XDG_CONFIG_HOME || posix.join(home, ".config"), "systemd", "user", `${name}.service`);
export const startupPath = (appData = process.env.APPDATA ?? win32.join(homedir(), "AppData", "Roaming"), name = NAME) =>
  win32.join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "Startup", `${name}.vbs`);

/** The file of the service of `name` on this system. */
const fileOf = (name: string) =>
  process.platform === "darwin" ? agentPath(homedir(), name) : process.platform === "win32" ? startupPath(undefined, name) : unitPath(homedir(), name);

export function launchAgent(spec: ServiceSpec, home?: string): ServiceFile {
  const args = spec.command.map((a) => `    <string>${xml(a)}</string>`).join("\n");
  return {
    path: agentPath(home),
    content: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xml(spec.path)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>${xml(spec.log)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(spec.log)}</string>
</dict>
</plist>
`,
  };
}

/** systemd splits ExecStart at spaces and reads \\, ", % and $ specially: every value is quoted and escaped. */
const systemdQuote = (a: string) => `"${a.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%").replace(/\$/g, "$$$$")}"`;

export function systemdUnit(spec: ServiceSpec, home?: string): ServiceFile {
  return {
    path: unitPath(home),
    content: `[Unit]
Description=Local MCP server for the Gemini MCP Bridge Chrome extension

[Service]
ExecStart=${spec.command.map(systemdQuote).join(" ")}
Environment=${systemdQuote(`PATH=${spec.path}`)}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`,
  };
}

/**
 * The command line the Windows script runs. With more than two quotes after `cmd /c`, cmd strips the first and
 * the last of the line; /s and one more pair of quotes around the whole line keep the inner ones.
 */
export function startupCommand(spec: ServiceSpec): string {
  const q = (a: string) => `"${a}"`;
  return `cmd /d /s /c "${spec.command.map(q).join(" ")} >> ${q(spec.log)} 2>&1"`;
}

/** A VBScript in the Startup folder runs the server without a window (its PATH is the user's at logon). */
export function startupScript(spec: ServiceSpec, appData?: string): ServiceFile {
  // inside a VBScript string a quote is written twice
  return {
    path: startupPath(appData),
    content: `' Starts ${NAME} at logon, without a window. Remove this file to stop that.\r\nCreateObject("WScript.Shell").Run "${startupCommand(spec).replace(/"/g, '""')}", 0, False\r\n`,
  };
}

export function logPath(home = homedir()): string {
  if (process.platform === "win32") return win32.join(process.env.LOCALAPPDATA ?? win32.join(home, "AppData", "Local"), NAME, "server.log");
  return posix.join(home, "Library", "Logs", `${NAME}.log`);
}

/** npx runs packages from a cache that npm may clean: a service needs an installed copy. */
export function fromNpxCache(script: string): boolean {
  return /[\\/]_npx[\\/]/.test(script);
}

function run(cmd: string, args: string[], quiet = false): boolean {
  try {
    execFileSync(cmd, args, { stdio: quiet ? "ignore" : ["ignore", "inherit", "inherit"] });
    return true;
  } catch {
    return false;
  }
}

function write(f: ServiceFile): void {
  mkdirSync(dirname(f.path), { recursive: true });
  writeFileSync(f.path, f.content);
}

const uid = () => process.getuid?.() ?? 0;

/** Stops the service of `name` and removes its file; returns the file, or undefined when there was none. */
function remove(name: string): string | undefined {
  const systemd = process.platform !== "darwin" && process.platform !== "win32";
  if (process.platform === "darwin") run("launchctl", ["bootout", `gui/${uid()}/${label(name)}`], true);
  if (systemd) run("systemctl", ["--user", "disable", "--now", name], true);
  const f = fileOf(name);
  if (!existsSync(f)) return undefined;
  rmSync(f);
  if (systemd) run("systemctl", ["--user", "daemon-reload"], true);
  return f;
}

/** The file of the service of the former name, when it is still installed (it may hold the port). */
export function formerService(): string | undefined {
  const f = fileOf(FORMER_NAME);
  return existsSync(f) ? f : undefined;
}

/** Installs and starts the service, in place of the one of the former name; returns the lines to show. */
export function install(spec: ServiceSpec): string[] {
  const former = remove(FORMER_NAME);
  const note = process.platform === "win32" ? " (the server it started runs until you log out; this one starts at your next logon)" : "";
  return [...(former ? [`Removed the service of the former name, ${FORMER_NAME}: ${former}${note}`] : []), ...installOwn(spec)];
}

function installOwn(spec: ServiceSpec): string[] {
  if (process.platform === "darwin") {
    mkdirSync(dirname(spec.log), { recursive: true });
    const f = launchAgent(spec);
    run("launchctl", ["bootout", `gui/${uid()}/${LABEL}`], true);
    write(f);
    // right after a bootout of a running job, bootstrap can fail once ("Input/output error")
    if (!run("launchctl", ["bootstrap", `gui/${uid()}`, f.path], true)) {
      execFileSync("sleep", ["1"]);
      if (!run("launchctl", ["bootstrap", `gui/${uid()}`, f.path])) throw new Error(`launchctl could not load ${f.path}`);
    }
    return [`Installed: ${f.path}`, `It starts now and whenever you log in. Log: ${spec.log}`];
  }
  if (process.platform === "win32") {
    mkdirSync(dirname(spec.log), { recursive: true });
    const f = startupScript(spec);
    write(f);
    run("wscript", [f.path]);
    return [`Installed: ${f.path}`, `It starts now and whenever you log in. Log: ${spec.log}`];
  }
  const f = systemdUnit(spec);
  write(f);
  if (!run("systemctl", ["--user", "daemon-reload"]) || !run("systemctl", ["--user", "enable", "--now", NAME])) {
    return [`Wrote ${f.path}, but systemctl --user did not work here.`, "Start the server another way (for example from your desktop's autostart)."];
  }
  return [`Installed: ${f.path}`, `It starts now and whenever you log in. Log: journalctl --user -u ${NAME}`];
}

/** Stops and removes the service, and the one of the former name. */
export function uninstall(): string[] {
  const removed = [remove(NAME), remove(FORMER_NAME)].filter((f): f is string => f !== undefined);
  if (!removed.length) return ["No service was installed."];
  const after = process.platform === "win32" ? ". A server started by it keeps running until you log out." : "; the server is stopped.";
  return removed.map((f) => `Removed ${f}${after}`);
}
