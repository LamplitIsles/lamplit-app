import { fixtureBackend } from "./fixture.ts";
import { searchFixture } from "./search-fixture.ts";
import { panelsFixture } from "./panels-fixture.ts";
import { expect, test } from "bun:test";
import { ChatController } from "../apps/web/src/lib/chat-controller.ts";
import {
  capabilities,
  type ChatMessage,
  type Receipt,
} from "../packages/contracts/src/index.ts";
import {
  createChatHost,
  type ChatBackend,
  type ChatChange,
} from "../packages/contracts/src/server.ts";
import { eventually } from "./chat.test.ts";

test("moving live window retains history/sent inputs and rejects previous-session archive/panel reads", async () => {
  const message = (id: number): ChatMessage => ({
    id: String(id),
    role: "user",
    text: `message ${id}`,
    createdAt: id,
    operationId: null,
    turnId: null,
  });
  const historicalOperation = crypto.randomUUID();
  let live = Array.from({ length: 30 }, (_, i) => message(i + 11));
  let sessionId = "history-fixture";
  let scope = Symbol("history fixture");
  let changed: (change: ChatChange) => void = () => {};
  let active: string | null = null;
  let stopped = false;
  const panels = panelsFixture();
  const search = searchFixture();
  const backend: ChatBackend = {
    ...fixtureBackend().backend,
    ...panels.backend,
    ...search.backend,
    async read() {
      return {
        version: 2,
        sessionId,
        name: "Fixture",
        activeTurnId: active,
        contextUsage: { tokens: null, capacity: null },
        compaction: null,
        messages: live,
        before: "11",
        capabilities,
      };
    },
    async compact(input) {
      return { sessionId: input.sessionId, accepted: false };
    },
    async history() {
      return {
        messages: Array.from({ length: 10 }, (_, i) => ({
          ...message(i + 1),
          operationId: i === 0 ? historicalOperation : null,
        })),
        before: null,
      };
    },
    async submit(input) {
      active = "queued-turn";
      changed({ type: "update", scope, state: { activeTurnId: active } });
      return {
        operationId: input.operationId,
        attempt: 1,
        state: "submitted",
        messageId: null,
        turnId: "stopped",
        error: null,
      };
    },
    async lookup(id) {
      return {
        operationId: id,
        attempt: 1,
        state: "submitted",
        messageId: null,
        turnId: null,
        error: null,
      };
    },
    async stop() {
      active = null;
      stopped = true;
      changed({ type: "update", scope, state: { activeTurnId: active } });
      return { stopped: true };
    },
    subscribe(listener) {
      changed = listener;
      return {
        scope,
        close() {
          changed = () => {};
        },
      };
    },
  };
  const publish = async () => {
    const value = await backend.read();
    changed({
      type: "update",
      scope,
      window: { messages: value.messages, before: value.before },
    });
  };
  let host = await createChatHost(backend);
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
  const previousLocation = Object.getOwnPropertyDescriptor(
    globalThis,
    "location",
  );
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: { href: `http://127.0.0.1:${server.port}/slice/` },
  });
  const saved = new Map<string, string>([
    [
      "lamplit.pending:history-fixture",
      JSON.stringify([
        {
          operationId: historicalOperation,
          text: "message 1",
          state: "sent",
          deliveryVersion: 2,
          createdAt: 1,
        },
      ]),
    ],
  ]);
  let storageFails = false;
  const controller = new ChatController(() => {}, {
    getItem: (key) => saved.get(key) ?? null,
    setItem: (key, value) => {
      if (storageFails) throw new Error("Fixture storage quota");
      saved.set(key, value);
    },
  });
  try {
    controller.start();
    await eventually(() => controller.connected);
    expect(controller.pending).toHaveLength(1);
    await controller.loadOlder();
    expect(controller.pending).toEqual([]);
    expect(controller.before).toBeNull();
    live = Array.from({ length: 30 }, (_, i) => message(i + 12));
    await publish();
    await eventually(() => controller.view?.messages.at(-1)?.id === "41");
    expect(
      [...controller.older, ...controller.view!.messages].map((m) => m.id),
    ).toEqual(Array.from({ length: 41 }, (_, i) => String(i + 1)));
    expect(controller.before).toBeNull();
    await publish();
    expect(
      new Set(
        [...controller.older, ...controller.view!.messages].map((m) => m.id),
      ).size,
    ).toBe(41);
    await controller.send("not consumed before stop");
    expect(controller.pending[0]?.state).toBe("sent");
    await eventually(() => controller.view?.activeTurnId === "queued-turn");
    await controller.stop();
    expect(stopped).toBe(true);
    expect(controller.pending[0]?.state).toBe("sent");
    expect(
      JSON.parse(saved.get("lamplit.pending:history-fixture")!)[0].state,
    ).toBe("sent");
    storageFails = true;
    await controller.send("storage failure remains visible");
    expect(controller.error).toContain("无法保存发送状态");
    storageFails = false;
    let release!: () => void;
    panels.delays.set(
      "relationship",
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    panels.delays.set("diaryList", panels.delays.get("relationship")!);
    search.delays.set("灯塔", panels.delays.get("relationship")!);
    const staleSearch = controller.readSearch("search", { query: "灯塔" }).then(
      () => "resolved",
      () => "stale",
    );
    const staleRelationship = controller.refreshRelationship(true);
    const staleDiary = controller.readPanel("diaryList", { cursor: null });
    // Capture the rejection immediately; no test-owned request may leak an unhandled rejection.
    const staleDiaryResult = staleDiary.then(
      () => "resolved",
      () => "stale",
    );
    sessionId = "different-fixture";
    live = [message(100)];
    host.close();
    host = await createChatHost(backend);
    await eventually(() => controller.view?.sessionId === sessionId);
    expect(controller.relationship).toBeUndefined();
    expect(controller.relationshipHistory.records).toEqual([]);
    release();
    panels.delays.clear();
    await staleRelationship;
    expect(await staleDiaryResult).toBe("stale");
    expect(await staleSearch).toBe("stale");
    await controller.refreshRelationship(true);
    expect(controller.relationshipHistory.scope).toBe("fixture-relationship");
    expect(controller.relationship?.current.affinity).toBe(65);
    expect(controller.older).toEqual([]);
    expect(controller.pending).toEqual([]);
  } finally {
    controller.close();
    host.close();
    for (const ws of channels.keys())
      (ws as import("bun").ServerWebSocket<undefined>).terminate();
    server.unref();
    void server.stop(true);
    if (previousLocation)
      Object.defineProperty(globalThis, "location", previousLocation);
    else Reflect.deleteProperty(globalThis, "location");
  }
});

