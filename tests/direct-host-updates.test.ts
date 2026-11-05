import { expect, test } from "bun:test";
import { openChat } from "../packages/contracts/src/client.ts";
import type { ChatMessage, ChatView } from "../packages/contracts/src/index.ts";
import { createChatHost, type ChatChange } from "../packages/contracts/src/server.ts";
import { fixtureBackend } from "./fixture.ts";

async function until(check: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Timed out");
    await Bun.sleep(5);
  }
}

test("direct reply changes reach the real client without rereading the backend", async () => {
  const fixture = fixtureBackend();
  const initial = await fixture.backend.read();
  let readCalls = 0, receiptCalls = 0, mediaCalls = 0;
  const scope = Symbol("fixture session");
  let listener: (change: ChatChange) => void = () => {};
  const backend = {
    ...fixture.backend,
    async read() { readCalls++; receiptCalls++; mediaCalls++; return initial; },
    subscribe(changed: (change: ChatChange) => void) {
      listener = changed;
      return { scope, close() { listener = () => {}; } };
    },
  };
  const errors: unknown[] = [];
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
  let view: ChatView | undefined;
  const client = await openChat(new WebSocket(`ws://127.0.0.1:${server.port}`), next => { view = next; }, () => {});
  try {
    const counts = [readCalls, receiptCalls, mediaCalls];
    const message: ChatMessage = { id: "answer", role: "agent", text: "first\nunfinished", textState: "streaming", createdAt: 1, operationId: null, turnId: "turn" };
    listener({ type: "update", scope, messages: [{ type: "upsert", message, afterId: null }] });
    await until(() => view?.messages[0]?.id === message.id);
    expect(view!.messages[0]!.ends).toEqual([6]);
    listener({ type: "update", scope, messages: [{ type: "upsert", message: { ...message, text: "first\nsecond\n" } }] });
    await until(() => view?.messages[0]?.text === "first\nsecond\n");
    expect(view!.messages[0]!.ends).toEqual([6, 13]);
    listener({ type: "update", scope, messages: [{ type: "upsert", message: { ...message, text: "first\nsecond\nfinal", textState: "complete" } }] });
    await until(() => view?.messages[0]?.textState === "complete");
    expect(view!.messages[0]!.ends).toEqual([6, 13, 18]);
    listener({ type: "update", scope, messages: [{ type: "upsert", message: { ...message, text: "rewritten\n", textState: "complete" } }] });
    expect(errors.some(error => String(error).includes("Reply source conflict"))).toBe(true);
    expect(view!.messages[0]!.text).toBe("first\nsecond\nfinal");
    expect([readCalls, receiptCalls, mediaCalls]).toEqual(counts);
  } finally { client.close(); host.close(); server.stop(true); }
});

test("direct preview and completed entry share source identity and boundaries", async () => {
  const fixture = fixtureBackend();
  const initial = await fixture.backend.read();
  const scope = Symbol("session");
  let listener: (change: ChatChange) => void = () => {};
  const backend = {
    ...fixture.backend,
    async read() { return initial; },
    subscribe(changed: (change: ChatChange) => void) { listener = changed; return { scope, close() {} }; },
  };
  const errors: unknown[] = [];
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
  let view: ChatView | undefined;
  const client = await openChat(new WebSocket(`ws://127.0.0.1:${server.port}`), next => { view = next; }, () => {});
  try {
    const preview = { id: "native-answer", text: "first\nunfinished", createdAt: 1, turnId: "turn" };
    listener({ type: "update", scope, state: { streamingReply: preview } });
    await until(() => view?.streamingReply?.id === preview.id);
    expect(view!.streamingReply!.ends).toEqual([6]);
    const complete: ChatMessage = { ...preview, role: "agent", text: "first\nfinal", textState: "complete", operationId: null };
    listener({ type: "update", scope, messages: [{ type: "upsert", message: { ...complete, text: "changed\nfinal" }, afterId: null }] });
    expect(errors.some(error => String(error).includes("Reply source conflict"))).toBe(true);
    expect(view!.streamingReply!.text).toBe(preview.text);
    listener({ type: "update", scope, state: { streamingReply: null }, messages: [{ type: "upsert", message: complete, afterId: null }] });
    await until(() => view?.messages[0]?.id === preview.id);
    expect(view!.streamingReply).toBeUndefined();
    expect(view!.messages[0]!.text).toBe("first\nfinal");
    expect(view!.messages[0]!.ends).toEqual([6, 11]);
  } finally { client.close(); host.close(); server.stop(true); }
});

