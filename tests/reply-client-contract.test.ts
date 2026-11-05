import { expect, test } from "bun:test";
import { createServiceStateDecoder, createServiceStateEncoder } from "../packages/contracts/node_modules/@earendil-works/chord/dist/index.js";
import { openChat } from "../packages/contracts/src/client.ts";
import { createChatHost } from "../packages/contracts/src/server.ts";
import type { ChatMessage, ChatView } from "../packages/contracts/src/index.ts";
import { fixtureBackend } from "./fixture.ts";

async function until(check: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Timed out");
    await Bun.sleep(5);
  }
}
const reply: ChatMessage = { id: "answer", role: "agent", text: "tail", textState: "streaming", createdAt: 1, operationId: null, turnId: "turn" };
async function harness(mode: "view" | "preview" | "history" | "invalid" | "valid") {
  const fixture = fixtureBackend();
  const other: ChatMessage[] = [
    { ...reply, id: "user", role: "user" },
    { ...reply, id: "notice", role: "notice" },
    { ...reply, id: "image", imageState: "preparing" },
    { ...reply, id: "voice", voice: { id: "a".repeat(64) } },
    { ...reply, id: "external", source: { kind: "keet", channel: "dm", senderLabel: "Friend", destination: "test" } },
  ];
  const host = await createChatHost({
    ...fixture.backend,
    async read() { return { ...(await fixture.backend.read()), messages: mode === "preview" ? [] : [reply, ...(mode === "valid" ? other : [])], ...((mode === "preview" || mode === "valid") ? { streamingReply: { id: "preview", text: "tail", createdAt: 1, turnId: "turn" } } : {}), before: "old" }; },
    async history() { return { messages: [{ ...reply, id: "history" }, ...(mode === "valid" ? other : [])], before: null }; },
  }, () => {});
  let removed = 0;
  const scrub = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { value.forEach(scrub); return; }
    const obj = value as Record<string, unknown>;
    if ("ends" in obj) { delete obj.ends; removed++; }
    Object.values(obj).forEach(scrub);
  };
  const channels = new Map<object, ReturnType<typeof host.connect>>();
  const decoder = createServiceStateDecoder(), encoder = createServiceStateEncoder();
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(req, server) { if (server.upgrade(req)) return; return new Response(null, { status: 404 }); },
    websocket: {
      open(ws) { channels.set(ws, host.connect({
        send(raw) {
          const frame = JSON.parse(raw);
          if (frame.type === "result" && frame.result?.instances) {
            const snapshot = decoder.decodeSnapshot(frame.result);
            if (mode === "view" || mode === "preview") scrub(snapshot);
            frame.result = encoder.encodeSnapshot(snapshot);
          } else if (frame.type === "result" && frame.result?.messages && mode === "history") scrub(frame.result);
          else if (frame.type === "result" && frame.result?.messages && mode === "invalid") frame.result.messages[0].ends = [5];
          ws.send(JSON.stringify(frame));
        },
        close(code, reason) { ws.close(code, reason); },
      }, async () => true)); },
      message(ws, raw) { void channels.get(ws)!.receive(String(raw)); },
      close(ws) { channels.get(ws)?.close(); channels.delete(ws); },
    },
  });
  let current: ChatView | undefined, offline = false;
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}`);
  return {
    async open() { return openChat(socket, view => { current = view; }, () => { offline = true; }); },
    get view() { return current; }, get offline() { return offline; }, get removed() { return removed; },
    close() { socket.close(); host.close(); server.stop(true); },
  };
}

for (const mode of ["view", "preview"] as const) {
  test(`openChat rejects projected ${mode} missing ends`, async () => {
    const h = await harness(mode);
    try {
      const result = h.open().then(() => "opened", () => "rejected");
      await until(() => h.removed > 0 || !!h.view || h.offline);
      expect(h.removed).toBeGreaterThan(0);
      expect(await result).toBe("rejected");
      expect(h.view).toBeUndefined();
    } finally { h.close(); }
  });
}

test("openChat rejects history reply missing ends while accepting empty ends", async () => {
  const h = await harness("history");
  try {
    const client = await h.open();
    await until(() => !!h.view);
    expect(h.view!.messages[0]!.ends).toEqual([]);
    await expect(client.history("old")).rejects.toThrow();
    expect(h.removed).toBeGreaterThan(0);
    expect(h.offline).toBe(false);
    client.close();
  } finally { h.close(); }
});

test("openChat accepts empty ends for projected replies and no ends for other records", async () => {
  const h = await harness("valid");
  try {
    const client = await h.open();
    await until(() => !!h.view);
    expect(h.view!.messages[0]!.ends).toEqual([]);
    expect(h.view!.streamingReply!.ends).toEqual([]);
    expect(h.view!.messages.slice(1).every(message => message.ends === undefined)).toBe(true);
    const page = await client.history("old");
    expect(page.messages[0]!.ends).toEqual([]);
    expect(page.messages.slice(1).every(message => message.ends === undefined)).toBe(true);
    client.close();
  } finally { h.close(); }
});

test("openChat rejects invalid projected history boundaries", async () => {
  const h = await harness("invalid");
  try {
    const client = await h.open();
    await expect(client.history("old")).rejects.toThrow();
    expect(h.offline).toBe(false);
    client.close();
  } finally { h.close(); }
});
