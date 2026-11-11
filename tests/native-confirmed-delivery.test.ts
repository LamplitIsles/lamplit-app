import { expect, test } from "bun:test";
import { openChat } from "../packages/contracts/src/client.ts";
import {
  createChatHost,
  type ChatBackend,
  type ChatChange,
} from "../packages/contracts/src/server.ts";
import {
  UploadResultSchema,
  validate,
  type ChatView,
  type Receipt,
} from "../packages/contracts/src/index.ts";
import { submissionsFixture } from "./submissions-fixture.ts";
import { fixtureImage } from "./panels-fixture.ts";
import { fixtureBackend } from "./fixture.ts";
import {
  createServiceSubscribeCall,
  createServiceUnsubscribeCall,
} from "../packages/contracts/node_modules/@earendil-works/chord/dist/index.js";

async function waitFor(check: () => boolean) {
  const end = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > end) throw new Error("Timed out waiting for fixture");
    await Bun.sleep(5);
  }
}
async function harness(backend: ChatBackend, onSubscriptionChange?: (value: import("../packages/contracts/src/server.ts").ChatSubscription | null) => Promise<void>) {
  const host = await createChatHost(backend, () => {});
  const channels = new Map<object, ReturnType<typeof host.connect>>();
  let authorized = true;
  let firstAuthorized = true;
  let firstSocket: object | undefined;
  let deliveryGate: Promise<void> | undefined;
  let releaseDelivery: (() => void) | undefined;
  let gateEntered = false;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, server) {
      if (server.upgrade(req)) return;
      return new Response(null, { status: 404 });
    },
    websocket: {
      open(ws) {
        firstSocket ??= ws;
        channels.set(
          ws,
          host.connect(ws, async () => {
            if (ws === firstSocket && deliveryGate) {
              gateEntered = true;
              await deliveryGate;
            }
            return authorized && (ws !== firstSocket || firstAuthorized);
          }, { onSubscriptionChange }),
        );
      },
      message(ws, raw) {
        void channels.get(ws)!.receive(String(raw));
      },
      close(ws) {
        channels.get(ws)?.close();
        channels.delete(ws);
      },
    },
  });
  const clients: Array<Awaited<ReturnType<typeof openChat>>> = [];
  const rawClients: WebSocket[] = [];
  async function connect(onReceipt: (receipt: Receipt) => void = () => {}, onOffline: () => void = () => {}) {
    let view: ChatView | undefined;
    const client = await openChat(
      new WebSocket(`ws://127.0.0.1:${server.port}`),
      (value) => {
        view = value;
      },
      onOffline,
      onReceipt,
    );
    clients.push(client);
    await waitFor(() => !!view);
    return { client, view: () => view! };
  }
  return {
    connect,
    rawSocket() {
      const socket = new WebSocket(`ws://127.0.0.1:${server.port}`);
      rawClients.push(socket);
      return socket;
    },
    holdFirst() {
      gateEntered = false;
      deliveryGate = new Promise<void>((resolve) => { releaseDelivery = resolve; });
    },
    gateEntered: () => gateEntered,
    releaseFirst() {
      releaseDelivery?.();
      deliveryGate = undefined;
    },
    injectFirst(frame: (subscriptionId: string) => unknown) {
      const record = channels.get(firstSocket!)!.getSubscription()!;
      (firstSocket as import("bun").ServerWebSocket<undefined>).send(JSON.stringify(frame(record.subscriptionId)));
    },
    revoke() {
      authorized = false;
    },
    revokeFirst() { firstAuthorized = false; },
    close() {
      releaseDelivery?.();
      clients.forEach((c) => c.close());
      rawClients.forEach((c) => c.close());
      host.close();
      server.stop(true);
    },
  };
}