test("a change during the initial read is folded into the first client view", async () => {
  const fixture = fixtureBackend();
  const initial = await fixture.backend.read();
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const reading = new Promise<void>(resolve => { entered = resolve; });
  const scope = Symbol("initial session");
  let listener: (change: ChatChange) => void = () => {};
  const backend = {
    ...fixture.backend,
    async read() { entered(); await held; return initial; },
    subscribe(changed: (change: ChatChange) => void) {
      listener = changed;
      return { scope, close() { listener = () => {}; } };
    },
  };
  const opening = createChatHost(backend);
  await reading;
  const message: ChatMessage = { id: "during-read", role: "agent", text: "first\n", textState: "streaming", createdAt: 1, operationId: null, turnId: "turn" };
  listener({ type: "update", scope, messages: [{ type: "upsert", message, afterId: null }] });
  listener({ type: "update", scope, messages: [{ type: "upsert", message: { ...message, text: "first\nsecond\n" } }] });
  release();
  const host = await opening;
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
  let view: ChatView | undefined;
  const client = await openChat(new WebSocket(`ws://127.0.0.1:${server.port}`), next => { view = next; }, () => {});
  try {
    await until(() => view !== undefined);
    expect(view!.messages[0]!.text).toBe("first\nsecond\n");
    expect(view!.messages[0]!.ends).toEqual([6, 13]);
  } finally { client.close(); host.close(); server.stop(true); }
});

test("a queued older preview cannot hide lines of an initially completed source", async () => {
  const fixture = fixtureBackend();
  const initial = await fixture.backend.read();
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const reading = new Promise<void>(resolve => { entered = resolve; });
  const scope = Symbol("session");
  let listener: (change: ChatChange) => void = () => {};
  const complete: ChatMessage = { id: "answer", role: "agent", text: "old\nnew\n", textState: "complete", createdAt: 1, operationId: null, turnId: "turn" };
  const backend = {
    ...fixture.backend,
    async read() { entered(); await held; return { ...initial, messages: [complete], before: "older" }; },
    async history() { return { messages: [complete], before: null }; },
    subscribe(changed: (change: ChatChange) => void) { listener = changed; return { scope, close() {} }; },
  };
  const errors: unknown[] = [];
  const opening = createChatHost(backend, error => errors.push(error));
  await reading;
  listener({ type: "update", scope, state: { streamingReply: { id: "answer", turnId: "turn", createdAt: 1, text: "old\n" } } });
  release();
  const host = await opening;
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
  let view: ChatView | undefined;
  const client = await openChat(new WebSocket(`ws://127.0.0.1:${server.port}`), next => { view = next; }, () => {});
  try {
    await until(() => view !== undefined);
    expect(view!.streamingReply).toBeUndefined();
    expect(view!.messages[0]!.text).toBe("old\nnew\n");
    expect(view!.messages[0]!.ends).toEqual([4, 8]);
    expect((await client.history("older")).messages[0]!.ends).toEqual([4, 8]);
    listener({ type: "update", scope, messages: [{ type: "upsert", message: { ...complete, text: "changed\n" } }] });
    expect(errors.some(error => String(error).includes("Reply source conflict"))).toBe(true);
    expect(view!.messages[0]!.ends).toEqual([4, 8]);
  } finally { client.close(); host.close(); server.stop(true); }
});

