// A small MCP server over stdio for the tests: the kind of server people list in "mcpServers".
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "upstream-test", version: "1.0.0" }, { instructions: "Adds numbers." });
server.registerTool("add", { description: "Add two numbers", inputSchema: { a: z.number(), b: z.number() } }, async ({ a, b }) => ({
  content: [{ type: "text", text: `${process.env.UP_PREFIX ?? ""}${a + b}` }],
}));
await server.connect(new StdioServerTransport());
