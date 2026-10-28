# ToolBridge AI

A local-first AI assistant that discovers and uses MCP tools for web research,
workspace files, and public GitHub APIs through a single chat interface.

**Status:** portfolio MVP, not a production multi-user service. This is an
original application built on the official MCP SDK, not a renamed fork.

## What makes it different from a chat wrapper?

- **Real MCP:** a host starts a separate stdio tool server, negotiates a connection,
  discovers JSON schemas, and passes those tools to the model.
- **Dynamic orchestration:** the model chooses tools; there is no keyword router.
  Tool results feed back into the model, with an eight-step execution budget.
- **Human control:** file creation pauses for approval of the exact path and
  content. Approval is one-use and expires after 60 seconds. Files cannot be
  overwritten or deleted.
- **Visible execution:** streamed assistant text, tool arguments, results, errors,
  durations, and per-run token usage.
- **Persistence:** SQLite stores completed conversation history on your device.
- **Bounded operations:** workspace paths only, no symlinks/junctions, 64 KiB files,
  fixed remote endpoints, request timeouts, and a three-minute run deadline.
- **Tests:** unit tests plus real stdio MCP / local mock-model integration tests.
  CI runs on Windows and Linux without paid API keys.

## Quick start

Requires Node.js **22.16+** and npm. Node 22's built-in SQLite may print an
experimental API warning; this is expected.

```powershell
npm ci
Copy-Item .env.example .env
# Edit .env locally and add your model key. Never paste secrets into chat.
npm run build
npm start
```

Open **http://127.0.0.1:4317**.

You can open the interface without API keys. Chat explicitly reports missing model
configuration; web search explicitly reports a missing search key.

### Configuration

| Variable | Purpose |
|---|---|
| `OPENAI_API_KEY` | Required for chat; stays on the backend |
| `OPENAI_MODEL` | Default `gpt-4.1-mini`; use a tool-capable model |
| `OPENAI_BASE_URL` | Optional trusted OpenAI-compatible endpoint |
| `BRAVE_SEARCH_API_KEY` | Required only for web search |
| `GITHUB_TOKEN` | Optional read-only token for higher public API rate limits |
| `PORT` | Local port, default `4317` |
| `TOOLBRIDGE_HOME` | Optional local data location; defaults to the project folder |

Model providers must support Chat Completions, streamed function calls, usage
chunks, and `max_completion_tokens`. Compatibility with arbitrary providers is
not guaranteed. The configured API key is sent to `OPENAI_BASE_URL`; only use a
provider you trust. Model and search providers may charge for requests.

### Try these prompts

1. "Find public GitHub repositories about MCP agents in TypeScript. Compare their
   approaches and include source URLs."
2. "Search the web for the latest MCP documentation and summarize it with sources."
3. "List my workspace files, then create a new getting-started.txt explaining MCP."
4. "Read getting-started.txt and suggest improvements." Changes are suggestions:
   this MVP intentionally supports new files only.

The application creates `workspace/` for files and `.toolbridge/` for SQLite data.
Both are ignored by Git. Never place credentials or private company material in
the workspace.

## Architecture

```text
React UI
  | authenticated same-origin fetch + NDJSON events
Node.js HTTP host
  |-- SQLite: completed conversations
  |-- Approval manager: owner-scoped, one-use decisions
  |-- Agent loop <--> OpenAI-compatible model
  |
  +-- MCP Client -- stdio / JSON-RPC --> MCP Server
                                        |-- workspace_list
                                        |-- workspace_read
                                        |-- workspace_create
                                        |-- web_search --> Brave Search API
                                        +-- github_search --> GitHub REST API
```

The model sees tool schemas obtained through `listTools`, not hand-maintained
function definitions. The host enforces approval policy independently of tool
annotations. The SDK's client/server v2 packages are used; tool transport remains
local stdio. This MVP connects one bundled server, not arbitrary remote servers.

### Key design choices

