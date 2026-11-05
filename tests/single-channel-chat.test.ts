import { expect, test } from "bun:test";
import "./marked-test-resolver.ts";
import { openChat } from "../packages/contracts/src/client.ts";
import type { ChatMessage, ChatView } from "../packages/contracts/src/index.ts";
import type { ChatChange } from "../packages/contracts/src/server.ts";
import { fixtureBackend } from "./fixture.ts";
const { createChatHost } = await import("../packages/contracts/src/server.ts");

async function until(check: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Timed out");
    await Bun.sleep(5);
  }
}

async function harness() {
  const fixture = fixtureBackend();
  const record = (text: string): ChatMessage => ({ id: "answer", role: "agent", text, textState: "complete", createdAt: 1, operationId: null, turnId: "turn" });
  let sessionId = "a", current = record("new\n"), history = record("old\n");
  let previewMode = false;
  let scope = Symbol("session"), publishedSession = sessionId;
  let notify: (change: ChatChange) => void = () => {}, submitCount = 0, conflictOnSubmit = false;
  let receipt: import("../packages/contracts/src/index.ts").Receipt | null = null;
  let release!: () => void, entered = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const backend = {
    ...fixture.backend,
    async read() { return { ...(await fixture.backend.read()), sessionId, messages: previewMode ? [] : [current], before: "older", ...(previewMode ? { streamingReply: { id: current.id, text: current.text, createdAt: current.createdAt, turnId: "turn" } } : {}) }; },
    async history() { entered = true; await gate; return { messages: [history], before: null }; },
    async submit(input: import("../packages/contracts/src/index.ts").Submission) {
      submitCount++;
      receipt = { operationId: input.operationId, state: "submitted", messageId: "accepted", turnId: "turn", error: null };
      if (conflictOnSubmit) { current = record("rewritten\n"); await publish(); }
      return receipt;
    },
    async lookup(id: string) { return receipt?.operationId === id ? receipt : null; },
    subscribe(changed: (change: ChatChange) => void) { notify = changed; return { scope, close() { notify = () => {}; } }; },
  };
  async function publish() {
    const next = await backend.read();
    if (next.sessionId !== publishedSession) {
      const nextScope = Symbol("session");
      notify({ type: "session", scope, nextScope, view: next });
      scope = nextScope;
      publishedSession = next.sessionId;
    } else notify({ type: "update", scope, window: { messages: next.messages, before: next.before }, state: { streamingReply: next.streamingReply ?? null } });
  }
  const errors: unknown[] = [], frames: any[] = [];
  const host = await createChatHost(backend, error => errors.push(error));
  const channels = new Map<object, ReturnType<typeof host.connect>>();
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(req, server) { if (server.upgrade(req)) return; return new Response(null, { status: 404 }); },
    websocket: {
      open(ws) { channels.set(ws, host.connect(ws, async () => true)); },
      message(ws, raw) { void channels.get(ws)!.receive(String(raw)); },
      close(ws) { channels.get(ws)?.close(); channels.delete(ws); },
    },
  });
  let view: ChatView | undefined, offline = false;
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}`);
  socket.addEventListener("message", event => { frames.push(JSON.parse(String(event.data))); });
  const client = await openChat(socket, next => { view = next; }, () => { offline = true; });
  await until(() => !!view);
  return {
    client, host, publish, frames, errors, release, entered: () => entered, view: () => view!, offline: () => offline,
    notify: () => { void publish(); },
    invalidate: () => { void publish(); },
    rewrite(text: string) { current = record(text); },
    current(message: ChatMessage) { current = message; },
    complete(message: ChatMessage) { current = message; previewMode = false; },
    preview(message: ChatMessage) { current = message; previewMode = true; },
    history(message: ChatMessage) { history = message; },
    conflictOnSubmit() { conflictOnSubmit = true; },
    submitCount: () => submitCount,
    switchSession(id = "b") { sessionId = id; current = record(`${id} session\n`); },
    close() { release(); client.close(); host.close(); server.stop(true); },
  };
}

test("change notification publishes no independent timeline frame", async () => {
  const h = await harness();
  try {
    h.notify();
    await h.publish();
    await h.client.lookup("unused");
    expect(h.frames.some(frame => frame.type === "timeline")).toBe(false);
    expect(h.offline()).toBe(false);
  } finally { h.close(); }
});

test("unpublished streaming preview can be replaced by final history and view", async () => {
  const h = await harness();
  try {
    const initial: ChatMessage = { id: "preview", role: "agent", text: "unfinished final answer", textState: "streaming", createdAt: 1, operationId: null, turnId: "turn" };
    const final: ChatMessage = { ...initial, text: "completed final answer", textState: "complete" };
    h.preview(initial);
    h.history(final);
    await h.publish();
    await until(() => h.view().streamingReply?.text === initial.text);
    expect(h.view().streamingReply!.ends).toEqual([]);
    const pending = h.client.history("older");
    await until(h.entered);
    h.release();
    const page = await pending;
    expect(page.messages[0]!.text).toBe(final.text);
    expect(page.messages[0]!.ends).toEqual([final.text.length]);
    h.complete(final);
    await h.publish();
    await until(() => h.view().messages[0]?.text === final.text);
    expect(h.view().messages[0]!.id).toBe(initial.id);
    expect(h.view().messages[0]!.ends).toEqual(page.messages[0]!.ends);
  } finally { h.close(); }
});

test("host publishes a rewritten final answer when preview had no complete line", async () => {
  const h = await harness();
  try {
    const initial: ChatMessage = { id: "preview", role: "agent", text: "unfinished final answer", textState: "streaming", createdAt: 1, operationId: null, turnId: "turn" };
    const final: ChatMessage = { ...initial, text: "completed final answer", textState: "complete" };
    h.preview(initial);
    await h.publish();
    await until(() => h.view().streamingReply?.text === initial.text);
    expect(h.view().streamingReply!.ends).toEqual([]);
    h.complete(final);
    await expect(h.publish()).resolves.toBeUndefined();
    await until(() => h.view().messages[0]?.text === final.text);
    expect(h.view().messages[0]!.ends).toEqual([final.text.length]);
  } finally { h.close(); }
});

test("unmatched history and mutable reply metadata do not create conflicts", async () => {
  const h = await harness();
  try {
    h.history({ id: "other", role: "agent", text: "old\n", textState: "complete", createdAt: 1, operationId: null, turnId: "turn" });
    const pending = h.client.history("older");
    await until(h.entered);
    h.release();
    expect((await pending).messages[0]!.id).toBe("other");
    h.history({ id: "answer", role: "agent", text: "new\n", textState: "complete", createdAt: 1, operationId: null, turnId: "turn", thinking: "updated metadata" });
    expect((await h.client.history("older")).messages[0]!.thinking).toBe("updated metadata");
  } finally { h.close(); }
});

test("history still checks the initial view when its source leaves during the read", async () => {
  const h = await harness();
  try {
    const pending = h.client.history("older");
    await until(h.entered);
    h.current({ id: "new-source", role: "agent", text: "other\n", textState: "complete", createdAt: 1, operationId: null, turnId: "turn" });
    await h.publish();
    await until(() => h.view().messages[0]?.id === "new-source");
    h.release();
    await expect(pending).rejects.toThrow();
  } finally { h.close(); }
});

test("history may finalize identical streaming text without treating it as a rewrite", async () => {
  const h = await harness();
  try {
    const message: ChatMessage = { id: "new-source", role: "agent", text: "line\n", textState: "streaming", createdAt: 1, operationId: null, turnId: "turn" };
    h.current(message);
    h.history({ ...message, textState: "complete" });
    await h.publish();
    await until(() => h.view().messages[0]?.id === "new-source");
    const pending = h.client.history("older");
    await until(h.entered);
    h.release();
    expect((await pending).messages[0]!.textState).toBe("complete");
  } finally { h.close(); }
});

test("history conflicts with an overlapping streaming preview source", async () => {
  const h = await harness();
  try {
    const message: ChatMessage = { id: "preview", role: "agent", text: "published\n", textState: "streaming", createdAt: 1, operationId: null, turnId: "turn" };
    h.preview(message);
    h.history({ ...message, text: "different\n" });
    await h.publish();
    await until(() => h.view().streamingReply?.id === "preview");
    const pending = h.client.history("older");
    await until(h.entered);
    h.release();
    await expect(pending).rejects.toThrow();
    expect(h.view().streamingReply!.text).toBe("published\n");
  } finally { h.close(); }
});

test("history permits a changed hidden tail while preserving published segment boundaries", async () => {
  const h = await harness();
  try {
    const message: ChatMessage = { id: "preview", role: "agent", text: "visible\r\nunfinished", textState: "streaming", createdAt: 1, operationId: null, turnId: "turn" };
    h.preview(message);
    h.history({ ...message, text: "visible\r\nfinal answer", textState: "complete" });
    await h.publish();
    await until(() => h.view().streamingReply?.id === "preview");
    expect(h.view().streamingReply!.ends).toEqual([9]);
    const pending = h.client.history("older");
    await until(h.entered);
    h.release();
    const page = await pending;
    expect(page.messages[0]!.text).toBe("visible\r\nfinal answer");
    expect(page.messages[0]!.ends).toEqual([9, "visible\r\nfinal answer".length]);
    h.history({ ...message, text: "changed\r\nfinal answer", textState: "complete" });
    await expect(h.client.history("older")).rejects.toThrow();
  } finally { h.close(); }
});

test("conflicting direct changes retain published view and connection", async () => {
  const h = await harness();
  try {
    h.rewrite("rewritten\n");
    h.invalidate();
    await until(() => h.errors.some(error => String(error).includes("Reply source conflict")));
    expect(h.view().messages[0]!.text).toBe("new\n");
    expect(h.offline()).toBe(false);
  } finally { h.close(); }
});

test("accepted send retains its receipt when a direct view update conflicts", async () => {
  const h = await harness();
  try {
    const operationId = crypto.randomUUID();
    h.conflictOnSubmit();
    expect((await h.client.submit({ operationId, text: "send once" })).state).toBe("submitted");
    expect(h.submitCount()).toBe(1);
    expect(h.view().messages[0]!.text).toBe("new\n");
    h.rewrite("new\n");
    expect(await h.client.lookup(operationId)).toEqual({ operationId, state: "submitted", messageId: "accepted", turnId: "turn", error: null });
    expect(h.submitCount()).toBe(1);
  } finally { h.close(); }
});

test("a later background conflict does not revoke an already delivered receipt", async () => {
  const h = await harness();
  try {
    const operationId = crypto.randomUUID();
    const confirmed = await h.client.submit({ operationId, text: "send once" });
    expect(confirmed.state).toBe("submitted");
    h.rewrite("rewritten\n");
    h.invalidate();
    await until(() => h.errors.some(error => String(error).includes("Reply source conflict")));
    expect(h.view().messages[0]!.text).toBe("new\n");
    expect(h.offline()).toBe(false);
    h.rewrite("new\n");
    expect(await h.client.lookup(operationId)).toEqual(confirmed);
    expect(h.submitCount()).toBe(1);
  } finally { h.close(); }
});

test("history cannot return older text for a reply already in the view", async () => {
  const h = await harness();
  try {
    const pending = h.client.history("older");
    await until(h.entered);
    h.release();
    await expect(pending).rejects.toThrow();
    expect(h.view().messages[0]!.text).toBe("new\n");
    expect(h.errors.some(error => String(error).includes("Reply source conflict"))).toBe(true);
  } finally { h.close(); }
});

test("an in-flight history read is rejected after the view changes session", async () => {
  const h = await harness();
  try {
    const pending = h.client.history("older");
    await until(h.entered);
    h.switchSession();
    await h.publish();
    await until(() => h.view().sessionId === "b");
    h.release();
    await expect(pending).rejects.toThrow();
    expect(h.view().sessionId).toBe("b");
  } finally { h.close(); }
});

test("returning to the same session does not revive its earlier in-flight history", async () => {
  const h = await harness();
  try {
    const pending = h.client.history("older");
    await until(h.entered);
    h.switchSession("b");
    await h.publish();
    await until(() => h.view().sessionId === "b");
    h.switchSession("a");
    await h.publish();
    await until(() => h.view().sessionId === "a");
    h.release();
    await expect(pending).rejects.toThrow();
  } finally { h.close(); }
});
