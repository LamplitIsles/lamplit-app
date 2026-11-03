import { expect, test } from "bun:test";
import { openChat } from "../packages/contracts/src/client.ts";
import { createChatHost } from "../packages/contracts/src/server.ts";
import { fixtureBackend } from "./fixture.ts";
import { eventually } from "./chat.test.ts";
import type {
  ChatTimelineEvent,
  TimelineUpdate,
} from "../packages/contracts/src/index.ts";

test("image slot state never presents an unverified image", async () => {
  const { MessageSchema, validate } =
    await import("../packages/contracts/src/index.ts");
  const slot = {
    id: "slot",
    role: "agent",
    text: "",
    createdAt: 1,
    operationId: null,
    turnId: "turn",
  };
  const image = {
    attachmentId: "image",
    name: "image.png",
    mediaType: "image/png",
    availability: "available",
  };
  for (const imageState of ["preparing", "failed", "unknown"]) {
    expect(validate(MessageSchema, { ...slot, imageState })).toBeDefined();
    expect(() =>
      validate(MessageSchema, { ...slot, imageState, images: [image] }),
    ).toThrow();
  }
  expect(() =>
    validate(MessageSchema, { ...slot, imageState: "ready" }),
  ).toThrow();
  expect(() =>
    validate(MessageSchema, { ...slot, imageState: "ready", images: [] }),
  ).toThrow();
  expect(
    validate(MessageSchema, { ...slot, imageState: "ready", images: [image] }),
  ).toBeDefined();
  expect(() =>
    validate(MessageSchema, {
      ...slot,
      imageState: "ready",
      images: [{ ...image, availability: "missing" }],
    }),
  ).toThrow();
  expect(() =>
    validate(MessageSchema, { ...slot, role: "user", imageState: "preparing" }),
  ).toThrow();
});

test("image upload binds each repeated filename to its own draft and rejects reordered results", async () => {
  const { validateUploadResult } =
    await import("../packages/contracts/src/images.ts");
  const operationId = crypto.randomUUID();
  const drafts = [
    {
      id: "draft-a",
      order: 0,
      name: "same.png",
      mediaType: "image/png" as const,
    },
    {
      id: "draft-b",
      order: 1,
      name: "same.png",
      mediaType: "image/png" as const,
    },
  ];
  const ref = (attachmentId: string) => ({
    attachmentId,
    name: "same.png",
    mediaType: "image/png" as const,
    availability: "available" as const,
  });
  const result = {
    sessionId: "session",
    operationId,
    images: [
      { id: "draft-a", order: 0, ref: ref("first") },
      { id: "draft-b", order: 1, ref: ref("second") },
    ],
  };
  expect(
    validateUploadResult(result, {
      sessionId: "session",
      operationId,
      images: drafts,
    }),
  ).toEqual(result);
  expect(() =>
    validateUploadResult(
      { ...result, images: [...result.images].reverse() },
      { sessionId: "session", operationId, images: drafts },
    ),
  ).toThrow();
  expect(() =>
    validateUploadResult(
      {
        ...result,
        images: [result.images[0], { ...result.images[1], ref: ref("first") }],
      },
      { sessionId: "session", operationId, images: drafts },
    ),
  ).toThrow();
});

test("retry image associations require the exact session, source and unique original and target identities", async () => {
  const { validateRetryImageMapping } =
    await import("../packages/contracts/src/index.ts");
  const sourceOperationId = crypto.randomUUID();
  const ref = (attachmentId: string) => ({
    attachmentId,
    name: "same.png",
    mediaType: "image/png" as const,
    availability: "available" as const,
  });
  const original = [ref("old-a"), ref("old-b")];
  const value = {
    sessionId: "session",
    sourceOperationId,
    images: [
      { sourceAttachmentId: "old-a", ref: ref("new-a") },
      { sourceAttachmentId: "old-b", ref: ref("new-b") },
    ],
  };
  expect(
    validateRetryImageMapping(value, "session", sourceOperationId, original),
  ).toEqual(value);
  expect(() =>
    validateRetryImageMapping(value, "other", sourceOperationId, original),
  ).toThrow();
  expect(() =>
    validateRetryImageMapping(value, "session", crypto.randomUUID(), original),
  ).toThrow();
  expect(() =>
    validateRetryImageMapping(
      { ...value, images: value.images.slice(0, 1) },
      "session",
      sourceOperationId,
      original,
    ),
  ).toThrow();
  expect(() =>
    validateRetryImageMapping(
      {
        ...value,
        images: [
          value.images[0],
          { ...value.images[1], sourceAttachmentId: "old-a" },
        ],
      },
      "session",
      sourceOperationId,
      original,
    ),
  ).toThrow();
  expect(() =>
    validateRetryImageMapping(
      {
        ...value,
        images: [value.images[0], { ...value.images[1], ref: ref("new-a") }],
      },
      "session",
      sourceOperationId,
      original,
    ),
  ).toThrow();
  expect(() =>
    validateRetryImageMapping(
      {
        ...value,
        images: [
          value.images[0],
          { ...value.images[1], sourceAttachmentId: "other" },
        ],
      },
      "session",
      sourceOperationId,
      original,
    ),
  ).toThrow();
});