| Choice | Reason / trade-off |
|---|---|
| Separate MCP process | Exercises a real protocol boundary; adds startup and lifecycle work |
| SQLite | Simple local persistence; not a distributed storage solution |
| One active run | Avoids conflicting history updates; limits throughput intentionally |
| Create-only file writes | Safer, auditable behavior; no editing existing files yet |
| Explicit approval | Human authorization; not a substitute for OS isolation |
| Fixed upstream API hosts | Avoids arbitrary-URL fetch / SSRF surface; fewer integrations |
| NDJSON over fetch | Supports POST, cancellation, and typed streamed events without WebSockets |
| Model retries: at most one | Handles transient model failures; tool writes are never automatically retried |

## Development and verification

```powershell
npm run check
npm run test:core
npm run test:http
npm audit
npm run dev
```

`npm run dev` builds the web interface once, then watches backend TypeScript.
After changing frontend files, run `npm run build:web` and refresh the browser.
`npm run test:core` can run the filesystem, approval, and persistence tests without
installing third-party packages, using Node's experimental TypeScript transform.
The normal test suite uses `tsx` and also exercises the actual MCP subprocess and
a local HTTP model stub. Stub-model tests do not establish live model quality.
`npm run test:http` builds and launches the production server with an isolated
temporary data directory and a local model stub. It verifies streamed runs,
approval / denial, persistence, invalid input, and HTTP access controls.

### Safety boundaries and limitations

- The host binds to `127.0.0.1`, validates Host / Origin, and requires a random
  startup token on application APIs. It does not expose a hosted multi-user API.
- There is no shell tool, delete tool, arbitrary URL fetch, or user-supplied server
  execution configuration.
- Workspace containment rejects traversal, absolute paths, Windows device / stream
  aliases, and existing symbolic links or junctions. This is **not an OS sandbox**:
  a hostile local process racing filesystem checks is outside this MVP's threat
  model. Run under a dedicated low-privilege account for stronger isolation.
- Read-only network tools still transmit queries to external providers. Model
  requests may include file contents and tool results. "Local-first" does not
  mean offline or that your data never leaves the device.
- Prompt instructions treat retrieved content as untrusted, but prompt-injection
  prevention is not guaranteed. Approval and restricted tools are the hard limits.
- Tool calls execute serially. Upstream calls have a 12-second timeout; MCP calls
  have a 20-second timeout. Model calls use a 45-second timeout with one retry.
- Stopping, denying, or timing out never rolls back actions already approved and
  completed. Failed runs are not saved to conversation history; files may remain.
- Conversation history is plaintext local SQLite, not encrypted. Tool traces are
  shown for the current run but not persisted. No telemetry service is configured.
- The standalone MCP tool server trusts its host. The UI host, not the MCP server,
  enforces user approval; do not connect an untrusted client directly to it.

## Portfolio and resume use

Explain the architecture, trade-offs, failure modes, and tests in your own words.
Do not claim production adoption, accuracy, cost savings, latency improvements,
or security guarantees without measurements.

A factual starting point, after you run and understand the project:

> Built a TypeScript AI workspace using MCP tool discovery, a bounded multi-step
> agent loop, streamed execution traces, approval-gated file creation, and SQLite
> conversation persistence; implemented stdio integration tests and cross-platform CI.

Good next milestones: record a demo, add an evaluation dataset, measure tool
selection and latency, implement authenticated remote MCP connections, and add
durable audit records. These are future work, not current features.

## References and licensing

- [Official MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- [Model Context Protocol](https://modelcontextprotocol.io/)
- [OpenAI Node SDK](https://github.com/openai/openai-node)
- [Brave Search API](https://brave.com/search/api/)
- [GitHub REST API](https://docs.github.com/en/rest)
- [LibreChat](https://github.com/LibreChat-AI/LibreChat) is a related application,
  not this project's codebase.

Original application code is MIT licensed; dependencies retain their own licenses.
AI assistance was used during development. Do not copy upstream code without
reviewing its license and preserving required attribution.
