import { expect, test } from "bun:test";
import { MessageSchema, PageSchema, validate, type ChatView } from "../packages/contracts/src/index.ts";
import { createChatHost, type ChatChange } from "../packages/contracts/src/server.ts";
import { openChat } from "../packages/contracts/src/client.ts";
import { fixtureBackend } from "./fixture.ts";

test("voice references survive message and history validation and reject malformed IDs", () => {
  const message = { id: "message", role: "agent" as const, text: "", createdAt: 1, operationId: null, turnId: "turn", voice: { id: "a".repeat(64) } };
  expect(validate(MessageSchema, message)).toEqual(message);
  expect(validate(PageSchema, { messages: [message], before: null }).messages).toEqual([message]);
  for (const voice of [{ id: "a".repeat(63) }, { id: "A".repeat(64) }, { id: "g".repeat(64) }, { id: "a".repeat(64) + "\n" }, { id: "a".repeat(64), url: "/api/audio/file" }, { id: 1 }])
    expect(() => validate(MessageSchema, { ...message, voice })).toThrow();
});

test("voice references survive publication, history and reconnect", async () => {
  const fixture = fixtureBackend();
  const voice = { id: "voice-message", role: "agent" as const, text: "", createdAt: 1, operationId: null, turnId: "turn", voice: { id: "a".repeat(64) } };
  let messages: ChatView["messages"] = [];
  const scope = Symbol("voice session");
  let changed: (change: ChatChange) => void = () => {};
  const backend = { ...fixture.backend,
    async read() { return { ...await fixture.backend.read(), messages }; },
    async history() { return { messages: [voice], before: null }; },
    subscribe(listener: (change: ChatChange) => void) { changed = listener; return { scope, close() { changed = () => {}; } }; },
  };
  let host = await createChatHost(backend);
  const channels = new Map<object, ReturnType<typeof host.connect>>();
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0,
    fetch(request, server) { if (server.upgrade(request)) return; return new Response(null, { status: 404 }); },
    websocket: {
      open(socket) { channels.set(socket, host.connect(socket, async () => true)); },
      message(socket, raw) { void channels.get(socket)!.receive(String(raw)); },
      close(socket) { channels.get(socket)?.close(); channels.delete(socket); },
    },
  });
  let view: ChatView | undefined;
  const connect = () => openChat(new WebSocket(`ws://127.0.0.1:${server.port}`), value => { view = value; }, () => {});
  let client = await connect();
  try {
    messages = [voice]; changed({ type: "update", scope, window: { messages, before: null } });
    const deadline = Date.now() + 3000;
    while (!view?.messages.length && Date.now() < deadline) await Bun.sleep(10);
    expect(view?.messages).toEqual([voice]);
    expect((await client.history("older")).messages).toEqual([voice]);
    client.close(); host.close(); host = await createChatHost(backend);
    client = await connect();
    expect(view?.messages).toEqual([voice]);
  } finally {
    client.close(); host.close();
    for (const socket of channels.keys()) (socket as import("bun").ServerWebSocket<undefined>).terminate();
    server.stop(true);
  }
});
