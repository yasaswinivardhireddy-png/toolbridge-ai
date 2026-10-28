import { randomUUID } from "node:crypto";
import type { RunEvent } from "../shared.js";

export class Approvals {
  private readonly pending = new Map<string, { resolve: (approved: boolean) => void; owner: string }>();

  request(owner: string, name: string, args: Record<string, unknown>, emit: (event: RunEvent) => void, signal: AbortSignal, timeoutMs = 60_000): Promise<boolean> {
    return new Promise(resolve => {
      const id = randomUUID();
      const finish = (approved: boolean) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", cancel);
        this.pending.delete(id);
        emit({ type: "approval_resolved", id, approved });
        resolve(approved);
      };
      const cancel = () => finish(false);
      const timer = setTimeout(cancel, timeoutMs);
      this.pending.set(id, { resolve: finish, owner });
      signal.addEventListener("abort", cancel, { once: true });
      emit({ type: "approval", id, name, args, expiresAt: Date.now() + timeoutMs });
      if (signal.aborted) {
        cancel();
      }
    });
  }

  decide(owner: string, id: string, approved: boolean): boolean {
    const entry = this.pending.get(id);
    const found = entry !== undefined && entry.owner === owner;
    if (found) {
      entry.resolve(approved);
    }
    return found;
  }
}
