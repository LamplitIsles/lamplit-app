import { searchFixture } from "./search-fixture.ts";
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
  const rejected = new Map<string, { input: Submission; receipt: Receipt }>();
  const deleted = new Set<string>();
  const retries = new Map<string, string>();
  const listeners = new Set<() => void>();
  let executions = 0;
  const changed = () => {
    for (const listener of listeners) listener();
  };
  const receipt = (id: string): Receipt | null =>
    submissions.has(id)
      ? {
          operationId: id,
          state: "submitted",
          messageId: id,
          turnId: active,
          error: null,
        }
      : null;
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
      const failed = rejected.get(input.operationId);
      if (failed) {
        if (JSON.stringify(failed.input) !== JSON.stringify(input))
          throw new Error("Identity conflict");
        return failed.receipt;
      }
      const old = submissions.get(input.operationId);
      if (old) {
        if (JSON.stringify(old) !== JSON.stringify(input))
          throw new Error("Identity conflict");
        return receipt(input.operationId)!;
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
      return receipt(input.operationId)!;
    },
    async finalizeSubmission(input) {
      const { sessionId } = input;
      if ("retry" in input) {
        if (
          input.retry.sessionId !== sessionId ||
          retries.get(input.retry.attemptId) !== input.retry.operationId
        )
          return null;
        return backend.lookup(input.retry.attemptId);
      }
      const { submission } = input;
      if (sessionId !== "fixture-session") throw new Error("Wrong session");
      const old =
        submissions.get(submission.operationId) ??
        rejected.get(submission.operationId)?.input;
      if (old && JSON.stringify(old) !== JSON.stringify(submission))
        throw new Error("Identity conflict");
      const accepted = receipt(submission.operationId);
      if (accepted) return accepted;
      if (!rejected.has(submission.operationId))
        rejected.set(submission.operationId, {
          input: structuredClone(submission),
          receipt: {
            operationId: submission.operationId,
            state: "failed",
            messageId: null,
            turnId: null,
            error: "消息未被接收",
          },
        });
      return rejected.get(submission.operationId)!.receipt;
    },
    async retryFailed({ sessionId, operationId, attemptId }) {
      if (retries.has(attemptId)) {
        if (
          sessionId !== "fixture-session" ||
          retries.get(attemptId) !== operationId
        )
          throw new Error("Identity conflict");
        return (await backend.lookup(attemptId))!;
      }
      if (
        sessionId !== "fixture-session" ||
        deleted.has(operationId) ||
        !rejected.has(operationId) ||
        operationId === attemptId
      )
        throw new Error("Invalid retry");
      retries.set(attemptId, operationId);
      return backend.submit({
        ...rejected.get(operationId)!.input,
        operationId: attemptId,
      });
    },
    async deleteFailed({ sessionId, operationId }) {
      if (sessionId !== "fixture-session") throw new Error("Wrong session");
      const removed = rejected.has(operationId);
      if (removed) deleted.add(operationId);
      return { sessionId, operationId, deleted: removed };
    },
    async lookup(id) {
      return receipt(id) ?? rejected.get(id)?.receipt ?? null;
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
    reset() {
      active = null;
      messages.length = 0;
      submissions.clear();
      rejected.clear();
      deleted.clear();
      retries.clear();
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
