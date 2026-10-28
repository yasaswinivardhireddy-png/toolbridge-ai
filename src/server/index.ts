import "dotenv/config";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import OpenAI from "openai";
import { z } from "zod";
import { Gateway } from "../mcp/gateway.js";
import type { RunEvent } from "../shared.js";
import { runAgent } from "./agent.js";
import { Approvals } from "./approvals.js";
import { describeRunError } from "./errors.js";
import { ConversationNotFound, Store } from "./store.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const home = path.resolve(process.env.TOOLBRIDGE_HOME || root);
const workspace = path.join(home, "workspace");
await mkdir(workspace, { recursive: true });
await mkdir(path.join(home, ".toolbridge"), { recursive: true });
const store = new Store(path.join(home, ".toolbridge", "conversations.db"));
const gateway = new Gateway();
try {
  await gateway.connect(workspace);
} catch (error) {
  store.close();
  await gateway.close();
  throw error;
}
const approvals = new Approvals();
const token = randomBytes(32).toString("hex");
const port = z.coerce.number().int().min(1024).max(65535).parse(process.env.PORT ?? 4317);
const DEFAULT_MODEL = "gpt-6-luna";
const model = process.env.OPENAI_MODEL || DEFAULT_MODEL;
// gpt-6-luna supports Chat Completions function calling only with reasoning disabled.
const reasoningEffort = z.enum(["", "none", "minimal", "low", "medium", "high", "xhigh", "max"])
  .parse(process.env.OPENAI_REASONING_EFFORT ?? (model === DEFAULT_MODEL ? "none" : "")) || undefined;
const client = process.env.OPENAI_API_KEY ? new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: process.env.OPENAI_BASE_URL || undefined,
  timeout: 45_000,
  maxRetries: 1
}) : undefined;
const active = new Map<string, AbortController>();

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(body));
}

