// Starting the server when the user logs in: a LaunchAgent on macOS, a systemd user service on Linux, a hidden
// script in the Startup folder on Windows. None needs administrator rights.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, posix, win32 } from "node:path";

export const NAME = "gemini-mcp-bridge-server";
export const LABEL = "io.github.somebodil.gemini-mcp-bridge-server";

export interface ServiceSpec {
  /** The program and its arguments: node, the script, its options. */
  command: string[];
  log: string;
}

export interface ServiceFile {
  path: string;
  content: string;
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function launchAgent(spec: ServiceSpec, home = homedir()): ServiceFile {
  const args = spec.command.map((a) => `    <string>${xml(a)}</string>`).join("\n");
  return {
    // each file is for one system and keeps its path style, whatever system builds it (tests run on all three)
    path: posix.join(home, "Library", "LaunchAgents", `${LABEL}.plist`),
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

/** systemd splits ExecStart at spaces and reads % and \ specially: every argument is quoted. */
const systemdArg = (a: string) => `"${a.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%")}"`;

export function systemdUnit(spec: ServiceSpec, home = homedir()): ServiceFile {
  return {
    path: posix.join(process.env.XDG_CONFIG_HOME || posix.join(home, ".config"), "systemd", "user", `${NAME}.service`),
    content: `[Unit]
Description=Local MCP server for the Gemini MCP Bridge Chrome extension

[Service]
ExecStart=${spec.command.map(systemdArg).join(" ")}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`,
  };
}

/** A VBScript in the Startup folder runs the server without a window and appends its output to the log. */
export function startupScript(spec: ServiceSpec, appData = process.env.APPDATA ?? win32.join(homedir(), "AppData", "Roaming")): ServiceFile {
  const cmdQuote = (a: string) => `"${a}"`;
  const line = `cmd /c ${spec.command.map(cmdQuote).join(" ")} >> ${cmdQuote(spec.log)} 2>&1`;
  // inside a VBScript string a quote is written twice
  return {
    path: win32.join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "Startup", `${NAME}.vbs`),
    content: `' Starts ${NAME} at logon, without a window. Remove this file to stop that.\r\nCreateObject("WScript.Shell").Run "${line.replace(/"/g, '""')}", 0, False\r\n`,
  };
}

export function logPath(home = homedir()): string {
  if (process.platform === "darwin") return join(home, "Library", "Logs", `${NAME}.log`);
  if (process.platform === "win32") return join(process.env.LOCALAPPDATA ?? join(home, "AppData", "Local"), NAME, "server.log");
  return join(home, ".local", "state", NAME, "server.log");
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

function uid(): number {
  return process.getuid?.() ?? 0;
}

/** Installs and starts the service; returns the lines to show. */
export function install(spec: ServiceSpec): string[] {
  mkdirSync(dirname(spec.log), { recursive: true });
  if (process.platform === "darwin") {
    const f = launchAgent(spec);
    run("launchctl", ["bootout", `gui/${uid()}/${LABEL}`], true);
    mkdirSync(dirname(f.path), { recursive: true });
    writeFileSync(f.path, f.content);
    if (!run("launchctl", ["bootstrap", `gui/${uid()}`, f.path])) throw new Error(`launchctl could not load ${f.path}`);
    return [`Installed: ${f.path}`, `It starts now and whenever you log in. Log: ${spec.log}`];
  }
  if (process.platform === "win32") {
    const f = startupScript(spec);
    mkdirSync(dirname(f.path), { recursive: true });
    writeFileSync(f.path, f.content);
    run("wscript", [f.path]);
    return [`Installed: ${f.path}`, `It starts now and whenever you log in. Log: ${spec.log}`];
  }
  const f = systemdUnit(spec);
  mkdirSync(dirname(f.path), { recursive: true });
  writeFileSync(f.path, f.content);
  if (!run("systemctl", ["--user", "daemon-reload"]) || !run("systemctl", ["--user", "enable", "--now", NAME])) {
    return [`Wrote ${f.path}, but systemctl --user did not work here.`, "Start the server another way (for example from your desktop's autostart)."];
  }
  return [`Installed: ${f.path}`, `It starts now and whenever you log in. Log: journalctl --user -u ${NAME}`];
}

export function uninstall(): string[] {
  if (process.platform === "darwin") {
    const f = launchAgent({ command: [], log: "" });
    run("launchctl", ["bootout", `gui/${uid()}/${LABEL}`], true);
    if (!existsSync(f.path)) return ["No service was installed."];
    rmSync(f.path);
    return [`Removed ${f.path}; the server is stopped.`];
  }
  if (process.platform === "win32") {
    const f = startupScript({ command: [], log: "" });
    if (!existsSync(f.path)) return ["No service was installed."];
    rmSync(f.path);
    return [`Removed ${f.path}. A server started by it keeps running until you log out.`];
  }
  const f = systemdUnit({ command: [], log: "" });
  run("systemctl", ["--user", "disable", "--now", NAME], true);
  if (!existsSync(f.path)) return ["No service was installed."];
  rmSync(f.path);
  run("systemctl", ["--user", "daemon-reload"], true);
  return [`Removed ${f.path}; the server is stopped.`];
}
