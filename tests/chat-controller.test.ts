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

test("moving live window retains history/unconsumed sends and rejects previous-session archive/panel reads", async () => {
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
        version: 1,
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
            state: "uncertain",
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
    expect(controller.recovery).toHaveLength(1);
    await controller.loadOlder();
    expect(controller.recovery).toEqual([]);
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

test("an in-flight send stays visible until observed and is not offered as recovery", async () => {
  const { fixtureBackend } = await import("./fixture.ts");
  const fixture = fixtureBackend();
  let submitted:
    | import("../packages/contracts/src/index.ts").Submission
    | undefined;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let observed = false;
  let delivery: ChatMessage["delivery"];
  let recoveryState: "uncertain" | "unconsumed" | "rejected" = "uncertain";
  const backend: ChatBackend = {
    ...fixture.backend,
    async read() {
      const view = await fixture.backend.read();
      return {
        ...view,
        messages: observed
          ? view.messages.map((message) =>
              delivery === undefined ? message : { ...message, delivery },
            )
          : [],
        recovery: submitted
          ? [
              {
                sourceId: submitted.operationId,
                operationId: submitted.operationId,
                text: submitted.text,
                images: [],
                state: recoveryState,
                replacementEligible: false,
              },
            ]
          : [],
      };
    },
    async submit(input) {
      submitted = input;
      await gate;
      return fixture.backend.submit(input);
    },
  };
  const host = await createChatHost(backend);
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
    value: { href: `http://127.0.0.1:${server.port}/` },
  });
  const saved = new Map<string, string>();
  const controller = new ChatController(() => {}, {
    getItem: (key) => saved.get(key) ?? null,
    setItem: (key, value) => {
      saved.set(key, value);
    },
  });
  let retired = 0;
  try {
    controller.start();
    await eventually(() => controller.connected);
    const send = controller.send("delayed native admission", () => {
      retired++;
    });
    // Local echo must precede the native receipt.
    expect(controller.pending.map((p) => p.text)).toEqual([
      "delayed native admission",
    ]);
    await eventually(() => !!submitted);
    await host.refresh();
    await eventually(() => controller.view!.recovery.length === 1);
    expect(controller.recovery).toEqual([]);
    expect(controller.pending[0]!.state).toBe("submitting");
    release();
    await send;
    // A consumed receipt can precede the replicated user message.
    expect(controller.pending.map((p) => p.text)).toEqual([
      "delayed native admission",
    ]);
    expect(retired).toBe(0);
    // A native view can retain a stale recovery candidate while its user message is visible.
    observed = true;
    await host.refresh();
    await eventually(() =>
      controller.view!.messages.some(
        (m) => m.operationId === submitted!.operationId,
      ),
    );
    expect(controller.pending).toEqual([]);
    expect(controller.recovery).toEqual([]);
    expect(retired).toBe(1);
    // A visible native echo can still carry unknown delivery and require inspection.
    delivery = "uncertain";
    await host.refresh();
    await eventually(
      () => controller.view!.messages[0]?.delivery === "uncertain",
    );
    expect(controller.recovery[0]?.state).toBe("uncertain");
    delivery = "consumed";
    await host.refresh();
    await eventually(
      () => controller.view!.messages[0]?.delivery === "consumed",
    );
    expect(controller.recovery).toEqual([]);
    // Explicit native failure/ non-consumption remains recoverable even with a visible echo.
    for (const state of ["unconsumed", "rejected"] as const) {
      recoveryState = state;
      await host.refresh();
      await eventually(() => controller.view!.recovery[0]?.state === state);
      expect(controller.recovery[0]?.state).toBe(state);
    }
    recoveryState = "uncertain";
    // A real failed admission still exposes the backend's uncertain recovery.
    backend.submit = async (input) => {
      submitted = input;
      observed = false;
      await host.refresh();
      throw new Error("Fixture lost acknowledgement");
    };
    await controller.send("failed native admission");
    expect(controller.pending[0]!.state).toBe("uncertain");
    expect(controller.recovery[0]!.text).toBe("failed native admission");
  } finally {
    release();
    controller.close();
    host.close();
    void server.stop(true);
    if (previousLocation)
      Object.defineProperty(globalThis, "location", previousLocation);
    else Reflect.deleteProperty(globalThis, "location");
  }
});