test("retry receipts reject duplicate source or target identities even before local preview matching", async () => {
  const { validateReceipt } =
    await import("../packages/contracts/src/index.ts");
  const sourceOperationId = crypto.randomUUID();
  const ref = (attachmentId: string) => ({
    attachmentId,
    name: "x.png",
    mediaType: "image/png",
    availability: "available",
  });
  const retryImages = {
    sessionId: "session",
    sourceOperationId,
    images: [
      { sourceAttachmentId: "old-a", ref: ref("new-a") },
      { sourceAttachmentId: "old-b", ref: ref("new-b") },
    ],
  };
  const receipt = {
    operationId: crypto.randomUUID(),
    state: "submitted",
    messageId: null,
    turnId: null,
    error: null,
    retryImages,
  };
  expect(() => validateReceipt(receipt)).not.toThrow();
  expect(() =>
    validateReceipt({
      ...receipt,
      retryImages: {
        ...retryImages,
        images: [
          retryImages.images[0],
          { ...retryImages.images[1], sourceAttachmentId: "old-a" },
        ],
      },
    }),
  ).toThrow();
  expect(() =>
    validateReceipt({
      ...receipt,
      retryImages: {
        ...retryImages,
        images: [
          retryImages.images[0],
          { ...retryImages.images[1], ref: ref("new-a") },
        ],
      },
    }),
  ).toThrow();
  expect(() =>
    validateReceipt({ ...receipt, operationId: sourceOperationId }),
  ).toThrow();
});

test("authenticated subscribers receive a historical item update even when the live view is unchanged", async () => {
  const fixture = fixtureBackend();
  let notify: (update?: TimelineUpdate) => void = () => {};
  const backend = {
    ...fixture.backend,
    subscribe(changed: typeof notify) {
      notify = changed;
      return () => {};
    },
  };
  const host = await createChatHost(backend);
  const channels = new Map<object, ReturnType<typeof host.connect>>();
  let authorized = true;
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
          host.connect(ws, async () => authorized),
        );
      },
      message(ws, data) {
        void channels.get(ws)!.receive(String(data));
      },
      close(ws) {
        channels.get(ws)?.close();
        channels.delete(ws);
      },
    },
  });
  const events: ChatTimelineEvent[] = [];
  const passiveFrames: string[] = [];
  const passive = new WebSocket(`ws://127.0.0.1:${server.port}`);
  passive.addEventListener("message", (event) =>
    passiveFrames.push(String(event.data)),
  );
  await new Promise<void>((resolve) =>
    passive.addEventListener("open", () => resolve(), { once: true }),
  );
  let offline = false;
  const client = await openChat(
    new WebSocket(`ws://127.0.0.1:${server.port}`),
    () => {},
    () => {
      offline = true;
    },
    (event) => events.push(event),
  );
  try {
    const message = {
      id: "image-slot",
      role: "agent" as const,
      text: "",
      createdAt: 1,
      operationId: null,
      turnId: "turn",
      imageState: "preparing" as const,
    };
    notify({
      sessionId: "other-session",
      change: {
        type: "item",
        message: { ...message, id: "secret-other-session" },
      },
    });
    notify({ sessionId: "fixture-session", change: { type: "item", message } });
    await eventually(() =>
      events.some(
        (event) =>
          event.type === "change" &&
          event.update.change.type === "item" &&
          event.update.change.message.id === "image-slot",
      ),
    );
    expect(events.at(-1)).toEqual({
      type: "change",
      update: {
        sessionId: "fixture-session",
        change: { type: "item", message },
      },
    });
    expect(
      events.some(
        (event) =>
          event.type === "change" && event.update.sessionId === "other-session",
      ),
    ).toBe(false);
    expect(passiveFrames).toEqual([]);
    const count = events.length;
    authorized = false;
    notify({
      sessionId: "fixture-session",
      change: { type: "item", message: { ...message, imageState: "failed" } },
    });
    await eventually(() => offline);
    expect(events).toHaveLength(count);
  } finally {
    client.close();
    passive.close();
    host.close();
    for (const ws of channels.keys())
      (ws as import("bun").ServerWebSocket<undefined>).terminate();
    server.unref();
    void server.stop(true);
  }
});

