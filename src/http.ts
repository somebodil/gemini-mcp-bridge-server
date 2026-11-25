// The HTTP side: MCP over Streamable HTTP on 127.0.0.1 only, for requests that carry the token.
//
// Any web page in the browser can send requests to 127.0.0.1, so a request is refused unless
//  - its Host is 127.0.0.1 or localhost (against DNS rebinding),
//  - it has no Origin or a chrome-extension:// one (web pages always send theirs), and
//  - it carries `Authorization: Bearer <token>`.
// Each request gets its own MCP server object (stateless mode): the extension's service worker may restart at
// any time, and there is nothing to keep between requests.

import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { VERSION, type Hub } from "./hub.ts";

const BODY_LIMIT = 8 * 1024 * 1024;

export interface ListenOptions {
  port: number;
  token: string;
  host?: string;
  log?: (line: string) => void;
}

export function mcpServerFor(hub: Hub): Server {
  const server = new Server({ name: "gemini-mcp-bridge-server", version: VERSION }, { capabilities: { tools: {} }, instructions: hub.instructions() });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: await hub.listTools() }));
  // the signal fires when the extension gives up or closes the connection: a running command is stopped
  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => hub.callTool(req.params.name, req.params.arguments ?? {}, extra.signal));
  return server;
}

export function checkRequest(req: IncomingMessage, token: string): { status: number; message: string } | null {
  const host = (req.headers.host ?? "").toLowerCase();
  if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) return { status: 403, message: "Host not allowed" };
  const origin = req.headers.origin;
  if (origin && !origin.startsWith("chrome-extension://")) return { status: 403, message: "Origin not allowed" };
  const auth = req.headers.authorization ?? "";
  const given = Buffer.from(auth.startsWith("Bearer ") ? auth.slice(7).trim() : "");
  const want = Buffer.from(token);
  if (given.length !== want.length || !timingSafeEqual(given, want)) return { status: 401, message: "Missing or wrong token" };
  return null;
}

function reply(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" }).end(message);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > BODY_LIMIT) throw new Error("Request too large");
    chunks.push(c as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function listen(hub: Hub, opts: ListenOptions): Promise<HttpServer> {
  const log = opts.log ?? (() => undefined);
  const http = createServer((req, res) => {
    void (async () => {
      const path = (req.url ?? "/").split("?")[0];
      if (path !== "/mcp") {
        if (path === "/" && req.method === "GET") return reply(res, 200, `gemini-mcp-bridge-server ${VERSION} is running. MCP endpoint: /mcp\n`);
        return reply(res, 404, "Not found");
      }
      const refused = checkRequest(req, opts.token);
      if (refused) {
        log(`refused ${req.method} from origin ${req.headers.origin ?? "-"}: ${refused.message}`);
        return reply(res, refused.status, refused.message);
      }
      if (req.method !== "POST") {
        res.setHeader("allow", "POST");
        return reply(res, 405, "Only POST: this server keeps no sessions");
      }
      let body: unknown;
      try {
        body = await readBody(req);
      } catch (e) {
        return reply(res, 400, e instanceof Error ? e.message : "Bad request");
      }
      const server = mcpServerFor(hub);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      try {
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
      } catch (e) {
        log(`error: ${e instanceof Error ? e.message : String(e)}`);
        if (!res.headersSent) reply(res, 500, "Internal error");
      }
    })();
  });
  return new Promise((resolve, reject) => {
    http.once("error", reject);
    http.listen(opts.port, opts.host ?? "127.0.0.1", () => {
      http.off("error", reject);
      resolve(http);
    });
  });
}