const gate = () => {
  let release!: () => void;
  return {
    promise: new Promise<void>((r) => {
      release = r;
    }),
    release: () => release(),
  };
};
async function controllerHarness(
  backend: ChatBackend,
  saved = new Map<string, string>(),
) {
  let changed: (change: ChatChange) => void = () => {};
  let scope: symbol, sessionId: string;
  const host = await createChatHost(
    {
      ...backend,
      async read(signal) {
        const value = await backend.read(signal);
        sessionId = value.sessionId;
        return value;
      },
      subscribe(listener) {
        changed = listener;
        const subscription = backend.subscribe(() => {
          void publish();
        });
        scope = subscription.scope;
        return {
          scope,
          close() {
            subscription.close();
            changed = () => {};
          },
        };
      },
    },
    () => {},
  );
  async function publish() {
    const value = await backend.read();
    if (value.sessionId !== sessionId) {
      const nextScope = Symbol("controller session");
      changed({ type: "session", scope, nextScope, view: value });
      scope = nextScope;
      sessionId = value.sessionId;
    } else
      changed({
        type: "update",
        scope,
        window: { messages: value.messages, before: value.before },
        state: {
          activeTurnId: value.activeTurnId,
          capabilities: value.capabilities,
          contextUsage: value.contextUsage,
          compaction: value.compaction,
          name: value.name,
          streamingReply: value.streamingReply ?? null,
          replyCompletedTurnId: value.replyCompletedTurnId ?? null,
        },
      });
  }
  const channels = new Map<object, ReturnType<typeof host.connect>>();
  const received: unknown[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, server) {
      if (server.upgrade(req)) return;
      return new Response(null, { status: 404 });
    },
    websocket: {
      open(ws) {
        channels.set(
          ws,
          host.connect(ws, async () => true),
        );
      },
      message(ws, raw) {
        received.push(JSON.parse(String(raw)));
        void channels.get(ws)!.receive(String(raw));
      },
      close(ws) {
        channels.get(ws)?.close();
        channels.delete(ws);
      },
    },
  });
  const previous = Object.getOwnPropertyDescriptor(globalThis, "location");
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: { href: `http://127.0.0.1:${server.port}/` },
  });
  const storage = {
    getItem: (k: string) => saved.get(k) ?? null,
    setItem: (k: string, v: string) => {
      saved.set(k, v);
    },
  };
  const controllers: ChatController[] = [];
  let disconnections = 0;
  const create = async () => {
    let connected = false;
    const c = new ChatController(() => {
      if (connected && !c.connected) disconnections++;
      connected = c.connected;
    }, storage);
    controllers.push(c);
    c.start();
    await eventually(() => c.connected);
    return c;
  };
  return {
    host,
    publish,
    deliver(receipt: Receipt) {
      changed({ type: "deliveryResult", scope, receipt });
    },
    received,
    saved,
    get disconnections() {
      return disconnections;
    },
    create,
    disconnect() {
      for (const ws of channels.keys())
        (ws as import("bun").ServerWebSocket<undefined>).terminate();
    },
    close() {
      controllers.forEach((c) => c.close());
      host.close();
      void server.stop(true);
      if (previous) Object.defineProperty(globalThis, "location", previous);
      else Reflect.deleteProperty(globalThis, "location");
    },
  };
}

test("single channel history overlap never duplicates the current live source", async () => {
  const live: ChatMessage = {
    id: "live",
    role: "agent",
    text: "answer\n",
    textState: "complete",
    createdAt: 2,
    operationId: null,
    turnId: "turn",
  };
  const old: ChatMessage = {
    id: "old",
    role: "user",
    text: "question",
    createdAt: 1,
    operationId: null,
    turnId: null,
  };
  const fixture = fixtureBackend();
  const backend: ChatBackend = {
    ...fixture.backend,
    async read() {
      return {
        ...(await fixture.backend.read()),
        messages: [live],
        before: "older",
      };
    },
    async history() {
      return { messages: [old, live], before: null };
    },
  };
  const h = await controllerHarness(backend);
  try {
    const c = await h.create();
    await c.loadOlder();
    expect(c.older.map((message) => message.id)).toEqual(["old"]);
    expect(
      [...c.older, ...c.view!.messages].map((message) => message.id),
    ).toEqual(["old", "live"]);
  } finally {
    h.close();
  }
});

test("single channel reconnect retains loaded history without an automatic history scan", async () => {
  let calls = 0;
  const fixture = fixtureBackend();
  const backend: ChatBackend = {
    ...fixture.backend,
    async read() {
      return {
        ...(await fixture.backend.read()),
        messages: [
          {
            id: "live",
            role: "user",
            text: "live",
            createdAt: 2,
            operationId: null,
            turnId: null,
          },
        ],
        before: "older",
      };
    },
    async history() {
      calls++;
      return {
        messages: [
          {
            id: "old",
            role: "user",
            text: "old",
            createdAt: 1,
            operationId: null,
            turnId: null,
          },
        ],
        before: null,
      };
    },
  };
  const h = await controllerHarness(backend);
  try {
    const c = await h.create();
    await c.loadOlder();
    expect(c.older.map((message) => message.id)).toEqual(["old"]);
    h.disconnect();
    await eventually(() => h.disconnections > 0);
    await eventually(() => c.connected, 5000);
    expect(c.older.map((message) => message.id)).toEqual(["old"]);
    expect(c.historyGaps).toEqual([]);
    expect(calls).toBe(1);
  } finally {
    h.close();
  }
});

test("reconnect gap can be paged without losing source order", async () => {
  const message = (i: number): ChatMessage => ({
    id: `m${i}`,
    role: "user",
    text: `message ${i}`,
    createdAt: i,
    operationId: null,
    turnId: null,
  });
  let records = Array.from({ length: 65 }, (_, i) => message(i));
  const fixture = fixtureBackend();
  const backend: ChatBackend = {
    ...fixture.backend,
    async read() {
      const live = records.slice(-30);
      return {
        ...(await fixture.backend.read()),
        messages: live,
        before: records.length > live.length ? live[0]!.id : null,
      };
    },
    async history(before) {
      const end = records.findIndex((message) => message.id === before);
      if (end < 0) throw new Error("Unknown cursor");
      const start = Math.max(0, end - 30);
      return {
        messages: records.slice(start, end),
        before: start ? records[start]!.id : null,
      };
    },
  };
  const h = await controllerHarness(backend);
  try {
    const c = await h.create();
    await c.loadOlder();
    expect(c.older.map((message) => message.id)).toEqual(
      Array.from({ length: 30 }, (_, i) => `m${i + 5}`),
    );
    c.setVisible(false);
    h.disconnect();
    await eventually(() => h.disconnections > 0);
    records = [
      ...records,
      ...Array.from({ length: 60 }, (_, i) => message(i + 65)),
    ];
    await h.publish();
    c.setVisible(true);
    await eventually(
      () => c.connected && c.view?.messages[0]?.id === "m95",
      5000,
    );
    expect(c.historyGaps).toHaveLength(1);
    for (let i = 0; i < 4 && c.historyGaps.length; i++)
      await c.fillGap(c.historyGaps[0]!.id);
    expect(c.historyGaps).toEqual([]);
    while (c.before) await c.loadOlder();
    expect(
      [...c.older, ...c.view!.messages].map((message) => message.id),
    ).toEqual(Array.from({ length: 125 }, (_, i) => `m${i}`));
  } finally {
    h.close();
  }
});

