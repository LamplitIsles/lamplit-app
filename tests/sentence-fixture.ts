import { fixtureBackend } from "./fixture.ts";
import type {
  ChatMessage,
  ChatView,
  StreamingReply,
} from "../packages/contracts/src/index.ts";
import { capabilities } from "../packages/contracts/src/index.ts";
import type { ChatChange } from "../packages/contracts/src/server.ts";

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
  let gapMessages: ChatMessage[] | undefined;
  let gapHistoryCalls = 0;
  let failNextGapPage = false;
  const listeners = new Set<{ fn: (change: ChatChange) => void; scope: symbol; sessionId: string }>();
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
        gapMessages = undefined;
        gapHistoryCalls = 0;
        failNextGapPage = false;
        seed();
        break;
      case "gap-seed":
        gapMessages = Array.from({ length: 65 }, (_, i) => record(`gap-${i}`, `消息 ${i}`, { createdAt: i }));
        break;
      case "gap-advance":
        if (!gapMessages) throw new Error("Missing gap fixture");
        gapMessages.push(...Array.from({ length: 60 }, (_, i) => record(`gap-${i + 65}`, `消息 ${i + 65}`, { createdAt: i + 65 })));
        break;
      case "gap-fail-next":
        failNextGapPage = true;
        break;
      case "media-captions":
        gapMessages = undefined;
        messages = [
          record("image-caption", "图片附带文字", { imageState: "failed" }),
          record("voice-caption", "语音附带文字", { voice: { id: "a".repeat(64) } }),
        ];
        older = [];
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
          record(preview.id, input.text ?? preview.text, {
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
    const view = currentView();
    for (const listener of listeners) {
      if (listener.sessionId !== sessionId) {
        const nextScope = Symbol("sentence session");
        listener.fn({ type: "session", scope: listener.scope, nextScope, view });
        listener.scope = nextScope;
        listener.sessionId = sessionId;
      } else listener.fn({ type: "update", scope: listener.scope,
        window: { messages: view.messages, before: view.before },
        state: { activeTurnId: view.activeTurnId, streamingReply: view.streamingReply ?? null,
          replyCompletedTurnId: view.replyCompletedTurnId ?? null } });
    }
    return {
      held: !!preview,
      generationId: preview?.id ?? null,
      executions,
      completed: input.action === "complete",
      gapHistoryCalls,
    };
  };
  function currentView(): ChatView {
    return {
      version: 2, name: "Mica", sessionId, activeTurnId: active,
      contextUsage: { tokens: null, capacity: null }, compaction: null, capabilities, recovery: [],
      messages: gapMessages ? gapMessages.slice(-30) : [...messages],
      ...(replyCompletedTurnId === undefined ? {} : { replyCompletedTurnId }),
      before: gapMessages ? (gapMessages.length > 30 ? String(gapMessages.length - 30) : null) : older.length ? "older" : null,
      ...(preview ? { streamingReply: preview } : {}),
    };
  }
  return {
    control,
    backend: {
      ...base.backend,
      async read() {
        return currentView();
      },
      async stop(turnId: string) {
        if (turnId !== active) return { stopped: false };
        control({ action: "stop" });
        return { stopped: true };
      },
      async history(before: string) {
        if (gapMessages) {
          gapHistoryCalls++;
          if (failNextGapPage) { failNextGapPage = false; throw new Error("test-owned gap failure"); }
          const end = Number(before), start = Math.max(0, end - 30);
          return { messages: gapMessages.slice(start, end), before: start ? String(start) : null };
        }
        return { messages: [...older], before: null };
      },
      subscribe(fn: (change: ChatChange) => void) {
        const listener = { fn, scope: Symbol("sentence session"), sessionId };
        listeners.add(listener);
        return { scope: listener.scope, close() { listeners.delete(listener); } };
      },
    },
  };
}