test("a timeline change during subscription persistence requests reconciliation after the snapshot", async () => {
  const fixture = fixtureBackend();
  let notify: (update?: TimelineUpdate) => void = () => {};
  const backend = {
    ...fixture.backend,
    subscribe(changed: typeof notify) {
      notify = changed;
      return () => {};
    },
  };
  const host = await createChatHost(backend);
  let entered!: () => void, release!: () => void;
  const enteredPromise = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
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
          host.connect(ws, async () => true, {
            async onSubscriptionChange(value) {
              if (value) {
                entered();
                await gate;
              }
            },
          }),
        );
      },
      message(ws, data) {
        void channels.get(ws)!.receive(String(data));
      },
      close(ws) {
        channels.get(ws)?.close();
        channels.delete(ws);
      },
    },
  });
  const events: ChatTimelineEvent[] = [];
  const opening = openChat(
    new WebSocket(`ws://127.0.0.1:${server.port}`),
    () => {},
    () => {},
    (event) => events.push(event),
  );
  let client: Awaited<typeof opening> | undefined;
  try {
    await enteredPromise;
    notify({ sessionId: "fixture-session", change: { type: "structure" } });
    await host.refresh();
    await Bun.sleep(20);
    release();
    client = await opening;
    await eventually(() =>
      events.some(
        (event) =>
          event.type === "change" && event.update.change.type === "structure",
      ),
    );
  } finally {
    release();
    client?.close();
    host.close();
    for (const ws of channels.keys())
      (ws as import("bun").ServerWebSocket<undefined>).terminate();
    server.unref();
    void server.stop(true);
  }
});

test("a burst of historical updates is bounded and requests an authoritative reread", async () => {
  const fixture = fixtureBackend();
  let notify: (update?: TimelineUpdate) => void = () => {};
  let hold = false,
    release!: () => void,
    entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const enteredPromise = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const backend = {
    ...fixture.backend,
    async read() {
      if (hold) {
        hold = false;
        entered();
        await gate;
      }
      return fixture.backend.read();
    },
    subscribe(changed: typeof notify) {
      notify = changed;
      return () => {};
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
      message(ws, data) {
        void channels.get(ws)!.receive(String(data));
      },
      close(ws) {
        channels.get(ws)?.close();
        channels.delete(ws);
      },
    },
  });
  const events: ChatTimelineEvent[] = [];
  const client = await openChat(
    new WebSocket(`ws://127.0.0.1:${server.port}`),
    () => {},
    () => {},
    (event) => events.push(event),
  );
  try {
    hold = true;
    const update = (i: number): TimelineUpdate => ({
      sessionId: "fixture-session",
      change: {
        type: "item",
        message: {
          id: `m${i}`,
          role: "agent",
          text: `${i}`,
          createdAt: i,
          operationId: null,
          turnId: "turn",
        },
      },
    });
    notify(update(0));
    await enteredPromise;
    for (let i = 1; i <= 110; i++) notify(update(i));
    release();
    await eventually(() =>
      events.some(
        (event) =>
          event.type === "change" && event.update.change.type === "structure",
      ),
    );
    expect(events.length).toBeLessThan(110);
  } finally {
    release();
    client.close();
    host.close();
    for (const ws of channels.keys())
      (ws as import("bun").ServerWebSocket<undefined>).terminate();
    server.unref();
    void server.stop(true);
  }
});
