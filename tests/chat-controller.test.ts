import { fixtureBackend } from "./fixture.ts";
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

test("history updates preserve image position and discover insertions beyond multiple consumed pages", async () => {
  const message = (i: number): ChatMessage => ({
    id: `m${i}`,
    role: "agent",
    text: `message ${i}`,
    createdAt: i,
    operationId: null,
    turnId: "turn",
  });
  let all = Array.from({ length: 96 }, (_, i) => message(i));
  all[4] = { ...all[4]!, text: "", imageState: "preparing" };
  let notify: (
    update?: import("../packages/contracts/src/index.ts").TimelineUpdate,
  ) => void = () => {};
  const backend: ChatBackend = {
    ...fixtureBackend().backend,
    async read() {
      return {
        ...(await fixtureBackend().backend.read()),
        messages: all.slice(-30),
        before: all.length > 30 ? all.at(-30)!.id : null,
      };
    },
    async history(before) {
      const end = all.findIndex((message) => message.id === before);
      if (end < 0) throw new Error("unknown cursor");
      const start = Math.max(0, end - 30);
      return {
        messages: all.slice(start, end),
        before: start ? all[start]!.id : null,
      };
    },
    subscribe(changed) {
      notify = changed;
      return () => {};
    },
  };
  const h = await controllerHarness(backend);
  try {
    const c = await h.create();
    while (c.before) await c.loadOlder();
    expect(c.older.find((m) => m.id === "m4")?.imageState).toBe("preparing");
    all[4] = {
      ...all[4]!,
      imageState: "ready",
      images: [
        {
          attachmentId: "photo",
          name: "photo.png",
          mediaType: "image/png",
          availability: "available",
        },
      ],
    };
    notify({
      sessionId: "fixture-session",
      change: { type: "item", message: all[4]! },
    });
    await eventually(
      () => c.older.find((m) => m.id === "m4")?.imageState === "ready",
    );
    const inserted = { ...message(1000), id: "inserted" };
    all = [inserted, ...all];
    notify({ sessionId: "fixture-session", change: { type: "structure" } });
    await eventually(() => c.older.some((m) => m.id === "inserted"));
    expect([...c.older, ...c.view!.messages].map((m) => m.id)).toEqual(
      all.map((m) => m.id),
    );
    expect(c.before).toBeNull();
  } finally {
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
    async retryFailed(input) {
      retries++;
      await f.backend.retryFailed(input);
      throw new Error("lost retry response");
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
        c.localPreviews.every((item) => item.operationId !== source),
    );
    expect(retries).toBe(1);
    expect(c.localPreviews.map((item) => item.previewUrl)).toEqual([
      "blob:first",
      "blob:second",
    ]);
    expect(c.localPreviews.map((item) => item.attachmentId)).not.toEqual(
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

test("changes during history reads and while disconnected are reconciled without losing the loaded range", async () => {
  const message = (i: number): ChatMessage => ({
    id: `m${i}`,
    role: "agent",
    text: `message ${i}`,
    createdAt: i,
    operationId: null,
    turnId: "turn",
  });
  let all = Array.from({ length: 65 }, (_, i) => message(i));
  let notify: (
    update?: import("../packages/contracts/src/index.ts").TimelineUpdate,
  ) => void = () => {};
  let hold = false,
    entered = gate(),
    release = gate();
  const backend: ChatBackend = {
    ...fixtureBackend().backend,
    async read() {
      return {
        ...(await fixtureBackend().backend.read()),
        messages: all.slice(-30),
        before: all.at(-30)!.id,
      };
    },
    async history(before) {
      const snapshot = [...all];
      const end = snapshot.findIndex((item) => item.id === before),
        start = Math.max(0, end - 30);
      if (end < 0) throw new Error("unknown cursor");
      if (hold) {
        hold = false;
        entered.release();
        await release.promise;
      }
      return {
        messages: snapshot.slice(start, end),
        before: start ? snapshot[start]!.id : null,
      };
    },
    subscribe(changed) {
      notify = changed;
      return () => {};
    },
  };
  const h = await controllerHarness(backend);
  try {
    const c = await h.create();
    while (c.before) await c.loadOlder();
    hold = true;
    notify({ sessionId: "fixture-session", change: { type: "structure" } });
    await entered.promise;
    all[0] = { ...all[0]!, text: "changed during history" };
    notify({
      sessionId: "fixture-session",
      change: { type: "item", message: all[0]! },
    });
    await eventually(
      () =>
        c.older.find((item) => item.id === "m0")?.text ===
        "changed during history",
    );
    release.release();
    await c.loadOlder();
    await eventually(
      () =>
        c.older.find((item) => item.id === "m0")?.text ===
        "changed during history",
    );
    h.disconnect();
    all = [{ ...message(1000), id: "offline-insertion" }, ...all];
    await eventually(() => h.disconnections > 0);
    await eventually(() => c.connected);
    await eventually(() =>
      c.older.some((item) => item.id === "offline-insertion"),
    );
    expect([...c.older, ...c.view!.messages].map((item) => item.id)).toEqual(
      all.map((item) => item.id),
    );
    expect(c.before).toBeNull();
  } finally {
    release.release();
    h.close();
  }
});

test("completion supersedes a buffered streaming item while later item updates survive history reconciliation", async () => {
  const message = (i: number): ChatMessage => ({
    id: `m${i}`,
    role: "agent",
    text: `text ${i}`,
    createdAt: i,
    operationId: null,
    turnId: "turn",
    textState: "complete",
  });
  const all = Array.from({ length: 65 }, (_, i) => message(i));
  let notify: (
    update?: import("../packages/contracts/src/index.ts").TimelineUpdate,
  ) => void = () => {};
  const entered = gate(),
    release = gate();
  let hold = false,
    reads = 0;
  const backend: ChatBackend = {
    ...fixtureBackend().backend,
    async read() {
      return {
        ...(await fixtureBackend().backend.read()),
        messages: all.slice(-30),
        before: "m35",
      };
    },
    async history(before) {
      reads++;
      const snapshot = [...all],
        end = snapshot.findIndex((item) => item.id === before),
        start = Math.max(0, end - 30);
      if (end < 0) throw new Error("unknown cursor");
      if (hold) {
        hold = false;
        entered.release();
        await release.promise;
      }
      return {
        messages: snapshot.slice(start, end),
        before: start ? snapshot[start]!.id : null,
      };
    },
    subscribe(changed) {
      notify = changed;
      return () => {};
    },
  };
  const h = await controllerHarness(backend);
  try {
    const c = await h.create();
    while (c.before) await c.loadOlder();
    const baseline = reads;
    hold = true;
    notify({ sessionId: "fixture-session", change: { type: "structure" } });
    await entered.promise;
    notify({
      sessionId: "fixture-session",
      change: {
        type: "item",
        message: { ...all[0]!, text: "partial", textState: "streaming" },
      },
    });
    await eventually(
      () => c.older.find((item) => item.id === "m0")?.text === "partial",
    );
    all[0] = { ...all[0]!, text: "completed full text", textState: "complete" };
    notify({ sessionId: "fixture-session", change: { type: "structure" } });
    await Bun.sleep(30);
    notify({
      sessionId: "fixture-session",
      change: {
        type: "item",
        message: {
          ...all[1]!,
          text: "later streaming",
          textState: "streaming",
        },
      },
    });
    await eventually(
      () =>
        c.older.find((item) => item.id === "m1")?.text === "later streaming",
    );
    release.release();
    await c.loadOlder();
    expect(reads).toBeGreaterThan(baseline + 2);
    expect(c.older.find((item) => item.id === "m0")).toMatchObject({
      text: "completed full text",
      textState: "complete",
    });
    expect(c.older.find((item) => item.id === "m1")).toMatchObject({
      text: "later streaming",
      textState: "streaming",
    });
    expect([...c.older, ...c.view!.messages]).toHaveLength(65);
  } finally {
    release.release();
    h.close();
  }
});

test("a failed history reconciliation preserves existing messages and can be retried", async () => {
  const message = (i: number): ChatMessage => ({
    id: `m${i}`,
    role: "agent",
    text: `${i}`,
    createdAt: i,
    operationId: null,
    turnId: "turn",
  });
  let all = Array.from({ length: 35 }, (_, i) => message(i)),
    fail = false;
  let notify: (
    update?: import("../packages/contracts/src/index.ts").TimelineUpdate,
  ) => void = () => {};
  const backend: ChatBackend = {
    ...fixtureBackend().backend,
    async read() {
      return {
        ...(await fixtureBackend().backend.read()),
        messages: all.slice(-30),
        before: all.at(-30)!.id,
      };
    },
    async history(before) {
      if (fail) throw new Error("unavailable");
      const end = all.findIndex((item) => item.id === before),
        start = Math.max(0, end - 30);
      return {
        messages: all.slice(start, end),
        before: start ? all[start]!.id : null,
      };
    },
    subscribe(changed) {
      notify = changed;
      return () => {};
    },
  };
  const h = await controllerHarness(backend);
  try {
    const c = await h.create();
    await c.loadOlder();
    const original = [...c.older, ...c.view!.messages].map((item) => item.id);
    all = [{ ...message(100), id: "inserted" }, ...all];
    fail = true;
    notify({ sessionId: "fixture-session", change: { type: "structure" } });
    await eventually(() => c.historySyncFailed);
    expect([...c.older, ...c.view!.messages].map((item) => item.id)).toEqual(
      original,
    );
    fail = false;
    c.retryHistory();
    await eventually(
      () =>
        !c.historySyncFailed && c.older.some((item) => item.id === "inserted"),
    );
    expect([...c.older, ...c.view!.messages].map((item) => item.id)).toEqual(
      all.map((item) => item.id),
    );
  } finally {
    h.close();
  }
});

test("an item changed during the first manual history page replaces the stale page result", async () => {
  const message = (i: number): ChatMessage => ({
    id: `m${i}`,
    role: "agent",
    text: `${i}`,
    createdAt: i,
    operationId: null,
    turnId: "turn",
  });
  const all = Array.from({ length: 35 }, (_, i) => message(i));
  const entered = gate(),
    release = gate();
  let notify: (
    update?: import("../packages/contracts/src/index.ts").TimelineUpdate,
  ) => void = () => {};
  const backend: ChatBackend = {
    ...fixtureBackend().backend,
    async read() {
      return {
        ...(await fixtureBackend().backend.read()),
        messages: all.slice(-30),
        before: "m5",
      };
    },
    async history() {
      const snapshot = all.slice(0, 5);
      entered.release();
      await release.promise;
      return { messages: snapshot, before: null };
    },
    subscribe(changed) {
      notify = changed;
      return () => {};
    },
  };
  const h = await controllerHarness(backend);
  try {
    const c = await h.create();
    const loading = c.loadOlder();
    await entered.promise;
    all[0] = { ...all[0]!, text: "new value" };
    notify({
      sessionId: "fixture-session",
      change: { type: "item", message: all[0]! },
    });
    await Bun.sleep(20);
    release.release();
    await loading;
    expect(c.older.find((item) => item.id === "m0")?.text).toBe("new value");
  } finally {
    release.release();
    h.close();
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
    await h.host.refresh();
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

for (const mode of ["reconciliation", "manual page"] as const) {
  test(`session switch lets new history proceed while old ${mode} is pending`, async () => {
    const message = (id: string, text = id): ChatMessage => ({
      id,
      role: "agent",
      text,
      createdAt: 1,
      operationId: null,
      turnId: "turn",
    });
    const aEntered = gate(),
      aRelease = gate(),
      bEntered = gate(),
      bRelease = gate();
    let sessionId = "A",
      holdA = mode === "manual page";
    let notify: (
      update?: import("../packages/contracts/src/index.ts").TimelineUpdate,
    ) => void = () => {};
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
      async history(before) {
        if (before === "A-live") {
          if (holdA) {
            aEntered.release();
            await aRelease.promise;
          }
          return { messages: [message("A-old")], before: null };
        }
        if (before === "B-live") {
          bEntered.release();
          await bRelease.promise;
          return {
            messages: [
              message("B-only", "new session"),
              message("B-old", "stale"),
            ],
            before: null,
          };
        }
        throw new Error("unexpected cursor");
      },
      subscribe(changed) {
        notify = changed;
        return () => {};
      },
    };
    const h = await controllerHarness(backend);
    try {
      const c = await h.create();
      let oldPage: Promise<void> | undefined;
      if (mode === "reconciliation") {
        await c.loadOlder();
        holdA = true;
        notify({ sessionId: "A", change: { type: "structure" } });
      } else oldPage = c.loadOlder();
      await aEntered.promise;
      notify({
        sessionId: "A",
        change: {
          type: "item",
          message: message("B-only", "old session patch"),
        },
      });
      await Bun.sleep(20);
      notify({ sessionId: "A", change: { type: "structure" } });
      await Bun.sleep(20);
      sessionId = "B";
      await h.host.refresh();
      await eventually(() => c.view?.sessionId === "B");
      const newPage = c.loadOlder();
      await eventually(
        () =>
          h.received.some((frame) => {
            const call = (
              frame as { call?: { member?: string; args?: unknown[] } }
            ).call;
            return call?.member === "history" && call.args?.[0] === "B-live";
          }),
        300,
      );
      expect(c.loadingOlder).toBe(true);
      notify({
        sessionId: "B",
        change: { type: "item", message: message("B-old", "fresh") },
      });
      await Bun.sleep(20);
      aRelease.release();
      if (oldPage) await oldPage;
      await bEntered.promise;
      await Bun.sleep(20);
      expect(c.loadingOlder).toBe(true);
      expect(c.older).toEqual([]);
      bRelease.release();
      await newPage;
      expect(c.loadingOlder).toBe(false);
      expect(c.older.map((item) => [item.id, item.text])).toEqual([
        ["B-only", "new session"],
        ["B-old", "fresh"],
      ]);
      expect(c.view?.sessionId).toBe("B");
      expect(c.before).toBeNull();
    } finally {
      aRelease.release();
      bRelease.release();
      h.close();
    }
  });
}

test("reconnection releases stale history ownership and preserves new page patches", async () => {
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
  let notify: (
    update?: import("../packages/contracts/src/index.ts").TimelineUpdate,
  ) => void = () => {};
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
    subscribe(changed) {
      notify = changed;
      return () => {};
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
    notify({
      sessionId: "fixture-session",
      change: { type: "item", message: message("new", "fresh") },
    });
    await Bun.sleep(20);
    oldRelease.release();
    await oldPage;
    expect(c.loadingOlder).toBe(true);
    expect(c.older).toEqual([]);
    newRelease.release();
    await newPage;
    expect(c.loadingOlder).toBe(false);
    expect(c.older.map((item) => [item.id, item.text])).toEqual([
      ["new", "fresh"],
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
    await h.host.refresh();
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
    await h.host.refresh();
    await eventually(() => c.view?.sessionId === "B");
    sessionId = "A";
    await h.host.refresh();
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
    const beforeDisconnect = harness.disconnections;
    harness.disconnect();
    await eventually(() => harness.disconnections > beforeDisconnect);
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

test("definite rejection retains bubble until acknowledged delete; reply failure/stop stay sent; withdrawal alone offers recovery", async () => {
  const { imagesFixture } = await import("./images-fixture.ts");
  const f = imagesFixture();
  const harness = await controllerHarness(f.backend);
  try {
    const c = await harness.create();
    const reasons: string[] = [];
    await f.control({ action: "mode", state: "failed" });
    await c.send("rejected", (r) => reasons.push(r.reason));
    expect(reasons).toEqual([]);
    expect(c.pending[0]?.state).toBe("failed");
    expect(c.recovery).toEqual([]);
    await c.deleteFailed(c.pending[0]!.operationId);
    expect(reasons).toEqual(["observed"]);
    expect(c.pending).toEqual([]);
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
          createdAt: Date.now(),
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

test("expired dispatched input finalizes once, survives lost acknowledgement/reopen, retry identity stays one bubble and delete waits for ack", async () => {
  const { submissionsFixture } = await import("./submissions-fixture.ts");
  const fixture = submissionsFixture();
  const id = crypto.randomUUID();
  const saved = new Map([
    [
      "lamplit.pending:fixture-session",
      JSON.stringify([
        {
          operationId: id,
          text: "expired original",
          state: "sending",
          dispatched: true,
          createdAt: Date.now() - 61000,
        },
      ]),
    ],
  ]);
  await fixture.control({ action: "finalizationLost", enabled: true });
  const h = await controllerHarness(fixture.backend, saved);
  try {
    let c = await h.create();
    await Bun.sleep(30);
    expect(c.connected).toBe(true);
    expect((await fixture.control({ action: "state" })).finalizeCalls).toBe(1);
    expect((await fixture.backend.lookup(id))?.state).toBe("failed");
    expect(c.pending[0]?.state).toBe("sending");
    c.close();
    await fixture.control({ action: "finalizationLost", enabled: false });
    c = await h.create();
    await eventually(() => c.pending[0]?.state === "failed");
    await fixture.control({ action: "mode", state: "slow" });
    const retry = c.retryFailed(id);
    await c.retryFailed(id);
    await eventually(() => c.pending[0]?.state === "sending");
    await Bun.sleep(30);
    expect((await fixture.control({ action: "state" })).retryCalls).toBe(1);
    expect(c.pending).toHaveLength(1);
    expect(c.pending[0]?.logicalId).toBe(id);
    expect(c.pending[0]?.operationId).not.toBe(id);
    await fixture.control({ action: "mode", state: "failed" });
    await retry;
    expect(c.pending[0]?.state).toBe("failed");
    await fixture.control({ action: "deleteFailure", enabled: true });
    await c.deleteFailed(id);
    expect(c.pending[0]?.state).toBe("failed");
    c.close();
    c = await h.create();
    expect(c.pending[0]?.logicalId).toBe(id);
    await fixture.control({ action: "deleteFailure", enabled: false });
    await c.deleteFailed(id);
    expect(c.pending).toEqual([]);
    c.close();
    c = await h.create();
    expect(c.pending).toEqual([]);
    expect(c.recovery).toEqual([]);
    expect(
      (
        await fixture.backend.submit({
          operationId: id,
          text: "expired original",
        })
      ).state,
    ).toBe("failed");
  } finally {
    await fixture.control({ action: "release" });
    h.close();
  }
});

for (const original of ["submit", "retry"])
  for (const action of ["retry", "delete"])
    test(`fenced failure unlocks ${action} while original ${original} RPC remains held`, async () => {
      const { imagesFixture } = await import("./images-fixture.ts");
      const f = imagesFixture(),
        held = gate(),
        deletion = gate();
      let heldId = "",
        retryCalls = 0,
        deleteCalls = 0;
      const backend: ChatBackend = {
        ...f.backend,
        async submit(input) {
          if (original === "submit" && !heldId) {
            heldId = input.operationId;
            await held.promise;
          }
          return f.backend.submit(input);
        },
        async retryFailed(input) {
          retryCalls++;
          if (original === "retry" && !heldId) {
            heldId = input.attemptId;
            await held.promise;
          }
          return f.backend.retryFailed(input);
        },
        async deleteFailed(input) {
          deleteCalls++;
          await deletion.promise;
          return f.backend.deleteFailed(input);
        },
      };
      const h = await controllerHarness(backend);
      let unresolved: Promise<void> | undefined;
      try {
        const c = await h.create();
        if (original === "retry") {
          await f.control({ action: "mode", state: "failed" });
          await c.send("held terminal original");
          await f.control({ action: "mode", state: "submitted" });
          unresolved = c.retryFailed(c.pending[0]!.operationId);
        } else unresolved = c.send("held terminal original");
        await eventually(() => !!heldId);
        const logicalId = c.pending[0]!.logicalId!;
        const beforeRetry = retryCalls;
        await c.retryFailed(logicalId);
        await c.deleteFailed(logicalId);
        expect(retryCalls).toBe(beforeRetry);
        expect(deleteCalls).toBe(0);
        c.pending[0]!.createdAt = Date.now() - 61000;
        // The host serializes calls on each carrier. Recover onto a new carrier
        // before fencing a request whose native handler remains held.
        c.setVisible(false);
        c.setVisible(true);
        await eventually(() => c.pending[0]?.state === "failed");
        expect((await backend.lookup(heldId))?.state).toBe("failed");
        if (action === "retry") {
          await c.retryFailed(logicalId);
          expect(retryCalls).toBe(beforeRetry + 1);
          await eventually(() =>
            c.view!.messages.some((m) => m.text === "held terminal original"),
          );
          held.release();
          await unresolved;
          expect(c.pending).toEqual([]);
          expect(
            c.view!.messages.filter((m) => m.text === "held terminal original"),
          ).toHaveLength(1);
        } else {
          const deleting = c.deleteFailed(logicalId);
          await eventually(() => deleteCalls === 1);
          held.release();
          await unresolved;
          await c.deleteFailed(logicalId);
          await c.retryFailed(logicalId);
          expect(deleteCalls).toBe(1);
          expect(retryCalls).toBe(beforeRetry);
          deletion.release();
          await deleting;
          expect(c.pending).toEqual([]);
          expect(c.recovery).toEqual([]);
        }
      } finally {
        held.release();
        deletion.release();
        await unresolved;
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
    await h.host.refresh();
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