test("reliable acceptance, definitive failure and explicit same-message retry", async () => {
  const f = submissionsFixture();
  const h = await harness(f.backend);
  try {
    const { client, view } = await h.connect();
    const input = { operationId: crypto.randomUUID(), text: "synthetic input" };
    await f.control({ action: "mode", state: "failed" });
    expect((await client.submit(input)).state).toBe("failed");
    expect((await client.lookup(input.operationId))?.state).toBe("failed");
    expect(view().messages).toHaveLength(0);
    await f.control({ action: "mode", state: "submitted" });
    expect((await client.submit(input)).state).toBe("submitted");
    await waitFor(() => view().messages.length === 1);
    expect((await client.lookup(input.operationId))?.state).toBe("submitted");
    expect((await client.submit(input)).state).toBe("submitted");
    expect(
      view().messages.filter((m) => m.operationId === input.operationId),
    ).toHaveLength(1);
    await expect(
      client.submit({ ...input, text: "different" }),
    ).rejects.toThrow();
    expect((await f.control({ action: "state" })).submissions).toHaveLength(1);
  } finally {
    h.close();
  }
});

test("basic fixture publishes a stable accepted receipt across turn completion", async () => {
  const f = fixtureBackend();
  const h = await harness(f.backend);
  const received: Receipt[] = [];
  try {
    const { client } = await h.connect((receipt) => received.push(receipt));
    const input = { operationId: crypto.randomUUID(), text: "fixture message" };
    const receipt = await client.submit(input);
    await waitFor(() => received.length === 1);
    expect(received[0]).toEqual(receipt);
    expect((await client.stop(input.operationId)).stopped).toBe(true);
    expect(await client.lookup(input.operationId)).toEqual(receipt);
    expect(await client.submit(input)).toEqual(receipt);
    expect(f.executions).toBe(1);
  } finally { h.close(); }
});

test("two sockets receive full results and distinguish a queued old failure from a new attempt", async () => {
  const f = submissionsFixture();
  const h = await harness(f.backend);
  const first: Receipt[] = [], second: Receipt[] = [];
  try {
    const a = await h.connect((r) => first.push(r));
    const b = await h.connect((r) => second.push(r));
    const input = { operationId: crypto.randomUUID(), text: "retry" };
    await f.control({ action: "mode", state: "failed" });
    h.holdFirst();
    expect((await b.client.submit(input)).attempt).toBe(1);
    await waitFor(h.gateEntered);
    expect((await b.client.submit(input)).attempt).toBe(2);
    await waitFor(() => second.length === 2);
    expect(a.view().messages).toHaveLength(0);
    expect(second.map((r) => [r.attempt, r.state])).toEqual([[1, "failed"], [2, "failed"]]);
    h.releaseFirst();
    await waitFor(() => first.length === 2);
    expect(first).toEqual(second);
    await f.control({ action: "mode", state: "submitted" });
    expect((await b.client.submit(input)).attempt).toBe(3);
    await waitFor(() => first.length === 3 && second.length === 3);
    expect(first[2]).toMatchObject({ operationId: input.operationId, attempt: 3, state: "submitted" });
    expect((await a.client.lookup(input.operationId))?.attempt).toBe(3);
  } finally { h.close(); }
});

test("queued result is dropped on session change, close or revoked authorization", async () => {
  for (const action of ["session", "close", "revoke"] as const) {
    const f = submissionsFixture();
    let notify!: (change: ChatChange) => void;
    let scope!: symbol;
    const backend: ChatBackend = {
      ...f.backend,
      subscribe(fn) {
        notify = fn;
        const sub = f.backend.subscribe(fn);
        scope = sub.scope;
        return sub;
      },
    };
    const h = await harness(backend);
    const received: Receipt[] = [];
    try {
      const first = await h.connect((r) => received.push(r));
      h.holdFirst();
      notify({ type: "deliveryResult", scope, receipt: { operationId: crypto.randomUUID(), attempt: 1, state: "failed", messageId: null, turnId: null, error: "failed" } });
      await waitFor(h.gateEntered);
      if (action === "session") {
        const next = Symbol("next");
        notify({ type: "session", scope, nextScope: next, view: first.view() });
        scope = next;
      } else if (action === "close") first.client.close();
      else h.revoke();
      h.releaseFirst();
      await Bun.sleep(30);
      expect(received).toEqual([]);
    } finally { h.close(); }
  }
});