async function gapHarness() {
  const message = (i: number, session = "A"): ChatMessage => ({
    id: `${session}-${i}`,
    role: "user",
    text: `${session} ${i}`,
    createdAt: i,
    operationId: null,
    turnId: null,
  });
  const fixture = fixtureBackend();
  let session = "A",
    records = Array.from({ length: 65 }, (_, i) => message(i));
  let behavior:
    | "normal"
    | "error"
    | "no-progress"
    | "empty"
    | "cycle"
    | "end"
    | "inclusive" = "normal";
  let hold:
    | { entered: ReturnType<typeof gate>; release: ReturnType<typeof gate> }
    | undefined;
  let submissions = 0;
  const calls: string[] = [];
  const backend: ChatBackend = {
    ...fixture.backend,
    async submit(input) {
      submissions++;
      return fixture.backend.submit(input);
    },
    async read() {
      const live = records.slice(-30);
      return {
        ...(await fixture.backend.read()),
        sessionId: session,
        messages: live,
        before: records.length > live.length ? live[0]!.id : null,
      };
    },
    async history(before) {
      calls.push(before);
      if (behavior === "end") return { messages: [], before: null };
      if (behavior === "cycle")
        return {
          messages: [],
          before: before.startsWith("cycle:")
            ? before.slice(6)
            : `cycle:${before}`,
        };
      if (behavior === "empty" && !before.startsWith("empty:"))
        return { messages: [], before: `empty:${before}` };
      if (before.startsWith("empty:")) before = before.slice(6);
      const end = records.findIndex((item) => item.id === before);
      if (end < 0 || behavior === "error")
        throw new Error("invalid or unavailable cursor");
      if (behavior === "no-progress") return { messages: [], before };
      const start = Math.max(0, end - (behavior === "inclusive" ? 29 : 30));
      const result = {
        messages: records.slice(
          start,
          end + (behavior === "inclusive" ? 1 : 0),
        ),
        before: start ? records[start]!.id : null,
      };
      const paused = hold;
      if (paused) {
        paused.entered.release();
        await paused.release.promise;
      }
      return result;
    },
  };
  const h = await controllerHarness(backend);
  const c = await h.create();
  const reconnect = async (count: number) => {
    const disconnected = h.disconnections;
    c.setVisible(false);
    h.disconnect();
    await eventually(() => h.disconnections > disconnected);
    const length = records.length;
    records = [
      ...records,
      ...Array.from({ length: count }, (_, i) => message(length + i, session)),
    ];
    await h.publish();
    c.setVisible(true);
    await eventually(
      () => c.connected && c.view?.messages.at(-1)?.id === records.at(-1)?.id,
      5000,
    );
  };
  return {
    h,
    c,
    calls,
    reconnect,
    submissions: () => submissions,
    behavior(value: typeof behavior) {
      behavior = value;
    },
    hold() {
      hold = { entered: gate(), release: gate() };
      return hold;
    },
    unhold() {
      hold = undefined;
    },
    session(value: string) {
      session = value;
      records = Array.from({ length: 35 }, (_, i) => message(i, value));
    },
  };
}

test("overlapping reconnect windows need no gap or history scan", async () => {
  const f = await gapHarness();
  try {
    await f.reconnect(20);
    expect(f.c.historyGaps).toEqual([]);
    expect(f.calls).toHaveLength(0);
    expect(
      [...f.c.older, ...f.c.view!.messages].map((item) => item.id),
    ).toEqual(Array.from({ length: 50 }, (_, i) => `A-${i + 35}`));
  } finally {
    f.h.close();
  }
});

test("a pending user in both windows does not prove their durable history is contiguous", async () => {
  const message = (i: number): ChatMessage => ({
    id: `durable-${i}`,
    role: "user",
    text: `${i}`,
    createdAt: i,
    operationId: null,
    turnId: null,
  });
  const pending: ChatMessage = {
    id: "same-native-submission-id",
    role: "user",
    text: "queued",
    createdAt: 10000,
    operationId: crypto.randomUUID(),
    turnId: null,
  };
  let records = Array.from({ length: 65 }, (_, i) => message(i));
  const fixture = fixtureBackend();
  const backend: ChatBackend = {
    ...fixture.backend,
    async read() {
      const durable = records.slice(-29);
      return {
        ...(await fixture.backend.read()),
        messages: [...durable, pending],
        before: durable[0]!.id,
      };
    },
    async history(before) {
      const end = records.findIndex((item) => item.id === before);
      if (end < 0) throw new Error("Unknown cursor");
      const start = Math.max(0, end - 30);
      return {
        messages: records.slice(start, end),
        before: start ? records[start]!.id : null,
      };
    },
  };
  const h = await controllerHarness(backend);
  try {
    const c = await h.create();
    await c.loadOlder();
    c.setVisible(false);
    h.disconnect();
    await eventually(() => h.disconnections > 0);
    records = [
      ...records,
      ...Array.from({ length: 60 }, (_, i) => message(i + 65)),
    ];
    await h.publish();
    c.setVisible(true);
    await eventually(
      () => c.connected && c.view?.messages[0]?.id === "durable-96",
      5000,
    );
    expect(c.view!.messages.at(-1)!.id).toBe(pending.id);
    expect(c.historyGaps).toHaveLength(1);
    const gap = c.historyGaps[0]!;
    expect([gap.afterId, gap.beforeId]).toEqual(["durable-64", "durable-96"]);
    await c.fillGap(gap.id);
    expect(c.historyGaps).toHaveLength(1);
    await c.fillGap(gap.id);
    expect(c.historyGaps).toEqual([]);
    await c.loadOlder();
    expect([...c.older, ...c.view!.messages].map((item) => item.id)).toEqual([
      ...Array.from({ length: 125 }, (_, i) => `durable-${i}`),
      pending.id,
    ]);
  } finally {
    h.close();
  }
});

test("a locally observed queued input cannot bridge a gap after it moves to the window front", async () => {
  const message = (i: number): ChatMessage => ({
    id: `record-${i}`,
    role: "user",
    text: `${i}`,
    createdAt: i,
    operationId: null,
    turnId: null,
  });
  const operationId = crypto.randomUUID();
  const pending: ChatMessage = {
    id: "authoritative-submission-id",
    role: "user",
    text: "queued",
    createdAt: 1,
    operationId,
    turnId: null,
  };
  let records = Array.from({ length: 65 }, (_, i) => message(i));
  const fixture = fixtureBackend();
  const backend: ChatBackend = {
    ...fixture.backend,
    async read() {
      const durable = records.slice(-29);
      return {
        ...(await fixture.backend.read()),
        messages:
          records.length === 65 ? [...durable, pending] : [pending, ...durable],
        before: durable[0]!.id,
      };
    },
    async history(before) {
      const end = records.findIndex((item) => item.id === before);
      if (end < 0) throw new Error("Unknown cursor");
      const start = Math.max(0, end - 30);
      return {
        messages: records.slice(start, end),
        before: start ? records[start]!.id : null,
      };
    },
  };
  const saved = new Map([
    [
      "lamplit.pending:fixture-session",
      JSON.stringify([
        { operationId, text: "queued", state: "sending", createdAt: 1 },
      ]),
    ],
  ]);
  const h = await controllerHarness(backend, saved);
  try {
    const c = await h.create();
    expect(c.pending[0]?.state).toBe("sending"); // A live item alone is not a durable receipt.
    await c.loadOlder();
    c.setVisible(false);
    h.disconnect();
    await eventually(() => h.disconnections > 0);
    c.setVisible(true);
    await eventually(() => c.connected, 5000);
    expect(c.historyGaps).toEqual([]);
    const disconnected = h.disconnections;
    c.setVisible(false);
    h.disconnect();
    await eventually(() => h.disconnections > disconnected);
    records = [
      ...records,
      ...Array.from({ length: 60 }, (_, i) => message(i + 65)),
    ];
    await h.publish();
    c.setVisible(true);
    await eventually(
      () => c.connected && c.view?.messages.at(-1)?.id === "record-124",
      5000,
    );
    expect(c.historyGaps.map((gap) => [gap.afterId, gap.beforeId])).toEqual([
      ["record-64", "record-96"],
    ]);
  } finally {
    h.close();
  }
});

