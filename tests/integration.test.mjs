import assert from "node:assert/strict";
import { test, afterEach } from "node:test";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import OpenAI from "openai";
import { Gateway } from "../src/mcp/gateway.ts";
import { runAgent } from "../src/server/agent.ts";
import { Approvals } from "../src/server/approvals.ts";
import { describeRunError } from "../src/server/errors.ts";
import { searchGithub, searchWeb } from "../src/tools/remote.ts";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

async function gatewayFixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "toolbridge-mcp-"));
  const gateway = new Gateway();
  t.after(async () => { await gateway.close(); await rm(directory, { recursive: true, force: true }); });
  await gateway.connect(directory);
  return { directory, gateway };
}

async function modelFixture(t, turns) {
  const requests = [];
  const server = createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) {
      text += chunk;
    }
    requests.push(JSON.parse(text));
    const turn = turns[Math.min(requests.length - 1, turns.length - 1)];
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const chunk = delta => `data: ${JSON.stringify({
      id: "chat-test", object: "chat.completion.chunk", created: 0, model: "test-model", ...delta
    })}\n\n`;
    const deltas = turn.deltas ?? [turn.delta];
    for (const delta of deltas) {
      response.write(chunk({ choices: [{ index: 0, delta, finish_reason: null }] }));
    }
    response.write(chunk({ choices: [{ index: 0, delta: {}, finish_reason: turn.finish ?? (deltas.some(delta => delta.tool_calls) ? "tool_calls" : "stop") }] }));
    response.write(chunk({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
    response.end("data: [DONE]\n\n");
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const address = server.address();
  const client = new OpenAI({ apiKey: "local-test-placeholder", baseURL: `http://127.0.0.1:${address.port}/v1`, maxRetries: 0 });
  return { client, requests };
}

const call = (name, args) => ({
  delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name, arguments: JSON.stringify(args) } }] }
});

test("real stdio MCP handshake discovers five tools and validates arguments", async t => {
  const { gateway } = await gatewayFixture(t);
  assert.deepEqual(gateway.catalog().map(tool => tool.name).sort(), [
    "github_search", "web_search", "workspace_create", "workspace_list", "workspace_read"
  ]);
  assert.equal(gateway.requiresApproval("workspace_create"), true);
  assert.equal(gateway.requiresApproval("unknown_write"), true);
  assert.equal(gateway.requiresApproval("workspace_read"), false);
  assert.equal(gateway.modelTools().length, 5);
  assert.equal((await gateway.call("workspace_list", {})).isError, false);
  assert.equal((await gateway.call("workspace_read", { path: "../outside" })).isError, true);
  assert.equal((await gateway.call("workspace_read", {})).isError, true);
  await assert.rejects(gateway.call("does_not_exist", {}), /Unknown MCP tool/);
});

test("model selects a real MCP tool and receives its result before final text", async t => {
  const { gateway } = await gatewayFixture(t);
  const { client, requests } = await modelFixture(t, [call("workspace_list", { path: "." }), { delta: { content: "The workspace is empty." } }]);
  const events = [];
  const result = await runAgent({
    client, model: "test-model", gateway, approvals: new Approvals(), owner: "owner",
    history: [], prompt: "Show my files", emit: event => events.push(event), signal: new AbortController().signal
  });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].tools.length, 5);
  assert.equal("reasoning_effort" in requests[0], false);
  assert.equal(requests[1].messages.at(-1).role, "tool");
  assert.match(requests[1].messages.at(-1).content, /entries/);
  assert.equal(result.messages.at(-1).content, "The workspace is empty.");
  assert.equal(result.inputTokens, 20);
  assert.equal(result.outputTokens, 10);
  assert.ok(events.some(event => event.type === "tool_end" && !event.isError));
  assert.ok(events.some(event => event.type === "text"));
});