test("before subscription readiness missed results reconcile by lookup; ready events reach callback", async () => {
  const f = submissionsFixture();
  let entered = false, release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const h = await harness(f.backend, async () => { entered = true; await gate; });
  const received: Receipt[] = [];
  try {
    const connecting = h.connect((r) => received.push(r));
    await waitFor(() => entered);
    const early = { operationId: crypto.randomUUID(), text: "before ready" };
    await f.backend.submit(early);
    release();
    const { client } = await connecting;
    expect(received).toEqual([]);
    expect((await client.lookup(early.operationId))?.attempt).toBe(1);
    const later = { operationId: crypto.randomUUID(), text: "after ready" };
    await client.submit(later);
    await waitFor(() => received.length === 1);
    expect(received[0]).toMatchObject({ operationId: later.operationId, attempt: 1, state: "submitted" });
  } finally { release(); h.close(); }
});

test("delivery results do not cross an unsubscribe awaiting persistence", async () => {
  const f = submissionsFixture();
  let notify!: (change: ChatChange) => void, scope!: symbol;
  let entered = false, release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const h = await harness({ ...f.backend, subscribe(fn) {
    notify = fn;
    const sub = f.backend.subscribe(fn);
    scope = sub.scope;
    return sub;
  } }, async (value) => { if (!value) { entered = true; await gate; } });
  const frames: Array<Record<string, unknown>> = [];
  const ws = h.rawSocket();
  ws.addEventListener("message", (event) => frames.push(JSON.parse(String(event.data))));
  const call = (id: string, value: unknown) => ws.send(JSON.stringify({ type: "call", version: 1, id, call: value }));
  const receipt: Receipt = { operationId: crypto.randomUUID(), attempt: 1, state: "failed", messageId: null, turnId: null, error: "failed" };
  try {
    await waitFor(() => ws.readyState === WebSocket.OPEN);
    call("subscribe", createServiceSubscribeCall("subscription", "lamplit.chat.v2", "singleton"));
    await waitFor(() => frames.some((frame) => frame.id === "subscribe"));
    call("unsubscribe", createServiceUnsubscribeCall("subscription"));
    await waitFor(() => entered);
    notify({ type: "deliveryResult", scope, receipt });
    await Bun.sleep(30);
    expect(frames.some((frame) => frame.type === "deliveryResult")).toBe(false);
    release();
    await waitFor(() => frames.some((frame) => frame.id === "unsubscribe"));
    call("resubscribe", createServiceSubscribeCall("next", "lamplit.chat.v2", "singleton"));
    await waitFor(() => frames.some((frame) => frame.id === "resubscribe"));
    notify({ type: "deliveryResult", scope, receipt });
    await waitFor(() => frames.some((frame) => frame.type === "deliveryResult"));
    expect(frames.find((frame) => frame.type === "deliveryResult")).toMatchObject({ subscriptionId: "next", receipt });
  } finally { release(); h.close(); }
});

test("invalid result events are rejected by host and client", async () => {
  const f = submissionsFixture();
  let notify!: (change: ChatChange) => void, scope!: symbol;
  const h = await harness({ ...f.backend, subscribe(fn) {
    notify = fn;
    const sub = f.backend.subscribe(fn);
    scope = sub.scope;
    return sub;
  } });
  const received: Receipt[] = [];
  let offline = false;
  const valid = { operationId: crypto.randomUUID(), attempt: 1, state: "failed" as const, messageId: null, turnId: null, error: "failed" };
  try {
    await h.connect((r) => received.push(r), () => { offline = true; });
    for (const attempt of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])
      notify({ type: "deliveryResult", scope, receipt: { ...valid, attempt } });
    for (const receipt of [
      { ...valid, operationId: "invalid" },
      { ...valid, state: "pending" },
      { ...valid, error: { message: "invalid" } },
      { ...valid, unexpected: true },
    ]) notify({ type: "deliveryResult", scope, receipt: receipt as never });
    notify({ type: "deliveryResult", scope: Symbol("other session"), receipt: valid });
    notify({ type: "deliveryResult", scope, receipt: valid });
    await waitFor(() => received.length === 1);
    expect(received).toEqual([valid]);
    h.injectFirst((subscriptionId) => ({ type: "deliveryResult", subscriptionId, receipt: { ...valid, attempt: 0 } }));
    await waitFor(() => offline);
    expect(received).toHaveLength(1);
  } finally { h.close(); }
});

