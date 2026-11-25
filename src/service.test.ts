import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fromNpxCache, LABEL, launchAgent, startupScript, systemdUnit } from "./service.ts";

const spec = { command: ["/opt/node 22/bin/node", "/usr/lib/x/cli.js", "--config", "/home/a b/c&d.json"], log: "/home/a/log <1>.txt" };

describe("service files", () => {
  it("macOS: a LaunchAgent with each argument as its own string, escaped", () => {
    const f = launchAgent(spec, "/Users/u");
    assert.equal(f.path, `/Users/u/Library/LaunchAgents/${LABEL}.plist`);
    assert.match(f.content, /<string>\/opt\/node 22\/bin\/node<\/string>\n {4}<string>\/usr\/lib\/x\/cli\.js<\/string>/);
    assert.match(f.content, /<string>\/home\/a b\/c&amp;d\.json<\/string>/);
    assert.match(f.content, /<key>StandardOutPath<\/key>\n {2}<string>\/home\/a\/log &lt;1&gt;\.txt<\/string>/);
    assert.match(f.content, /<key>RunAtLoad<\/key>\n {2}<true\/>/);
  });

  it("Linux: a systemd user unit with quoted arguments", () => {
    const f = systemdUnit({ ...spec, command: [...spec.command, '50%"x\\y'] }, "/home/u");
    assert.ok(f.path.endsWith("/systemd/user/gemini-mcp-bridge-server.service"));
    assert.match(f.content, /^ExecStart="\/opt\/node 22\/bin\/node" "\/usr\/lib\/x\/cli\.js" "--config" "\/home\/a b\/c&d\.json" "50%%\\"x\\\\y"$/m);
    assert.match(f.content, /WantedBy=default\.target/);
  });

  it("Windows: a hidden script in the Startup folder", () => {
    const f = startupScript({ command: ["C:\\Program Files\\nodejs\\node.exe", "C:\\x\\cli.js"], log: "C:\\l\\server.log" }, "C:\\Users\\u\\AppData\\Roaming");
    assert.match(f.path, /Start Menu[\\/]Programs[\\/]Startup[\\/]gemini-mcp-bridge-server\.vbs$/);
    assert.ok(f.content.includes('.Run "cmd /c ""C:\\Program Files\\nodejs\\node.exe"" ""C:\\x\\cli.js"" >> ""C:\\l\\server.log"" 2>&1", 0, False'), f.content);
  });

  it("knows the npx cache", () => {
    assert.equal(fromNpxCache("/home/u/.npm/_npx/1a2b/node_modules/gemini-mcp-bridge-server/dist/cli.js"), true);
    assert.equal(fromNpxCache("C:\\Users\\u\\AppData\\Local\\npm-cache\\_npx\\1a\\node_modules\\x\\cli.js"), true);
    assert.equal(fromNpxCache("/usr/local/lib/node_modules/gemini-mcp-bridge-server/dist/cli.js"), false);
  });
});
