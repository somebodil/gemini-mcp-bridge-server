// The server's name: its command, its config folder and its service. Until 0.6.0 it was gemini-mcp-bridge-server;
// the config file and the service of that name are taken over (config.ts, service.ts).

import pkg from "../package.json" with { type: "json" };

export const NAME = pkg.name;
export const FORMER_NAME = "gemini-mcp-bridge-server";