test("initial read already containing final facts does not regress buffered source, user or media", async () => {
  const fixture = fixtureBackend();
  const base = await fixture.backend.read();
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const reading = new Promise<void>(resolve => { entered = resolve; });
  const scope = Symbol("initial session");
  let listener: (change: ChatChange) => void = () => {};
  const user: ChatMessage = { id: "user", role: "user", text: "hello", createdAt: 1, operationId: null, turnId: "turn" };
  const answer: ChatMessage = { id: "answer", role: "agent", text: "final\n", textState: "complete", createdAt: 2, operationId: null, turnId: "turn" };
  const image: ChatMessage = { id: "image", role: "agent", text: "", createdAt: 3, operationId: null, turnId: "turn", imageState: "ready", images: [{ attachmentId: "photo", name: "photo.png", mediaType: "image/png", availability: "available" }] };
  const backend = {
    ...fixture.backend,
    async read() { entered(); await held; return { ...base, messages: [user, answer, image] }; },
    subscribe(changed: (change: ChatChange) => void) { listener = changed; return { scope, close() {} }; },
  };
  const opening = createChatHost(backend);
  await reading;
  listener({ type: "update", scope, messages: [{ type: "upsert", message: user, afterId: null }] });
  listener({ type: "update", scope, messages: [{ type: "upsert", message: { ...answer, text: "early", textState: "streaming" }, afterId: "user" }] });
  listener({ type: "update", scope, messages: [{ type: "upsert", message: answer }] });
  listener({ type: "update", scope, messages: [{ type: "upsert", message: image, afterId: "answer" }] });
  release();
  const host = await opening;
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
  let view: ChatView | undefined;
  const client = await openChat(new WebSocket(`ws://127.0.0.1:${server.port}`), next => { view = next; }, () => {});
  try {
    await until(() => view !== undefined);
    expect(view!.messages.map(message => message.id)).toEqual(["user", "answer", "image"]);
    expect(view!.messages[1]!.text).toBe("final\n");
    expect(view!.messages[1]!.ends).toEqual([6]);
    expect(view!.messages[2]!.imageState).toBe("ready");
  } finally { client.close(); host.close(); server.stop(true); }
});

test("a temporary ordering anchor may disappear while initial history is held", async () => {
  const fixture = fixtureBackend();
  const initial = await fixture.backend.read();
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const reading = new Promise<void>(resolve => { entered = resolve; });
  const scope = Symbol("session");
  let listener: (change: ChatChange) => void = () => {};
  const backend = {
    ...fixture.backend,
    async read() { entered(); await held; return initial; },
    subscribe(changed: (change: ChatChange) => void) { listener = changed; return { scope, close() {} }; },
  };
  const opening = createChatHost(backend);
  await reading;
  const item = (id: string): ChatMessage => ({ id, role: "user", text: id, createdAt: 1, operationId: null, turnId: null });
  listener({ type: "update", scope, messages: [{ type: "upsert", message: item("a"), afterId: null }] });
  listener({ type: "update", scope, messages: [{ type: "upsert", message: item("b"), afterId: "a" }] });
  listener({ type: "update", scope, messages: [{ type: "remove", id: "a" }] });
  release();
  const host = await opening;
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
  let view: ChatView | undefined;
  const client = await openChat(new WebSocket(`ws://127.0.0.1:${server.port}`), next => { view = next; }, () => {});
  try {
    await until(() => view !== undefined);
    expect(view!.messages.map(message => message.id)).toEqual(["b"]);
  } finally { client.close(); host.close(); server.stop(true); }
});