test("configured reasoning effort is forwarded with every model request", async t => {
  const { gateway } = await gatewayFixture(t);
  const { client, requests } = await modelFixture(t, [call("workspace_list", {}), { delta: { content: "Done." } }]);
  await runAgent({
    client, model: "test-model", reasoningEffort: "none", gateway, approvals: new Approvals(), owner: "owner",
    history: [], prompt: "List", emit: () => {}, signal: new AbortController().signal
  });
  assert.deepEqual(requests.map(request => request.reasoning_effort), ["none", "none"]);
});

test("provider tool-call fields are preserved and index-less calls stay separate", async t => {
  const { gateway } = await gatewayFixture(t);
  const signature = { google: { thought_signature: "opaque-signature" } };
  const { client, requests } = await modelFixture(t, [
    { finish: "stop", deltas: [
      { tool_calls: [{ id: "call_a", type: "function", extra_content: signature, function: { name: "workspace_list", arguments: "{}" } }] },
      { tool_calls: [{ id: "call_b", type: "function", function: { name: "workspace_read", arguments: "{\"path\":\"missing.txt\"}" } }] }
    ] },
    { delta: { content: "Done." } }
  ]);
  const events = [];
  await runAgent({
    client, model: "test-model", gateway, approvals: new Approvals(), owner: "owner",
    history: [], prompt: "Inspect", emit: event => events.push(event), signal: new AbortController().signal
  });
  const assistant = requests[1].messages.find(message => message.role === "assistant");
  assert.deepEqual(assistant.tool_calls.map(toolCall => toolCall.id), ["call_a", "call_b"]);
  assert.deepEqual(assistant.tool_calls[0].extra_content, signature);
  assert.deepEqual(requests[1].messages.filter(message => message.role === "tool").map(message => message.tool_call_id), ["call_a", "call_b"]);
  assert.deepEqual(events.filter(event => event.type === "tool_end").map(event => event.name), ["workspace_list", "workspace_read"]);
});

test("tool arguments streamed across chunks are reassembled without extra fields", async t => {
  const { gateway } = await gatewayFixture(t);
  const { client, requests } = await modelFixture(t, [
    { deltas: [
      { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "workspace_list", arguments: "" } }] },
      { tool_calls: [{ index: 0, function: { arguments: "{\"path\":" } }] },
      { tool_calls: [{ index: 0, function: { arguments: "\".\"}" } }] }
    ] },
    { delta: { content: "Listed." } }
  ]);
  await runAgent({
    client, model: "test-model", gateway, approvals: new Approvals(), owner: "owner",
    history: [], prompt: "List", emit: () => {}, signal: new AbortController().signal
  });
  const assistant = requests[1].messages.find(message => message.role === "assistant");
  assert.deepEqual(assistant.tool_calls, [
    { id: "call_1", type: "function", function: { name: "workspace_list", arguments: "{\"path\":\".\"}" } }
  ]);
});

test("provider failures produce actionable messages", () => {
  const apiError = status => OpenAI.APIError.generate(status, undefined, "failed", new Headers());
  assert.match(describeRunError(apiError(401), false), /HTTP 401.*OPENAI_API_KEY/);
  assert.match(describeRunError(apiError(404), false), /HTTP 404.*OPENAI_MODEL/);
  assert.match(describeRunError(apiError(429), false), /HTTP 429.*Rate limit/);
  assert.match(describeRunError(apiError(503), false), /HTTP 503.*overloaded/);
  assert.match(describeRunError(new OpenAI.APIConnectionTimeoutError(), false), /did not respond in time/);
  assert.match(describeRunError(new OpenAI.APIConnectionError({ message: "offline" }), false), /Could not reach/);
  assert.match(describeRunError(apiError(503), true), /Run stopped/);
  assert.equal(describeRunError(new Error("Tool budget reached."), false), "Tool budget reached.");
});