test("multiple reconnect gaps fill separately with at most one page per trigger", async () => {
  const f = await gapHarness();
  try {
    await f.c.loadOlder();
    const originalBefore = f.c.before;
    await f.reconnect(60);
    await f.reconnect(60);
    expect(f.c.historyGaps.map((gap) => [gap.afterId, gap.beforeId])).toEqual([
      ["A-64", "A-95"],
      ["A-124", "A-155"],
    ]);
    expect(f.calls).toHaveLength(1);
    const firstId = f.c.historyGaps[0]!.id;
    let previousCalls = f.calls.length;
    await f.c.fillGap(firstId);
    expect(f.calls.length - previousCalls).toBe(1);
    expect(f.c.historyGaps[0]).toMatchObject({
      id: firstId,
      afterId: "A-64",
      beforeId: "A-65",
      status: "pending",
    });
    previousCalls = f.calls.length;
    await f.c.fillGap(firstId);
    expect(f.calls.length - previousCalls).toBe(1);
    expect(f.c.historyGaps).toHaveLength(1);
    const secondId = f.c.historyGaps[0]!.id;
    await f.c.fillGap(secondId);
    await f.c.fillGap(secondId);
    expect(f.c.historyGaps).toEqual([]);
    expect(f.c.before).toBe(originalBefore);
    await f.c.loadOlder();
    expect(
      [...f.c.older, ...f.c.view!.messages].map((item) => item.id),
    ).toEqual(Array.from({ length: 185 }, (_, i) => `A-${i}`));
  } finally {
    f.h.close();
  }
});

test("empty gap pages advance and cursor cycles stop without spinning", async () => {
  const f = await gapHarness();
  try {
    await f.reconnect(60);
    const id = f.c.historyGaps[0]!.id;
    const before = f.c.older.map((item) => item.id);
    f.behavior("empty");
    await f.c.fillGap(id);
    expect(f.c.historyGaps[0]!.status).toBe("pending");
    expect(f.c.older.map((item) => item.id)).toEqual(before);
    f.behavior("normal");
    await f.c.fillGap(id);
    expect(f.c.historyGaps[0]!.beforeId).toBe("A-65");
    f.behavior("cycle");
    await f.c.fillGap(id);
    expect(f.c.historyGaps[0]!.status).toBe("pending");
    await f.c.fillGap(id);
    expect(f.c.historyGaps[0]!.status).toBe("unavailable");
  } finally {
    f.h.close();
  }
});

test("overlapping gap pages deduplicate without losing order", async () => {
  const f = await gapHarness();
  try {
    await f.reconnect(60);
    f.behavior("inclusive");
    const id = f.c.historyGaps[0]!.id;
    await f.c.fillGap(id);
    expect(f.c.historyGaps[0]).toMatchObject({
      beforeId: "A-66",
      status: "pending",
    });
    await f.c.fillGap(id);
    expect(f.c.historyGaps).toEqual([]);
    expect(
      [...f.c.older, ...f.c.view!.messages].map((item) => item.id),
    ).toEqual(Array.from({ length: 90 }, (_, i) => `A-${i + 35}`));
  } finally {
    f.h.close();
  }
});

test("history ending without the retained boundary leaves an unavailable gap", async () => {
  const f = await gapHarness();
  try {
    await f.reconnect(60);
    const id = f.c.historyGaps[0]!.id;
    const before = f.c.older.map((item) => item.id);
    f.behavior("end");
    await f.c.fillGap(id);
    expect(f.c.historyGaps[0]!.status).toBe("unavailable");
    expect(f.c.older.map((item) => item.id)).toEqual(before);
    expect(f.calls).toHaveLength(1);
  } finally {
    f.h.close();
  }
});

test("visible gaps can each request a single page concurrently", async () => {
  const f = await gapHarness();
  try {
    await f.reconnect(60);
    await f.reconnect(60);
    const hold = f.hold();
    const ids = f.c.historyGaps.map((gap) => gap.id);
    const calls = f.calls.length;
    const first = f.c.fillGap(ids[0]!);
    const second = f.c.fillGap(ids[1]!);
    await hold.entered.promise;
    await eventually(() => f.calls.length === calls + 2);
    expect(f.c.historyGaps.map((gap) => gap.status)).toEqual([
      "loading",
      "loading",
    ]);
    hold.release.release();
    await Promise.all([first, second]);
    expect(f.c.historyGaps.map((gap) => gap.status)).toEqual([
      "pending",
      "pending",
    ]);
    expect(f.calls.length - calls).toBe(2);
  } finally {
    f.h.close();
  }
});

test("gap failures are explicit, retryable, and no progress stops paging", async () => {
  const f = await gapHarness();
  try {
    await f.reconnect(60);
    const id = f.c.historyGaps[0]!.id;
    const before = f.c.older.map((item) => item.id);
    f.behavior("error");
    await f.c.fillGap(id);
    expect(f.c.historyGaps[0]!.status).toBe("error");
    expect(f.c.older.map((item) => item.id)).toEqual(before);
    f.behavior("normal");
    await f.c.fillGap(id);
    expect(f.c.historyGaps[0]!.status).toBe("pending");
    f.behavior("no-progress");
    await f.c.fillGap(id);
    expect(f.c.historyGaps[0]!.status).toBe("unavailable");
    const calls = f.calls.length;
    await f.c.fillGap(id);
    expect(f.calls).toHaveLength(calls);
  } finally {
    f.h.close();
  }
});

test("a held gap page cannot enter a later session after returning to the same session ID", async () => {
  const f = await gapHarness();
  const held = f.hold();
  try {
    await f.reconnect(60);
    const old = f.c.fillGap(f.c.historyGaps[0]!.id);
    await held.entered.promise;
    f.session("B");
    await f.h.publish();
    await eventually(() => f.c.view?.sessionId === "B");
    f.session("A");
    await f.h.publish();
    await eventually(() => f.c.view?.sessionId === "A");
    held.release.release();
    await old;
    expect(f.c.historyGaps).toEqual([]);
    expect(f.c.older).toEqual([]);
  } finally {
    held.release.release();
    f.h.close();
  }
});

