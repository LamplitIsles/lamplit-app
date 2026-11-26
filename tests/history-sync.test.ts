import { expect, test } from "bun:test";
import { openChat } from "../packages/contracts/src/client.ts";
import {
  validate,
  HistorySyncInputSchema,
  type ChatMessage,
  type ChatView,
  type HistorySyncInput,
  type HistorySyncResult,
} from "../packages/contracts/src/index.ts";
import { fixtureBackend } from "./fixture.ts";
import { createDirectTestHost } from "./direct-test-host.ts";

async function until(check: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Timed out");
    await Bun.sleep(5);
  }
}

async function harness(before = "older-cursor") {
  const fixture = fixtureBackend();
  let session = "fixture-session",
    authorized = true;
  let authorizationGate: Promise<void> | undefined;
  let response: (input: HistorySyncInput) => Promise<unknown> = async (
    input,
  ) => ({
    kind: input.kind,
    sessionId: input.sessionId,
    historyId: "generation",
    records: [],
    before: null,
    head: "head",
  });
  let mutate: ((result: unknown) => unknown) | undefined;
  const host = await createDirectTestHost({
    ...fixture.backend,
    async read() {
      return { ...(await fixture.backend.read()), sessionId: session, messages: [answer, ui], before };
    },
    async historySync(input) {
      return (await response(input)) as HistorySyncResult;
    },
  });
  const channels = new Map<object, ReturnType<typeof host.connect>>();
  const methods = new Map<string, string>();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, s) {
      if (s.upgrade(req)) return;
      return new Response(null, { status: 404 });
    },
    websocket: {
      open(ws) {
        channels.set(
          ws,
          host.connect(
            {
              get bufferedAmount() {
                return ws.getBufferedAmount();
              },
              send(raw) {
                const frame = JSON.parse(raw);
                if (
                  frame.type === "result" &&
                  methods.get(frame.id) === "historySync" &&
                  mutate
                )
                  frame.result = mutate(frame.result);
                ws.send(JSON.stringify(frame));
              },
              close(code, reason) {
                ws.close(code, reason);
              },
            },
            async () => {
              if (authorizationGate) await authorizationGate;
              return authorized;
            },
          ),
        );
      },
      message(ws, raw) {
        const frame = JSON.parse(String(raw));
        if (frame.type === "call") methods.set(frame.id, frame.call.member);
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
  const connect = () => openChat(
    new WebSocket(`ws://127.0.0.1:${server.port}`),
    (next) => {
      view = next;
    },
    () => {
      offline = true;
    },
  );
  let client = await connect();
  await until(() => !!view);
  return {
    get client() { return client; },
    async reconnect() { client.close(); offline = false; client = await connect(); },
    host,
    get view() {
      return view!;
    },
    get offline() {
      return offline;
    },
    respond(fn: typeof response) {
      response = fn;
    },
    mutate(fn?: typeof mutate) {
      mutate = fn;
    },
    async switchSession(id: string) {
      session = id;
      await host.publish();
      await until(() => view?.sessionId === id);
    },
    revoke() {
      authorized = false;
    },
    gateAuthorization(gate?: Promise<void>) {
      authorizationGate = gate;
    },
    async publishSession(id: string) {
      session = id;
      await host.publish();
    },
    async rawCall(input: unknown, member = "historySync") {
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}`);
      return await new Promise<any>((resolve, reject) => {
        ws.addEventListener("open", () =>
          ws.send(
            JSON.stringify({
              type: "call",
              version: 1,
              id: "raw",
              call: {
                serviceId: "lamplit.chat.v2",
                member,
                args: [input],
              },
            }),
          ),
        );
        ws.addEventListener("message", (event) => {
          resolve(JSON.parse(String(event.data)));
          ws.close();
        });
        ws.addEventListener("error", reject);
      });
    },
    close() {
      client.close();
      host.close();
      void server.stop(true);
    },
  };
}

const sessionId = "fixture-session";
const start = { kind: "start", sessionId } as const;
const user: ChatMessage = {
  id: "user",
  role: "user",
  text: "photo",
  createdAt: 1,
  operationId: null,
  turnId: null,
  images: [
    {
      attachmentId: "image",
      name: "a.png",
      mediaType: "image/png",
      availability: "available",
    },
  ],
};
const answer: ChatMessage = {
  id: "answer",
  role: "agent",
  text: "😀 first\r\nlast\n",
  textState: "complete",
  createdAt: 2,
  operationId: null,
  turnId: "turn",
};
const ui: ChatMessage = {
  id: "ui",
  role: "agent",
  text: "",
  createdAt: 3,
  operationId: null,
  turnId: null,
  ui: { huge: "x".repeat(17000) },
};
const record = (message: ChatMessage, orderKey: string) => ({ message, orderKey });

test("Chord sync returns snapshots, older pages, newer pages and resync alongside the live projection", async () => {
  const h = await harness();
  const wake = {
    occurrenceId: "occurrence",
    reminderId: "reminder",
    triggeredAtMs: 123,
  };
  const records = [
    record(user, "001"),
    { ...record(answer, "002"), wake },
    record(ui, "003"),
  ];
  const appended = [record({ ...user, id: "new-user", text: "later" }, "004")];
  h.respond(async (input) =>
    input.kind === "start"
      ? {
          kind: "start",
          sessionId,
          historyId: "generation",
          records,
          before: "older-cursor",
          head: "head-cursor",
        }
      : input.kind === "older"
        ? input.before === "expired"
          ? { kind: "resyncRequired", sessionId }
          : {
              kind: "older",
              sessionId,
              historyId: "generation",
              records: [],
              before: null,
            }
        : input.after === "expired"
          ? { kind: "resyncRequired", sessionId }
          : {
              kind: "newer",
              sessionId,
              historyId: "generation",
              records: appended,
              nextAfter: "next",
              hasMore: true,
            },
  );
  try {
    const result = await h.client.historySync(start);
    if (result.kind !== "start") throw new Error("unexpected result");
    expect(result.records[0]!.message.images).toEqual(user.images);
    expect(result.records[1]!.wake).toEqual(wake);
    expect(result.records[1]!.message.ends).toEqual([10, 15]);
    expect(result.records[2]!.message.ui).toEqual({});
    expect((ui.ui as { huge: string }).huge).toHaveLength(17000);
    expect(h.view.messages).toEqual([
      result.records[1]!.message,
      result.records[2]!.message,
    ]);
    expect(h.view.before).toBe(result.before);
    expect(
      await h.client.historySync({
        kind: "older",
        sessionId,
        before: result.before!,
      }),
    ).toEqual({
      kind: "older",
      sessionId,
      historyId: "generation",
      records: [],
      before: null,
    });
    const newer = await h.client.historySync({
      kind: "newer",
      sessionId,
      after: result.head,
    });
    expect(newer.kind).toBe("newer");
    if (newer.kind === "newer") {
      expect(newer.records).toEqual(appended);
      expect(newer.nextAfter).toBe("next");
      expect(newer.hasMore).toBe(true);
    }
    for (const input of [
      { kind: "older", sessionId, before: "expired" },
      { kind: "newer", sessionId, after: "expired" },
    ] as const)
      expect(await h.client.historySync(input)).toEqual({
        kind: "resyncRequired",
        sessionId,
      });
  } finally {
    h.close();
  }
});

test("strict inputs and results reject invalid ranges, streaming, wrong stage and session without disconnecting", async () => {
  const h = await harness();
  const valid = {
    kind: "start",
    sessionId,
    historyId: "generation",
    records: [record(user, "001")],
    before: null,
    head: "head",
  };
  try {
    for (const input of [
      { ...start, extra: 1 },
      { kind: "older", sessionId, before: "" },
      { kind: "newer", sessionId, after: "x".repeat(4097) },
    ])
      expect(() => validate(HistorySyncInputSchema, input)).toThrow();
    await expect(
      h.client.historySync({ ...start, sessionId: "other" }),
    ).rejects.toThrow();
    expect((await h.rawCall({ ...start, extra: true })).type).toBe("error");
    expect((await h.rawCall({ ...start, sessionId: "other" })).type).toBe(
      "error",
    );
    for (const invalid of [
      { ...valid, sessionId: "other" },
      { ...valid, kind: "resyncRequired" },
      { ...valid, extra: 1 },
      {
        ...valid,
        records: Array.from({ length: 129 }, (_, i) =>
          record({ ...user, id: String(i) }, String(i)),
        ),
      },
      {
        ...valid,
        records: [record({ ...answer, textState: "streaming" }, "001")],
      },
      { ...valid, records: [record(user, "é")] },
      { ...valid, records: [{ ...record(user, "a"), rowVersion: 1 }] },
      { ...valid, records: [record(user, "b"), record(answer, "a")] },
      { ...valid, records: [record(user, "a"), record(answer, "a")] },
      {
        ...valid,
        records: [
          {
            ...record(user, "a"),
            wake: { occurrenceId: "o", reminderId: "r", triggeredAtMs: 1 },
          },
        ],
      },
      { ...valid, records: [record(user, "a"), record(user, "b")] },
    ]) {
      h.respond(async () => invalid);
      await expect(h.client.historySync(start)).rejects.toThrow();
    }
    h.respond(async () => ({ kind: "newer", sessionId, historyId: "generation", records: [record(user, "a")], nextAfter: "same", hasMore: false }));
    await expect(h.client.historySync({ kind: "newer", sessionId, after: "same" })).rejects.toThrow();
    h.respond(async () => ({ kind: "newer", sessionId, historyId: "generation", records: [], nextAfter: "same", hasMore: false }));
    expect((await h.client.historySync({ kind: "newer", sessionId, after: "same" })).kind).toBe("newer");
    h.respond(async () => ({ kind: "newer", sessionId, historyId: "generation", records: [], nextAfter: "advanced", hasMore: true }));
    expect((await h.client.historySync({ kind: "newer", sessionId, after: "same" })).kind).toBe("newer");
    const longCursor = "c".repeat(400);
    h.respond(async (input) => ({
      kind: "older",
      sessionId,
      historyId: "generation",
      records: [],
      before: input.kind === "older" ? "previous" : null,
    }));
    const older = await h.client.historySync({
      kind: "older",
      sessionId,
      before: longCursor,
    });
    expect(older.kind === "older" && older.before).toBe("previous");
    expect((await h.rawCall(longCursor, "history")).type).toBe("error");
    h.respond(async () => ({ kind: "older", sessionId, historyId: "generation", records: [], before: longCursor }));
    await expect(h.client.historySync({ kind: "older", sessionId, before: longCursor })).rejects.toThrow();
    h.respond(async () => ({
      kind: "newer",
      sessionId,
      historyId: "generation",
      records: [],
      nextAfter: "same",
      hasMore: true,
    }));
    await expect(
      h.client.historySync({ kind: "newer", sessionId, after: "same" }),
    ).rejects.toThrow();
    h.respond(async () => ({
      ...valid,
      records: Array.from({ length: 128 }, (_, i) =>
        record({ ...user, id: String(i) }, String(i).padStart(3, "0")),
      ),
    }));
    const max = await h.client.historySync(start);
    expect(max.kind === "start" && max.records.length).toBe(128);
    h.mutate((result) => ({ ...(result as object), records: [record(user, "b"), record(answer, "a")] }));
    await expect(h.client.historySync(start)).rejects.toThrow();
    h.mutate((result) => ({ ...(result as object), kind: "older" }));
    await expect(h.client.historySync(start)).rejects.toThrow();
    h.mutate((result) => ({ ...(result as object), sessionId: "other" }));
    await expect(h.client.historySync(start)).rejects.toThrow();
    h.mutate((result) => ({
      ...(result as object),
      records: [{ ...record(answer, "x"), message: { ...answer, ends: [1] } }],
    }));
    await expect(h.client.historySync(start)).rejects.toThrow();
    h.mutate();
    expect(await h.client.lookup(crypto.randomUUID())).toBeNull();
    expect(h.offline).toBe(false);
  } finally {
    h.close();
  }
});

test("held sync is isolated from lookup and detects session lifetime changes; oversized result fails only its call", async () => {
  const h = await harness();
  let release!: () => void,
    entered = false;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  h.respond(async () => {
    entered = true;
    await held;
    return {
      kind: "start",
      sessionId,
      historyId: "generation",
      records: [],
      before: null,
      head: "head",
    };
  });
  try {
    const pending = h.client.historySync(start);
    await until(() => entered);
    expect(await h.client.lookup(crypto.randomUUID())).toBeNull();
    await h.switchSession("other");
    await h.switchSession(sessionId);
    release();
    await expect(pending).rejects.toThrow();
    h.respond(async () => ({
      kind: "start",
      sessionId,
      historyId: "generation",
      records: [record({ ...user, text: "x".repeat(2 * 1024 * 1024) }, "a")],
      before: null,
      head: "head",
    }));
    await expect(h.client.historySync(start)).rejects.toThrow();
    expect(await h.client.lookup(crypto.randomUUID())).toBeNull();
    expect(h.offline).toBe(false);
    h.revoke();
    await expect(h.client.historySync(start)).rejects.toThrow();
    await until(() => h.offline);
  } finally {
    release();
    h.close();
  }
});

test("session changes while a sync result waits for authorization fail that result", async () => {
  const h = await harness();
  let release!: () => void,
    ready = false;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  h.respond(async () => {
    h.gateAuthorization(gate);
    ready = true;
    return {
      kind: "start",
      sessionId,
      historyId: "generation",
      records: [record(user, "a")],
      before: null,
      head: "head",
    };
  });
  try {
    const pending = h.client.historySync(start);
    await until(() => ready);
    await h.publishSession("other");
    h.gateAuthorization();
    release();
    await expect(pending).rejects.toThrow();
    await until(() => h.view.sessionId === "other");
    expect(h.offline).toBe(false);
  } finally {
    release();
    h.close();
  }
});

test("live before uses the same bounded older cursor", async () => {
  const cursor = "v".repeat(400);
  const h = await harness(cursor);
  h.respond(async input => ({ kind: "older", sessionId: input.sessionId, historyId: "generation", records: [], before: null }));
  try {
    expect(h.view.before).toBe(cursor);
    expect((await h.client.historySync({ kind: "older", sessionId, before: h.view.before! })).kind).toBe("older");
  } finally { h.close(); }
});

test("a saved newer cursor remains usable after reconnect", async () => {
  const h = await harness();
  h.respond(async input => input.kind === "start"
    ? { kind: "start", sessionId, historyId: "generation", records: [record(user, "001")], before: null, head: "saved-head" }
    : { kind: "newer", sessionId, historyId: "generation", records: [record(answer, "002")], nextAfter: "saved-next", hasMore: false });
  try {
    const initial = await h.client.historySync(start);
    if (initial.kind !== "start") throw new Error("Expected start");
    await h.reconnect();
    const resumed = await h.client.historySync({ kind: "newer", sessionId, after: initial.head });
    if (resumed.kind !== "newer") throw new Error("Expected newer");
    expect(resumed.records[0]!.message.id).toBe("answer");
    expect(resumed.nextAfter).toBe("saved-next");
  } finally { h.close(); }
});
