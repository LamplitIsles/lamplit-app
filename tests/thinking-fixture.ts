import { fixtureBackend } from "./fixture.ts";
import {
  MessageSchema,
  validate,
  type ChatMessage,
} from "../packages/contracts/src/index.ts";

/** Test-owned completed DTO feed; native hosts project equivalent actual thinking blocks. */
export function thinkingFixture() {
  const base = fixtureBackend();
  const live: ChatMessage[] = [];
  const older: ChatMessage[] = [];
  const listeners = new Set<() => void>();
  const changed = () => listeners.forEach((fn) => fn());
  return {
    backend: {
      ...base.backend,
      async read() {
        return {
          ...(await base.backend.read()),
          messages: [...live],
          before: older.length ? "older" : null,
        };
      },
      async history(before: string) {
        if (before !== "older") throw new Error("Invalid fixture cursor");
        return { messages: [...older], before: null };
      },
      subscribe(fn: () => void) {
        listeners.add(fn);
        return () => {
          listeners.delete(fn);
        };
      },
    },
    control(input: {
      action: string;
      message?: ChatMessage;
      history?: boolean;
    }) {
      if (input.action === "reset") {
        live.length = older.length = 0;
      } else if (input.action === "message") {
        const message = validate(MessageSchema, input.message);
        const target = input.history ? older : live;
        target.push(message);
        // Preserve the native failed-reply outcome of a successful thinking-only stop.
        if (
          message.role === "agent" &&
          message.thinking &&
          !message.text &&
          !message.images?.length
        ) {
          const { thinking: _, ...notice } = message;
          target.push({
            ...notice,
            id: `${message.id}:status`,
            role: "notice",
            text: "回复失败",
          });
        }
      } else throw new Error("Unknown fixture action");
      changed();
      return { accepted: true };
    },
  };
}
