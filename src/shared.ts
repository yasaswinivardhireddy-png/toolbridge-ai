export type RunEvent =
  | { type: "run"; conversationId: string }
  | { type: "text"; text: string }
  | { type: "tool_start"; name: string; args: Record<string, unknown> }
  | { type: "tool_end"; name: string; result: string; durationMs: number; isError: boolean }
  | { type: "approval"; id: string; name: string; args: Record<string, unknown>; expiresAt: number }
  | { type: "approval_resolved"; id: string; approved: boolean }
  | { type: "done"; inputTokens: number; outputTokens: number }
  | { type: "error"; message: string };

export interface ConversationSummary {
  id: string;
  title: string;
  updatedAt: string;
}

export interface DisplayMessage {
  role: "user" | "assistant";
  content: string;
}
