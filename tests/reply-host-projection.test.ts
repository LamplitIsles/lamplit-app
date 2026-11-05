import { expect, test } from "bun:test";
import "./marked-test-resolver.ts";
import * as marked from "../packages/contracts/node_modules/marked";
import { openChat } from "../packages/contracts/src/client.ts";
import type { ChatMessage, ChatView, StreamingReply } from "../packages/contracts/src/index.ts";
import { fixtureBackend } from "./fixture.ts";
import { createDirectTestHost as createChatHost } from "./direct-test-host.ts";

async function until(check: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Timed out");
    await Bun.sleep(5);
  }
}

test("conflict in a second source cannot advance the first source", async () => {
  const fixture = fixtureBackend();
  const item = (id: string, text: string): ChatMessage => ({ id, role: "agent", text, textState: "streaming", createdAt: 1, operationId: null, turnId: "turn" });
  let messages = [item("a", "a\npending"), item("b", "b\npending")];
  const host = await createChatHost({ ...fixture.backend, async read() { return { ...(await fixture.backend.read()), messages }; } }, () => {});
  try {
    messages = [item("a", "a\nfirst candidate\n"), item("b", "rewritten\n")];
    await expect(host.publish()).rejects.toThrow("Reply source conflict");
    messages = [item("a", "a\nsecond candidate\n"), item("b", "b\npending")];
    await expect(host.publish()).resolves.toBeUndefined();
  } finally { host.close(); }
});

test("a later source parse failure cannot partially advance an earlier source", async () => {
  const fixture = fixtureBackend();
  const item = (id: string, text: string): ChatMessage => ({ id, role: "agent", text, textState: "streaming", createdAt: 1, operationId: null, turnId: "turn" });
  let messages = [item("a", "a\npending"), item("b", "b\npending")];
  const host = await createChatHost({ ...fixture.backend, async read() { return { ...(await fixture.backend.read()), messages }; } }, () => {});
  const original = marked.Lexer.lex;
  marked.Lexer.lex = function (...args) {
    if (args[0].includes("parse trigger")) throw new Error("test parser failure");
    return original(...args);
  };
  try {
    messages = [item("a", "a\nfirst candidate\n"), item("b", "b\nparse trigger\n")];
    await expect(host.publish()).rejects.toThrow("test parser failure");
    messages = [item("a", "a\nsecond candidate\n"), item("b", "b\npending")];
    await expect(host.publish()).resolves.toBeUndefined();
  } finally { host.close(); marked.Lexer.lex = original; }
});

test("host publishes source and stable UTF-16 ends through live, final and history", async () => {
  const fixture = fixtureBackend();
  let message: ChatMessage | undefined;
  let preview: StreamingReply | undefined;
  let sessionId = "session-a";
  // This test-owned backend guarantees that one attempt has one authoritative
  // ID, reused for preview, live message, final message and history.
  const backend = {
    ...fixture.backend,
    async read() { return { ...(await fixture.backend.read()), sessionId, activeTurnId: "turn", messages: message ? [message] : [], before: "older", ...(preview ? { streamingReply: preview } : {}) }; },
    async history() { return { messages: message ? [message] : [], before: null }; },
  };
  const errors: unknown[] = [];
  const host = await createChatHost(backend, error => errors.push(error));
  const channels = new Map<object, ReturnType<typeof host.connect>>();
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(req, socketServer) { if (socketServer.upgrade(req)) return; return new Response(null, { status: 404 }); },
    websocket: {
      open(ws) { channels.set(ws, host.connect(ws, async () => true)); },
      message(ws, raw) { void channels.get(ws)!.receive(String(raw)); },
      close(ws) { channels.get(ws)?.close(); channels.delete(ws); },
    },
  });
  let view: ChatView | undefined;
  const client = await openChat(new WebSocket(`ws://127.0.0.1:${server.port}`), next => { view = next; }, () => {});
  try {
    preview = { id: "authoritative-answer", text: "😀 first\r\n```js\n", createdAt: 1, turnId: "turn" };
    await host.publish();
    await until(() => view?.streamingReply?.text === preview!.text);
    const first = view!.streamingReply as StreamingReply & { ends?: number[] };
    expect(first.ends).toEqual(["😀 first\r\n".length]);
    const prefix = first.ends!;
    message = { id: preview.id, role: "agent", text: preview.text, textState: "streaming", createdAt: 1, operationId: null, turnId: "turn" };
    await host.publish();
    await until(() => view?.messages[0]?.text === message!.text);
    expect(view!.streamingReply).toBeUndefined();
    expect(view!.messages[0]!.ends).toEqual(prefix);
    message = { id: preview.id, role: "agent", text: "😀 first\r\n```js\nvalue()\n```\nlast\n\n", textState: "streaming", createdAt: 1, operationId: null, turnId: "turn" };
    preview = undefined;
    await host.publish();
    await until(() => view?.messages[0]?.text === message!.text);
    const growing = view!.messages[0] as ChatMessage & { ends?: number[] };
    expect(growing.ends!.slice(0, prefix.length)).toEqual(prefix);
    expect(growing.ends).toEqual([10, 28, 33]);
    const accepted = message;
    message = { ...message, text: "rewritten\n" };
    await expect(host.publish()).rejects.toThrow("Reply source conflict");
    expect(view!.messages[0]!.text).toBe(accepted.text);
    expect(errors.some(error => String(error).includes("Reply source conflict"))).toBe(true);
    message = accepted;
    message = { ...message, textState: "complete" };
    await host.publish();
    await until(() => view?.messages[0]?.textState === "complete");
    const final = view!.messages[0] as ChatMessage & { ends?: number[] };
    const historical = (await client.history("older")).messages[0] as ChatMessage & { ends?: number[] };
    expect(final.id).toBe("authoritative-answer");
    expect(historical.id).toBe(final.id);
    expect(historical.ends).toEqual(final.ends);
    expect(final.text).toBe(message.text);
    const finished = message;
    message = { ...finished, text: "edited after completion\n" };
    await expect(host.publish()).rejects.toThrow("Reply source conflict");
    expect(view!.messages[0]!.text).toBe(finished.text);
    message = finished;
    sessionId = "session-b";
    message = { ...message, text: "different\n", textState: "streaming" };
    await host.publish();
    await until(() => view?.sessionId === "session-b");
    expect((view!.messages[0] as ChatMessage & { ends?: number[] }).ends).toEqual([10]);
    const longText = "different\n" + Array.from({ length: 35 }, (_, i) => `line ${i}\n`).join("");
    message = { ...message, text: longText, textState: "complete" };
    await host.publish();
    await until(() => view?.messages[0]?.text === longText);
    expect(view!.messages).toHaveLength(1);
    expect(view!.messages[0]!.ends).toHaveLength(36);
    expect((await client.history("older")).messages[0]!.ends).toEqual(view!.messages[0]!.ends);
  } finally {
    client.close(); host.close(); server.stop(true);
  }
});