test("gap reconnect and page fills do not replay an acknowledged submission", async () => {
  const f = await gapHarness();
  try {
    await f.c.send("send once");
    expect(f.submissions()).toBe(1);
    expect(f.c.pending[0]!.state).toBe("sent");
    const id = f.c.pending[0]!.operationId;
    await f.reconnect(60);
    await f.c.fillGap(f.c.historyGaps[0]!.id);
    await f.c.fillGap(f.c.historyGaps[0]!.id);
    expect(f.submissions()).toBe(1);
    expect(f.c.pending[0]!.operationId).toBe(id);
    expect(f.c.pending[0]!.state).toBe("sent");
  } finally {
    f.h.close();
  }
});

test("gap responses from a prior connection and session cannot alter a new request", async () => {
  const f = await gapHarness();
  const held = f.hold();
  try {
    await f.reconnect(60);
    const id = f.c.historyGaps[0]!.id;
    const old = f.c.fillGap(id);
    await held.entered.promise;
    await f.reconnect(0);
    expect(f.c.historyGaps[0]!.status).toBe("pending");
    f.unhold();
    await f.c.fillGap(id);
    expect(f.c.historyGaps[0]!.beforeId).toBe("A-65");
    held.release.release();
    await old;
    expect(f.c.historyGaps[0]!.beforeId).toBe("A-65");
    f.session("B");
    await f.h.publish();
    await eventually(() => f.c.view?.sessionId === "B");
    expect(f.c.historyGaps).toEqual([]);
    expect(f.c.older).toEqual([]);
  } finally {
    held.release.release();
    f.h.close();
  }
});

test("manual history failure retains the current range and retries only on request", async () => {
  let calls = 0;
  const fixture = fixtureBackend();
  const backend: ChatBackend = {
    ...fixture.backend,
    async read() {
      return {
        ...(await fixture.backend.read()),
        messages: [
          {
            id: "live",
            role: "user",
            text: "live",
            createdAt: 2,
            operationId: null,
            turnId: null,
          },
        ],
        before: "older",
      };
    },
    async history() {
      calls++;
      if (calls === 1) throw new Error("temporary history error");
      return {
        messages: [
          {
            id: "old",
            role: "user",
            text: "old",
            createdAt: 1,
            operationId: null,
            turnId: null,
          },
        ],
        before: null,
      };
    },
  };
  const h = await controllerHarness(backend);
  try {
    const c = await h.create();
    await c.loadOlder();
    expect(c.historySyncFailed).toBe(true);
    expect(c.before).toBe("older");
    expect(c.view?.messages[0]?.id).toBe("live");
    expect(calls).toBe(1);
    c.retryHistory();
    await eventually(() => c.before === null);
    expect(c.historySyncFailed).toBe(false);
    expect(c.older.map((message) => message.id)).toEqual(["old"]);
    expect(calls).toBe(2);
  } finally {
    h.close();
  }
});

test("old session page cannot clear a new session's in-flight pagination", async () => {
  const aEntered = gate(),
    aRelease = gate(),
    bEntered = gate(),
    bRelease = gate();
  let sessionId = "A";
  const fixture = fixtureBackend();
  const message = (id: string): ChatMessage => ({
    id,
    role: "user",
    text: id,
    createdAt: 1,
    operationId: null,
    turnId: null,
  });
  const backend: ChatBackend = {
    ...fixture.backend,
    async read() {
      return {
        ...(await fixture.backend.read()),
        sessionId,
        messages: [message(`${sessionId}-live`)],
        before: `${sessionId}-cursor`,
      };
    },
    async history(before) {
      if (before === "A-cursor") {
        aEntered.release();
        await aRelease.promise;
        return { messages: [message("A-old")], before: null };
      }
      bEntered.release();
      await bRelease.promise;
      return { messages: [message("B-old")], before: null };
    },
  };
  const h = await controllerHarness(backend);
  try {
    const c = await h.create();
    const oldPage = c.loadOlder();
    await aEntered.promise;
    sessionId = "B";
    await h.publish();
    await eventually(() => c.view?.sessionId === "B");
    const newPage = c.loadOlder();
    await bEntered.promise;
    aRelease.release();
    await oldPage;
    expect(c.loadingOlder).toBe(true);
    expect(c.older).toEqual([]);
    bRelease.release();
    await newPage;
    expect(c.loadingOlder).toBe(false);
    expect(c.older.map((message) => message.id)).toEqual(["B-old"]);
  } finally {
    aRelease.release();
    bRelease.release();
    h.close();
  }
});

test("local image previews survive failed-send retry and a lost retry receipt without resending", async () => {
  const { imagesFixture } = await import("./images-fixture.ts");
  const { fixtureImage } = await import("./panels-fixture.ts");
  const f = imagesFixture();
  let retries = 0;
  const backend: ChatBackend = {
    ...f.backend,
    async submit(input) {
      const result = await f.backend.submit(input);
      if (result.state === "submitted") {
        retries++;
        throw new Error("lost retry response");
      }
      return result;
    },
  };
  const h = await controllerHarness(backend);
  const descriptors = new Map(
    ["fetch", "document", "createImageBitmap"].map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (_: unknown, init: RequestInit) =>
      Response.json(await f.imageBackend.upload(JSON.parse(String(init.body)))),
  });
  Object.defineProperty(globalThis, "createImageBitmap", {
    configurable: true,
    value: async () => ({ width: 1, height: 1, close() {} }),
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      createElement: () => ({
        getContext: () => ({ drawImage() {} }),
        toBlob: (done: (blob: Blob) => void) =>
          done(
            new Blob([new Uint8Array([255, 216, 255, 217])], {
              type: "image/jpeg",
            }),
          ),
      }),
    },
  });
  try {
    const c = await h.create();
    await f.control({ action: "mode", state: "failed" });
    const drafts = ["first", "second"].map((id) => ({
      id,
      file: new File([fixtureImage], "same.png", { type: "image/png" }),
      previewUrl: `blob:${id}`,
    }));
    let released = 0;
    const sending = c.send("with images", () => released++, drafts);
    expect(c.pending[0]?.previews?.map((item) => item.previewUrl)).toEqual([
      "blob:first",
      "blob:second",
    ]);
    await sending;
    const source = c.pending[0]!.operationId;
    expect(c.pending[0]?.state).toBe("failed");
    const originalIds = c.localPreviews.map((item) => item.attachmentId);
    expect(originalIds).toHaveLength(2);
    await f.control({ action: "mode", state: "submitted" });
    await c.retryFailed(source);
    await eventually(
      () =>
        c.pending.length === 0 &&
        c.localPreviews.every((item) => item.operationId === source),
    );
    expect(retries).toBe(1);
    expect(c.localPreviews.map((item) => item.previewUrl)).toEqual([
      "blob:first",
      "blob:second",
    ]);
    expect(c.localPreviews.map((item) => item.attachmentId)).toEqual(
      originalIds,
    );
    expect(released).toBe(0);
    const attempt = c.localPreviews[0]!.operationId;
    expect(c.releasePreviews("wrong-session", attempt)).toBe(false);
    expect(c.releasePreviews("fixture-session", attempt)).toBe(true);
    expect(released).toBe(1);
  } finally {
    h.close();
    for (const [key, descriptor] of descriptors)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
  }
});