test("oversized delivery result closes the slow channel instead of bypassing frame limits", async () => {
  const f = submissionsFixture();
  let notify!: (change: ChatChange) => void, scope!: symbol;
  const h = await harness({ ...f.backend, subscribe(fn) {
    notify = fn;
    const sub = f.backend.subscribe(fn);
    scope = sub.scope;
    return sub;
  } });
  let offline = false;
  const received: Receipt[] = [];
  try {
    await h.connect((r) => received.push(r), () => { offline = true; });
    notify({ type: "deliveryResult", scope, receipt: { operationId: crypto.randomUUID(), attempt: 1, state: "failed", messageId: null, turnId: null, error: "x".repeat(2 * 1024 * 1024) } });
    await waitFor(() => offline);
    expect(received).toEqual([]);
  } finally { h.close(); }
});

test("delivery events reauthorize each socket independently", async () => {
  const f = submissionsFixture();
  const h = await harness(f.backend);
  const first: Receipt[] = [], second: Receipt[] = [];
  let offline = false;
  try {
    await h.connect((r) => first.push(r), () => { offline = true; });
    const b = await h.connect((r) => second.push(r));
    h.revokeFirst();
    const input = { operationId: crypto.randomUUID(), text: "authorized device" };
    expect((await b.client.submit(input)).state).toBe("submitted");
    await waitFor(() => offline && second.length === 1);
    expect(first).toEqual([]);
    expect(second[0]).toMatchObject({ operationId: input.operationId, attempt: 1 });
  } finally { h.close(); }
});

test("unknown is not failure or automatic resubmission, even after reconnect", async () => {
  const f = submissionsFixture();
  const h = await harness(f.backend);
  try {
    const { client } = await h.connect();
    const input = { operationId: crypto.randomUUID(), text: "unconfirmed" };
    await f.control({ action: "mode", state: "null" });
    await expect(client.submit(input)).rejects.toThrow();
    expect(await client.lookup(input.operationId)).toBeNull();
    const second = await h.connect();
    expect(await second.client.lookup(input.operationId)).toBeNull();
    expect((await f.control({ action: "state" })).submitCalls).toBe(1);
    await f.control({ action: "mode", state: "submitted" });
    await expect(second.client.submit(input)).rejects.toThrow();
    expect((await f.control({ action: "state" })).submissions).toHaveLength(0);
    expect(await second.client.lookup(input.operationId)).toBeNull();
    expect(second.view().messages).toHaveLength(0);
    await f.control({ action: "reset" });
    await f.control({ action: "mode", state: "lost" });
    const accepted = {
      operationId: crypto.randomUUID(),
      text: "accepted but response lost",
    };
    await expect(client.submit(accepted)).rejects.toThrow();
    expect((await second.client.lookup(accepted.operationId))?.state).toBe(
      "submitted",
    );
    expect((await f.control({ action: "state" })).submitCalls).toBe(1);
  } finally {
    h.close();
  }
});

test("a new message is delivered to the active turn without waiting for it to finish", async () => {
  const f = submissionsFixture();
  const h = await harness(f.backend);
  try {
    const { client, view } = await h.connect();
    const first = { operationId: crypto.randomUUID(), text: "first" };
    const steer = { operationId: crypto.randomUUID(), text: "while replying" };
    expect((await client.submit(first)).state).toBe("submitted");
    await waitFor(() => view().activeTurnId === first.operationId);
    const result = await client.submit(steer);
    expect(result.state).toBe("submitted");
    expect(result.turnId).toBe(first.operationId);
    await waitFor(() =>
      view().messages.some((m) => m.operationId === steer.operationId),
    );
    expect(view().activeTurnId).toBe(first.operationId);
    expect((await f.control({ action: "state" })).executions).toBe(1);
  } finally {
    h.close();
  }
});