async function body(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer: Buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > 128_000) {
      throw new Error("Request exceeds 128 KB.");
    }
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function authorized(request: IncomingMessage): boolean {
  const header = request.headers["x-toolbridge-token"];
  const supplied = typeof header === "string" ? Buffer.from(header) : Buffer.alloc(0);
  const expected = Buffer.from(token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

const server = createServer((request, response) => {
  void handle(request, response).catch(error => {
    console.error("Request failed:", error instanceof Error ? error.name : "UnknownError");
    if (!response.headersSent) {
      json(response, error instanceof z.ZodError || error instanceof SyntaxError ? 400 : 500,
        { error: "Request failed. Check input and retry; see the local terminal for the error category." });
    } else {
      response.end();
    }
  });
});

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Content-Security-Policy", "default-src 'self'; connect-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  const host = request.headers.host;
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
    json(response, 403, { error: "Localhost access only." });
    return;
  }
  if (request.headers.origin && request.headers.origin !== `http://${host}`) {
    json(response, 403, { error: "Cross-origin requests are forbidden." });
    return;
  }
  const url = new URL(request.url ?? "/", `http://${host}`);
  if (url.pathname === "/api/health" && request.method === "GET") {
    json(response, 200, { status: "ok", mcpConnected: true });
    return;
  }
  if (url.pathname.startsWith("/api/")) {
    if (!authorized(request)) {
      json(response, 401, { error: "Reload the app to refresh your local session." });
      return;
    }
    if (url.pathname === "/api/config" && request.method === "GET") {
      json(response, 200, {
        modelConfigured: Boolean(client),
        searchConfigured: Boolean(process.env.BRAVE_SEARCH_API_KEY),
        model,
        tools: gateway.catalog().map(tool => ({ name: tool.name, description: tool.description, requiresApproval: gateway.requiresApproval(tool.name) }))
      });
      return;
    }
    if (url.pathname === "/api/conversations" && request.method === "GET") {
      json(response, 200, store.list());
      return;
    }
    const conversation = /^\/api\/conversations\/([a-f0-9-]{36})$/.exec(url.pathname);
    if (conversation && request.method === "GET") {
      try {
        json(response, 200, store.display(conversation[1]!));
      } catch (error) {
        if (!(error instanceof ConversationNotFound)) {
          throw error;
        }
        json(response, 404, { error: "Conversation not found." });
      }
      return;
    }
    if (url.pathname === "/api/approvals" && request.method === "POST") {
      const input = z.object({ id: z.string().uuid(), approved: z.boolean() }).parse(await body(request));
      const decided = approvals.decide(token, input.id, input.approved);
      json(response, decided ? 200 : 404, decided ? { decided: true } : { error: "Approval expired or was already decided." });
      return;
    }
    if (url.pathname === "/api/chat" && request.method === "POST") {
      if (!client) {
        json(response, 503, { error: "Set OPENAI_API_KEY in .env and restart to enable chat." });
        return;
      }
      if (active.size) {
        json(response, 409, { error: "A run is already active. Finish or stop it first." });
        return;
      }
      const input = z.object({ prompt: z.string().trim().min(1).max(8000), conversationId: z.string().uuid().optional() })
        .parse(await body(request));
      let history;
      try {
        history = input.conversationId ? store.load(input.conversationId) : [];
      } catch (error) {
        if (!(error instanceof ConversationNotFound)) {
          throw error;
        }
        json(response, 404, { error: "Conversation not found." });
        return;
      }
      // Recheck after body I/O so concurrent requests cannot both start a run.
      if (active.size) {
        json(response, 409, { error: "A run is already active." });
        return;
      }
      const id = input.conversationId ?? store.create(input.prompt);
      const controller = new AbortController();
      active.set(id, controller);
      const timeout = setTimeout(() => controller.abort(), 180_000);
      response.on("close", () => controller.abort());
      response.writeHead(200, {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Accel-Buffering": "no"
      });
      const emit = (event: RunEvent) => {
        if (!response.destroyed) {
          response.write(`${JSON.stringify(event)}\n`);
        }
      };
      emit({ type: "run", conversationId: id });
      try {
        const result = await runAgent({
          client, model, reasoningEffort,
          gateway, approvals, owner: token, history, prompt: input.prompt, emit, signal: controller.signal
        });
        store.save(id, result.messages);
        emit({ type: "done", inputTokens: result.inputTokens, outputTokens: result.outputTokens });
      } catch (error) {
        console.error("Agent run failed:", error instanceof Error ? error.name : "UnknownError");
        emit({ type: "error", message: describeRunError(error, controller.signal.aborted) });
      } finally {
        clearTimeout(timeout);
        active.delete(id);
        response.end();
      }
      return;
    }
    json(response, 404, { error: "API route not found." });
    return;
  }
  if (request.method !== "GET") {
    json(response, 405, { error: "Method not allowed." });
    return;
  }
  const webRoot = path.join(root, "dist", "web");
  const assets: Record<string, string> = { ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };
  if (url.pathname === "/") {
    const html = await readFile(path.join(webRoot, "index.html"), "utf8");
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    response.end(html.replace("__TOOLBRIDGE_TOKEN__", token));
  } else if (/^\/assets\/[a-zA-Z0-9_.-]+\.(js|css|svg)$/.test(url.pathname)) {
    try {
      const file = path.join(webRoot, ...url.pathname.split("/").filter(Boolean));
      const data = await readFile(file);
      response.writeHead(200, { "Content-Type": assets[path.extname(file)]!, "Cache-Control": "public, max-age=3600" });
      response.end(data);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
      json(response, 404, { error: "Asset not found." });
    }
  } else {
    json(response, 404, { error: "Page not found." });
  }
}

server.requestTimeout = 30_000;
server.listen(port, "127.0.0.1", () => console.info(`ToolBridge AI: http://127.0.0.1:${port}`));
server.on("error", error => {
  console.error("Server failed:", error.message);
  void shutdown().finally(() => { process.exitCode = 1; });
});

async function shutdown(): Promise<void> {
  for (const controller of active.values()) {
    controller.abort();
  }
  server.close();
  server.closeAllConnections();
  await gateway.close();
  store.close();
}
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => { void shutdown(); });
}
