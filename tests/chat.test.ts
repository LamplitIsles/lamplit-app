import { expect, test } from "bun:test";
import { createChatHost } from "../packages/contracts/src/server.ts";
import { openChat } from "../packages/contracts/src/client.ts";
import { fixtureBackend } from "./fixture.ts";
import {
  SubmissionSchema,
  validate,
  type ChatView,
} from "../packages/contracts/src/index.ts";

export async function eventually(check: () => boolean, timeout = 3000) {
  const end = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > end) throw new Error("Timed out");
    await Bun.sleep(10);
  }
}

test("a timed-out history read leaves other calls and the connection usable", async () => {
  const fixture = fixtureBackend();
  let release!: () => void,
    entered = false,
    offline = false;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const host = await createChatHost({
    ...fixture.backend,
    async history(before) {
      if (before === "old") {
        entered = true;
        await held;
      }
      return { messages: [], before: null };
    },
  });
  const channels = new Map<object, ReturnType<typeof host.connect>>();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, s) {
      return s.upgrade(req) ? undefined : new Response(null, { status: 404 });
    },
    websocket: {
      open(ws) {
        channels.set(
          ws,
          host.connect(ws, async () => true),
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
  const client = await openChat(
    new WebSocket(`ws://127.0.0.1:${server.port}`),
    () => {},
    () => {
      offline = true;
    },
  );
  const originalTimer = globalThis.setTimeout;
  try {
    let expire: (() => void) | undefined;
    globalThis.setTimeout = ((
      callback: (...args: any[]) => void,
      delay?: number,
      ...args: any[]
    ) => {
      if (delay === 30000 && !expire) expire = () => callback(...args);
      return originalTimer(callback, delay, ...args);
    }) as typeof setTimeout;
    const old = client.history("old");
    globalThis.setTimeout = originalTimer;
    await eventually(() => entered && !!expire);
    expire!();
    await expect(old).rejects.toThrow("timed out");
    expect(offline).toBe(false);
    expect(await client.history("new")).toEqual({ messages: [], before: null });
    expect(offline).toBe(false);
  } finally {
    globalThis.setTimeout = originalTimer;
    release();
    client.close();
    host.close();
    void server.stop(true);
  }
});

test("held history does not reorder mutations, and revoked access blocks reads and results", async () => {
  const fixture = fixtureBackend(),
    order: string[] = [],
    frames: any[] = [],
    closed: number[] = [];
  let releaseHistory!: () => void, releaseSubmit!: () => void;
  const heldHistory = new Promise<void>((resolve) => {
    releaseHistory = resolve;
  });
  const heldSubmit = new Promise<void>((resolve) => {
    releaseSubmit = resolve;
  });
  let authorized = true,
    historyCalls = 0;
  const source = crypto.randomUUID();
  const host = await createChatHost({
    ...fixture.backend,
    async history() {
      historyCalls++;
      await heldHistory;
      return { messages: [], before: null };
    },
    async submit(input) {
      order.push("submit-start");
      await heldSubmit;
      order.push("submit-end");
      return {
        operationId: input.operationId,
        attempt: 1,
        state: "submitted",
        messageId: null,
        turnId: null,
        error: null,
      };
    },
    async lookup(input) {
      order.push("lookup");
      return { operationId: input, attempt: 1, state: "submitted", messageId: null, turnId: null, error: null };
    },
  });
  const connection = host.connect(
    {
      send(raw) {
        frames.push(JSON.parse(raw));
      },
      close(code) {
        closed.push(code!);
      },
    },
    async () => authorized,
  );
  const call = (id: string, member: string, arg: unknown) =>
    JSON.stringify({
      type: "call",
      version: 1,
      id,
      call: { serviceId: "lamplit.chat.v2", member, args: [arg] },
    });
  try {
    await connection.receive(call("h1", "history", "old"));
    await eventually(() => historyCalls === 1);
    const first = connection.receive(
      call("s", "submit", { operationId: source, text: "hello" }),
    );
    const second = connection.receive(
      call("r", "lookup", source),
    );
    await eventually(() => order.includes("submit-start"));
    await Bun.sleep(20);
    expect(order).toEqual(["submit-start"]);
    releaseSubmit();
    await first;
    await second;
    expect(order).toEqual(["submit-start", "submit-end", "lookup"]);
    await eventually(() => frames.some((frame) => frame.id === "r"));
    authorized = false;
    await connection.receive(call("h2", "history", "new"));
    await eventually(() => closed.includes(1008));
    releaseHistory();
    await Bun.sleep(20);
    expect(historyCalls).toBe(1);
    expect(frames.some((frame) => frame.id === "h1" || frame.id === "h2")).toBe(
      false,
    );
  } finally {
    releaseSubmit();
    releaseHistory();
    connection.close();
    host.close();
  }
});

test("concurrent history reads are bounded and excess requests fail in isolation", async () => {
  const fixture = fixtureBackend(),
    frames: any[] = [];
  let release!: () => void,
    calls = 0;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const host = await createChatHost({
    ...fixture.backend,
    async history() {
      calls++;
      await held;
      return { messages: [], before: null };
    },
  });
  const connection = host.connect(
    {
      send(raw) {
        frames.push(JSON.parse(raw));
      },
      close() {},
    },
    async () => true,
  );
  try {
    for (let i = 0; i < 9; i++)
      await connection.receive(
        JSON.stringify({
          type: "call",
          version: 1,
          id: String(i),
          call: {
            serviceId: "lamplit.chat.v2",
            member: "history",
            args: ["cursor"],
          },
        }),
      );
    await eventually(() => frames.some((frame) => frame.id === "8"));
    expect(calls).toBe(8);
    expect(frames.find((frame) => frame.id === "8")?.type).toBe("error");
    release();
    await eventually(
      () => frames.filter((frame) => frame.type === "result").length === 8,
    );
    await connection.receive(
      JSON.stringify({
        type: "call",
        version: 1,
        id: "again",
        call: {
          serviceId: "lamplit.chat.v2",
          member: "history",
          args: ["cursor"],
        },
      }),
    );
    await eventually(() =>
      frames.some((frame) => frame.id === "again" && frame.type === "result"),
    );
  } finally {
    release();
    connection.close();
    host.close();
  }
});
test("runtime schema rejects invalid submissions", () => {
  expect(() =>
    validate(SubmissionSchema, { operationId: "bad", text: "hello" }),
  ).toThrow();
  expect(() =>
    validate(SubmissionSchema, {
      operationId: crypto.randomUUID(),
      text: "hello",
      extra: true,
    }),
  ).toThrow();
});
test("Chord over WebSocket: admission, complete messages, steer, targeted stop, rehydration and revoked access", async () => {
  const fixture = fixtureBackend();
  const errors: unknown[] = [];
  let host = await createChatHost(fixture.backend, (e) => errors.push(e));
  let authorized = true;
  const channels = new Map<object, ReturnType<typeof host.connect>>();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, server) {
      if (server.upgrade(req)) return;
      return new Response("Not found", { status: 404 });
    },
    websocket: {
      open(ws) {
        channels.set(
          ws,
          host.connect(ws, async () => authorized),
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
  let view: ChatView | undefined,
    offline = false;
  let client = await openChat(
    new WebSocket(`ws://127.0.0.1:${server.port}`),
    (v) => {
      view = v;
    },
    () => {
      offline = true;
    },
  );
  try {
    const input = { operationId: crypto.randomUUID(), text: "first" };
    expect((await client.submit(input)).state).toBe("submitted");
    await client.submit(input);
    expect(fixture.executions).toBe(1);
    await expect(
      client.submit({ ...input, text: "changed" }),
    ).rejects.toThrow();
    await client.submit({ operationId: crypto.randomUUID(), text: "steer" });
    expect(fixture.executions).toBe(1);
    expect(view?.messages.filter((m) => m.role === "agent")).toHaveLength(0);
    expect((await client.stop("stale-turn")).stopped).toBe(false);
    client.close();
    expect(offline).toBe(true);
    // Reconstruct provider and path dictionaries without changing engine authority.
    host.close();
    host = await createChatHost(fixture.backend, (e) => errors.push(e));
    await fixture.complete();
    client = await openChat(
      new WebSocket(`ws://127.0.0.1:${server.port}`),
      (v) => {
        view = v;
      },
      () => {
        offline = true;
      },
    );
    await eventually(
      () => view?.messages.filter((m) => m.role === "agent").length === 1,
    );
    expect((await client.lookup(input.operationId))?.state).toBe("submitted");
    const next = { operationId: crypto.randomUUID(), text: "next" };
    await client.submit(next);
    expect((await client.stop(input.operationId)).stopped).toBe(false);
    expect((await client.stop(next.operationId)).stopped).toBe(true);
    authorized = false;
    offline = false;
    await expect(
      client.submit({ operationId: crypto.randomUUID(), text: "forbidden" }),
    ).rejects.toThrow();
    await eventually(() => offline);
    expect(fixture.executions).toBe(2);
  } finally {
    client.close();
    host.close();
    for (const ws of channels.keys())
      (ws as import("bun").ServerWebSocket<undefined>).terminate();
    server.unref();
    void server.stop(true);
  }
});

test("v2 submission contract rejects old receipts and validates nullable lookup", async () => {
  const {
    ReceiptSchema,
    LookupSchema,
    MessageSchema,
    ViewSchema,
  } = await import("../packages/contracts/src/index.ts");
  const id = crypto.randomUUID();
  const receipt = {
    operationId: id,
    attempt: 1,
    state: "submitted" as const,
    messageId: id,
    turnId: null,
    error: null,
  };
  expect(validate(ReceiptSchema, receipt)).toEqual(receipt);
  expect(validate(LookupSchema, null)).toBeNull();
  for (const state of [
    "accepted",
    "consumed",
    "unconsumed",
    "uncertain",
    "missing",
    "rejected",
  ])
    expect(() => validate(ReceiptSchema, { ...receipt, state })).toThrow();
  const message = {
    id,
    role: "user",
    text: "x",
    createdAt: 1,
    operationId: id,
    turnId: null,
  };
  expect(() =>
    validate(MessageSchema, { ...message, delivery: "consumed" }),
  ).toThrow();
  const view = await fixtureBackend().backend.read();
  expect(() => validate(ViewSchema, { ...view, version: 1 })).toThrow();
  expect(() => validate(ViewSchema, { ...view, recovery: [] })).toThrow();
});
