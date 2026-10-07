import { searchFixture } from "./search-fixture.ts";
import { panelsFixture } from "./panels-fixture.ts";
import { expect, test } from "bun:test";
import { ChatController } from "../apps/web/src/lib/chat-controller.ts";
import {
  capabilities,
  type ChatMessage,
} from "../packages/contracts/src/index.ts";
import {
  createChatHost,
  type ChatBackend,
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
  let active: string | null = null;
  let stopped = false;
  const panels = panelsFixture();
  const search = searchFixture();
  const backend: ChatBackend = {
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
        recovery: [
          {
            sourceId: historicalOperation,
            operationId: historicalOperation,
            text: "message 1",
            images: [],
            replacementEligible: false,
          },
        ],
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
      return {
        operationId: input.operationId,
        state: "submitted",
        messageId: null,
        turnId: "stopped",
        error: null,
      };
    },
    async lookup(id) {
      return {
        operationId: id,
        state: "submitted",
        messageId: null,
        turnId: null,
        error: null,
      };
    },
    async stop() {
      active = null;
      stopped = true;
      return { stopped: true };
    },
    subscribe() {
      return () => {};
    },
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
    expect(controller.recovery).toHaveLength(1);
    expect(controller.pending).toHaveLength(1);
    await controller.loadOlder();
    expect(controller.pending).toEqual([]);
    expect(controller.recovery).toHaveLength(1);
    expect(controller.before).toBeNull();
    live = Array.from({ length: 30 }, (_, i) => message(i + 12));
    await host.refresh();
    await eventually(() => controller.view?.messages.at(-1)?.id === "41");
    expect(
      [...controller.older, ...controller.view!.messages].map((m) => m.id),
    ).toEqual(Array.from({ length: 41 }, (_, i) => String(i + 1)));
    expect(controller.before).toBeNull();
    await host.refresh();
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
  const host = await createChatHost(backend, () => {});
  const channels = new Map<object, ReturnType<typeof host.connect>>();
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
  const create = async () => {
    const c = new ChatController(() => {}, storage);
    controllers.push(c);
    c.start();
    await eventually(() => c.connected);
    return c;
  };
  return {
    host,
    saved,
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
        await harness.host.refresh();
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
    const retirements: string[] = [];
    const sending = c.send("slow", (r) => retirements.push(r.reason));
    expect(c.pending[0]?.state).toBe("sending");
    expect(c.recovery).toEqual([]);
    await eventually(() => calls === 1);
    hold.release();
    await sending;
    expect(c.pending[0]?.state).toBe("sent");
    expect(retirements).toEqual([]);
    hide = false;
    await harness.host.refresh();
    await eventually(() => !c.pending.length);
    expect(retirements).toEqual(["observed"]);
    hold = gate();
    mode = "publish-first";
    const publish = c.send("published", (r) => retirements.push(r.reason));
    await eventually(() =>
      c.view!.messages.some((m) => m.text === "published"),
    );
    expect(c.pending).toEqual([]);
    hold.release();
    await publish;
    expect(retirements).toEqual(["observed", "observed"]);
    mode = "lost";
    await c.send("pending null");
    await eventually(() => lookups > 0);
    expect(c.pending[0]?.state).toBe("sending");
    expect(c.recovery).toEqual([]);
    const id = c.pending[0]!.operationId;
    c.close();
    c = await harness.create();
    expect(c.pending[0]?.operationId).toBe(id);
    expect(c.pending[0]?.state).toBe("sending");
    harness.disconnect();
    await eventually(() => !c.connected);
    expect(c.recovery).toEqual([]);
    await eventually(() => c.connected, 5000);
    expect(c.pending[0]?.state).toBe("sending");
    expect(calls).toBe(3); // Reconciliation never creates a new submission.
    await fixture.backend.submit({ operationId: id, text: "pending null" });
    await harness.host.refresh();
    await eventually(() => !c.pending.length);
    expect(c.view!.messages.filter((m) => m.operationId === id)).toHaveLength(
      1,
    );
  } finally {
    hold.release();
    harness.close();
  }
});

test("definite rejection restores once; reply failure/stop stay sent; withdrawal alone offers recovery", async () => {
  const { imagesFixture } = await import("./images-fixture.ts");
  const f = imagesFixture();
  const harness = await controllerHarness(f.backend);
  try {
    const c = await harness.create();
    const reasons: string[] = [];
    await f.control({ action: "mode", state: "failed" });
    await c.send("rejected", (r) => reasons.push(r.reason));
    expect(reasons).toEqual(["failed"]);
    expect(c.pending).toEqual([]);
    expect(c.recovery[0]?.text).toBe("rejected");
    await f.control({ action: "consume" });
    await f.control({ action: "mode", state: "submitted" });
    await c.send("submitted");
    await eventually(() =>
      c.view!.messages.some((m) => m.text === "submitted"),
    );
    await c.stop();
    expect(c.recovery).toEqual([]);
    expect(c.pending).toEqual([]);
    await f.control({ action: "mode", state: "withdrawn" });
    await c.send("withdrawn");
    await eventually(() => c.recovery.some((r) => r.text === "withdrawn"));
    expect(c.view!.messages.filter((m) => m.text === "withdrawn")).toHaveLength(
      1,
    );
    expect(
      c.recovery.find((r) => r.text === "withdrawn")?.replacementEligible,
    ).toBe(true);
    c.dismissRecovery(c.recovery[0]!.sourceId);
    expect(c.recovery).toEqual([]);
  } finally {
    harness.close();
  }
});

test("persisted local inputs normalize once without losing text, image references or identity", async () => {
  const { fixtureBackend } = await import("./fixture.ts");
  const f = fixtureBackend();
  const id = crypto.randomUUID();
  const image = {
    attachmentId: "saved-photo",
    name: "photo.png",
    mediaType: "image/png",
    availability: "available",
  };
  const saved = new Map([
    [
      "lamplit.pending:fixture-session",
      JSON.stringify([
        {
          operationId: id,
          text: "preserved",
          images: [image],
          createdAt: 1,
          state: "uncertain",
        },
      ]),
    ],
  ]);
  const h = await controllerHarness(f.backend, saved);
  try {
    const c = await h.create();
    expect(c.pending[0]).toMatchObject({
      operationId: id,
      text: "preserved",
      images: [image],
      state: "sending",
    });
    expect(c.recovery).toEqual([]);
    expect(
      JSON.parse(saved.get("lamplit.pending:fixture-session")!)[0].state,
    ).toBe("sending");
  } finally {
    h.close();
  }
});
