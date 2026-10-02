import { panelsFixture } from "./panels-fixture.ts";
import {
  capabilities,
  type ChatMessage,
  type ChatView,
  type Receipt,
  type Submission,
} from "../packages/contracts/src/index.ts";
import type { ChatBackend } from "../packages/contracts/src/server.ts";
export function fixtureBackend() {
  let active: string | null = null;
  const messages: ChatMessage[] = [];
  const submissions = new Map<string, Submission>();
  const listeners = new Set<() => void>();
  let executions = 0;
  const changed = () => {
    for (const listener of listeners) listener();
  };
  const receipt = (id: string): Receipt => ({
    operationId: id,
    state: submissions.has(id) ? "consumed" : "missing",
    messageId: submissions.has(id) ? id : null,
    turnId: active,
    error: null,
  });
  const panels = panelsFixture();
  const backend: ChatBackend = {
    ...panels.backend,
    async read(): Promise<ChatView> {
      return {
        version: 1,
        sessionId: "fixture-session",
        name: "Mica",
        activeTurnId: active,
        contextUsage: { tokens: null, capacity: null },
        compaction: null,
        messages: [...messages].slice(-30),
        before: null,
        capabilities,
        recovery: [],
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
        if (old.text !== input.text) throw new Error("Identity conflict");
        return receipt(input.operationId);
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
      changed();
      return receipt(input.operationId);
    },
    async lookup(id) {
      return receipt(id);
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
      return () => listeners.delete(listener);
    },
  };
  return {
    backend,
    panels,
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
      messages.push({
        id: `turn:${active}:status`,
        role: "notice",
        text: "回复完成",
        createdAt: Date.now(),
        operationId: null,
        turnId: active,
      });
      active = null;
      changed();
    },
  };
}