test("a history reply from a previous session cannot enter the new session", async () => {
  const message = (i: number): ChatMessage => ({
    id: `old-${i}`,
    role: "agent",
    text: `${i}`,
    createdAt: i,
    operationId: null,
    turnId: "turn",
  });
  const entered = gate(),
    release = gate();
  let sessionId = "fixture-session";
  const backend: ChatBackend = {
    ...fixtureBackend().backend,
    async read() {
      return {
        ...(await fixtureBackend().backend.read()),
        sessionId,
        messages:
          sessionId === "fixture-session"
            ? Array.from({ length: 30 }, (_, i) => message(i + 5))
            : [message(100)],
        before: sessionId === "fixture-session" ? "old-5" : null,
      };
    },
    async history() {
      entered.release();
      await release.promise;
      return {
        messages: Array.from({ length: 5 }, (_, i) => message(i)),
        before: null,
      };
    },
  };
  const h = await controllerHarness(backend);
  try {
    const c = await h.create();
    const oldPage = c.loadOlder();
    await entered.promise;
    sessionId = "new-session";
    await h.publish();
    await eventually(() => c.view?.sessionId === "new-session");
    release.release();
    await oldPage;
    expect(c.older).toEqual([]);
    expect(c.view?.messages.map((item) => item.id)).toEqual(["old-100"]);
    expect(c.before).toBeNull();
  } finally {
    release.release();
    h.close();
  }
});

test("reconnection releases stale history ownership without reviving its old page", async () => {
  const message = (id: string, text = id): ChatMessage => ({
    id,
    role: "agent",
    text,
    createdAt: 1,
    operationId: null,
    turnId: "turn",
  });
  const oldEntered = gate(),
    oldRelease = gate(),
    newEntered = gate(),
    newRelease = gate();
  let calls = 0;
  const backend: ChatBackend = {
    ...fixtureBackend().backend,
    async read() {
      return {
        ...(await fixtureBackend().backend.read()),
        messages: [message("live")],
        before: "live",
      };
    },
    async history() {
      if (++calls === 1) {
        oldEntered.release();
        await oldRelease.promise;
        return { messages: [message("old")], before: null };
      }
      newEntered.release();
      await newRelease.promise;
      return { messages: [message("new", "stale")], before: null };
    },
  };
  const h = await controllerHarness(backend);
  try {
    const c = await h.create();
    const oldPage = c.loadOlder();
    await oldEntered.promise;
    h.disconnect();
    await eventually(() => h.disconnections > 0);
    await eventually(() => c.connected);
    const newPage = c.loadOlder();
    await newEntered.promise;
    oldRelease.release();
    await oldPage;
    expect(c.loadingOlder).toBe(true);
    expect(c.older).toEqual([]);
    newRelease.release();
    await newPage;
    expect(c.loadingOlder).toBe(false);
    expect(c.older.map((item) => [item.id, item.text])).toEqual([
      ["new", "stale"],
    ]);
  } finally {
    oldRelease.release();
    newRelease.release();
    h.close();
  }
});

test("new session receives history while the old session read is still held", async () => {
  const message = (id: string): ChatMessage => ({
    id,
    role: "agent",
    text: id,
    createdAt: 1,
    operationId: null,
    turnId: "turn",
  });
  const entered = gate(),
    release = gate();
  let sessionId = "A";
  const backend: ChatBackend = {
    ...fixtureBackend().backend,
    async read() {
      return {
        ...(await fixtureBackend().backend.read()),
        sessionId,
        messages: [message(`${sessionId}-live`)],
        before: `${sessionId}-live`,
      };
    },
    async history(cursor) {
      if (cursor === "A-live") {
        entered.release();
        await release.promise;
        return { messages: [message("A-old")], before: null };
      }
      return { messages: [message("B-old")], before: null };
    },
  };
  const h = await controllerHarness(backend);
  try {
    const c = await h.create();
    const oldPage = c.loadOlder();
    await entered.promise;
    sessionId = "B";
    await h.publish();
    await eventually(() => c.view?.sessionId === "B");
    const newPage = c.loadOlder();
    await eventually(() => c.older.some((item) => item.id === "B-old"), 300);
    await newPage;
    expect(c.before).toBeNull();
    release.release();
    await oldPage;
    expect(c.older.map((item) => item.id)).toEqual(["B-old"]);
  } finally {
    release.release();
    h.close();
  }
});

test("returning to the same session does not accept its earlier history request", async () => {
  const message = (id: string): ChatMessage => ({
    id,
    role: "agent",
    text: id,
    createdAt: 1,
    operationId: null,
    turnId: "turn",
  });
  const entered = gate(),
    release = gate();
  let sessionId = "A";
  const backend: ChatBackend = {
    ...fixtureBackend().backend,
    async read() {
      return {
        ...(await fixtureBackend().backend.read()),
        sessionId,
        messages: [message(`${sessionId}-live`)],
        before: `${sessionId}-live`,
      };
    },
    async history() {
      entered.release();
      await release.promise;
      return { messages: [message("obsolete")], before: null };
    },
  };
  const h = await controllerHarness(backend);
  try {
    const c = await h.create();
    const oldPage = c.loadOlder();
    await entered.promise;
    sessionId = "B";
    await h.publish();
    await eventually(() => c.view?.sessionId === "B");
    sessionId = "A";
    await h.publish();
    await eventually(() => c.view?.sessionId === "A");
    release.release();
    await oldPage;
    expect(c.older).toEqual([]);
    expect(c.before).toBe("A-live");
    expect(c.loadingOlder).toBe(false);
  } finally {
    release.release();
    h.close();
  }
});

