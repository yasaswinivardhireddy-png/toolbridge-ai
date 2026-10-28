import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type OpenAI from "openai";
import type { ConversationSummary, DisplayMessage } from "../shared.js";

export type Message = OpenAI.Chat.Completions.ChatCompletionMessageParam;

export class ConversationNotFound extends Error {}

export class Store {
  private readonly db: DatabaseSync;

  constructor(filename: string) {
    this.db = new DatabaseSync(filename);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, messages TEXT NOT NULL, updatedAt TEXT NOT NULL
      );
    `);
  }

  list(): ConversationSummary[] {
    return this.db.prepare("SELECT id, title, updatedAt FROM conversations ORDER BY updatedAt DESC LIMIT 50")
      .all().map(row => ({ id: String(row.id), title: String(row.title), updatedAt: String(row.updatedAt) }));
  }

  load(id: string): Message[] {
    const row = this.db.prepare("SELECT messages FROM conversations WHERE id = ?").get(id);
    if (!row) {
      throw new ConversationNotFound("Conversation not found.");
    }
    return JSON.parse(String(row.messages)) as Message[];
  }

  display(id: string): DisplayMessage[] {
    const messages: DisplayMessage[] = [];
    for (const message of this.load(id)) {
      if ((message.role === "user" || message.role === "assistant") && typeof message.content === "string" && message.content) {
        messages.push({ role: message.role, content: message.content });
      }
    }
    return messages;
  }

  create(title: string): string {
    const id = randomUUID();
    this.db.prepare("INSERT INTO conversations (id, title, messages, updatedAt) VALUES (?, ?, ?, ?)")
      .run(id, title.slice(0, 80), "[]", new Date().toISOString());
    return id;
  }

  save(id: string, messages: Message[]): void {
    this.db.prepare("UPDATE conversations SET messages = ?, updatedAt = ? WHERE id = ?")
      .run(JSON.stringify(messages), new Date().toISOString(), id);
  }

  close(): void {
    this.db.close();
  }
}
