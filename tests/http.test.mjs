import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer, request as httpRequest } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

test("production HTTP host streams real MCP actions, gates writes, and persists completed turns", { timeout: 45_000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "toolbridge-http-"));
  const cleanups = [() => rm(directory, { recursive: true, force: true })];
  t.after(async () => {
    for (const cleanup of cleanups.reverse()) {
      await cleanup();
    }
  });
  const model = createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) { text += chunk; }
    const body = JSON.parse(text);
    const user = body.messages.findLast(message => message.role === "user").content;
    const isToolResult = body.messages.at(-1).role === "tool";
    const delta = isToolResult ? { content: "The requested action has been processed." } : {
      tool_calls: [{
        index: 0, id: "call_http", type: "function",
        function: {
          name: "workspace_create",
          arguments: JSON.stringify({ path: user.includes("deny") ? "denied.txt" : "approved.txt", content: "HTTP to MCP" })
        }
      }]
    };
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(`data: ${JSON.stringify({
      id: "http-test", object: "chat.completion.chunk", created: 0, model: "test",
      choices: [{ index: 0, delta, finish_reason: isToolResult ? "stop" : "tool_calls" }]
    })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise(resolve => model.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise(resolve => { model.close(resolve); model.closeAllConnections(); }));
  const modelPort = model.address().port;

  const reservation = createServer();
  await new Promise(resolve => reservation.listen(0, "127.0.0.1", resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const app = spawn(process.execPath, ["dist/server/index.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port), TOOLBRIDGE_HOME: directory,
      OPENAI_API_KEY: "local-test-placeholder",
      OPENAI_BASE_URL: `http://127.0.0.1:${modelPort}/v1`,
      OPENAI_MODEL: "test", BRAVE_SEARCH_API_KEY: "", GITHUB_TOKEN: ""
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const exited = once(app, "exit");
  let output = "";
  app.stdout.on("data", chunk => { output += chunk; });
  app.stderr.on("data", chunk => { output += chunk; });
  cleanups.push(async () => {
    if (app.exitCode === null && app.signalCode === null) {
      app.kill();
      await exited;
    }
  });
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (app.exitCode !== null) { throw new Error(`App exited before ready: ${output}`); }
    try {
      ready = (await fetch(`${base}/api/health`)).ok;
    } catch (error) {
      if (!(error instanceof TypeError)) { throw error; }
    }
    if (ready) { break; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(ready, output);
  const html = await (await fetch(base)).text();
  const token = /name="toolbridge-token" content="([a-f0-9]+)"/.exec(html)?.[1];
  assert.ok(token);
  const headers = { "Content-Type": "application/json", "X-ToolBridge-Token": token };
  assert.equal((await fetch(`${base}/api/config`)).status, 401);
  assert.equal((await fetch(`${base}/api/config`, { headers: { ...headers, Origin: "https://example.com" } })).status, 403);
  const invalidHostStatus = await new Promise((resolve, reject) => {
    const request = httpRequest(`${base}/api/config`, {
      headers: { ...headers, Host: `evil.example:${port}` }
    }, response => {
      response.resume();
      resolve(response.statusCode);
    });
    request.on("error", reject);
    request.end();
  });
  assert.equal(invalidHostStatus, 403);
  const config = await (await fetch(`${base}/api/config`, { headers })).json();
  assert.equal(config.tools.length, 5);
  assert.equal(config.modelConfigured, true);
  assert.equal((await fetch(`${base}/api/chat`, { method: "POST", headers, body: JSON.stringify({ prompt: "" }) })).status, 400);
  assert.equal((await fetch(`${base}/api/conversations/00000000-0000-4000-8000-000000000000`, { headers })).status, 404);

  for (const approved of [false, true]) {
    const response = await fetch(`${base}/api/chat`, {
      method: "POST", headers,
      body: JSON.stringify({ prompt: approved ? "Please create a file" : "Please deny a file" })
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /ndjson/);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const events = [];
    let pending = "";
    for (;;) {
      const { value, done } = await reader.read();
      pending += decoder.decode(value, { stream: !done });
      let boundary;
      while ((boundary = pending.indexOf("\n")) >= 0) {
        const event = JSON.parse(pending.slice(0, boundary));
        pending = pending.slice(boundary + 1);
        events.push(event);
        if (event.type === "approval") {
          const concurrent = await fetch(`${base}/api/chat`, {
            method: "POST", headers, body: JSON.stringify({ prompt: "concurrent" })
          });
          assert.equal(concurrent.status, 409);
          const decision = await fetch(`${base}/api/approvals`, {
            method: "POST", headers, body: JSON.stringify({ id: event.id, approved })
          });
          assert.equal(decision.status, 200);
          const repeated = await fetch(`${base}/api/approvals`, {
            method: "POST", headers, body: JSON.stringify({ id: event.id, approved: true })
          });
          assert.equal(repeated.status, 404);
          assert.ok((await repeated.json()).error);
        }
      }
      if (done) { break; }
    }
    assert.equal(events.at(-1).type, "done");
    assert.ok(events.some(event => event.type === "tool_end" && event.isError === !approved));
    const run = events.find(event => event.type === "run");
    const history = await (await fetch(`${base}/api/conversations/${run.conversationId}`, { headers })).json();
    assert.equal(history[0].role, "user");
    assert.equal(history.at(-1).content, "The requested action has been processed.");
  }
  assert.equal(await readFile(path.join(directory, "workspace", "approved.txt"), "utf8"), "HTTP to MCP");
  await assert.rejects(readFile(path.join(directory, "workspace", "denied.txt")), { code: "ENOENT" });
  const conversations = await (await fetch(`${base}/api/conversations`, { headers })).json();
  assert.equal(conversations.length, 2);
});