test("slow acknowledgement, publish ordering, null lookup, reload and reconnect never imply failure", async () => {
  const { fixtureBackend } = await import("./fixture.ts");
  const fixture = fixtureBackend();
  let hold = gate(),
    hide = true,
    mode = "slow",
    calls = 0,
    lookups = 0;
  const backend: ChatBackend = {
    ...fixture.backend,
    async read() {
      const view = await fixture.backend.read();
      return { ...view, messages: hide ? [] : view.messages };
    },
    async submit(input) {
      calls++;
      if (mode === "slow") await hold.promise;
      if (mode === "lost") throw new Error("lost reply");
      if (mode === "publish-first") {
        await fixture.backend.submit(input);
        await harness.publish();
        await hold.promise;
        throw new Error("late error");
      }
      return fixture.backend.submit(input);
    },
    async lookup(id) {
      lookups++;
      return fixture.backend.lookup(id);
    },
  };
  const harness = await controllerHarness(backend);
  try {
    let c = await harness.create();
    let retirements = 0;
    const sending = c.send("slow", () => { retirements++; });
    expect(c.pending[0]?.state).toBe("sending");
    await eventually(() => calls === 1);
    hold.release();
    await sending;
    expect(c.pending[0]?.state).toBe("sent");
    expect(retirements).toBe(0);
    hide = false;
    await harness.publish();
    await eventually(() => !c.pending.length);
    expect(retirements).toBe(1);
    hold = gate();
    mode = "publish-first";
    const publish = c.send("published", () => { retirements++; });
    await eventually(() =>
      c.view!.messages.some((m) => m.text === "published"),
    );
    expect(c.pending[0]?.state).toBe("sending");
    hold.release();
    await publish;
    await eventually(() => c.pending.length === 0);
    expect(retirements).toBe(2);
    mode = "lost";
    await c.send("pending null");
    await eventually(() => lookups > 0);
    expect(c.pending[0]?.state).toBe("sending");
    const id = c.pending[0]!.operationId;
    c.close();
    c = await harness.create();
    expect(c.pending[0]?.operationId).toBe(id);
    expect(c.pending[0]?.state).toBe("sending");
    const beforeDisconnect = harness.disconnections;
    harness.disconnect();
    await eventually(() => harness.disconnections > beforeDisconnect);
    await eventually(() => c.connected, 5000);
    expect(c.pending[0]?.state).toBe("sending");
    expect(calls).toBe(3); // Reconciliation never creates a new submission.
    await fixture.backend.submit({ operationId: id, text: "pending null" });
    await harness.publish();
    await eventually(() => !c.pending.length);
    expect(c.view!.messages.filter((m) => m.operationId === id)).toHaveLength(
      1,
    );
  } finally {
    hold.release();
    harness.close();
  }
});

test("definite failure is retried with the same message ID or discarded locally", async () => {
  const { submissionsFixture } = await import("./submissions-fixture.ts");
  const f = submissionsFixture();
  const h = await controllerHarness(f.backend);
  try {
    const c = await h.create();
    await f.control({ action: "mode", state: "failed" });
    await c.send("retry me");
    const id = c.pending[0]!.operationId;
    expect(c.pending[0]?.state).toBe("failed");
    await f.control({ action: "mode", state: "submitted" });
    await c.retryFailed(id);
    await eventually(() => c.view!.messages.some((m) => m.operationId === id));
    const state = await f.control({ action: "state" });
    expect(state.submissions).toHaveLength(1);
    expect(state.submissions[0]?.operationId).toBe(id);
    await f.control({ action: "mode", state: "failed" });
    await c.send("discard me");
    const failed = c.pending.find((p) => p.text === "discard me")!;
    expect(failed.state).toBe("failed");
    const calls = (await f.control({ action: "state" })).submitCalls;
    await c.deleteFailed(failed.operationId);
    expect(c.pending.some((p) => p.operationId === failed.operationId)).toBe(
      false,
    );
    expect((await f.control({ action: "state" })).submitCalls).toBe(calls);
  } finally {
    h.close();
  }
});

test("unknown sticker admission survives reopen and reconnect without automatic replay", async () => {
  const { imagesFixture } = await import("./images-fixture.ts");
  const { fixtureImage } = await import("./panels-fixture.ts");
  const { openChat } = await import("../packages/contracts/src/client.ts");
  const f = imagesFixture();
  const operationId = crypto.randomUUID();
  const sticker = { id: "cat", version: "a".repeat(64) };
  const encoded = btoa(String.fromCharCode(...fixtureImage));
  const staged = await f.stageSticker(
    {
      sessionId: "fixture-session",
      operationId,
      images: [
        {
          id: "cat",
          order: 0,
          name: "cat.png",
          mediaType: "image/png",
          original: encoded,
          preview: encoded,
          model: encoded,
        },
      ],
    },
    sticker,
  );
  const submission = { operationId, text: "", images: [staged.image] };
  let calls = 0,
    lookups = 0,
    hidden = true;
  const backend: ChatBackend = {
    ...f.backend,
    async read() {
      const view = await f.backend.read();
      return { ...view, messages: hidden ? [] : view.messages };
    },
    async submit(input) {
      calls++;
      await f.backend.submit(input);
      throw new Error("test-owned acknowledgement lost");
    },
    async lookup(id) {
      lookups++;
      return hidden ? null : f.backend.lookup(id);
    },
  };
  const saved = new Map<string, string>();
  const h = await controllerHarness(backend, saved);
  try {
    // The future picker is not implemented. Dispatch the real contract first,
    // then persist the exact immutable attempt as a future client would.
    const socket = new WebSocket(
      location.href.replace("http:", "ws:").replace(/\/$/, ""),
    );
    const client = await openChat(
      socket,
      () => {},
      () => {},
    );
    await expect(client.submit(submission)).rejects.toThrow();
    client.close();
    expect(calls).toBe(1);
    saved.set(
      "lamplit.pending:fixture-session",
      JSON.stringify([
        {
          ...submission,
          createdAt: Date.now(),
          state: "sending",
          dispatched: true,
        },
      ]),
    );
    let c = await h.create();
    await eventually(() => lookups > 0);
    expect(c.pending[0]?.images?.[0]?.sticker).toEqual(sticker);
    expect(c.pending[0]?.state).toBe("sending");
    c.close();
    c = await h.create();
    expect(c.pending[0]?.images?.[0]?.sticker).toEqual(sticker);
    const before = h.disconnections;
    h.disconnect();
    await eventually(() => h.disconnections > before);
    await eventually(() => c.connected, 5000);
    expect(c.pending[0]?.state).toBe("sending");
    expect(calls).toBe(1);
    hidden = false;
    await h.publish();
    await eventually(() => !c.pending.length);
    expect(
      c.view?.messages.find((message) => message.operationId === operationId)
        ?.images?.[0]?.sticker,
    ).toEqual(sticker);
    expect(calls).toBe(1);
  } finally {
    h.close();
  }
});

test("a delayed lookup from the prior attempt cannot fail an explicit retry", async () => {
  const id = crypto.randomUUID();
  const oldLookup = gate(),
    retryResult = gate();
  const saved = new Map<string, string>();
  const controller = new ChatController(() => {}, {
    getItem: (key) => saved.get(key) ?? null,
    setItem: (key, value) => {
      saved.set(key, value);
    },
  });
  const c = controller as any;
  const failed = {
    operationId: id,
    attempt: 1,
    state: "failed",
    messageId: null,
    turnId: null,
    error: "failed",
  };
  let submissions = 0;
  c.view = { sessionId: "fixture-session", messages: [] };
  c.storageKey = "lamplit.pending:fixture-session";
  c.pending = [
    {
      operationId: id,
      text: "retry",
      state: "sending",
      dispatched: true,
      createdAt: 1,
    },
  ];
  c.client = {
    close() {},
    async lookup() {
      await oldLookup.promise;
      return failed;
    },
    async submit(input: { operationId: string }) {
      submissions++;
      expect(input.operationId).toBe(id);
      await retryResult.promise;
      return { ...failed, attempt: 2, state: "submitted", error: null };
    },
  };
  try {
    const lookup = c.reconcile();
    c.applyReceipt(failed);
    const retry = controller.retryFailed(id);
    expect(controller.pending[0]?.state).toBe("sending");
    oldLookup.release();
    await lookup;
    expect(controller.pending[0]?.state).toBe("sending");
    retryResult.release();
    await retry;
    expect(controller.pending[0]?.state).toBe("sent");
    expect(submissions).toBe(1);
  } finally {
    oldLookup.release();
    retryResult.release();
    controller.close();
  }
});

