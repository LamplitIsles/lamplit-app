import { expect, test } from "bun:test";
import "./marked-test-resolver.ts";
import { openChat } from "../packages/contracts/src/client.ts";
import type { ChatMessage, ChatView, Submission } from "../packages/contracts/src/index.ts";
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

/** App-owned Pi-shaped fake. Native partials never enter read() or history(). */
function completedBackend() {
  const fixture = fixtureBackend();
  let sessionId = "pi-session-a", active: string | null = null, held = "";
  let scope = Symbol("pi session"), publishedSession = sessionId;
  let listener: (change: ChatChange) => void = () => {};
  const calls: string[] = [];
  let records: ChatMessage[] = Array.from({ length: 33 }, (_, index) => ({
    id: `native:${index + 1}`, role: "user", text: `input ${index + 1}`, createdAt: index,
    operationId: null, turnId: null,
  }));
  records[32] = { ...records[32]!, source: { kind: "keet", channel: "dm", senderLabel: "Friend", destination: "test" }, images: [{ attachmentId: "incoming", name: "incoming.png", mediaType: "image/png", availability: "available" }] };
  const cursor = (id: string) => JSON.stringify([sessionId, id]);
  const backend = {
    ...fixture.backend,
    async read() {
      const visible = records.slice(-30);
      return { ...(await fixture.backend.read()), sessionId, activeTurnId: active, messages: visible,
        before: records.length > visible.length ? cursor(visible[0]!.id) : null };
    },
    async history(before: string) {
      const [owner, id] = JSON.parse(before) as [string, string];
      if (owner !== sessionId) throw new Error("Wrong session cursor");
      const end = records.findIndex(record => record.id === id);
      if (end < 0) throw new Error("Unknown cursor");
      const start = Math.max(0, end - 30);
      return { messages: records.slice(start, end), before: start ? cursor(records[start]!.id) : null };
    },
    async submit(input: Submission) {
      calls.push(input.operationId);
      if (input.text === "reject") return { operationId: input.operationId, attempt: 1, state: "failed" as const, messageId: null, turnId: null, error: "rejected" };
      active = input.operationId;
      records.push({ id: `submission:${input.operationId}`, role: "user", text: input.text, createdAt: 100, operationId: input.operationId, turnId: active });
      await publish();
      return { operationId: input.operationId, attempt: 1, state: "submitted" as const, messageId: `submission:${input.operationId}`, turnId: active, error: null };
    },
    async stop(id: string) {
      if (active !== id) return { stopped: false };
      records.push({ id: `notice:stop:${id}`, role: "notice", text: "已停止回复", createdAt: 102, operationId: null, turnId: id });
      held = ""; active = null;
      await publish();
      return { stopped: true };
    },
    subscribe(changed: (change: ChatChange) => void) { listener = changed; return { scope, close() { listener = () => {}; } }; },
  };
  async function publish() {
    const current = await backend.read();
    if (current.sessionId !== publishedSession) {
      const nextScope = Symbol("pi session");
      listener({ type: "session", scope, nextScope, view: current });
      scope = nextScope;
      publishedSession = current.sessionId;
    } else {
      listener({ type: "update", scope, window: { messages: current.messages, before: current.before }, state: { activeTurnId: current.activeTurnId } });
    }
  }
  return {
    backend, calls, publish,
    partial(text: string) { held = text; },
    complete(text: string) {
      if (!active || !text.startsWith(held)) throw new Error("Invalid fake completion");
      records.push({ id: "native:501", role: "agent", text, createdAt: 101, operationId: null, turnId: active,
        images: [{ attachmentId: "reply", name: "reply.png", mediaType: "image/png", availability: "available" }] });
      held = ""; active = null;
    },
    fail() {
      if (!active) throw new Error("No fake turn");
      records.push({ id: `notice:fail:${active}`, role: "notice", text: "回复失败", createdAt: 103, operationId: null, turnId: active });
      held = ""; active = null;
    },
    advanceWindow() {
      for (let i = 0; i < 30; i++) records.push({ id: `later:${i}`, role: "user", text: `later ${i}`, createdAt: 200 + i, operationId: null, turnId: null });
    },
    switchSession() { sessionId = "pi-session-b"; active = null; held = ""; records = []; },
  };
}

