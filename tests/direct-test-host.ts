import { createChatHost, type ChatBackend, type ChatChange } from "../packages/contracts/src/server.ts";

/** A test-owned provider that publishes its explicitly controlled window. */
export async function createDirectTestHost(backend: Omit<ChatBackend, "subscribe">, observer: (error: unknown) => void = () => {}) {
  let scope = Symbol("test session"), sessionId: string | undefined;
  let listener: (change: ChatChange) => void = () => {};
  const errors: unknown[] = [];
  const host = await createChatHost({
    ...backend,
    async read(signal) { const view = await backend.read(signal); sessionId = view.sessionId; return view; },
    subscribe(changed) { listener = changed; return { scope, close() { listener = () => {}; } }; },
  }, error => { errors.push(error); observer(error); });
  const publish = async () => {
    const view = await backend.read();
    const errorCount = errors.length;
    if (view.sessionId !== sessionId) {
      const nextScope = Symbol("test session");
      listener({ type: "session", scope, nextScope, view });
      scope = nextScope;
      sessionId = view.sessionId;
    } else listener({ type: "update", scope, window: { messages: view.messages, before: view.before }, state: {
      name: view.name, activeTurnId: view.activeTurnId, capabilities: view.capabilities,
      contextUsage: view.contextUsage, compaction: view.compaction,
      streamingReply: view.streamingReply ?? null, replyCompletedTurnId: view.replyCompletedTurnId ?? null,
    } });
    if (errors.length !== errorCount) throw errors.at(-1);
  };
  return { ...host, publish };
}