test("explicit retry preserves the logical message and its staged image", async () => {
  const f = submissionsFixture();
  const h = await harness(f.backend);
  try {
    const { client } = await h.connect();
    const operationId = crypto.randomUUID();
    const image = btoa(String.fromCharCode(...fixtureImage));
    const uploaded = validate(
      UploadResultSchema,
      await f.imageBackend.upload({
        sessionId: "fixture-session",
        operationId,
        images: [
          {
            id: "image",
            order: 0,
            name: "fixture.png",
            mediaType: "image/png",
            original: image,
            preview: image,
            model: image,
          },
        ],
      }),
    );
    const input = {
      operationId,
      text: "synthetic image",
      images: uploaded.images.map((item) => item.ref),
    };
    await f.control({ action: "mode", state: "failed" });
    expect((await client.submit(input)).state).toBe("failed");
    await f.control({ action: "mode", state: "submitted" });
    expect((await client.submit(input)).state).toBe("submitted");
    const state = await f.control({ action: "state" });
    expect(
      state.messages.filter((m) => m.operationId === operationId),
    ).toHaveLength(1);
    expect(
      state.messages.find((m) => m.operationId === operationId)?.images,
    ).toEqual(input.images);
  } finally {
    h.close();
  }
});

test("a retry in flight never exposes the prior failure as the current outcome", async () => {
  const f = submissionsFixture();
  const h = await harness(f.backend);
  try {
    const first = await h.connect();
    const second = await h.connect();
    const input = { operationId: crypto.randomUUID(), text: "retrying" };
    await f.control({ action: "mode", state: "failed" });
    expect((await first.client.submit(input)).state).toBe("failed");
    await f.control({ action: "mode", state: "slow" });
    const retry = first.client.submit(input);
    for (
      let i = 0;
      i < 100 && (await f.control({ action: "state" })).submitCalls < 2;
      i++
    )
      await Bun.sleep(5);
    expect((await f.control({ action: "state" })).submitCalls).toBe(2);
    expect(await second.client.lookup(input.operationId)).toBeNull();
    await f.control({ action: "release" });
    expect((await retry).state).toBe("submitted");
    expect((await second.client.lookup(input.operationId))?.state).toBe(
      "submitted",
    );
  } finally {
    await f.control({ action: "release" });
    h.close();
  }
});

test("a proven stopped queued input is failed; absence remains unknown", async () => {
  const f = submissionsFixture();
  const h = await harness(f.backend);
  try {
    const { client } = await h.connect();
    const a = { operationId: crypto.randomUUID(), text: "active" };
    const b = { operationId: crypto.randomUUID(), text: "queued" };
    const unknownId = crypto.randomUUID();
    expect((await client.submit(a)).state).toBe("submitted");
    await f.control({ action: "mode", state: "queued" });
    await expect(client.submit(b)).rejects.toThrow();
    expect(await client.lookup(b.operationId)).toBeNull();
    expect((await client.stop(a.operationId)).stopped).toBe(true);
    expect((await client.lookup(b.operationId))?.state).toBe("failed");
    expect((await client.lookup(a.operationId))?.state).toBe("submitted");
    expect(await client.lookup(unknownId)).toBeNull();
    await f.control({ action: "mode", state: "submitted" });
    expect((await client.submit(b)).state).toBe("submitted");
    expect(
      (await f.control({ action: "state" })).messages.filter(
        (m: { operationId: string | null }) => m.operationId === b.operationId,
      ),
    ).toHaveLength(1);
  } finally {
    h.close();
  }
});

