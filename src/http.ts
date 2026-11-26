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
//
// Each request is logged under its number (log.ts): what came, each step of the work, and what went back, or that
// nothing could go back. A WARN or ERROR line comes the moment something goes wrong.

import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { VERSION, type Hub } from "./hub.ts";
import { message, oneLine, short, silent, tagged, type Logger } from "./log.ts";
import { appendPerf, cleanLines, PERF_BODY_LIMIT } from "./perf.ts";

const BODY_LIMIT = 8 * 1024 * 1024;
/** A body still coming in after this long is said to be slow. */
const SLOW_BODY_MS = 5_000;
/** How much of a reply is kept to see whether it is a JSON-RPC error. */
const REPLY_KEEP = 64 * 1024;

export interface ListenOptions {
  port: number;
  token: string;
  /** Where each request, the steps of its work and its reply are said. */
  log?: Logger;
  /** Where /perf appends the lines it gets; without it, /perf is not there. */
  perfLog?: string;
}

function mcpServerFor(hub: Hub, log: Logger): Server {
  const server = new Server({ name: "gemini-mcp-bridge-server", version: VERSION }, { capabilities: { tools: {} }, instructions: hub.instructions() });
  server.setRequestHandler(ListToolsRequestSchema, () => {
    const tools = hub.listTools();
    log.info(`listed ${tools.length} tools`);
    return { tools };
  });
  // the signal fires when the extension gives up or closes the connection: a running command is stopped
  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => hub.callTool(req.params.name, req.params.arguments ?? {}, extra.signal, log));
  server.onerror = (e) => log.error(`MCP: ${message(e)}`);
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

/** A JSON-RPC error with no id, as the MCP SDK answers a body it cannot take. */
function replyRpcError(res: ServerResponse, status: number, code: number, message: string): void {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }));
}

/** Where a request came from: the address of the other end of the connection. */
const from = (req: IncomingMessage) => (req.socket.remoteAddress ?? "?").replace(/^::ffff:/, "");

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

/** What a body asks for, on one line: the method of each message, and for a tool call the tool and its arguments. */
function describe(body: unknown): string {
  return (Array.isArray(body) ? body : [body])
    .map((m) => {
      if (typeof m !== "object" || m === null) return "not a JSON-RPC message";
      const { method, params } = m as { method?: unknown; params?: Record<string, unknown> };
      if (method === "tools/call") return `tools/call ${String(params?.name)} ${short(params?.arguments ?? {})}`;
      if (method === "initialize") {
        const client = params?.clientInfo as { name?: unknown; version?: unknown } | undefined;
        return `initialize from ${String(client?.name)} ${String(client?.version)}`;
      }
      return typeof method === "string" ? method : "a reply to the server";
    })
    .join(", ");
}

/** The JSON-RPC errors in a reply: JSON, or the data lines of an event stream. */
function rpcErrors(text: string): string[] {
  const start = text.trimStart()[0];
  const parts = start === "{" || start === "[" ? [text] : text.split("\n").flatMap((l) => (l.startsWith("data:") ? [l.slice(5)] : []));
  const out: string[] = [];
  for (const part of parts) {
    let v: unknown;
    try {
      v = JSON.parse(part);
    } catch {
      continue;
    }
    for (const m of Array.isArray(v) ? v : [v]) {
      const e = (m as { error?: { code?: unknown; message?: unknown } } | null)?.error;
      if (e) out.push(`${String(e.code)} ${oneLine(String(e.message), 200)}`);
    }
  }
  return out;
}

/** Counts what is written to `res` and keeps its start, to say how large the reply was and whether it was an error. */
function watchReply(res: ServerResponse): () => { bytes: number; text: string } {
  const kept: Buffer[] = [];
  let bytes = 0;
  const take = (chunk: unknown, encoding: unknown) => {
    if (typeof chunk !== "string" && !(chunk instanceof Uint8Array)) return;
    const b = typeof chunk === "string" ? Buffer.from(chunk, typeof encoding === "string" ? (encoding as BufferEncoding) : "utf8") : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    bytes += b.length;
    if (bytes <= REPLY_KEEP) kept.push(b);
  };
  const write = res.write.bind(res) as (...a: unknown[]) => boolean;
  const end = res.end.bind(res) as (...a: unknown[]) => ServerResponse;
  res.write = ((...a: unknown[]) => {
    take(a[0], a[1]);
    return write(...a);
  }) as ServerResponse["write"];
  res.end = ((...a: unknown[]) => {
    take(a[0], a[1]);
    return end(...a);
  }) as ServerResponse["end"];
  return () => ({ bytes, text: Buffer.concat(kept).toString("utf8") });
}

