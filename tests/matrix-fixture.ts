import { fixtureBackend } from "./fixture.ts";
import type { ChatChange } from "../packages/contracts/src/server.ts";
import {
  MessageSchema,
  validate,
  type ChatMessage,
} from "../packages/contracts/src/index.ts";

/** Test-owned source feed. Native consumers implement these controls via their real adapters. */
export function matrixFixture() {
  const base = fixtureBackend();
  const live: ChatMessage[] = [];
  const older: ChatMessage[] = [];
  const listeners = new Set<(change: ChatChange) => void>();
  const scope = Symbol("source fixture session");
  const changed = () => {
    void base.backend.read().then(view => {
      for (const fn of listeners) fn({ type: "update", scope,
        window: { messages: [...live, ...view.messages].slice(-30), before: older.length ? "older-page" : null },
        state: { activeTurnId: view.activeTurnId } });
    });
  };
  const backend = {
    ...base.backend,
    async read() {
      const view = await base.backend.read();
      return {
        ...view,
        messages: [...live, ...view.messages].slice(-30),
        before: older.length ? "older-page" : null,
      };
    },
    async history(before: string) {
      if (before !== "older-page") throw new Error("Invalid fixture cursor");
      return { messages: [...older], before: null };
    },
    subscribe(listener: (change: ChatChange) => void) {
      listeners.add(listener);
      const off = base.backend.subscribe(() => changed());
      return { scope, close() {
        listeners.delete(listener);
        off.close();
      } };
    },
  };
  return {
    backend,
    async control(input: {
      action: string;
      id?: string;
      senderId?: string;
      senderDisplayName?: string;
      roomId?: string;
      createdAt?: number;
      text?: string;
      history?: boolean;
    }) {
      if (input.action === "reset") {
        base.reset();
        live.length = older.length = 0;
        changed();
      } else if (input.action === "incoming") {
        const message = validate(MessageSchema, {
          id: input.id,
          role: "user",
          text: input.text,
          createdAt: input.createdAt,
          operationId: null,
          turnId: null,
          source: {
            kind: "matrix",
            senderId: input.senderId,
            senderDisplayName: input.senderDisplayName,
            roomId: input.roomId,
          },
        });
        (input.history ? older : live).push(message);
        changed();
        return {};
      } else if (input.action === "reminder") base.remind();
      else if (input.action === "complete") await base.complete("普通回复");
      else if (input.action !== "state")
        throw new Error("Unknown fixture control");
      return {
        submissions: (await base.backend.read()).messages
          .filter((m) => m.role === "user" && !m.source)
          .map((m) => m.text),
      };
    },
  };
}
