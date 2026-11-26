// The server's name: its command and its config folder. Until 0.6.0 it was gemini-mcp-bridge-server; the config
// file of that name is taken over (config.ts).

import pkg from "../package.json" with { type: "json" };

export const NAME = pkg.name;
export const FORMER_NAME = "gemini-mcp-bridge-server";