test("completed Pi-shaped source uses native entry identity across view, history and reconnect", async () => {
  const fixture = completedBackend();
  const errors: unknown[] = [];
  const host = await createChatHost(fixture.backend, error => errors.push(error));
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
  const views: ChatView[] = [];
  const connect = () => openChat(new WebSocket(`ws://127.0.0.1:${server.port}`), view => { views.push(view); }, () => {});
  let client = await connect();
  try {
    await until(() => views.length > 0);
    const initial = views.at(-1)!;
    const incoming = initial.messages.find(message => message.id === "native:33")!;
    expect(incoming.source).toEqual({ kind: "keet", channel: "dm", senderLabel: "Friend", destination: "test" });
    expect(incoming.images?.[0]?.attachmentId).toBe("incoming");
    const firstHistory = await client.history(initial.before!);
    expect(firstHistory.messages.map(message => message.id)).toEqual(["native:1", "native:2", "native:3"]);
    expect(firstHistory.before).toBeNull();

    const operationId = crypto.randomUUID();
    expect((await client.submit({ operationId, text: "question" })).state).toBe("submitted");
    fixture.partial("😀 first\r\n");
    await fixture.publish();
    await until(() => views.at(-1)?.activeTurnId === operationId);
    expect(views.at(-1)?.streamingReply).toBeUndefined();
    expect(views.at(-1)?.messages.some(message => message.role === "agent")).toBe(false);

    // The same source prefix is exercised incrementally by the CFL-shaped
    // fake in reply-host-projection.test.ts; Pi only supplies its final entry.
    const chunks = ["😀 first\r\n", "```js\nvalue()\n```\n", "last\n", ...Array.from({ length: 31 }, (_, i) => `line ${i}\n`)];
    const source = chunks.join("") + "\n\n";
    let end = 0;
    const expected = chunks.map(chunk => end += chunk.length);
    fixture.complete(source);
    await fixture.publish();
    await until(() => views.at(-1)?.messages.some(message => message.id === "native:501") === true);
    const answer = views.at(-1)!.messages.find(message => message.id === "native:501")!;
    expect(answer.text).toBe(source);
    expect(answer.ends).toEqual(expected);
    expect(answer.ends?.slice(0, 3)).toEqual([10, 28, 33]);
    expect(answer.images?.[0]?.attachmentId).toBe("reply");
    expect(views.at(-1)?.streamingReply).toBeUndefined();

    fixture.advanceWindow();
    await fixture.publish();
    await until(() => views.at(-1)?.messages[0]?.id === "later:0");
    const oldCursor = views.at(-1)!.before!;
    const page = await client.history(oldCursor);
    const historical = page.messages.find(message => message.id === "native:501")!;
    expect(historical).toEqual(answer);
    expect(page.messages.find(message => message.id === "native:33")).toEqual(incoming);
    expect(page.messages.length).toBeLessThanOrEqual(30);
    client.close();
    client = await connect();
    await until(() => views.at(-1)?.messages[0]?.id === "later:0");
    expect((await client.history(oldCursor)).messages.find(message => message.id === "native:501")).toEqual(answer);

    const stopped = crypto.randomUUID();
    await client.submit({ operationId: stopped, text: "stop" });
    fixture.partial("never published stop partial\n");
    expect(await client.stop(stopped)).toEqual({ stopped: true });
    await until(() => views.at(-1)?.messages.some(message => message.id === `notice:stop:${stopped}`) === true);
    expect(views.at(-1)?.messages.some(message => message.text.includes("never published"))).toBe(false);
    const failed = crypto.randomUUID();
    await client.submit({ operationId: failed, text: "fail" });
    fixture.partial("never published failure partial\n");
    fixture.fail();
    await fixture.publish();
    await until(() => views.at(-1)?.messages.some(message => message.id === `notice:fail:${failed}`) === true);
    expect(views.at(-1)?.messages.some(message => message.text.includes("never published"))).toBe(false);
    const rejected = crypto.randomUUID();
    expect(await client.submit({ operationId: rejected, text: "reject" })).toMatchObject({ state: "failed", error: "rejected" });
    expect(fixture.calls).toEqual([operationId, stopped, failed, rejected]);
    expect(views.every(view => view.streamingReply === undefined)).toBe(true);

    fixture.switchSession();
    await fixture.publish();
    await until(() => views.at(-1)?.sessionId === "pi-session-b");
    expect(errors).toEqual([]);
    await expect(client.history(oldCursor)).rejects.toThrow();
    expect(errors.map(String)).toEqual(["Error: Wrong session cursor"]);
  } finally { client.close(); host.close(); server.stop(true); }
});