test("optimistic send rolls back only settled nonadmission; accepted/observed input wins stale results", async () => {
  const { fixtureBackend } = await import("./fixture.ts");
  const fixture = fixtureBackend();
  const gate = () => {
    let release!: () => void;
    return {
      promise: new Promise<void>((resolve) => {
        release = resolve;
      }),
      release: () => release(),
    };
  };
  const receipt = (
    operationId: string,
    state: import("../packages/contracts/src/index.ts").Receipt["state"],
  ): import("../packages/contracts/src/index.ts").Receipt => ({
    operationId,
    state,
    messageId: durableReceipt ? `message:${operationId}` : null,
    turnId: null,
    error: null,
  });
  let durableReceipt = false;
  let submitGate = gate(),
    lookupGate = gate();
  let input:
    | import("../packages/contracts/src/index.ts").Submission
    | undefined;
  let result: "accepted" | "rejected" | "error" | "observed" | "disconnect" =
    "rejected";
  let hideInput = false;
  let lookupState: import("../packages/contracts/src/index.ts").Receipt["state"] =
    "missing";
  let viewRead = 0;
  let holdLookup = false,
    lookups = 0,
    submits = 0,
    sessionId = "fixture-session";
  const backend: ChatBackend = {
    ...fixture.backend,
    async read() {
      const view = await fixture.backend.read();
      return {
        ...view,
        messages: view.messages.filter(
          (m) => !hideInput || m.operationId !== input?.operationId,
        ),
        sessionId,
        contextUsage: { tokens: ++viewRead, capacity: 1000 },
      };
    },
    async submit(value) {
      input = value;
      submits++;
      await submitGate.promise;
      if (result === "error") throw new Error("lost reply");
      if (result === "disconnect") {
        await fixture.backend.submit(value);
        for (const ws of channels.keys())
          (ws as import("bun").ServerWebSocket<undefined>).terminate();
        return receipt(value.operationId, "accepted");
      }
      if (result === "observed") {
        await fixture.backend.submit(value);
        await host.refresh();
        throw new Error("stale error after native observation");
      }
      return receipt(value.operationId, result);
    },
    async lookup(id) {
      lookups++;
      const state = lookupState;
      if (holdLookup) await lookupGate.promise;
      return receipt(id, state);
    },
  };
  const host = await createChatHost(backend);
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
  const previousLocation = Object.getOwnPropertyDescriptor(
    globalThis,
    "location",
  );
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: { href: `http://127.0.0.1:${server.port}/` },
  });
  const saved = new Map<string, string>();
  const controller = new ChatController(() => {}, {
    getItem: (key) => saved.get(key) ?? null,
    setItem: (key, value) => {
      saved.set(key, value);
    },
  });
  const retirements: string[] = [];
  const retire = (
    r: import("../apps/web/src/lib/companion/client/contracts.ts").PendingSubmissionRetirement,
  ) => retirements.push(r.reason);
  try {
    await expect(controller.send("offline", retire)).rejects.toThrow(
      "连接已断开",
    );
    expect(submits).toBe(0);
    controller.start();
    await eventually(() => controller.connected);
    const rejected = controller.send("failed text", retire);
    expect(controller.pending[0]?.text).toBe("failed text");
    await eventually(() => !!input);
    await host.refresh();
    expect(lookups).toBe(0); // A still-running admission cannot be withdrawn by missing lookup.
    submitGate.release();
    await rejected;
    expect(controller.pending).toEqual([]);
    expect(retirements).toEqual(["failed"]);
    expect(JSON.parse(saved.get("lamplit.pending:fixture-session")!)).toEqual(
      [],
    );

    // A generic RPC error keeps the echo until two settled missing reads prove nonadmission.
    submitGate = gate();
    lookupGate = gate();
    input = undefined;
    result = "error";
    holdLookup = true;
    const unknown = controller.send("unknown outcome", retire);
    await eventually(() => !!input);
    submitGate.release();
    await unknown;
    await eventually(() => lookups === 1);
    expect(controller.pending[0]?.state).toBe("uncertain");
    expect(retirements).toEqual(["failed"]);
    lookupGate.release();
    await eventually(() => controller.pending.length === 0);
    expect(lookups).toBe(2);
    expect(retirements).toEqual(["failed", "failed"]);

    // Native observation releases once; a late error never resurrects or restores that input.
    holdLookup = false;
    submitGate = gate();
    result = "observed";
    const observed = controller.send("observed wins", retire);
    submitGate.release();
    await observed;
    await eventually(() => controller.pending.length === 0);
    expect(retirements.at(-1)).toBe("observed");
    expect(
      controller.view?.messages.filter((m) => m.text === "observed wins"),
    ).toHaveLength(1);

    // A socket really drops after admission; reconnect looks up the same ID without replay.
    result = "disconnect";
    hideInput = true;
    lookupState = "accepted";
    submitGate = gate();
    const disconnected = controller.send("accepted before socket loss", retire);
    submitGate.release();
    await disconnected;
    await eventually(() => !controller.connected);
    expect(controller.pending[0]?.text).toBe("accepted before socket loss");
    await eventually(() => controller.connected, 5000);
    await eventually(() => controller.pending[0]?.state === "accepted");
    expect(retirements).toEqual(["failed", "failed", "observed"]);
    hideInput = false;
    await host.refresh();
    await eventually(() => controller.pending.length === 0);
    expect(retirements.at(-1)).toBe("observed");

    // Accepted input survives late native rejection and stale missing reconciliation.
    submitGate = gate();
    result = "accepted";
    const accepted = controller.send("durably accepted", retire);
    submitGate.release();
    await accepted;
    lookupState = "rejected";
    await host.refresh();
    await eventually(() => controller.pending[0]?.state === "rejected");
    expect(controller.pending[0]?.state).toBe("rejected");
    expect(controller.error).toContain("恢复编辑");
    lookupState = "missing";
    await host.refresh();
    await eventually(() => lookups >= 5);
    expect(controller.pending[0]?.state).toBe("rejected");
    expect(retirements).toEqual(["failed", "failed", "observed", "observed"]);

    // Switching session releases previews without restoring into the new conversation.
    submitGate = gate();
    result = "rejected";
    const stale = controller.send("old session", retire);
    sessionId = "next-session";
    await host.refresh();
    await eventually(() => controller.view?.sessionId === sessionId);
    submitGate.release();
    await stale;
    expect(controller.pending).toEqual([]);
    expect(retirements.slice(-2)).toEqual(["observed", "observed"]);
    expect(submits).toBe(6); // No automatic replay.
    // Reload rechecks transport state but cannot revoke a recorded durable admission.
    saved.set(
      `lamplit.pending:${sessionId}`,
      JSON.stringify([
        {
          operationId: crypto.randomUUID(),
          text: "saved accepted",
          state: "accepted",
          createdAt: Date.now(),
        },
      ]),
    );
    const reloaded = new ChatController(() => {}, {
      getItem: (key) => saved.get(key) ?? null,
      setItem: (key, value) => {
        saved.set(key, value);
      },
    });
    try {
      reloaded.start();
      await eventually(() => reloaded.connected);
      await eventually(() => reloaded.pending[0]?.state === "accepted");
      expect(reloaded.pending[0]?.text).toBe("saved accepted");
      expect(submits).toBe(6);
    } finally {
      reloaded.close();
    }
    // A rejected receipt with a durable message is execution failure, including a lost ack.
    durableReceipt = true;
    lookupState = "rejected";
    const beforeDurable = retirements.length;
    for (const outcome of ["rejected", "error"] as const) {
      result = outcome;
      submitGate = gate();
      const text = `durable ${outcome}`;
      const sending = controller.send(text, retire);
      submitGate.release();
      await sending;
      await eventually(() =>
        controller.pending.some(
          (p) => p.text === text && p.state === "rejected",
        ),
      );
      expect(controller.error).toContain("恢复编辑");
      expect(retirements).toHaveLength(beforeDurable);
    }
    // Uncertainty can still prove admission; keep that fact before ignoring stale state.
    lookupState = "uncertain";
    result = "error";
    submitGate = gate();
    const uncertain = controller.send("durable uncertain", retire);
    submitGate.release();
    await uncertain;
    await eventually(() =>
      controller.pending.some(
        (p) => p.text === "durable uncertain" && p.admitted,
      ),
    );
    expect(
      JSON.parse(saved.get(`lamplit.pending:${sessionId}`)!).find(
        (p: { text: string }) => p.text === "durable uncertain",
      ).admitted,
    ).toBe(true);
    expect(
      controller.pending.find((p) => p.text === "durable error")?.state,
    ).toBe("rejected");
    expect(retirements).toHaveLength(beforeDurable);
    durableReceipt = false;
    lookupState = "missing";
    const beforeMissingLookups = lookups;
    await host.refresh();
    await eventually(() => lookups >= beforeMissingLookups + 6);
    expect(
      controller.pending.find((p) => p.text === "durable uncertain")?.state,
    ).toBe("uncertain");
    expect(retirements).toHaveLength(beforeDurable);
    const submissionsBeforeReload = submits;
    // Intentional recovery dismissal releases borrowed previews exactly once.
    const dismissed = controller.pending.find(
      (p) => p.text === "durable rejected",
    )!;
    controller.dismissRecovery(dismissed.operationId);
    controller.dismissRecovery(dismissed.operationId);
    expect(retirements.slice(beforeDurable)).toEqual(["observed"]);
    controller.close();
    lookupState = "missing"; // Stale missing cannot revoke the stored durable rejection.
    const durableReload = new ChatController(() => {}, {
      getItem: (key) => saved.get(key) ?? null,
      setItem: (key, value) => {
        saved.set(key, value);
      },
    });
    try {
      const beforeReloadLookups = lookups;
      durableReload.start();
      await eventually(() => durableReload.connected);
      await eventually(() => lookups >= beforeReloadLookups + 4);
      expect(durableReload.pending.map((p) => [p.text, p.state])).toEqual([
        ["durable error", "rejected"],
        ["durable uncertain", "uncertain"],
      ]);
      expect(submits).toBe(submissionsBeforeReload);
    } finally {
      durableReload.close();
    }
  } finally {
    submitGate.release();
    lookupGate.release();
    controller.close();
    host.close();
    void server.stop(true);
    if (previousLocation)
      Object.defineProperty(globalThis, "location", previousLocation);
    else Reflect.deleteProperty(globalThis, "location");
  }
});
