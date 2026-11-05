import { expect, test } from "bun:test";
import "./marked-test-resolver.ts";
import { openChat } from "../packages/contracts/src/client.ts";
import { MessageSchema, validate, type ChatView } from "../packages/contracts/src/index.ts";
import { createDirectTestHost as createChatHost } from "./direct-test-host.ts";
import { sentenceFixture } from "./sentence-fixture.ts";
const { stableReplySegments } = await import("../packages/contracts/src/reply-chunks.ts");

async function until(check: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Timed out");
    await Bun.sleep(5);
  }
}

test("real host/client transports source identity and raw text across a fake preview, final and history", async () => {
  const fixture = sentenceFixture();
  const source = "🙂 first\r\n```js\nvalue()\n```\nlast\n\n";
  let complete = { id: "", role: "agent" as const, text: source, createdAt: 1792129000000, operationId: null, turnId: "turn-1" };
  const host = await createChatHost({ ...fixture.backend, async history() { return { messages: [complete], before: null }; } });
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
    fixture.control({ action: "start", text: "🙂 first\r\n```js\n" });
    await host.publish();
    await until(() => view?.streamingReply?.text === "🙂 first\r\n```js\n");
    const previewId = view!.streamingReply!.id;
    complete = { ...complete, id: previewId };
    const previewSession = view!.sessionId;
    const first = stableReplySegments(view!.streamingReply!.text, false);
    expect(first.map(s => s.text)).toEqual(["🙂 first\r\n"]);
    expect(view!.streamingReply!.ends).toEqual(first.map(segment => segment.end));
    fixture.control({ action: "advance", text: "🙂 first\r\n```js\nvalue()\n```\nlast\n" });
    await host.publish();
    await until(() => view?.streamingReply?.text.endsWith("last\n") === true);
    expect(view!.streamingReply!.id).toBe(previewId);
    const growing = stableReplySegments(view!.streamingReply!.text, false);
    expect(growing.slice(0, first.length)).toEqual(first);
    fixture.control({ action: "complete", text: source });
    await host.publish();
    await until(() => view?.messages.some(message => message.id === complete.id) === true);
    const final = view!.messages.find(message => message.id === complete.id)!;
    const historical = (await client.history("older")).messages[0]!;
    expect(final.text).toBe(source);
    expect(historical.text).toBe(source);
    expect(historical.id).toBe(final.id);
    expect(final.id).toBe(previewId);
    expect(stableReplySegments(final.text, true).slice(0, growing.length)).toEqual(growing);
    expect(stableReplySegments(historical.text, true)).toEqual(stableReplySegments(final.text, true));
    expect(historical.ends).toEqual(final.ends);
    // The fixture's authoritative ID preserves the displayed ordinal through completion.
    expect(JSON.stringify([previewSession, final.id, 0])).toBe(JSON.stringify([previewSession, previewId, 0]));
    fixture.control({ action: "session" });
    await host.publish();
    await until(() => view?.sessionId !== previewSession);
    expect(JSON.stringify([view!.sessionId, final.id, 0])).not.toBe(JSON.stringify([previewSession, final.id, 0]));
    expect(validate(MessageSchema, { ...final, ends: [first[0]!.end] }).ends).toEqual([first[0]!.end]);
  } finally {
    client.close(); host.close(); server.stop(true);
  }
});
