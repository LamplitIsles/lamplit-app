import { fixtureBackend } from "./fixture.ts";
import {
  MessageSchema,
  validate,
  type ChatMessage,
} from "../packages/contracts/src/index.ts";

/** Test-owned source feed. Native consumers implement these controls via their real adapters. */
export function keetFixture(imageProfile: "dm" | "text-only" = "dm") {
  const base = fixtureBackend();
  const live: ChatMessage[] = [];
  const older: ChatMessage[] = [];
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const fn of listeners) fn();
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
    subscribe(listener: () => void) {
      listeners.add(listener);
      const off = base.backend.subscribe(listener);
      return () => {
        listeners.delete(listener);
        off();
      };
    },
  };
  return {
    backend,
    async control(input: {
      action: string;
      id?: string;
      channel?: "dm" | "group";
      senderLabel?: string;
      destination?: string;
      text?: string;
      history?: boolean;
      hasImage?: boolean;
      images?: ChatMessage["images"];
    }) {
      if (input.action === "reset") {
        base.reset();
        live.length = older.length = 0;
        changed();
      } else if (input.action === "incoming") {
        if (input.images && (input.channel !== "dm" || imageProfile !== "dm"))
          throw new Error(
            "Images are supported only by the DM acceptance profile",
          );
        const imageNote =
          input.hasImage && !input.images
            ? "图片暂不可用（测试原生入口说明）"
            : undefined;
        const message = validate(MessageSchema, {
          id: input.id,
          role: "user",
          text: [input.text, imageNote].filter(Boolean).join("\n\n"),
          createdAt: 1791320400000,
          operationId: null,
          turnId: null,
          ...(input.images ? { images: input.images } : {}),
          source: {
            kind: "keet",
            channel: input.channel,
            senderLabel: input.senderLabel,
            destination: input.destination,
          },
        });
        (input.history ? older : live).push(message);
        changed();
        return { imageNote };
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
