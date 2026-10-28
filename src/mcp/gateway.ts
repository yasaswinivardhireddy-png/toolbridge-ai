import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client, type Tool } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type OpenAI from "openai";

export class Gateway {
  private readonly client = new Client({ name: "toolbridge-host", version: "0.1.0" });
  private tools: Tool[] = [];

  async connect(workspace: string): Promise<void> {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const isSource = import.meta.url.endsWith(".ts");
    const args = isSource
      ? ["--import", "tsx", path.join(here, "server.ts"), "--stdio"]
      : [path.join(here, "server.js"), "--stdio"];
    // Do not inherit model keys or unrelated shell credentials into the tool process.
    const env: Record<string, string> = { TOOLBRIDGE_WORKSPACE: workspace };
    for (const name of ["PATH", "Path", "SystemRoot", "TEMP", "TMP", "HOME", "USERPROFILE", "BRAVE_SEARCH_API_KEY", "GITHUB_TOKEN"]) {
      const value = process.env[name];
      if (value) {
        env[name] = value;
      }
    }
    await this.client.connect(new StdioClientTransport({
      command: process.execPath, args, env, stderr: "inherit"
    }));
    this.tools = (await this.client.listTools()).tools;
  }

  catalog(): Tool[] {
    return this.tools;
  }

  modelTools(): OpenAI.Chat.Completions.ChatCompletionTool[] {
    return this.tools.map(tool => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema
      }
    }));
  }

  requiresApproval(name: string): boolean {
    // Policy belongs to the host, not to untrusted MCP annotations.
    return !["workspace_list", "workspace_read", "web_search", "github_search"].includes(name);
  }

  async call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<{ text: string; isError: boolean }> {
    if (!this.tools.some(tool => tool.name === name)) {
      throw new Error(`Unknown MCP tool: ${name}`);
    }
    const response = await this.client.callTool(
      { name, arguments: args }, { timeout: 20_000, signal }
    );
    return { text: JSON.stringify(response), isError: response.isError === true };
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}