test("a locally failed text message remains retryable after reload", async () => {
  const fixture = fixtureBackend();
  const id = crypto.randomUUID();
  const saved = new Map([["lamplit.pending:fixture-session", JSON.stringify([{
    operationId: id, text: "not dispatched", state: "failed", dispatched: false,
    createdAt: 1, deliveryVersion: 2,
  }])]]);
  const h = await controllerHarness(fixture.backend, saved);
  try {
    const c = await h.create();
    expect(c.pending[0]?.state).toBe("failed");
    await c.retryFailed(id);
    await eventually(() => c.view?.messages.some(message => message.operationId === id) ?? false);
    expect(fixture.executions).toBe(1);
  } finally { h.close(); }
});

test("a file retry retains its logical message identity after reload", () => {
  const logicalId = crypto.randomUUID(), operationId = crypto.randomUUID();
  const files = [{ attachmentId: "file-ref", name: "file.txt", mediaType: "text/plain", size: 4, availability: "available" }];
  const saved = new Map([["lamplit.pending:fixture-session", JSON.stringify([{
    operationId, logicalId, text: "file", state: "sending", dispatched: true,
    files, createdAt: 1, deliveryVersion: 2,
  }])]]);
  const controller = new ChatController(() => {}, {
    getItem: (key) => saved.get(key) ?? null,
    setItem: (key, value) => { saved.set(key, value); },
  });
  try {
    (controller as any).hydrate("fixture-session");
    expect(controller.pending[0]).toMatchObject({ operationId, logicalId, files, state: "sending" });
  } finally { controller.close(); }
});

test("an uncertain retry can be removed locally without replay or hiding later history", async () => {
  const fixture = fixtureBackend();
  const pendingRetry = gate();
  let calls = 0;
  const backend: ChatBackend = {
    ...fixture.backend,
    async submit() { calls++; if (calls === 2) await pendingRetry.promise; throw new Error("response lost"); },
    async lookup() { return null; },
  };
  const h = await controllerHarness(backend);
  try {
    const c = await h.create();
    await c.send("uncertain retry");
    const id = c.pending[0]!.operationId;
    h.deliver({ operationId: id, attempt: 1, state: "failed", messageId: null, turnId: null, error: "failed" });
    await eventually(() => c.pending[0]?.state === "failed");
    const retry = c.retryFailed(id);
    await eventually(() => calls === 2);
    expect(c.canDiscardPending(id)).toBe(false);
    c.discardPending(id);
    expect(c.pending).toHaveLength(1);
    pendingRetry.release();
    await retry;
    expect(c.pending[0]?.state).toBe("sending");
    expect(c.canDiscardPending(id)).toBe(true);
    c.discardPending(id);
    expect(c.pending).toHaveLength(0);
    h.deliver({ operationId: id, attempt: 2, state: "submitted", messageId: id, turnId: null, error: null });
    expect(c.pending).toHaveLength(0);
    expect(calls).toBe(2);
    await fixture.backend.submit({ operationId: id, text: "uncertain retry" });
    await h.publish();
    await eventually(() => c.view?.messages.some(message => message.operationId === id) ?? false);
    expect(calls).toBe(2);
  } finally { pendingRetry.release(); h.close(); }
});

test("pushed delivery results settle without a view change and ignore an older retry", async () => {
  const fixture = fixtureBackend();
  const retry = gate();
  let calls = 0;
  const backend: ChatBackend = {
    ...fixture.backend,
    async submit(input) {
      calls++;
      if (calls === 1) throw new Error("response lost");
      await retry.promise;
      return { operationId: input.operationId, attempt: 2, state: "failed", messageId: null, turnId: null, error: "second failure" };
    },
    async lookup() { return null; },
  };
  const h = await controllerHarness(backend);
  try {
    const c = await h.create();
    await c.send("message");
    const id = c.pending[0]!.operationId;
    const first: Receipt = { operationId: id, attempt: 1, state: "failed", messageId: null, turnId: null, error: "first failure" };
    const nextResult = (controller: ChatController, attempt: number) => new Promise<void>((resolve) => {
      const socket: WebSocket = (controller as any).socket;
      const onMessage = (event: MessageEvent) => {
        const frame = JSON.parse(String(event.data));
        if (frame.type !== "deliveryResult" || frame.receipt.operationId !== id || frame.receipt.attempt !== attempt) return;
        socket.removeEventListener("message", onMessage);
        resolve();
      };
      socket.addEventListener("message", onMessage);
    });
    h.deliver(first);
    await eventually(() => c.pending[0]?.state === "failed");
    const pendingRetry = c.retryFailed(id);
    await eventually(() => calls === 2);
    const oldResult = nextResult(c, 1);
    h.deliver(first);
    await oldResult;
    expect(c.pending[0]?.state).toBe("sending");
    c.close();
    const reopened = await h.create();
    expect(reopened.pending[0]?.retryAfter).toBe(1);
    const oldAfterReload = nextResult(reopened, 1);
    h.deliver(first);
    await oldAfterReload;
    expect(reopened.pending[0]?.state).toBe("sending");
    h.deliver({ ...first, attempt: 2, error: "second failure" });
    await eventually(() => reopened.pending[0]?.state === "failed");
    const oldAfterFailure = nextResult(reopened, 1);
    h.deliver(first);
    await oldAfterFailure;
    expect(reopened.pending[0]?.attempt).toBe(2);
    expect(reopened.pending[0]?.state).toBe("failed");
    retry.release();
    await pendingRetry;
    expect(calls).toBe(2);
  } finally {
    retry.release();
    h.close();
  }
});

test("a definite pushed failure permits retry before the old submit response arrives", async () => {
  const fixture = fixtureBackend();
  const firstResponse = gate();
  let calls = 0;
  const backend: ChatBackend = {
    ...fixture.backend,
    async submit(input) {
      calls++;
      if (calls === 1) {
        await firstResponse.promise;
        return { operationId: input.operationId, attempt: 1, state: "failed", messageId: null, turnId: null, error: "failed" };
      }
      return { operationId: input.operationId, attempt: 2, state: "submitted", messageId: null, turnId: null, error: null };
    },
    async lookup() { return null; },
  };
  const h = await controllerHarness(backend);
  try {
    const c = await h.create();
    const sending = c.send("message");
    await eventually(() => calls === 1);
    const id = c.pending[0]!.operationId;
    h.deliver({ operationId: id, attempt: 1, state: "failed", messageId: null, turnId: null, error: "failed" });
    await eventually(() => c.pending[0]?.state === "failed");
    const retrying = c.retryFailed(id);
    expect(c.pending[0]?.state).toBe("sending");
    firstResponse.release();
    await Promise.all([sending, retrying]);
    expect(calls).toBe(2);
    expect(c.pending[0]?.state).toBe("sent");
    expect(c.pending[0]?.attempt).toBe(2);
  } finally {
    firstResponse.release();
    h.close();
  }
});