/** One MCP message (or a batch): read and said, handled by an MCP server object of its own, and its reply said. */
async function mcpRequest(hub: Hub, req: IncomingMessage, res: ServerResponse, log: Logger, ms: () => number): Promise<void> {
  const slow = setTimeout(() => log.warn(`the body is still coming in after ${SLOW_BODY_MS / 1000} s`), SLOW_BODY_MS);
  let body: string | null;
  try {
    body = await readBody(req, BODY_LIMIT);
  } catch (e) {
    // nobody to answer
    return log.error(`the upload broke off after ${ms()} ms (${message(e)}): the extension gave up or went away`);
  } finally {
    clearTimeout(slow);
  }
  if (body === null) {
    log.error(`refused: the body is over ${BODY_LIMIT} bytes`);
    return replyRpcError(res, 413, -32000, `Payload too large: the limit is ${BODY_LIMIT} bytes`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (e) {
    log.error(`the body is not JSON (${message(e)}): ${oneLine(body, 200)}`);
    return replyRpcError(res, 400, -32700, "Parse error: Invalid JSON");
  }
  log.info(`← ${describe(parsed)} · ${Buffer.byteLength(body)} bytes from ${from(req)}`);
  const sent = watchReply(res);
  const server = mcpServerFor(hub, log);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  transport.onerror = (e) => log.error(`transport: ${message(e)}`);
  res.on("finish", () => {
    const { bytes, text } = sent();
    // only a reply that names an error is read as JSON; a large one is not an error
    const errors = bytes <= REPLY_KEEP && text.includes('"error"') ? rpcErrors(text) : [];
    const what = `→ HTTP ${res.statusCode}, ${bytes} bytes, ${ms()} ms`;
    if (errors.length) log.error(`${what}: JSON-RPC error ${errors.join("; ")}`);
    else if (res.statusCode >= 400) log.error(`${what}${text ? `: ${oneLine(text, 300)}` : ""}`);
    else log.info(what);
  });
  // closing the server closes the transport, which aborts a call still running
  res.on("close", () => {
    if (!res.writableFinished) log.error(`the connection closed after ${ms()} ms, before the reply was sent: the extension gave up or went away`);
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, parsed);
}

/** Appends the lines of the body to the log; answers with where the file is, for the extension's options page. */
async function perfRequest(req: IncomingMessage, res: ServerResponse, file: string, log: Logger, first: { told: boolean }): Promise<void> {
  let body: string | null;
  try {
    body = await readBody(req, PERF_BODY_LIMIT);
  } catch (e) {
    // the extension gave up during the upload (its time limit, a service worker that stopped): nobody to answer
    return log.warn(`a performance log upload broke off (${message(e)})`);
  }
  if (body === null) {
    log.warn(`refused a performance log upload over ${PERF_BODY_LIMIT} bytes`);
    return reply(res, 413, "Too large");
  }
  try {
    appendPerf(file, cleanLines(body));
  } catch (e) {
    log.error(`cannot write ${file}: ${message(e)}`);
    return reply(res, 500, "Cannot write the performance log");
  }
  if (!first.told) {
    first.told = true;
    log.info(`the extension's performance log goes to ${file}`);
  }
  reply(res, 200, file);
}

export function listen(hub: Hub, opts: ListenOptions): Promise<HttpServer> {
  const root = opts.log ?? silent;
  const perfTold = { told: false };
  let count = 0;
  const http = createServer((req, res) => {
    const log = tagged(root, `#${++count}`);
    const started = Date.now();
    const ms = () => Date.now() - started;
    // nothing that goes wrong with one request may end the server
    void (async () => {
      const path = (req.url ?? "/").split("?")[0];
      const perfFile = path === "/perf" ? opts.perfLog : undefined;
      if (path !== "/mcp" && perfFile === undefined) {
        if (path === "/" && req.method === "GET") return reply(res, 200, `gemini-mcp-bridge-server ${VERSION} is running. MCP endpoint: /mcp\n`);
        log.warn(`${req.method} ${path} from ${from(req)}: not found`);
        return reply(res, 404, "Not found");
      }
      const refused = checkRequest(req, opts.token);
      if (refused) {
        log.warn(`refused ${req.method} ${path} from ${from(req)} (origin ${req.headers.origin ?? "none"}): ${refused.message}`);
        return reply(res, refused.status, refused.message);
      }
      if (req.method !== "POST") {
        log.warn(`refused ${req.method} ${path}: only POST is answered`);
        res.setHeader("allow", "POST");
        return reply(res, 405, perfFile ? "Only POST" : "Only POST: this server keeps no sessions");
      }
      if (perfFile) return await perfRequest(req, res, perfFile, log, perfTold);
      await mcpRequest(hub, req, res, log, ms);
    })().catch((e: unknown) => {
      log.error(`internal error: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
      if (!res.headersSent) reply(res, 500, "Internal error");
    });
  });
  // what is not HTTP at all, or a request whose headers do not come in time; a reset connection is a client's
  // ordinary way of leaving
  http.on("clientError", (e: NodeJS.ErrnoException, socket: Duplex) => {
    if (e.code === "ECONNRESET" || !socket.writable) return void socket.destroy();
    root.warn(`closed a connection that sent what is not HTTP or came too slowly (${e.code ?? message(e)})`);
    socket.end(`HTTP/1.1 ${e.code === "ERR_HTTP_REQUEST_TIMEOUT" ? "408 Request Timeout" : "400 Bad Request"}\r\nConnection: close\r\n\r\n`);
  });
  return new Promise((resolve, reject) => {
    http.once("error", reject);
    http.listen(opts.port, () => {
      http.off("error", reject);
      resolve(http);
    });
  });
}
