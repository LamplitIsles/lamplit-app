import { expect, test } from "bun:test";
import {
  validate,
  ContextUsageSchema,
  CompactionSchema,
  CompactInputSchema,
  CompactResultSchema,
  validateSubmission,
} from "../packages/contracts/src/index.ts";
import { createChatHost } from "../packages/contracts/src/server.ts";
import { compactFixture } from "./compact-fixture.ts";
import { ChatController } from "../apps/web/src/lib/chat-controller.ts";
import { eventually } from "./chat.test.ts";

test("strict nullable native context and compact ownership payloads", () => {
  for (const tokens of [null, 0, 42, Number.MAX_SAFE_INTEGER])
    expect(
      validate(ContextUsageSchema, { tokens, capacity: 100000 }).tokens,
    ).toBe(tokens);
  expect(
    validate(ContextUsageSchema, { tokens: null, capacity: null }),
  ).toEqual({ tokens: null, capacity: null });
  for (const tokens of [-1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "1"])
    expect(() =>
      validate(ContextUsageSchema, { tokens, capacity: 100000 }),
    ).toThrow();
  for (const capacity of [0, -1, NaN, Infinity, "1"])
    expect(() =>
      validate(ContextUsageSchema, { tokens: 0, capacity }),
    ).toThrow();
  expect(() =>
    validate(ContextUsageSchema, { tokens: 0, capacity: 1, cost: 1 }),
  ).toThrow();
  expect(() => validate(CompactInputSchema, { sessionId: "" })).toThrow();
  expect(() =>
    validate(CompactInputSchema, { sessionId: "owned", focus: "custom" }),
  ).toThrow();
  expect(() =>
    validate(CompactResultSchema, { sessionId: "owned", accepted: 1 }),
  ).toThrow();
  expect(
    validate(CompactionSchema, { id: null, status: "running" })?.status,
  ).toBe("running");
  expect(() =>
    validate(CompactionSchema, { id: "c", status: "done" }),
  ).toThrow();
  expect(() =>
    validateSubmission({ operationId: crypto.randomUUID(), text: "/compact" }),
  ).toThrow();
  expect(
    validateSubmission({
      operationId: crypto.randomUUID(),
      text: "/compact extra",
    }).text,
  ).toBe("/compact extra");
}, 15000);

test("native compact over Chord: ownership, single admission, completion, stale callbacks and no replay", async () => {
  const fixture = compactFixture();
  let coalescedFreshUsage = false;
  const backend = {
    ...fixture.backend,
    async read() {
      const view = await fixture.backend.read();
      // Native refresh can coalesce completion/invalidation and fresh usage.
      return coalescedFreshUsage && view.compaction?.status === "complete"
        ? { ...view, contextUsage: { tokens: 12000, capacity: 100000 } }
        : view;
    },
  };
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
    value: { href: `http://127.0.0.1:${server.port}/slice/` },
  });
  const storage = new Map<string, string>();
  const controller = new ChatController(() => {}, {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => {
      storage.set(key, value);
    },
  });
  try {
    controller.start();
    await eventually(() => controller.connected);
    // Public host checks owner before invoking the native engine.
    const { openChat } = await import("../packages/contracts/src/client.ts");
    const client = await openChat(
      new WebSocket(`ws://127.0.0.1:${server.port}`),
      () => {},
      () => {},
    );
    try {
      await expect(
        client.compact({ sessionId: "another-owner" }),
      ).rejects.toThrow();
    } finally {
      client.close();
    }

    expect((await fixture.control({ action: "state" })).calls).toBe(0);
    await fixture.control({ action: "busy", enabled: true });
    await host.refresh();
    await eventually(() => controller.view?.activeTurnId === "native-busy");
    await expect(controller.send("/compact")).rejects.toThrow();
    await fixture.control({ action: "busy", enabled: false });
    await host.refresh();
    await eventually(() => !controller.view?.activeTurnId);
    await fixture.control({ action: "refuse", enabled: true });
    await expect(controller.send("/compact")).rejects.toThrow();
    expect(controller.pending).toEqual([]);
    await fixture.control({ action: "refuse", enabled: false });
    await fixture.control({ action: "usage", tokens: 80000, capacity: 100000 });
    await host.refresh();

    await controller.send("/compact");
    await eventually(() => controller.view?.compaction?.status === "running");
    await expect(controller.compact()).rejects.toThrow();
    expect((await fixture.control({ action: "state" })).executions).toBe(1);
    expect((await fixture.control({ action: "state" })).submissions).toEqual(
      [],
    );
    await fixture.control({ action: "finish" });
    await host.refresh();
    await eventually(() => controller.view?.compaction?.status === "complete");
    expect(controller.view!.contextUsage).toEqual({
      tokens: null,
      capacity: 100000,
    });
    await fixture.control({ action: "usage", tokens: 10000, capacity: 100000 });
    await host.refresh();
    await eventually(() => controller.view?.contextUsage.tokens === 10000);

    await fixture.control({ action: "usage", tokens: 80000, capacity: 100000 });
    await fixture.control({ action: "auto" });
    await host.refresh();
    await eventually(() => controller.view?.compaction?.status === "running");
    expect(controller.view!.contextUsage.tokens).toBe(80000);
    coalescedFreshUsage = true;
    await fixture.control({ action: "finish" });
    await host.refresh();
    await eventually(() => controller.view?.compaction?.status === "complete");
    // No later event, usage update or reload may be needed to show fresh tokens.
    expect(controller.view!.contextUsage).toEqual({
      tokens: 12000,
      capacity: 100000,
    });
    const initialUsage: { tokens: number | null } = { tokens: null };
    const initial = await openChat(
      new WebSocket(`ws://127.0.0.1:${server.port}`),
      (view) => {
        initialUsage.tokens = view.contextUsage.tokens;
      },
      () => {},
    );
    try {
      expect(initialUsage.tokens).toBe(12000);
    } finally {
      initial.close();
    }
    coalescedFreshUsage = false;

    await fixture.control({ action: "hold", enabled: true });
    const pending = controller.compact().then(
      () => "accepted",
      () => "stale",
    );
    await eventually(() => controller.view?.compaction?.status === "running");
    await fixture.control({ action: "session", sessionId: "next" });
    await host.refresh();
    await eventually(() => controller.view?.sessionId === "next");
    await fixture.control({ action: "release" });
    expect(await pending).toBe("stale");
    expect(controller.compactPending).toBe(false);

    await fixture.control({ action: "hold", enabled: true });
    const lost = controller.compact().catch(() => {});
    await eventually(() => controller.view?.compaction?.status === "running");
    const calls = (await fixture.control({ action: "state" })).calls;

    for (const channel of channels.values()) channel.disconnect();
    await lost;
    await fixture.control({ action: "release" });
    await fixture.control({ action: "finish" });
    await eventually(
      () =>
        controller.connected &&
        controller.view?.compaction?.status === "complete",
    );
    expect((await fixture.control({ action: "state" })).calls).toBe(calls);
    expect(controller.pending).toEqual([]);
  } finally {
    await fixture.control({ action: "release" });
    controller.close();
    host.close();
    for (const ws of channels.keys()) (ws as { terminate(): void }).terminate();
    server.unref();
    void server.stop(true);
    if (previous) Object.defineProperty(globalThis, "location", previous);
    else Reflect.deleteProperty(globalThis, "location");
  }
}, 15000);
