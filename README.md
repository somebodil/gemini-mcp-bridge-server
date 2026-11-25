# gemini-mcp-bridge-server

The local MCP server for [Gemini MCP Bridge](https://github.com/somebodil/gemini-mcp-bridge), the Chrome extension that lets Gemini on the web ([gemini.google.com](https://gemini.google.com)) use the tools of your computer.

The extension runs in Chrome and cannot touch your computer by itself. This server is the part that can: it runs commands, reads and writes files, and passes calls through to the other MCP servers you list. The extension reaches it at `http://127.0.0.1:7341/mcp`.

```bash
npx gemini-mcp-bridge-server
```

Node.js 20 or later. The first start creates the config file with a random token, then prints what to enter in the extension's options:

```
gemini-mcp-bridge-server 0.1.0
  URL:    http://127.0.0.1:7341/mcp
  Token:  3q2-...
  Config: /home/you/.config/gemini-mcp-bridge-server/config.json (new)
  Tools:  run_command, read_file, write_file, list_directory
```

Leave the window open while you use Gemini. Every call shows up there.

## Tools

| Tool | What it does |
|---|---|
| `run_command` | Runs a command in your shell (`$SHELL -c`, `cmd.exe` on Windows), with a time limit (60 s by default, at most 600 s). Returns the exit code, stdout and stderr. |
| `read_file` | Reads a text file, whole or some of its lines. |
| `write_file` | Writes a text file, or adds to its end. Missing folders are created. |
| `list_directory` | Lists a folder. |

Paths may be absolute, start with `~`, or be relative to your home folder. The server also tells Gemini, in its MCP instructions, your operating system, your home folder and your shell, so that Gemini writes paths and commands that work.

## Options

```
gemini-mcp-bridge-server [--port <n>] [--config <file>] [--no-shell] [--no-files] [--new-token]
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

`mcpServers` has the shape other MCP clients use, so an existing list can be copied in: stdio servers (`command`, `args`, `env`, `cwd`) and Streamable HTTP servers (`url`, `headers`). Their tools appear with the server's name in front, as `playwright__browser_navigate`. `"disabled": true` leaves one out.

## Safety

- The server listens on `127.0.0.1` only. Any web page in your browser can send requests to `127.0.0.1`, so the server refuses a request unless all three hold:
  - It carries the token: `Authorization: Bearer <token>`.
  - It has no `Origin`, or a `chrome-extension://` one. Web pages always send their own `Origin`.
  - Its `Host` is `127.0.0.1` or `localhost`, which defeats DNS rebinding.
- Whoever has the token can run commands as you. Keep it like a password. `--new-token` replaces it.
- The extension asks before each call by default. What Gemini writes can come from a web page or a document it read ("prompt injection"): keep `run_command` and `write_file` on *Ask* in the extension unless you watch closely. `--no-shell` and `--no-files` turn the tools off on this side.

## Development

```bash
npm install
npm run check   # types, lint, tests (including a stdio MCP server passed through)
npm start       # build and run dist/cli.js
```

## License

MIT
