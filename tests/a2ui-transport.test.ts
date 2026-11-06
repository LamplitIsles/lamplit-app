import { expect, test } from "bun:test";
import { openChat } from "../packages/contracts/src/client.ts";
import {
  validate,
  MessageSchema,
  type ChatMessage,
  type ChatView,
} from "../packages/contracts/src/index.ts";
import {
  boundA2UIInMessages,
  validateA2UISurface,
} from "../packages/contracts/src/a2ui.ts";
import {
  createChatHost,
  type ChatChange,
} from "../packages/contracts/src/server.ts";
import { fixtureBackend } from "./fixture.ts";
import fixture from "../packages/contracts/fixtures/a2ui-v1.json";
import workspaceFixture from "./fixtures/a2ui-workspace-media.json";

const base = {
  role: "agent" as const,
  text: "",
  createdAt: 1,
  operationId: null,
  turnId: "turn",
};
async function until(check: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Timed out");
    await Bun.sleep(5);
  }
}

test("UI bounding copies only the projection and leaves outer message validation strict", () => {
  const messages = [
    { ...base, id: "bad", ui: { huge: "x".repeat(17000) } },
    { ...base, id: "next", role: "user", text: "hello" },
  ];
  const source = { messages };
  const copy = boundA2UIInMessages(source) as typeof source;
  expect((copy.messages[0] as { ui: unknown }).ui).toEqual({});
  expect((messages[0] as { ui: { huge: string } }).ui.huge).toHaveLength(17000);
  expect(copy.messages[1]).toEqual(messages[1]);
  expect(() =>
    validate(MessageSchema, { ...base, id: "bad", ui: {}, unexpected: true }),
  ).toThrow();
  expect(() =>
    validate(MessageSchema, { ...base, id: "bad", ui: {}, role: "user" }),
  ).toThrow();
  expect(() =>
    validate(MessageSchema, { ...base, id: "bad", ui: {}, text: "other" }),
  ).toThrow();
  let nested: unknown = "leaf";
  for (let i = 0; i < 40; i++) nested = { nested };
  expect(
    (
      boundA2UIInMessages({
        messages: [{ ...base, id: "bad", ui: nested }],
      }) as any
    ).messages[0].ui,
  ).toEqual({});
});

test("live and historical UI keep order and identity across invalid payloads and later updates", async () => {
  const mock = fixtureBackend();
  const scope = Symbol("session");
  let listener: (change: ChatChange) => void = () => {};
  const bad: ChatMessage = { ...base, id: "bad", ui: { version: "v999" } };
  let good: ChatMessage = { ...base, id: "good", ui: fixture };
  const other: ChatMessage = {
    ...base,
    id: "other",
    role: "user",
    text: "hello",
  };
  const backend = {
    ...mock.backend,
    async read() {
      return {
        ...(await mock.backend.read()),
        messages: [other, bad, good],
        before: "older",
      };
    },
    async history() {
      return { messages: [other, bad, good], before: null };
    },
    subscribe(changed: (change: ChatChange) => void) {
      listener = changed;
      return { scope, close() {} };
    },
  };
  const errors: unknown[] = [];
  const host = await createChatHost(backend, (error) => errors.push(error));
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
  let view: ChatView | undefined;
  let offline = false;
  const client = await openChat(
    new WebSocket(`ws://127.0.0.1:${server.port}`),
    (next) => {
      view = next;
    },
    () => {
      offline = true;
    },
  );
  try {
    await until(() => view?.messages.length === 3);
    expect(view!.messages.map((m) => m.id)).toEqual(["other", "bad", "good"]);
    expect(() => validateA2UISurface(view!.messages[1]!.ui)).toThrow();
    expect(validateA2UISurface(view!.messages[2]!.ui) as unknown).toEqual(
      fixture,
    );
    const history = await client.history("older");
    expect(history.messages.map((m) => m.id)).toEqual(["other", "bad", "good"]);
    expect(history.messages[1]!.ui).toEqual(bad.ui);
    good = { ...good, ui: workspaceFixture };
    listener({
      type: "update",
      scope,
      messages: [{ type: "upsert", message: good }],
    });
    await until(
      () =>
        JSON.stringify(view?.messages[2]?.ui) ===
        JSON.stringify(workspaceFixture),
    );
    expect(validateA2UISurface(view!.messages[2]!.ui) as unknown).toEqual(
      workspaceFixture,
    );
    expect((await client.history("older")).messages[2]!.ui).toEqual(
      workspaceFixture,
    );
    listener({
      type: "update",
      scope,
      messages: [
        {
          type: "upsert",
          message: { ...bad, ui: { huge: "x".repeat(17000) } },
        },
      ],
    });
    await until(() => JSON.stringify(view?.messages[1]?.ui) === "{}");
    listener({
      type: "update",
      scope,
      messages: [{ type: "upsert", message: { ...bad, ui: fixture } }],
    });
    await until(
      () => JSON.stringify(view?.messages[1]?.ui) === JSON.stringify(fixture),
    );
    expect(view!.messages.map((m) => m.id)).toEqual(["other", "bad", "good"]);
    expect(offline).toBe(false);
    expect(errors).toEqual([]);
    listener({
      type: "update",
      scope,
      messages: [
        {
          type: "upsert",
          message: { ...bad, unexpected: true } as ChatMessage,
        },
      ],
    });
    expect(errors).toHaveLength(1);
    listener({
      type: "update",
      scope,
      messages: [
        { type: "upsert", message: { ...bad, ui: { version: "next" } } },
      ],
    });
    await until(() => (view?.messages[1]?.ui as any)?.version === "next");
    expect(offline).toBe(false);
  } finally {
    client.close();
    host.close();
    server.stop(true);
  }
});

test("bounding the client projection leaves the replicated state intact for the next patch", async () => {
  const { replicatedState } =
    await import("../packages/contracts/node_modules/@earendil-works/chord/dist/index.js");
  const { BACKGROUND_CONTEXT } =
    await import("../packages/contracts/node_modules/@earendil-works/chord/dist/context/index.js");
  const state = replicatedState({
    messages: [
      { ...base, id: "bad", ui: { huge: "x".repeat(17000), counter: 1 } },
    ],
  });
  let projection: any;
  const unsubscribe = state.subscribe((value) => {
    projection = boundA2UIInMessages(value);
  });
  expect(projection.messages[0].ui).toEqual({});
  expect(state.value.messages[0]!.ui.huge).toHaveLength(17000);
  state.change(BACKGROUND_CONTEXT, (draft) => {
    draft.messages[0]!.ui.counter = 2;
  });
  expect(state.value.messages[0]!.ui.counter).toBe(2);
  expect(state.value.messages[0]!.ui.huge).toHaveLength(17000);
  expect(projection.messages[0].ui).toEqual({});
  state.change(BACKGROUND_CONTEXT, (draft) => {
    draft.messages[0]!.ui.huge = "short";
  });
  expect(projection.messages[0].ui).toEqual({ huge: "short", counter: 2 });
  unsubscribe();
});
