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
    await host.refresh();
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

test("v2 submission contract rejects old receipts/delivery/recovery and validates nullable lookup", async () => {
  const {
    ReceiptSchema,
    LookupSchema,
    MessageSchema,
    RecoverySchema,
    ViewSchema,
  } = await import("../packages/contracts/src/index.ts");
  const id = crypto.randomUUID();
  const receipt = {
    operationId: id,
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
  const recovery = {
    sourceId: id,
    operationId: id,
    text: "x",
    images: [],
    replacementEligible: true,
  };
  expect(validate(RecoverySchema, recovery)).toEqual(recovery);
  expect(() =>
    validate(RecoverySchema, { ...recovery, state: "unconsumed" }),
  ).toThrow();
  const view = await fixtureBackend().backend.read();
  expect(() => validate(ViewSchema, { ...view, version: 1 })).toThrow();
});
