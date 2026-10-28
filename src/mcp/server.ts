import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { Workspace } from "../tools/filesystem.js";
import { searchGithub, searchWeb } from "../tools/remote.js";

export function createToolServer(workspacePath: string): McpServer {
  const server = new McpServer({ name: "toolbridge-workspace", version: "0.1.0" });
  const workspace = new Workspace(workspacePath);
  const readOnly = { readOnlyHint: true, destructiveHint: false };
  const query = z.string().trim().min(1).max(500);
  const filePath = z.string().min(1).max(240);
  const count = z.number().int().min(1).max(10).default(5);

  async function result(operation: () => Promise<unknown>) {
    let response;
    try {
      response = { content: [{ type: "text" as const, text: JSON.stringify(await operation()) }] };
    } catch (error) {
      response = {
        isError: true,
        content: [{ type: "text" as const, text: error instanceof Error ? error.message : "Tool execution failed." }]
      };
    }
    return response;
  }

  server.registerTool("workspace_list", {
    description: "List up to 200 entries in the dedicated workspace. Paths are relative.",
    inputSchema: z.object({ path: filePath.default(".") }),
    annotations: readOnly
  }, ({ path }) => result(() => workspace.list(path)));

  server.registerTool("workspace_read", {
    description: "Read a UTF-8 file up to 64 KiB inside the dedicated workspace.",
    inputSchema: z.object({ path: filePath }),
    annotations: readOnly
  }, ({ path }) => result(() => workspace.read(path)));

  server.registerTool("workspace_create", {
    description: "Create a new UTF-8 file in an existing workspace directory. Never overwrites. Requires user approval.",
    inputSchema: z.object({ path: filePath, content: z.string().max(65_536) }),
    annotations: { readOnlyHint: false, destructiveHint: false }
  }, ({ path, content }) => result(() => workspace.write(path, content)));

  server.registerTool("web_search", {
    description: "Search the public web with Brave Search. Returns titles, URLs and snippets; requires a configured search key.",
    inputSchema: z.object({ query, count }),
    annotations: readOnly
  }, ({ query, count }) => result(() => searchWeb(query, count)));

  server.registerTool("github_search", {
    description: "Search public GitHub repositories with the GitHub REST API. Returns source links and repository metadata.",
    inputSchema: z.object({ query, count }),
    annotations: readOnly
  }, ({ query, count }) => result(() => searchGithub(query, count)));
  return server;
}

if (process.argv.includes("--stdio")) {
  const workspace = process.env.TOOLBRIDGE_WORKSPACE;
  if (!workspace) {
    throw new Error("TOOLBRIDGE_WORKSPACE is required.");
  }
  serveStdio(() => createToolServer(workspace));
}
