# local-mcp-bridge-server

The local MCP server for [Gemini MCP Bridge](https://github.com/somebodil/gemini-mcp-bridge), the Chrome extension that lets Gemini on the web ([gemini.google.com](https://gemini.google.com)) use the tools of your computer. Until 0.6.0 this server was called `gemini-mcp-bridge-server`: see [From gemini-mcp-bridge-server](#from-gemini-mcp-bridge-server).

The extension runs in Chrome and cannot touch your computer by itself. This server is the part that can: it runs commands, reads and writes files, and passes calls through to the other MCP servers you list. The extension reaches it at `http://127.0.0.1:7341/mcp`, or at the address of the computer the server runs on.

```bash
cd myproject && npx local-mcp-bridge-server
```

The folder you start it in is its working folder: commands start there, and relative paths (below). Node.js 20 or later. The first start creates the config file with a random token, then prints what to enter in the extension's options:

```
local-mcp-bridge-server 0.9.0
  URL:    http://127.0.0.1:7341/mcp
  Token:  3q2-...
  Config: /home/you/.config/local-mcp-bridge-server/config.json (new)
  Perf:   /home/you/.config/local-mcp-bridge-server/perf.log (when the extension's performance log is on)
  Folder: /home/you/myproject (the working folder: commands start here, and relative paths)
  Tools:  run_command, read_file, list_directory
```

Leave the window open while you use the extension. Every request shows up there as it comes (see *Log* below).

## From gemini-mcp-bridge-server

Until 0.6.0 this server was called `gemini-mcp-bridge-server`. Without `--config`, the first start (or `token`) copies the old config file (`~/.config/gemini-mcp-bridge-server/config.json`, on Windows `%APPDATA%\gemini-mcp-bridge-server\config.json`) to the new place, with its token, port and servers: the URL and the token in the extension stay as they are.

A service that an earlier version installed (`install-service`, until 0.7.0) starts that version at every login and holds the port. Remove it once:

```bash
npx local-mcp-bridge-server@0.7.0 uninstall-service   # removes the service of either name
npm uninstall -g gemini-mcp-bridge-server            # if you had installed it
```

## Tools

| Tool | What it does |
|---|---|
| `run_command` | Runs a command line with `bash -c` (`cmd.exe` on Windows; `$SHELL` only when there is no bash), with a time limit (60 s by default, at most 600 s). Returns the exit code, stdout and stderr. Gemini is told to write bash syntax only. It writes files with it too: a here-document (`cat > FILE <<'GMB_EOF'` ... `GMB_EOF`) writes each line as it is, and code in another language goes into a file this way and runs in the same command, one round instead of two. A command line over 100 KB runs from a temporary script file (Linux takes at most 128 KiB in one argument). |
| `read_file` | Reads a text file, whole or some of its lines. |
| `list_directory` | Lists a folder (at most 1000 entries); links show as what they point to. |
| `write_file` | Only where `run_command` cannot write a file: without bash (`cmd.exe` on Windows) and with `--no-shell`. Writes a text file, or adds to its end. Missing folders are created. |

Paths may be absolute, start with `~` (your home folder), or be relative to the working folder, the folder the server was started in. Only the starting folder changes: `$HOME` and `~` stay your home folder. The server also tells Gemini, in its MCP instructions, your operating system, your home folder, the working folder and your shell, so that Gemini writes paths and commands that work, and that each `run_command` starts anew in the working folder (a `cd` does not carry over to the next call). To work in another folder, start the server there: the extension tells the AI with a message soon after (it asks the server again once its list is half a minute old, or at once with its **Refresh**). The extension tells the AI of a learned chat page where its own instructions and skills are, in your home folder and in the working folder: see [Its own folder](https://github.com/somebodil/gemini-mcp-bridge#its-own-folder-learn-the-page-once).

## Options

```
local-mcp-bridge-server [--port <n>] [--config <file>] [--no-shell] [--no-files] [--new-token]
local-mcp-bridge-server token | perf-log
```

`token` shows the URL and the token again, `perf-log` the extension's performance log (below).

The config file is `~/.config/local-mcp-bridge-server/config.json` (on Windows `%APPDATA%\local-mcp-bridge-server\config.json`). Only your user can read it.

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

## Log

While it runs, the server writes to stdout each request as it comes, each step of the work, and the reply as it goes out, all under the number of the request. Something going wrong is a `WARN` or `ERROR` line at once: a tool that failed (with why), wrong arguments, a body that is not JSON (HTTP 400), any reply with an error status (with what it said), a refused request, a file tool still running after 5 seconds, a call the extension gave up on, a reply that had nowhere to go.

```
14:33:50.923 INFO  #1 ← tools/call run_command {"command":"mkdir -p /tmp/job && cat > /tmp/job/main.py <<'GMB_EOF' && python3 /tmp/job/main.py\nprint(\"hello\")\nGMB_EOF"} · 215 bytes from 127.0.0.1
14:33:50.929 INFO  #1 running with /bin/bash in /home/you, time limit 60 s: mkdir -p /tmp/job && cat > /tmp/job/main.py <<'GMB_EOF' && python3 /tmp/job/main.py print("hello") GMB_EOF
14:33:50.930 INFO  #1 started: process 49314
14:33:51.084 INFO  #1 run_command done (155 ms): 33 characters: exit code: 0 --- stdout --- hello
14:33:51.086 INFO  #1 → HTTP 200, 108 bytes, 164 ms
14:33:51.090 INFO  #2 ← tools/call read_file {} · 91 bytes from 127.0.0.1
14:33:51.090 ERROR #2 read_file failed (0 ms): "path" must be a string; it was nothing.
14:33:52.143 ERROR #8 the connection closed after 1011 ms, before the reply was sent: the extension gave up or went away
```

A string argument over 200 characters (the content of a file) shows as its start and its length; a result, as its length and its start.

## Performance log

When the extension's *Performance log* option is on (off by default; it is for finding out why a page is slow), the extension sends its lines to this server every ten seconds, and the server appends them to `perf.log` next to the config file. `local-mcp-bridge-server perf-log` shows the file. Past 1 MB it becomes `perf.log.1` and a new one begins. Only your user can read it.

The lines say which clicks, keys and frames took long on the page and how much of that time was the extension's own work, and every minute how much time the extension took. They carry names and numbers only, no text of the page. The same lines are on the extension's options page, with **Copy**.

## Safety

- The server listens on every address of the computer, not on `127.0.0.1` alone: a browser elsewhere reaches it too (on the host of a virtual machine through a forwarded port, through an SSH tunnel, on another computer of your network). It does not look at where a request comes from. It refuses a request unless both hold:
  - It carries the token: `Authorization: Bearer <token>`.
  - It has no `Origin`, or a `chrome-extension://` one. Web pages always send their own `Origin`.
- Whoever has the token can run commands as you. Keep it like a password. `--new-token` replaces it.
- The token is the only lock, and it travels unencrypted. On a network you do not trust (a café, a shared office), close the port to other computers with the firewall of your system, or send it through an SSH tunnel.
- The extension asks before each call by default. What Gemini writes can come from a web page or a document it read ("prompt injection"): keep `run_command` (and `write_file`, where it is there) on *Ask* in the extension unless you watch closely. `--no-shell` and `--no-files` turn the tools off on this side.

## Development

```bash
npm install
npm run check   # types, lint, tests (tools, HTTP checks, pass-through servers, config, command line)
npm run smoke   # build, then run dist/cli.js as users do: --version, token, start, tools/list
npm start       # build and run dist/cli.js
```

## License

MIT