test("host reuses one active parser as a source grows", async () => {
  const fixture = fixtureBackend();
  let text = "";
  const backend = { ...fixture.backend, async read() {
    return { ...(await fixture.backend.read()), messages: [{ id: "answer", role: "agent" as const, text, textState: "streaming" as const, createdAt: 1, operationId: null, turnId: "turn" }] };
  } };
  const original = marked.Lexer.lex;
  let calls = 0;
  marked.Lexer.lex = function (...args) { calls++; return original(...args); };
  const host = await createChatHost(backend);
  try {
    for (let i = 0; i < 100; i++) {
      text += `line ${i}\n`;
      await host.publish();
    }
    expect(calls).toBe(100);
  } finally { host.close(); marked.Lexer.lex = original; }
});

test("input, notice, image and voice state changes are not treated as reply text conflicts", async () => {
  const fixture = fixtureBackend();
  const base = { createdAt: 1, operationId: null, turnId: null };
  let messages: ChatMessage[] = [
    { ...base, id: "input", role: "user", text: "draft" },
    { ...base, id: "notice", role: "notice", text: "pending" },
    { ...base, id: "image", role: "agent", text: "preparing", imageState: "preparing" },
    { ...base, id: "voice", role: "agent", text: "voice pending", voice: { id: "a".repeat(64) } },
    { ...base, id: "answer", role: "agent", text: "reply\n", textState: "complete" },
    { ...base, id: "external", role: "agent", text: "source pending", source: { kind: "keet", channel: "dm", senderLabel: "Friend", destination: "test" } },
  ];
  const backend = { ...fixture.backend, async read() { return { ...(await fixture.backend.read()), messages }; } };
  const errors: unknown[] = [];
  const host = await createChatHost(backend, error => errors.push(error));
  try {
    messages = [
      { ...messages[0]!, text: "accepted" },
      { ...messages[1]!, text: "failed" },
      { ...messages[2]!, text: "image ready", imageState: "ready", images: [{ attachmentId: "photo", name: "photo.png", mediaType: "image/png", availability: "available" }] },
      { ...messages[3]!, text: "voice ready" },
      { ...messages[4]!, thinking: "metadata changed" },
      { ...messages[5]!, text: "source updated" },
    ];
    await expect(host.publish()).resolves.toBeUndefined();
    const { images: _images, ...image } = messages[2]!;
    messages = messages.map(item => item.id === "image" ? { ...image, text: "image failed", imageState: "failed" } : item);
    await expect(host.publish()).resolves.toBeUndefined();
    expect(errors).toEqual([]);
  } finally { host.close(); }
});

test("an oversized projected source follows the existing frame disconnect behavior", async () => {
  const fixture = fixtureBackend();
  let text = "first\n";
  const backend = { ...fixture.backend, async read() {
    return { ...(await fixture.backend.read()), messages: [{ id: "answer", role: "agent" as const, text, textState: "streaming" as const, createdAt: 1, operationId: null, turnId: "turn" }] };
  } };
  const host = await createChatHost(backend, () => {});
  const channels = new Map<object, ReturnType<typeof host.connect>>();
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(req, socketServer) { if (socketServer.upgrade(req)) return; return new Response(null, { status: 404 }); },
    websocket: {
      open(ws) { channels.set(ws, host.connect(ws, async () => true)); },
      message(ws, raw) { void channels.get(ws)!.receive(String(raw)); },
      close(ws) { channels.get(ws)?.close(); channels.delete(ws); },
    },
  });
  let view: ChatView | undefined, offline = false, code = 0;
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}`);
  socket.addEventListener("close", event => { code = event.code; });
  const client = await openChat(socket, next => { view = next; }, () => { offline = true; });
  try {
    await until(() => view?.messages[0]?.text === "first\n");
    text += "x".repeat(2 * 1024 * 1024);
    await host.publish();
    await until(() => offline && !!code);
    expect(code).toBe(1013);
    expect(view!.messages[0]!.text).toBe("first\n");
  } finally { client.close(); host.close(); server.stop(true); }
});