test("socket rejects invalid identity, malformed receipts and revoked authorization", async () => {
  const f = submissionsFixture();
  let bad = false,
    wrongLookup = false;
  const backend: ChatBackend = {
    ...f.backend,
    async submit(input) {
      if (bad)
        return {
          operationId: crypto.randomUUID(),
          attempt: 1,
          state: "submitted",
          messageId: null,
          turnId: null,
          error: null,
        };
      return f.backend.submit(input);
    },
    async lookup(id) {
      if (wrongLookup)
        return {
          operationId: crypto.randomUUID(),
          attempt: 1,
          state: "failed",
          messageId: null,
          turnId: null,
          error: "not delivered",
        };
      if (bad)
        return {
          operationId: id,
          attempt: 1,
          state: "pending",
          messageId: null,
          turnId: null,
          error: null,
        } as never;
      return f.backend.lookup(id);
    },
  };
  const h = await harness(backend);
  try {
    const { client } = await h.connect();
    await expect(
      client.submit({ operationId: "not-uuid", text: "hi" }),
    ).rejects.toThrow();
    await expect(client.lookup("not-uuid")).rejects.toThrow();
    bad = true;
    await expect(
      client.submit({ operationId: crypto.randomUUID(), text: "hi" }),
    ).rejects.toThrow();
    await expect(client.lookup(crypto.randomUUID())).rejects.toThrow();
    wrongLookup = true;
    await expect(client.lookup(crypto.randomUUID())).rejects.toThrow();
    h.revoke();
    await expect(client.lookup(crypto.randomUUID())).rejects.toThrow();
  } finally {
    h.close();
  }
});

for (const method of ["submit", "lookup"] as const)
  test(`a ${method} result cannot cross a session lifetime, even when the session ID repeats`, async () => {
    const f = submissionsFixture();
    const first = Symbol("first"),
      next = Symbol("next");
    let notify: (change: ChatChange) => void = () => {};
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = false;
    const backend: ChatBackend = {
      ...f.backend,
      subscribe(listener) {
        notify = listener;
        return { scope: first, close() {} };
      },
      async submit(input) {
        started = true;
        await gate;
        return {
          operationId: input.operationId,
          attempt: 1,
          state: "submitted",
          messageId: null,
          turnId: null,
          error: null,
        };
      },
      async lookup(id) {
        started = true;
        await gate;
        return {
          operationId: id,
          attempt: 1,
          state: "failed",
          messageId: null,
          turnId: null,
          error: "not delivered",
        };
      },
    };
    const h = await harness(backend);
    try {
      const { client } = await h.connect();
      const operationId = crypto.randomUUID();
      const pending =
        method === "submit"
          ? client.submit({ operationId, text: "held" })
          : client.lookup(operationId);
      await waitFor(() => started);
      notify({
        type: "session",
        scope: first,
        nextScope: next,
        view: await f.backend.read(),
      });
      release();
      await expect(pending).rejects.toThrow();
    } finally {
      release();
      h.close();
    }
  });

test("a held lookup does not block submit or stop on the same socket", async () => {
  const f = submissionsFixture();
  let release!: () => void,
    lookupStarted = false;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const backend: ChatBackend = {
    ...f.backend,
    async lookup(id) {
      lookupStarted = true;
      await gate;
      return f.backend.lookup(id);
    },
  };
  const h = await harness(backend);
  try {
    const { client } = await h.connect();
    const waiting = client.lookup(crypto.randomUUID());
    await waitFor(() => lookupStarted);
    const input = { operationId: crypto.randomUUID(), text: "live steer" };
    const submitted = client.submit(input);
    const stopped = submitted.then(() => client.stop(input.operationId));
    const result = await Promise.race([
      stopped.then((value) => value.stopped),
      Bun.sleep(1000).then(() => false),
    ]);
    expect(result).toBe(true);
    release();
    expect(await waiting).toBeNull();
  } finally {
    release();
    h.close();
  }
});