test("an initial completed source is not regressed by its earlier queued streaming event", async () => {
  const fixture = fixtureBackend();
  const initial = await fixture.backend.read();
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const reading = new Promise<void>(resolve => { entered = resolve; });
  const scope = Symbol("session");
  let listener: (change: ChatChange) => void = () => {};
  const complete: ChatMessage = { id: "answer", role: "agent", text: "done\n", textState: "complete", createdAt: 1, operationId: null, turnId: "turn" };
  const backend = {
    ...fixture.backend,
    async read() { entered(); await held; return { ...initial, messages: [complete] }; },
    subscribe(changed: (change: ChatChange) => void) { listener = changed; return { scope, close() {} }; },
  };
  const opening = createChatHost(backend);
  await reading;
  listener({ type: "update", scope, messages: [{ type: "upsert", message: { ...complete, text: "old", textState: "streaming" }, afterId: null }] });
  release();
  const host = await opening;
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
  let view: ChatView | undefined;
  const client = await openChat(new WebSocket(`ws://127.0.0.1:${server.port}`), next => { view = next; }, () => {});
  try {
    await until(() => view !== undefined);
    expect(view!.messages[0]!.text).toBe("done\n");
    expect(view!.messages[0]!.textState).toBe("complete");
  } finally { client.close(); host.close(); server.stop(true); }
});

test("a queued structural window cannot turn an initially completed source back into streaming", async () => {
  const fixture = fixtureBackend();
  const initial = await fixture.backend.read();
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const reading = new Promise<void>(resolve => { entered = resolve; });
  const scope = Symbol("session");
  let listener: (change: ChatChange) => void = () => {};
  const complete: ChatMessage = { id: "answer", role: "agent", text: "done\n", textState: "complete", createdAt: 1, operationId: null, turnId: "turn" };
  const backend = {
    ...fixture.backend,
    async read() { entered(); await held; return { ...initial, messages: [complete] }; },
    subscribe(changed: (change: ChatChange) => void) { listener = changed; return { scope, close() {} }; },
  };
  const opening = createChatHost(backend);
  await reading;
  listener({ type: "update", scope, window: { messages: [{ ...complete, text: "old", textState: "streaming" }], before: null } });
  release();
  const host = await opening;
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
  let view: ChatView | undefined;
  const client = await openChat(new WebSocket(`ws://127.0.0.1:${server.port}`), next => { view = next; }, () => {});
  try {
    await until(() => view !== undefined);
    expect(view!.messages[0]!.text).toBe("done\n");
    expect(view!.messages[0]!.textState).toBe("complete");
  } finally { client.close(); host.close(); server.stop(true); }
});

test("alternating source updates during initial read do not exhaust an event-count limit", async () => {
  const fixture = fixtureBackend();
  const base = await fixture.backend.read();
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const reading = new Promise<void>(resolve => { entered = resolve; });
  const scope = Symbol("session");
  let listener: (change: ChatChange) => void = () => {};
  const item = (id: string, text: string): ChatMessage => ({ id, role: "agent", text, textState: "streaming", createdAt: 1, operationId: null, turnId: "turn" });
  const backend = {
    ...fixture.backend,
    async read() { entered(); await held; return { ...base, messages: [item("a", ""), item("b", "")] }; },
    subscribe(changed: (change: ChatChange) => void) { listener = changed; return { scope, close() {} }; },
  };
  const opening = createChatHost(backend);
  await reading;
  for (let i = 0; i < 1100; i++) {
    const id = i % 2 ? "b" : "a";
    listener({ type: "update", scope, messages: [{ type: "upsert", message: item(id, `${i}\n`) }] });
  }
  release();
  const host = await opening;
  host.close();
});

test("cancelling a held initial read releases the subscription and passes its signal", async () => {
  const fixture = fixtureBackend();
  const scope = Symbol("session");
  let observed: AbortSignal | undefined, unsubscribed = false;
  let entered!: () => void;
  const reading = new Promise<void>(resolve => { entered = resolve; });
  const backend = {
    ...fixture.backend,
    async read(signal?: AbortSignal): Promise<ChatView> {
      observed = signal;
      entered();
      return new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(new Error("provider aborted")), { once: true }));
    },
    subscribe() { return { scope, close() { unsubscribed = true; } }; },
  };
  const controller = new AbortController();
  const opening = createChatHost(backend, () => {}, { signal: controller.signal });
  await reading;
  controller.abort();
  await expect(opening).rejects.toThrow();
  expect(observed?.aborted).toBe(true);
  expect(unsubscribed).toBe(true);
});

