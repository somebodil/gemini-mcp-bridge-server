// The HTTP side: MCP over Streamable HTTP, for requests that carry the token. The server listens on every
// address of the computer, so that it is reached through a forwarded port too (a browser on the host of a
// virtual machine, an SSH tunnel) and from another computer: where a request comes from is not looked at.
//
// Any web page in the browser can send requests to it, so a request is refused unless
//  - it has no Origin or a chrome-extension:// one (web pages always send theirs, also after DNS rebinding), and
//  - it carries `Authorization: Bearer <token>`.
// Each request gets its own MCP server object (stateless mode): the extension's service worker may restart at
// any time, and there is nothing to keep between requests.
// /perf takes the lines of the extension's performance log (perf.ts), with the same checks.

import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { VERSION, type Hub } from "./hub.ts";
import { appendPerf, cleanLines, PERF_BODY_LIMIT } from "./perf.ts";

const BODY_LIMIT = 8 * 1024 * 1024;

export interface ListenOptions {
  port: number;
  token: string;
  log?: (line: string) => void;
  /** Where /perf appends the lines it gets; without it, /perf is not there. */
  perfLog?: string;
}

function mcpServerFor(hub: Hub): Server {
  const server = new Server({ name: "gemini-mcp-bridge-server", version: VERSION }, { capabilities: { tools: {} }, instructions: hub.instructions() });
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: hub.listTools() }));
  // the signal fires when the extension gives up or closes the connection: a running command is stopped
  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => hub.callTool(req.params.name, req.params.arguments ?? {}, extra.signal));
  return server;
}

function checkRequest(req: IncomingMessage, token: string): { status: number; message: string } | null {
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

/** The body as text, or null when it is larger than `limit` (what is past the limit is read but not kept). */
async function readBody(req: IncomingMessage, limit: number): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req as AsyncIterable<Buffer>) {
    size += c.length;
    if (size <= limit) chunks.push(c);
  }
  return size > limit ? null : Buffer.concat(chunks).toString("utf8");
}

/** Appends the lines of the body to the log; answers with where the file is, for the extension's options page. */
async function perfRequest(req: IncomingMessage, res: ServerResponse, file: string, log: (line: string) => void, first: { told: boolean }): Promise<void> {
  let body: string | null;
  try {
    body = await readBody(req, PERF_BODY_LIMIT);
  } catch {
    // the extension gave up during the upload (its time limit, a service worker that stopped): nobody to answer
    return;
  }
  if (body === null) return reply(res, 413, "Too large");
  try {
    appendPerf(file, cleanLines(body));
  } catch (e) {
    log(`cannot write ${file}: ${e instanceof Error ? e.message : String(e)}`);
    return reply(res, 500, "Cannot write the performance log");
  }
  if (!first.told) {
    first.told = true;
    log(`the extension's performance log goes to ${file}`);
  }
  reply(res, 200, file);
}

export function listen(hub: Hub, opts: ListenOptions): Promise<HttpServer> {
  const log = opts.log ?? (() => undefined);
  const perfTold = { told: false };
  const http = createServer((req, res) => {
    // nothing that goes wrong with one request may end the server
    void (async () => {
      const path = (req.url ?? "/").split("?")[0];
      const perfFile = path === "/perf" ? opts.perfLog : undefined;
      if (path !== "/mcp" && perfFile === undefined) {
        if (path === "/" && req.method === "GET") return reply(res, 200, `gemini-mcp-bridge-server ${VERSION} is running. MCP endpoint: /mcp\n`);
        return reply(res, 404, "Not found");
      }
      const refused = checkRequest(req, opts.token);
      if (refused) {
        log(`refused ${req.method} ${path} from origin ${req.headers.origin ?? "-"}: ${refused.message}`);
        return reply(res, refused.status, refused.message);
      }
      if (req.method !== "POST") {
        res.setHeader("allow", "POST");
        return reply(res, 405, perfFile ? "Only POST" : "Only POST: this server keeps no sessions");
      }
      if (perfFile) return await perfRequest(req, res, perfFile, log, perfTold);
      // the transport reads the body: 413 when it is too large, a JSON-RPC parse error when it is not JSON
      const server = mcpServerFor(hub);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true, maxRequestBodySize: BODY_LIMIT });
      // closing the server closes the transport, which aborts a call still running
      res.on("close", () => void server.close());
      try {
        await server.connect(transport);
        await transport.handleRequest(req, res);
      } catch (e) {
        log(`error: ${e instanceof Error ? e.message : String(e)}`);
        if (!res.headersSent) reply(res, 500, "Internal error");
      }
    })().catch((e: unknown) => {
      log(`error: ${e instanceof Error ? e.message : String(e)}`);
      if (!res.headersSent) reply(res, 500, "Internal error");
    });
  });
  return new Promise((resolve, reject) => {
    http.once("error", reject);
    http.listen(opts.port, () => {
      http.off("error", reject);
      resolve(http);
    });
  });
}
