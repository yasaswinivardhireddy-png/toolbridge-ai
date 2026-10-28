import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Workspace } from "../src/tools/filesystem.ts";
import { Approvals } from "../src/server/approvals.ts";
import { ConversationNotFound, Store } from "../src/server/store.ts";

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "toolbridge-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, "workspace");
  await mkdir(root);
  return { directory, root, workspace: new Workspace(root) };
}

test("workspace creates, reads and lists a UTF-8 file", async t => {
  const { workspace } = await fixture(t);
  await workspace.write("notes.txt", "Hello MCP");
  assert.deepEqual(await workspace.read("notes.txt"), { path: "notes.txt", content: "Hello MCP" });
  assert.deepEqual(await workspace.list(), {
    path: ".", entries: [{ name: "notes.txt", kind: "file" }], truncated: false
  });
});

test("workspace refuses overwrite and preserves existing content", async t => {
  const { workspace } = await fixture(t);
  await workspace.write("notes.txt", "original");
  await assert.rejects(workspace.write("notes.txt", "replacement"), { code: "EEXIST" });
  assert.equal((await workspace.read("notes.txt")).content, "original");
});

test("workspace rejects traversal, absolute paths and Windows aliases", async t => {
  const { workspace } = await fixture(t);
  for (const candidate of ["../secret", "..\\secret", "/etc/passwd", "\\Windows", "C:\\secret",
    "file.txt:secret", ".. \\secret", "notes.", "NUL", "con.txt", "folder\\..\\secret", "a\0b"]) {
    await assert.rejects(workspace.read(candidate), /relative workspace path|escapes/);
  }
});

test("workspace rejects junction escape through existing parent", async t => {
  const { directory, root, workspace } = await fixture(t);
  const outside = path.join(directory, "outside");
  await mkdir(outside);
  await writeFile(path.join(outside, "private.txt"), "not in workspace");
  await symlink(outside, path.join(root, "link"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(workspace.read("link/private.txt"), /Symbolic links/);
  await assert.rejects(workspace.write("link/new.txt", "text"), /Symbolic links/);
});

test("workspace enforces the exact 64 KiB byte limit", async t => {
  const { root, workspace } = await fixture(t);
  await workspace.write("boundary.txt", "a".repeat(65_536));
  assert.equal((await workspace.read("boundary.txt")).content.length, 65_536);
  await assert.rejects(workspace.write("large.txt", "a".repeat(65_537)), /64 KiB/);
  await assert.rejects(workspace.write("unicode.txt", "\u20ac".repeat(22_000)), /64 KiB/);
  await writeFile(path.join(root, "external.txt"), "a".repeat(65_537));
  await assert.rejects(workspace.read("external.txt"), /64 KiB/);
});

test("workspace refuses invalid UTF-8 and directories as files", async t => {
  const { root, workspace } = await fixture(t);
  await writeFile(path.join(root, "binary"), Buffer.from([0xff, 0xfe, 0xfd]));
  await assert.rejects(workspace.read("binary"));
  await assert.rejects(workspace.read("."), /regular UTF-8/);
});

test("workspace lists no more than 200 entries and labels truncation", async t => {
  const { root, workspace } = await fixture(t);
  await Promise.all(Array.from({ length: 201 }, (_, index) => writeFile(path.join(root, `${index}.txt`), "")));
  const result = await workspace.list();
  assert.equal(result.entries.length, 200);
  assert.equal(result.truncated, true);
});

test("approval is scoped to the owner, one-shot, and records the exact action", async () => {
  const approvals = new Approvals();
  const events = [];
  const args = { path: "notes.txt", content: "hello" };
  const result = approvals.request("owner", "workspace_create", args, event => events.push(event), new AbortController().signal);
  const request = events[0];
  assert.equal(request.type, "approval");
  assert.deepEqual(request.args, args);
  assert.equal(approvals.decide("other", request.id, true), false);
  assert.equal(approvals.decide("owner", request.id, true), true);
  assert.equal(await result, true);
  assert.equal(approvals.decide("owner", request.id, true), false);
  assert.equal(events.at(-1).approved, true);
});

test("approval denial, expiry and cancellation never authorize actions", async () => {
  const approvals = new Approvals();
  const events = [];
  const emit = event => events.push(event);
  const denied = approvals.request("o", "write", {}, emit, new AbortController().signal);
  approvals.decide("o", events.at(-1).id, false);
  assert.equal(await denied, false);
  assert.equal(await approvals.request("o", "write", {}, emit, new AbortController().signal, 5), false);
  const controller = new AbortController();
  const cancelled = approvals.request("o", "write", {}, emit, controller.signal);
  controller.abort();
  assert.equal(await cancelled, false);
  assert.equal(await approvals.request("o", "write", {}, emit, controller.signal), false);
});

test("SQLite persists conversation history across reopen and filters display messages", async t => {
  const { directory } = await fixture(t);
  const filename = path.join(directory, "conversations.db");
  const store = new Store(filename);
  const id = store.create("Discuss MCP");
  store.save(id, [
    { role: "user", content: "hello" },
    { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "workspace_list", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "c1", content: "{}" },
    { role: "assistant", content: "Here are your files." }
  ]);
  store.close();
  const reopened = new Store(filename);
  try {
    assert.equal(reopened.list()[0].id, id);
    assert.equal(reopened.load(id).length, 4);
    assert.deepEqual(reopened.display(id), [
      { role: "user", content: "hello" }, { role: "assistant", content: "Here are your files." }
    ]);
    assert.throws(() => reopened.load("missing"), ConversationNotFound);
    assert.equal((await readFile(filename)).subarray(0, 6).toString(), "SQLite");
  } finally {
    reopened.close();
  }
});