test("provider failure while initializing aborts the read and subscription", async () => {
  const fixture = fixtureBackend();
  const scope = Symbol("session");
  let listener: (change: ChatChange) => void = () => {}, observed: AbortSignal | undefined, unsubscribed = false;
  const backend = {
    ...fixture.backend,
    async read(signal?: AbortSignal): Promise<ChatView> {
      observed = signal;
      return new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(new Error("provider aborted")), { once: true }));
    },
    subscribe(changed: (change: ChatChange) => void) { listener = changed; return { scope, close() { unsubscribed = true; } }; },
  };
  const opening = createChatHost(backend, () => {});
  listener({ type: "error", error: new Error("test provider failure") });
  await expect(opening).rejects.toThrow("test provider failure");
  expect(observed?.aborted).toBe(true);
  expect(unsubscribed).toBe(true);
});

test("direct changes preserve admission, media, history and session fences", async () => {
  const fixture = fixtureBackend();
  const initial = await fixture.backend.read();
  const scopeA = Symbol("session a"), scopeB = Symbol("session b"), scopeAgain = Symbol("session a again");
  let listener: (change: ChatChange) => void = () => {}, submits = 0;
  let releaseHistory!: () => void, historyEntered!: () => void;
  const heldHistory = new Promise<void>(resolve => { releaseHistory = resolve; });
  const readingHistory = new Promise<void>(resolve => { historyEntered = resolve; });
  const backend = {
    ...fixture.backend,
    async read() { return initial; },
    async history() { historyEntered(); await heldHistory; return { messages: [], before: null }; },
    async submit(input: Parameters<typeof fixture.backend.submit>[0]) {
      submits++;
      listener({ type: "update", scope: scopeA, messages: [{ type: "upsert", afterId: null, message: {
        id: input.operationId, role: "user", text: input.text, createdAt: 1, operationId: input.operationId, turnId: "turn",
      } }], state: { activeTurnId: "turn" } });
      return { operationId: input.operationId, state: "submitted" as const, messageId: input.operationId, turnId: "turn", error: null };
    },
    subscribe(changed: (change: ChatChange) => void) {
      listener = changed;
      return { scope: scopeA, close() { listener = () => {}; } };
    },
  };
  const host = await createChatHost(backend);
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
  let view: ChatView | undefined;
  const client = await openChat(new WebSocket(`ws://127.0.0.1:${server.port}`), next => { view = next; }, () => {});
  try {
    const operationId = crypto.randomUUID();
    const receipt = await client.submit({ operationId, text: "hello" });
    expect(receipt.state).toBe("submitted");
    await until(() => view?.messages[0]?.id === operationId);
    const image: ChatMessage = { id: "image", role: "agent", text: "", createdAt: 2, operationId: null, turnId: "turn", imageState: "ready",
      images: [{ attachmentId: "photo", name: "photo.png", mediaType: "image/png", availability: "available" }] };
    listener({ type: "update", scope: scopeA, messages: [{ type: "upsert", message: image, afterId: operationId }] });
    await until(() => view?.messages[1]?.id === "image");
    expect(view!.messages[1]!.images![0]!.attachmentId).toBe("photo");
    const history = client.history("older");
    await readingHistory;
    listener({ type: "session", scope: scopeA, nextScope: scopeB, view: { ...initial, sessionId: "session-b" } });
    listener({ type: "session", scope: scopeB, nextScope: scopeAgain, view: initial });
    listener({ type: "update", scope: scopeA, messages: [{ type: "upsert", message: image, afterId: null }] });
    releaseHistory();
    await expect(history).rejects.toThrow();
    await until(() => view?.sessionId === initial.sessionId && view.messages.length === 0);
    expect(submits).toBe(1);
  } finally { client.close(); host.close(); server.stop(true); }
});

