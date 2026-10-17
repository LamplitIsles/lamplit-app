import { fixtureBackend } from "./fixture.ts";
import type {
  ChatMessage,
  StreamingReply,
} from "../packages/contracts/src/index.ts";

export const SENTENCE_PROMPT = "Test-owned sentence acceptance input";

/** App-only model of the semantic controls documented in docs/sentence-replies.md.
 * Native acceptance must translate them to its real held fake provider/events. */
export function sentenceFixture(profile = "default") {
  const base = fixtureBackend();
  let sessionId = "sentence-session";
  let messages: ChatMessage[] = [];
  let older: ChatMessage[] = [];
  let preview: StreamingReply | undefined;
  let active: string | null = null;
  let replyCompletedTurnId: string | undefined;
  let attempt = 0;
  let executions = 0;
  const listeners = new Set<() => void>();
  const record = (
    id: string,
    text: string,
    extra: Partial<ChatMessage> = {},
  ): ChatMessage => ({
    id,
    text,
    role: "agent",
    operationId: null,
    turnId: null,
    createdAt: 1792128000000 + messages.length,
    ...extra,
  });
  const seed = () => {
    messages = [
      record(
        "history",
        "历史第一行。同行第二句。\n历史第二行。",
        profile === "cfl" ? {} : { thinking: "一次思考" },
      ),
    ];
    older = [
      record("older", "更早第一行。\n更早第二行。", {
        createdAt: 1792127000000,
      }),
    ];
    preview = undefined;
    active = null;
    replyCompletedTurnId = undefined;
  };
  seed();
  const control = (input: { action: string; text?: string }) => {
    if (
      ["advance", "complete", "item-complete", "body-complete"].includes(
        input.action,
      ) &&
      (!preview ||
        typeof input.text !== "string" ||
        !input.text.startsWith(preview.text))
    )
      throw new Error("Provider text must extend the held prefix");
    switch (input.action) {
      case "reset":
        sessionId = "sentence-session";
        executions = 0;
        seed();
        break;
      case "start":
        if (preview) throw new Error("Provider already held");
        replyCompletedTurnId = undefined;
        executions++;
        active = `turn-${++attempt}`;
        // Model real user/answer coexistence in isolated handoff cases.
        // Existing seeded-history cases stay within the contract page limit.
        if (messages.length === 0)
          messages.push(
            record(`prompt-${attempt}`, SENTENCE_PROMPT, {
              role: "user",
              turnId: active,
            }),
          );
        preview = {
          id: `attempt-${attempt}`,
          turnId: active,
          createdAt: 1792129000000 + attempt,
          text: input.text ?? "",
        };
        break;
      case "advance":
        if (!preview) throw new Error("No held provider");
        preview = { ...preview, text: input.text ?? "" };
        break;
      case "item-complete":
      case "body-complete":
      case "complete":
        if (!preview) throw new Error("No held provider");
        messages.push(
          record(`native-entry-${attempt}`, input.text ?? preview.text, {
            turnId: active,
            createdAt: preview.createdAt,
          }),
        );
        preview = undefined;
        replyCompletedTurnId =
          input.action === "body-complete" ? (active ?? undefined) : undefined;
        if (input.action === "complete") active = null;
        break;
      case "stop":
      case "fail":
        preview = undefined;
        replyCompletedTurnId = undefined;
        active = null;
        messages.push(
          record(
            `notice-${++attempt}`,
            input.action === "stop" ? "已停止回复" : "回复失败",
            { role: "notice" },
          ),
        );
        break;
      case "session":
        sessionId = `session-${++attempt}`;
        messages = [];
        older = [];
        preview = undefined;
        replyCompletedTurnId = undefined;
        active = null;
        break;
      case "evidence":
        replyCompletedTurnId = input.text;
        break;
      case "finish-execution":
        active = null;
        replyCompletedTurnId = undefined;
        break;
      case "update":
        messages = messages.map((m) =>
          m.id === "history" ? { ...m, text: input.text ?? "" } : m,
        );
        break;
      case "status":
        break;
      case "excluded":
        messages.push(
          record("keet", "Keet第一行。\nKeet第二行。", {
            source: {
              kind: "keet",
              channel: "dm",
              senderLabel: "Friend",
              destination: "Test",
            },
          }),
        );
        messages.push(
          record("matrix", "Matrix第一行。\nMatrix第二行。", {
            source: {
              kind: "matrix",
              senderId: "@fixture:test",
              senderDisplayName: "Friend",
              roomId: "!fixture:test",
            },
          }),
        );
        messages.push(
          record(
            "rich",
            "普通第一行。同行第二句。\n普通第二行。\n\n**粗体第一句。粗体第二句。**\n\n```js\na.b();\n```",
            {
              ...(profile === "cfl" ? {} : { thinking: "图片组合一次思考" }),
              images: [1, 2].map((i) => ({
                attachmentId: `sentence-image-${i}`,
                name: `image-${i}.png`,
                mediaType: "image/png" as const,
                availability: "missing" as const,
              })),
            },
          ),
        );
        messages.push(
          record("user", "用户第一行。\n用户第二行。", { role: "user" }),
        );
        messages.push(
          record("notice", "提示第一行。\n提示第二行。", { role: "notice" }),
        );
        messages.push(
          record("reminder", "提醒第一行。\n提醒第二行。", {
            source: {
              kind: "reminder",
              reminderId: "alarm",
              occurrenceId: "occurrence",
            },
          }),
        );
        break;
      default:
        throw new Error("Unknown sentence fixture action");
    }
    listeners.forEach((fn) => fn());
    return {
      held: !!preview,
      generationId: preview?.id ?? null,
      executions,
      completed: input.action === "complete",
    };
  };
  return {
    control,
    backend: {
      ...base.backend,
      async read() {
        return {
          ...(await base.backend.read()),
          sessionId,
          messages: [...messages],
          activeTurnId: active,
          ...(replyCompletedTurnId === undefined
            ? {}
            : { replyCompletedTurnId }),
          before: older.length ? "older" : null,
          ...(preview ? { streamingReply: preview } : {}),
        };
      },
      async stop(turnId: string) {
        if (turnId !== active) return { stopped: false };
        control({ action: "stop" });
        return { stopped: true };
      },
      async history() {
        return { messages: [...older], before: null };
      },
      subscribe(fn: () => void) {
        listeners.add(fn);
        return () => {
          listeners.delete(fn);
        };
      },
    },
  };
}
