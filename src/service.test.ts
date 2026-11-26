import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { FORMER_NAME } from "./name.ts";
import { agentPath, fromNpxCache, LABEL, launchAgent, startupCommand, startupPath, startupScript, systemdUnit, unitPath } from "./service.ts";

const spec = {
  command: ["/opt/node 22/bin/node", "/usr/lib/x/cli.js", "--config", "/home/a b/c&d.json"],
  path: "/opt/homebrew/bin:/usr/bin",
  log: "/home/a/log <1>.txt",
};

describe("service files", () => {
  it("macOS: a LaunchAgent with each argument as its own string, the installer's PATH, escaped", () => {
    const f = launchAgent(spec, "/Users/u");
    assert.equal(f.path, `/Users/u/Library/LaunchAgents/${LABEL}.plist`);
    assert.match(f.content, /<string>\/opt\/node 22\/bin\/node<\/string>\n {4}<string>\/usr\/lib\/x\/cli\.js<\/string>/);
    assert.match(f.content, /<string>\/home\/a b\/c&amp;d\.json<\/string>/);
    assert.match(f.content, /<key>PATH<\/key>\n {4}<string>\/opt\/homebrew\/bin:\/usr\/bin<\/string>/);
    assert.match(f.content, /<key>StandardOutPath<\/key>\n {2}<string>\/home\/a\/log &lt;1&gt;\.txt<\/string>/);
    assert.match(f.content, /<key>RunAtLoad<\/key>\n {2}<true\/>/);
  });

  it("Linux: a systemd user unit with quoted and escaped arguments and PATH", () => {
    const f = systemdUnit({ ...spec, command: [...spec.command, '50%"x\\y$HOME'] }, "/home/u");
    assert.ok(f.path.endsWith("/systemd/user/local-mcp-bridge-server.service"));
    assert.match(f.content, /^ExecStart="\/opt\/node 22\/bin\/node" "\/usr\/lib\/x\/cli\.js" "--config" "\/home\/a b\/c&d\.json" "50%%\\"x\\\\y\$\$HOME"$/m);
    assert.match(f.content, /^Environment="PATH=\/opt\/homebrew\/bin:\/usr\/bin"$/m);
    assert.match(f.content, /WantedBy=default\.target/);
  });

  it("Windows: a hidden script in the Startup folder, whose line keeps its quotes", () => {
    const win = { command: ["C:\\Program Files\\nodejs\\node.exe", "C:\\x\\cli.js"], path: "", log: "C:\\l\\server.log" };
    assert.equal(startupCommand(win), 'cmd /d /s /c ""C:\\Program Files\\nodejs\\node.exe" "C:\\x\\cli.js" >> "C:\\l\\server.log" 2>&1"');
    const f = startupScript(win, "C:\\Users\\u\\AppData\\Roaming");
    assert.equal(f.path, "C:\\Users\\u\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\local-mcp-bridge-server.vbs");
    assert.ok(f.content.includes('.Run "cmd /d /s /c """"C:\\Program Files\\nodejs\\node.exe"" ""C:\\x\\cli.js"" >> ""C:\\l\\server.log"" 2>&1""", 0, False'), f.content);
  });

  it("Windows: the line really starts the program and fills the log", { skip: process.platform !== "win32" && "runs cmd.exe" }, () => {
    const d = mkdtempSync(join(tmpdir(), "gmbs svc "));
    try {
      mkdirSync(join(d, "a b"));
      const script = join(d, "a b", "s.js");
      writeFileSync(script, "console.log('started')");
      const log = join(d, "a b", "log.txt");
      execSync(startupCommand({ command: [process.execPath, script], path: "", log }));
      assert.match(readFileSync(log, "utf8"), /started/);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("finds the files of the former name's service too, which install-service and uninstall-service remove", () => {
    assert.equal(LABEL, "io.github.somebodil.local-mcp-bridge-server");
    assert.equal(agentPath("/Users/u", FORMER_NAME), "/Users/u/Library/LaunchAgents/io.github.somebodil.gemini-mcp-bridge-server.plist");
    assert.ok(unitPath("/home/u", FORMER_NAME).endsWith("/systemd/user/gemini-mcp-bridge-server.service"));
    assert.equal(startupPath("C:\\Users\\u\\AppData\\Roaming", FORMER_NAME), "C:\\Users\\u\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\gemini-mcp-bridge-server.vbs");
  });

  it("knows the npx cache", () => {
    assert.equal(fromNpxCache("/home/u/.npm/_npx/1a2b/node_modules/local-mcp-bridge-server/dist/cli.js"), true);
    assert.equal(fromNpxCache("C:\\Users\\u\\AppData\\Local\\npm-cache\\_npx\\1a\\node_modules\\x\\cli.js"), true);
    assert.equal(fromNpxCache("/usr/local/lib/node_modules/local-mcp-bridge-server/dist/cli.js"), false);
  });
});
