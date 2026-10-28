import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { ConversationSummary, DisplayMessage, RunEvent } from "../src/shared.js";
import "./style.css";

interface Config {
  modelConfigured: boolean;
  searchConfigured: boolean;
  model: string;
  tools: { name: string; description: string; requiresApproval: boolean }[];
}

const token = document.querySelector<HTMLMetaElement>('meta[name="toolbridge-token"]')?.content ?? "";

async function api(url: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", "X-ToolBridge-Token": token, ...init?.headers }
  });
  if (!response.ok) {
    const data = await response.json() as { error?: string };
    throw new Error(data.error ?? `Request failed (${response.status}).`);
  }
  return response;
}

function App() {
  const [config, setConfig] = useState<Config>();
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [conversationId, setConversationId] = useState<string>();
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [usage, setUsage] = useState("");
  const [approvalBusy, setApprovalBusy] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const end = useRef<HTMLDivElement>(null);

  async function refreshHistory() {
    setConversations(await (await api("/api/conversations")).json() as ConversationSummary[]);
  }

  useEffect(() => {
    void Promise.all([
      api("/api/config").then(response => response.json()).then((value: Config) => setConfig(value)),
      refreshHistory()
    ]).catch((reason: Error) => setError(reason.message));
    return () => controller.current?.abort();
  }, []);

  useEffect(() => { end.current?.scrollIntoView({ behavior: "smooth" }); }, [messages, events]);

  function onEvent(event: RunEvent) {
    if (event.type === "run") {
      setConversationId(event.conversationId);
    } else if (event.type === "text") {
      setMessages(previous => {
        const next = [...previous];
        const last = next[next.length - 1];
        if (last?.role === "assistant") {
          next[next.length - 1] = { role: "assistant", content: last.content + event.text };
        } else {
          next.push({ role: "assistant", content: event.text });
        }
        return next;
      });
    } else if (event.type === "error") {
      setError(event.message);
    } else if (event.type === "done") {
      setUsage(`${event.inputTokens.toLocaleString()} input / ${event.outputTokens.toLocaleString()} output tokens`);
    } else {
      setEvents(previous => [...previous, event]);
    }
  }

  async function send(event: React.FormEvent) {
    event.preventDefault();
    if (!prompt.trim() || busy) {
      return;
    }
    const text = prompt.trim();
    const abort = new AbortController();
    controller.current = abort;
    setBusy(true);
    setPrompt("");
    setError("");
    setEvents([]);
    setUsage("");
    setMessages(previous => [...previous, { role: "user", content: text }]);
    let terminalEvent = false;
    try {
      const response = await api("/api/chat", {
        method: "POST",
        body: JSON.stringify({ prompt: text, conversationId }),
        signal: abort.signal
      });
      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error("The browser could not open the response stream.");
      }
      const decoder = new TextDecoder();
      let pending = "";
      for (;;) {
        const result = await reader.read();
        pending += decoder.decode(result.value, { stream: !result.done });
        let boundary;
        while ((boundary = pending.indexOf("\n")) >= 0) {
          const line = pending.slice(0, boundary);
          pending = pending.slice(boundary + 1);
          if (line) {
            const event = JSON.parse(line) as RunEvent;
            terminalEvent ||= event.type === "done" || event.type === "error";
            onEvent(event);
          }
        }
        if (result.done) {
          break;
        }
      }
      if (!terminalEvent) {
        throw new Error("The stream ended unexpectedly. Approved file actions may already have completed.");
      }
    } catch (reason) {
      setError(abort.signal.aborted
        ? "Run stopped. Approved file actions are not rolled back."
        : reason instanceof Error ? reason.message : "Chat request failed.");
    } finally {
      controller.current = null;
      setBusy(false);
      try {
        await refreshHistory();
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : "Could not refresh history.");
      }
    }
  }

  async function load(id: string) {
    try {
      const history = await (await api(`/api/conversations/${id}`)).json() as DisplayMessage[];
      setConversationId(id);
      setMessages(history);
      setEvents([]);
      setUsage("");
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load conversation.");
    }
  }

  const resolved = new Set(events.filter(event => event.type === "approval_resolved").map(event => event.id));
  const approval = events.findLast(event => event.type === "approval" && !resolved.has(event.id));

  async function decide(id: string, approved: boolean) {
    setApprovalBusy(true);
    try {
      await api("/api/approvals", { method: "POST", body: JSON.stringify({ id, approved }) });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Approval failed.");
    } finally {
      setApprovalBusy(false);
    }
  }

  return <div className="app">
    <aside className="sidebar">
      <a className="brand" href="/" aria-label="ToolBridge home"><span className="brand-mark">tb</span> ToolBridge<span className="ai">AI</span></a>
      <div className="workspace-label">YOUR LOCAL WORKSPACE</div>
      <button className="new-chat" disabled={busy} onClick={() => {
        setConversationId(undefined); setMessages([]); setEvents([]); setError(""); setUsage("");
      }}>+ New conversation</button>
      <h2>Recent conversations</h2>
      <nav aria-label="Conversation history">
        {conversations.map(conversation => <button key={conversation.id} disabled={busy}
          className={`history-item ${conversationId === conversation.id ? "selected" : ""}`}
          onClick={() => { void load(conversation.id); }}>{conversation.title}</button>)}
        {!conversations.length && <p className="muted small">Your conversations stay on this device.</p>}
      </nav>
      <div className="sidebar-bottom"><span className="status-dot" /> Local-first by design<br /><span className="muted small">Tools run locally. Queries go to configured providers.</span></div>
    </aside>
    <main>
      <header><span>Workspace / <strong>Assistant</strong></span><span className="badge">MCP CONNECTED {config ? ` / ${config.tools.length} tools` : ""}</span></header>
      <section className="chat" aria-label="Conversation">
        {!messages.length && <div className="welcome">
          <div className="eyebrow">ONE CONVERSATION. REAL CAPABILITIES.</div>
          <h1>Less switching.<br /><span>More doing.</span></h1>
          <p>Search the web, explore APIs, and work with files.<br />Your assistant finds the right tools. You stay in control.</p>
          <div className="suggestions">
            {[
              ["Explore GitHub", "Find public GitHub repositories about MCP agents in TypeScript. Compare their approaches and include source URLs."],
              ["Research a topic", "Search the web for the latest Model Context Protocol documentation. Summarize the key concepts with sources."],
              ["Create something", "List my workspace files, then create a new file called getting-started.txt explaining what MCP is."]
            ].map(([title, text]) => <button key={title} onClick={() => setPrompt(text!)}><span>{title}</span><span aria-hidden="true">↗</span></button>)}
          </div>
        </div>}
        {messages.map((message, index) => <article key={index} className={`message ${message.role}`}>
          <div className="message-label">{message.role === "user" ? "YOU" : "TOOLBRIDGE"}</div>
          <div className="message-content">{message.content}</div>
        </article>)}
        {busy && <div className="working" role="status"><span className="status-dot" /> Working through your request...</div>}
        {busy && approval?.type === "approval" && <section className="approval" aria-label="Action approval">
          <h3>Permission to create a file</h3><p>Review the exact path and content before approving.</p>
          <pre>{JSON.stringify(approval.args, null, 2)}</pre>
          <p className="small">Expires after 60 seconds. Existing files are never overwritten.</p>
          <div className="approval-buttons"><button disabled={approvalBusy} onClick={() => { void decide(approval.id, false); }}>Deny</button>
            <button className="send" disabled={approvalBusy} onClick={() => { void decide(approval.id, true); }}>Approve</button></div>
        </section>}
        <div ref={end} />
      </section>
      <div className="composer-wrap">
        {error && <div className="error" role="alert">{error}</div>}
        {config && !config.modelConfigured && <div className="notice">Setup needed: add OPENAI_API_KEY to your local .env file and restart. Never paste API keys into chat.</div>}
        <form className="composer" onSubmit={event => { void send(event); }}>
          <label className="sr-only" htmlFor="prompt">Message ToolBridge</label>
          <textarea id="prompt" placeholder="What would you like to get done?" maxLength={8000} rows={2}
            value={prompt} onChange={event => setPrompt(event.target.value)} disabled={busy}
            onKeyDown={event => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault(); event.currentTarget.form?.requestSubmit();
              }
            }} />
          <div className="composer-bottom"><span>Files stay inside your workspace. Writes need approval.</span>
            {busy ? <button type="button" className="stop" onClick={() => controller.current?.abort()}>Stop</button>
              : <button type="submit" className="send" disabled={!prompt.trim() || !config?.modelConfigured}>Send ↗</button>}</div>
        </form>
        <div className="footer-note">{usage || "AI can make mistakes. Review sources and tool actions."}</div>
      </div>
    </main>
    <aside className="tools-panel">
      <div className="panel-title">Connected capabilities <span>{config?.tools.length ?? 0}</span></div>
      {config?.tools.map(tool => <div className="tool-card" key={tool.name}>
        <div className="tool-name">{tool.name.replaceAll("_", " ")}</div>
        <p>{tool.description}</p>
        <span className={`tool-tag ${tool.requiresApproval ? "approval-tag" : ""}`}>{tool.requiresApproval ? "APPROVAL REQUIRED" : "READ ONLY"}</span>
        {tool.name === "web_search" && !config.searchConfigured && <div className="setup-label">Search key needed</div>}
      </div>)}
      <h2>Execution timeline</h2>
      {!events.length && <p className="muted small">Tool calls, timings, and approval requests appear here as they happen.</p>}
      <div aria-live="polite">
        {events.map((event, index) => event.type === "tool_start"
          ? <details className="trace" key={index}><summary>RUNNING / {event.name}</summary><pre>{JSON.stringify(event.args, null, 2)}</pre></details>
          : event.type === "tool_end"
            ? <details className={`trace ${event.isError ? "trace-error" : ""}`} key={index}><summary>{event.isError ? "ERROR" : "DONE"} / {event.name} / {event.durationMs} ms</summary><pre>{event.result}</pre></details>
            : event.type === "approval_resolved"
              ? <div className="trace" key={index}>{event.approved ? "APPROVED" : "DENIED / EXPIRED"}</div>
              : null)}
      </div>
    </aside>
  </div>;
}

createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
