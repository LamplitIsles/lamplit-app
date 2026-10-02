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

test("moving live window retains history/unconsumed sends and rejects previous-session panel reads", async () => {
  const message = (id: number): ChatMessage => ({
    id: String(id),
    role: "user",
    text: `message ${id}`,
    createdAt: id,
    operationId: null,
    turnId: null,
  });
  let live = Array.from({ length: 30 }, (_, i) => message(i + 11));
  let sessionId = "history-fixture";
  let active: string | null = null;
  let stopped = false;
  const panels = panelsFixture();
  const backend: ChatBackend = {
    ...panels.backend,
    async read() {
      return {
        version: 1,
        sessionId,
        name: "Fixture",
        activeTurnId: active,
        messages: live,
        before: "11",
        capabilities,
        recovery: [],
      };
    },
    async history() {
      return {
        messages: Array.from({ length: 10 }, (_, i) => message(i + 1)),
        before: null,
      };
    },
    async submit(input) {
      active = "queued-turn";
      return {
        operationId: input.operationId,
        state: "accepted",
        messageId: null,
        turnId: "stopped",
        error: null,
      };
    },
    async lookup(id) {
      return {
        operationId: id,
        state: stopped ? "unconsumed" : "accepted",
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
  const saved = new Map<string, string>();
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
    await controller.loadOlder();
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
    expect(controller.pending[0]?.state).toBe("accepted");
    await eventually(() => controller.view?.activeTurnId === "queued-turn");
    await controller.stop();
    await eventually(() => controller.pending[0]?.state === "unconsumed");
    expect(controller.pending[0]?.state).toBe("unconsumed");
    expect(
      JSON.parse(saved.get("lamplit.pending:history-fixture")!)[0].state,
    ).toBe("unconsumed");
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
