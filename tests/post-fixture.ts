import { fixtureBackend } from "./fixture.ts";
import {
  MessageSchema,
  validate,
  type ChatMessage,
  type MessageSource,
} from "../packages/contracts/src/index.ts";

/** Owned display-contract feed, never a native Post ingress substitute. */
export function postFixture() {
  const base = fixtureBackend();
  const live: ChatMessage[] = [],
    older: ChatMessage[] = [];
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const fn of listeners) fn();
  };
  return {
    backend: {
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
        if (before !== "older-page") throw new Error("Invalid owned cursor");
        return { messages: [...older], before: null };
      },
      subscribe(listener: () => void) {
        listeners.add(listener);
        const off = base.backend.subscribe(listener);
        return () => {
          listeners.delete(listener);
          off();
        };
      },
    },
    async control(input: {
      action: string;
      id?: string;
      source?: MessageSource;
      text?: string;
      createdAt?: number;
      images?: ChatMessage["images"];
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
          source: input.source,
          ...(input.images ? { images: input.images } : {}),
        });
        (input.history ? older : live).push(message);
        changed();
      } else if (input.action === "reminder") base.remind();
      else if (input.action === "complete") await base.complete("普通回复");
      else if (input.action !== "state")
        throw new Error("Unknown owned control");
      return {
        submissions: (await base.backend.read()).messages
          .filter((m) => m.role === "user" && !m.source)
          .map((m) => m.text),
      };
    },
  };
}