test("provider error disconnects every client and a fresh host restores state without resending", async () => {
  const fixture = fixtureBackend();
  const initial = await fixture.backend.read();
  const scope = Symbol("session");
  const answer: ChatMessage = { id: "answer", role: "agent", text: "original\n", textState: "complete", createdAt: 1, operationId: null, turnId: "turn" };
  let listener!: (change: ChatChange) => void;
  let release!: () => void, finished!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const done = new Promise<void>(resolve => { finished = resolve; });
  const acceptedId = crypto.randomUUID(), unknownId = crypto.randomUUID();
  const calls: string[] = [];
  const receipts = new Map<string, { operationId: string; state: "submitted"; messageId: string; turnId: string; error: null }>();
  let reads = 0, latest = "before";
  const backend = {
    ...fixture.backend,
    async read() { reads++; return { ...initial, messages: [answer], name: latest }; },
    async submit(input: Parameters<typeof fixture.backend.submit>[0]) {
      calls.push(input.operationId);
      if (input.operationId === unknownId) await held;
      const receipt = { operationId: input.operationId, state: "submitted" as const, messageId: input.operationId, turnId: "turn", error: null };
      receipts.set(input.operationId, receipt);
      if (input.operationId === unknownId) finished();
      return receipt;
    },
    async lookup(id: string) { return receipts.get(id) ?? null; },
    subscribe(changed: (change: ChatChange) => void) { listener = changed; return { scope, close() {} }; },
  };
  const errors: unknown[] = [];
  let host = await createChatHost(backend, error => errors.push(error));
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
  const views: ChatView[][] = [[], [], []], offline = [0, 0, 0];
  const closeCodes: number[][] = [[], [], []], retryable: boolean[] = [];
  const connect = (i: number) => {
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}`);
    socket.addEventListener("close", event => closeCodes[i]!.push(event.code));
    return openChat(socket, view => views[i]!.push(view), error => { offline[i]!++; retryable[i] = error.retryable; });
  };
  const a = await connect(0), b = await connect(1);
  let c: Awaited<ReturnType<typeof openChat>> | undefined;
  try {
    await until(() => views[0]!.length > 0 && views[1]!.length > 0);
    listener({ type: "update", scope, messages: [{ type: "upsert", message: { ...answer, text: "changed\n" } }] });
    expect(errors.some(error => String(error).includes("Reply source conflict"))).toBe(true);
    expect(views[0]!.at(-1)!.messages[0]!.text).toBe("original\n");
    expect(offline).toEqual([0, 0, 0]);
    errors.length = 0;
    expect((await a.submit({ operationId: acceptedId, text: "accepted" })).state).toBe("submitted");
    const unknown = b.submit({ operationId: unknownId, text: "unknown" }).then(() => "resolved", () => "unknown");
    await until(() => calls.includes(unknownId));
    latest = "after";
    const oldListener = listener;
    oldListener({ type: "error", error: new Error("fixture provider failure") });
    await until(() => offline[0] === 1 && offline[1] === 1);
    expect(errors.map(String)).toEqual(["Error: fixture provider failure"]);
    expect(closeCodes.slice(0, 2)).toEqual([[1012], [1012]]);
    expect(retryable.slice(0, 2)).toEqual([true, true]);
    expect(await unknown).toBe("unknown");
    expect(() => host.connect({ send() {}, close() {} }, async () => true)).toThrow(/closed/i);
    host = await createChatHost(backend, error => errors.push(error));
    c = await connect(2);
    await until(() => views[2]!.length > 0);
    oldListener({ type: "update", scope, state: { name: "late stale value" } });
    expect(views[2]!.at(-1)!.name).toBe("after");
    expect((await c.lookup(acceptedId))?.state).toBe("submitted");
    expect(await c.lookup(unknownId)).toBeNull();
    release();
    await done;
    expect((await c.lookup(unknownId))?.state).toBe("submitted");
    expect(views[2]!.at(-1)!.name).toBe("after");
    expect(calls).toEqual([acceptedId, unknownId]);
    expect(reads).toBe(2);
  } finally { release(); a.close(); b.close(); c?.close(); host.close(); server.stop(true); }
});