for (const approved of [true, false]) {
  test(`file creation respects user approval: ${approved}`, async t => {
    const { directory, gateway } = await gatewayFixture(t);
    const { client } = await modelFixture(t, [
      call("workspace_create", { path: "notes.txt", content: "Created through MCP" }),
      { delta: { content: approved ? "File created." : "Action denied." } }
    ]);
    const approvals = new Approvals();
    const events = [];
    await runAgent({
      client, model: "test-model", gateway, approvals, owner: "owner", history: [], prompt: "Create notes",
      signal: new AbortController().signal,
      emit: event => {
        events.push(event);
        if (event.type === "approval") {
          queueMicrotask(() => approvals.decide("owner", event.id, approved));
        }
      }
    });
    if (approved) {
      assert.equal(await readFile(path.join(directory, "notes.txt"), "utf8"), "Created through MCP");
    } else {
      await assert.rejects(readFile(path.join(directory, "notes.txt")), { code: "ENOENT" });
    }
    assert.ok(events.some(event => event.type === "tool_end" && event.isError === !approved));
  });
}

test("agent stops at the eight-step budget", async t => {
  const { gateway } = await gatewayFixture(t);
  const { client, requests } = await modelFixture(t, [call("workspace_list", {})]);
  await assert.rejects(runAgent({
    client, model: "test-model", gateway, approvals: new Approvals(), owner: "owner",
    history: [], prompt: "List", emit: () => {}, signal: new AbortController().signal
  }), /eight-step/);
  assert.equal(requests.length, 8);
});

test("agent surfaces incomplete model output instead of treating it as success", async t => {
  const { gateway } = await gatewayFixture(t);
  const { client } = await modelFixture(t, [{ delta: { content: "Partial" }, finish: "length" }]);
  await assert.rejects(runAgent({
    client, model: "test-model", gateway, approvals: new Approvals(), owner: "owner",
    history: [], prompt: "Explain", emit: () => {}, signal: new AbortController().signal
  }), /did not complete/);
});

test("agent honors cancellation before issuing a model request", async t => {
  const { gateway } = await gatewayFixture(t);
  const { client, requests } = await modelFixture(t, [{ delta: { content: "unused" } }]);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(runAgent({
    client, model: "test-model", gateway, approvals: new Approvals(), owner: "owner",
    history: [], prompt: "Explain", emit: () => {}, signal: controller.signal
  }), { name: "AbortError" });
  assert.equal(requests.length, 0);
});

test("search fails explicitly without credentials", async t => {
  const previous = process.env.BRAVE_SEARCH_API_KEY;
  delete process.env.BRAVE_SEARCH_API_KEY;
  t.after(() => {
    if (previous === undefined) { delete process.env.BRAVE_SEARCH_API_KEY; }
    else { process.env.BRAVE_SEARCH_API_KEY = previous; }
  });
  await assert.rejects(searchWeb("MCP", 5), /not configured/);
});

test("GitHub connector uses a fixed endpoint, encodes the query, and preserves source URLs", async () => {
  let actualUrl;
  globalThis.fetch = async url => {
    actualUrl = url;
    return new Response(JSON.stringify({
      total_count: 1,
      items: [{ full_name: "example/project", html_url: "https://github.com/example/project", description: null, stargazers_count: 10, language: "TypeScript" }]
    }), { status: 200 });
  };
  const result = await searchGithub("mcp language:typescript", 3);
  assert.equal(actualUrl.origin, "https://api.github.com");
  assert.equal(actualUrl.searchParams.get("q"), "mcp language:typescript");
  assert.equal(actualUrl.searchParams.get("per_page"), "3");
  assert.equal(result.repositories[0].html_url, "https://github.com/example/project");
});

test("upstream errors never expose response bodies", async () => {
  globalThis.fetch = async () => new Response("private provider details", { status: 429 });
  await assert.rejects(searchGithub("MCP", 5), error => /HTTP 429/.test(error.message) && !error.message.includes("private"));
});

test("upstream response size is capped while reading the stream", async () => {
  globalThis.fetch = async () => new Response("a".repeat(1024 * 1024 + 1), { status: 200 });
  await assert.rejects(searchGithub("MCP", 5), /exceeds 1 MiB/);
});

test("upstream schema errors are surfaced, not replaced with empty results", async () => {
  globalThis.fetch = async () => new Response('{"items":"invalid"}', { status: 200 });
  await assert.rejects(searchGithub("MCP", 5), { name: "ZodError" });
});
