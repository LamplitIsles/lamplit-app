import { expect, test } from "bun:test";
import { createChatHost, type ChatChange } from "../packages/contracts/src/server.ts";
import { openChat } from "../packages/contracts/src/client.ts";
import type { ChatView } from "../packages/contracts/src/index.ts";
import { fixtureBackend } from "./fixture.ts";

test("invalid initial snapshot closes its already installed subscription", async () => {
  const fixture = fixtureBackend();
  let subscribed = false, disposed = false;
  await expect(createChatHost({
    ...fixture.backend,
    async read() { return { ...(await fixture.backend.read()), version: 1 } as unknown as ChatView; },
    subscribe() { subscribed = true; return { scope: Symbol("session"), close() { disposed = true; } }; },
  }, () => {})).rejects.toThrow();
  expect(subscribed).toBe(true);
  expect(disposed).toBe(true);
});

test("a throwing error observer cannot prevent provider failure from closing the host", async () => {
  const fixture = fixtureBackend();
  const scope = Symbol("session");
  let notify: (change: ChatChange) => void = () => {}, errors = 0, disposed = 0;
  const host = await createChatHost({
    ...fixture.backend,
    subscribe(changed) { notify = changed; return { scope, close() { disposed++; } }; },
  }, () => { errors++; throw new Error("observer failure"); });
  const channels = new Map<object, ReturnType<typeof host.connect>>();
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0,
    fetch(req, server) { if (server.upgrade(req)) return; return new Response(null, { status: 404 }); },
    websocket: {
      open(ws) { channels.set(ws, host.connect(ws, async () => true)); },
      message(ws, raw) { void channels.get(ws)!.receive(String(raw)); },
      close(ws) { channels.get(ws)?.close(); channels.delete(ws); },
    },
  });
  let view: ChatView | undefined;
  let disconnected!: (retryable: boolean) => void;
  const offline = new Promise<boolean>(resolve => { disconnected = resolve; });
  const client = await openChat(new WebSocket(`ws://127.0.0.1:${server.port}`), next => { view = next; }, error => disconnected(error.retryable));
  try {
    const initialName = view?.name;
    expect(initialName).toBeDefined();
    expect(() => notify({ type: "error", error: new Error("provider error") })).not.toThrow();
    expect(await offline).toBe(true);
    expect(errors).toBe(1);
    expect(disposed).toBe(1);
    expect(() => host.connect({ send() {}, close() {} }, async () => true)).toThrow(/closed/i);
    notify({ type: "update", scope, state: { name: "late" } });
    expect(view?.name).toBe(initialName);
    expect(errors).toBe(1);
  } finally { client.close(); host.close(); server.stop(true); }
});