test("history and lookup share a bounded read budget without blocking mutations", async () => {
  const f = submissionsFixture();
  let release!: () => void,
    reads = 0;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const backend: ChatBackend = {
    ...f.backend,
    async lookup() {
      reads++;
      await gate;
      return null;
    },
    async history() {
      reads++;
      await gate;
      return { messages: [], before: null };
    },
  };
  const h = await harness(backend);
  try {
    const { client } = await h.connect();
    const pending: Array<Promise<unknown>> = [];
    for (let i = 0; i < 4; i++) {
      pending.push(client.lookup(crypto.randomUUID()));
      pending.push(client.history(`cursor-${i}`));
    }
    await waitFor(() => reads === 8);
    await expect(client.lookup(crypto.randomUUID())).rejects.toThrow();
    await expect(client.history("extra")).rejects.toThrow();
    expect(reads).toBe(8);
    const input = { operationId: crypto.randomUUID(), text: "unblocked" };
    const stopped = client
      .submit(input)
      .then(() => client.stop(input.operationId));
    expect(
      await Promise.race([
        stopped.then((value) => value.stopped),
        Bun.sleep(1000).then(() => false),
      ]),
    ).toBe(true);
    release();
    await Promise.all(pending);
    expect(await client.lookup(crypto.randomUUID())).toBeNull();
    expect(reads).toBe(9);
  } finally {
    release();
    h.close();
  }
});

test("a held lookup is rejected on connection close and cannot enter a new client", async () => {
  const f = submissionsFixture();
  let release!: () => void,
    started = false;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const backend: ChatBackend = {
    ...f.backend,
    async lookup(id) {
      started = true;
      await gate;
      return {
        operationId: id,
        attempt: 1,
        state: "submitted",
        messageId: null,
        turnId: null,
        error: null,
      };
    },
  };
  const h = await harness(backend);
  try {
    const first = await h.connect();
    const pending = first.client.lookup(crypto.randomUUID());
    await waitFor(() => started);
    first.client.close();
    await expect(pending).rejects.toThrow();
    release();
    const second = await h.connect();
    const input = { operationId: crypto.randomUUID(), text: "new socket" };
    expect((await second.client.submit(input)).operationId).toBe(
      input.operationId,
    );
  } finally {
    release();
    h.close();
  }
});

test("lookup timeout leaves the socket usable and ignores its late result", async () => {
  const f = submissionsFixture();
  let release!: () => void,
    started = false;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const backend: ChatBackend = {
    ...f.backend,
    async lookup(id) {
      started = true;
      await gate;
      return {
        operationId: id,
        attempt: 1,
        state: "failed",
        messageId: null,
        turnId: null,
        error: "late",
      };
    },
  };
  const h = await harness(backend);
  const originalTimer = globalThis.setTimeout;
  try {
    const { client } = await h.connect();
    let expire: (() => void) | undefined;
    globalThis.setTimeout = ((
      callback: (...args: any[]) => void,
      delay?: number,
      ...args: any[]
    ) => {
      if (delay === 30000 && !expire) expire = () => callback(...args);
      return originalTimer(callback, delay, ...args);
    }) as typeof setTimeout;
    const pending = client.lookup(crypto.randomUUID());
    globalThis.setTimeout = originalTimer;
    await waitFor(() => started && !!expire);
    expire!();
    await expect(pending).rejects.toThrow("timed out");
    const input = {
      operationId: crypto.randomUUID(),
      text: "after read timeout",
    };
    expect((await client.submit(input)).state).toBe("submitted");
    release();
    expect((await client.stop(input.operationId)).stopped).toBe(true);
  } finally {
    globalThis.setTimeout = originalTimer;
    release();
    h.close();
  }
});

test("authorization revoked during a held lookup blocks its response and later mutation", async () => {
  const f = submissionsFixture();
  let release!: () => void,
    started = false,
    submits = 0;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const backend: ChatBackend = {
    ...f.backend,
    async lookup(id) {
      started = true;
      await gate;
      return {
        operationId: id,
        attempt: 1,
        state: "submitted",
        messageId: null,
        turnId: null,
        error: null,
      };
    },
    async submit(input) {
      submits++;
      return f.backend.submit(input);
    },
  };
  const h = await harness(backend);
  try {
    const { client } = await h.connect();
    const result = client.lookup(crypto.randomUUID()).then(
      () => "result",
      () => "rejected",
    );
    await waitFor(() => started);
    h.revoke();
    await expect(
      client.submit({ operationId: crypto.randomUUID(), text: "forbidden" }),
    ).rejects.toThrow();
    release();
    expect(await result).toBe("rejected");
    expect(submits).toBe(0);
  } finally {
    release();
    h.close();
  }
});
