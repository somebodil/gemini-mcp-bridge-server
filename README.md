# gemini-mcp-bridge-server

The local MCP server for [Gemini MCP Bridge](https://github.com/somebodil/gemini-mcp-bridge), the Chrome extension that lets Gemini on the web ([gemini.google.com](https://gemini.google.com)) use the tools of your computer.

The extension runs in Chrome and cannot touch your computer by itself. This server is the part that can: it runs commands, reads and writes files, and passes calls through to the other MCP servers you list. The extension reaches it at `http://127.0.0.1:7341/mcp`, or at the address of the computer the server runs on.

```bash
npx gemini-mcp-bridge-server
```

Node.js 20 or later. The first start creates the config file with a random token, then prints what to enter in the extension's options:

```
gemini-mcp-bridge-server 0.3.0
  URL:    http://127.0.0.1:7341/mcp
  Token:  3q2-...
  Config: /home/you/.config/gemini-mcp-bridge-server/config.json (new)
  Perf:   /home/you/.config/gemini-mcp-bridge-server/perf.log (when the extension's performance log is on)
  Tools:  run_command, read_file, write_file, list_directory
```

Leave the window open while you use Gemini. Every call shows up there.

## Start it when you log in

Install it once, then let your system start it:

```bash
npm install -g gemini-mcp-bridge-server
gemini-mcp-bridge-server install-service
```

It starts at once and at every login: a LaunchAgent on macOS (log: `~/Library/Logs/gemini-mcp-bridge-server.log`), a systemd user service on Linux (log: `journalctl --user -u gemini-mcp-bridge-server`), a hidden script in the Startup folder on Windows (log: `%LOCALAPPDATA%\gemini-mcp-bridge-server\server.log`). No administrator rights are needed. `--port`, `--no-shell` and `--no-files` given here are saved in the config.

- `gemini-mcp-bridge-server token` shows the URL and the token again (the service does not write the token into its log).
- `gemini-mcp-bridge-server perf-log` shows the extension's performance log (below).
- `gemini-mcp-bridge-server uninstall-service` stops it and removes it.
- The service runs the Node.js that installed it, with the `PATH` of the terminal you installed it from (so that `npx` and your tools are found): after removing that Node.js version (with nvm, say) or changing your `PATH`, run `install-service` again.

## Tools

| Tool | What it does |
|---|---|
| `run_command` | Runs a command in your shell (`$SHELL -c`, `cmd.exe` on Windows), with a time limit (60 s by default, at most 600 s). Returns the exit code, stdout and stderr. |
| `read_file` | Reads a text file, whole or some of its lines. |
| `write_file` | Writes a text file, or adds to its end. Missing folders are created. |
| `list_directory` | Lists a folder (at most 1000 entries); links show as what they point to. |

Paths may be absolute, start with `~`, or be relative to your home folder. The server also tells Gemini, in its MCP instructions, your operating system, your home folder and your shell, so that Gemini writes paths and commands that work.

## Options

```
gemini-mcp-bridge-server [--port <n>] [--config <file>] [--no-shell] [--no-files] [--new-token]
gemini-mcp-bridge-server token | perf-log | install-service | uninstall-service
```

The config file is `~/.config/gemini-mcp-bridge-server/config.json` (on Windows `%APPDATA%\gemini-mcp-bridge-server\config.json`). Only your user can read it.

```json
{
  "port": 7341,
  "token": "…",
  "tools": { "shell": true, "files": true },
  "mcpServers": {
    "playwright": { "command": "npx", "args": ["@playwright/mcp@latest"] },
    "other": { "url": "http://127.0.0.1:9000/mcp", "headers": { "Authorization": "Bearer …" } }
  }
}
```

The server writes this file only on the first start and with a new token; keys it does not know stay in it. A wrong value (a port that is not a number, a server without `command` or `url`) stops the start with a message that names it.

`mcpServers` has the shape other MCP clients use, so an existing list can be copied in: stdio servers (`command`, `args`, `env`, `cwd`) and Streamable HTTP servers (`url`, `headers`). Their tools appear with the server's name in front, as `playwright__browser_navigate`. `"disabled": true` leaves one out. A server that stops is started again at its next call (after a short wait that grows while it keeps failing).

## Performance log

When the extension's *Performance log* option is on (off by default; it is for finding out why a page is slow), the extension sends its lines to this server every ten seconds, and the server appends them to `perf.log` next to the config file. `gemini-mcp-bridge-server perf-log` shows the file. Past 1 MB it becomes `perf.log.1` and a new one begins. Only your user can read it.

The lines say which clicks, keys and frames took long on the page and how much of that time was the extension's own work, and every minute how much time the extension took. They carry names and numbers only, no text of the page. The same lines are on the extension's options page, with **Copy**.

## Safety

- The server listens on every address of the computer, not on `127.0.0.1` alone: a browser elsewhere reaches it too (on the host of a virtual machine through a forwarded port, through an SSH tunnel, on another computer of your network). It does not look at where a request comes from. It refuses a request unless both hold:
  - It carries the token: `Authorization: Bearer <token>`.
  - It has no `Origin`, or a `chrome-extension://` one. Web pages always send their own `Origin`.
- Whoever has the token can run commands as you. Keep it like a password. `--new-token` replaces it.
- The token is the only lock, and it travels unencrypted. On a network you do not trust (a café, a shared office), close the port to other computers with the firewall of your system, or send it through an SSH tunnel.
- The extension asks before each call by default. What Gemini writes can come from a web page or a document it read ("prompt injection"): keep `run_command` and `write_file` on *Ask* in the extension unless you watch closely. `--no-shell` and `--no-files` turn the tools off on this side.

## Development

```bash
npm install
npm run check   # types, lint, tests (tools, HTTP checks, pass-through servers, config, command line, service files)
npm run smoke   # build, then run dist/cli.js as users do: --version, token, start, tools/list
npm start       # build and run dist/cli.js
```

## License

MIT
