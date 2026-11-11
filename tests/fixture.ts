import { searchFixture } from "./search-fixture.ts";
import { panelsFixture } from "./panels-fixture.ts";
import {
  capabilities,
  type ChatMessage,
  type ChatView,
  type Receipt,
  type Submission,
} from "../packages/contracts/src/index.ts";
import type { ChatBackend, ChatChange } from "../packages/contracts/src/server.ts";
export function fixtureBackend() {
  let active: string | null = null;
  const messages: ChatMessage[] = [];
  const submissions = new Map<string, Submission>();
  const receipts = new Map<string, Receipt>();
  const listeners = new Set<(change: ChatChange) => void>();
  const scope = Symbol("fixture session");
  let executions = 0;
  const changed = () => {
    for (const listener of listeners) listener({ type: "update", scope,
      window: { messages: [...messages].slice(-30), before: null }, state: { activeTurnId: active } });
  };
  const panels = panelsFixture();
  const backend: ChatBackend = {
    ...panels.backend,
    ...searchFixture().backend,
    async read(): Promise<ChatView> {
      return {
        version: 2,
        sessionId: "fixture-session",
        name: "Mica",
        activeTurnId: active,
        contextUsage: { tokens: null, capacity: null },
        compaction: null,
        messages: [...messages].slice(-30),
        before: null,
        capabilities,
      };
    },
    async compact(input) {
      return { sessionId: input.sessionId, accepted: false };
    },
    async history() {
      return { messages: [], before: null };
    },
    async submit(input) {
      const old = submissions.get(input.operationId);
      if (old) {
        if (JSON.stringify(old) !== JSON.stringify(input))
          throw new Error("Identity conflict");
        return receipts.get(input.operationId)!;
      }
      submissions.set(input.operationId, { ...input });
      messages.push({
        id: input.operationId,
        role: "user",
        text: input.text,
        createdAt: Date.now(),
        operationId: input.operationId,
        turnId: active ?? input.operationId,
      });
      if (!active) {
        active = input.operationId;
        executions++;
      }
      const receipt: Receipt = {
        operationId: input.operationId, attempt: 1, state: "submitted",
        messageId: input.operationId, turnId: active, error: null,
      };
      receipts.set(input.operationId, receipt);
      changed();
      for (const listener of listeners) listener({ type: "deliveryResult", scope, receipt });
      return receipt;
    },
    async lookup(id) {
      return receipts.get(id) ?? null;
    },
    async stop(id) {
      if (active !== id) return { stopped: false };
      messages.push({
        id: `turn:${id}:status`,
        role: "notice",
        text: "已停止回复",
        createdAt: Date.now(),
        operationId: null,
        turnId: id,
      });
      active = null;
      changed();
      return { stopped: true };
    },
    subscribe(listener) {
      listeners.add(listener);
      return { scope, close() { listeners.delete(listener); } };
    },
  };
  return {
    backend,
    panels,
    reset() {
      active = null;
      messages.length = 0;
      submissions.clear();
      receipts.clear();
      executions = 0;
      changed();
    },
    remind() {
      messages.push({
        id: crypto.randomUUID(),
        role: "user",
        text: "应用提醒正文",
        source: { kind: "reminder", reminderId: "once" },
        createdAt: Date.now(),
        operationId: null,
        turnId: null,
      });
      changed();
    },
    get executions() {
      return executions;
    },
    async complete(text = "完整回复") {
      if (!active) return;
      messages.push({
        id: `answer:${active}`,
        role: "agent",
        text,
        createdAt: Date.now(),
        operationId: null,
        turnId: active,
      });
      active = null;
      changed();
    },
  };
}
