// A small MCP server over stdio for the tests: the kind of server people list in "mcpServers".
//   UP_PREFIX: put in front of results, to tell two servers apart
//   UP_DIE=1: also a tool "die" that ends the process, to test restarts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "upstream-test", version: "1.0.0" }, { instructions: "Adds numbers." });
server.registerTool("add", { description: "Add two numbers", inputSchema: { a: z.number(), b: z.number() } }, async ({ a, b }) => ({
  content: [{ type: "text", text: `${process.env.UP_PREFIX ?? ""}${a + b}` }],
}));
if (process.env.UP_DIE === "1") {
  server.registerTool("die", { description: "End this server" }, async () => {
    setTimeout(() => process.exit(0), 20);
    return { content: [{ type: "text", text: "bye" }] };
  });
}
await server.connect(new StdioServerTransport());
