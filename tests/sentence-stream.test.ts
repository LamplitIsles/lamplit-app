import { expect, test } from "bun:test";
import { ChatController } from "../apps/web/src/lib/chat-controller.ts";
import { CompanionNotifications } from "../apps/web/src/lib/companion/client/notifications.ts";
import {
  initialPreferences,
  SENTENCE_STORAGE_KEY,
  writePreference,
} from "../apps/web/src/lib/companion/client/preferences.ts";
import { ViewSchema, validate } from "../packages/contracts/src/index.ts";
import { createChatHost } from "../packages/contracts/src/server.ts";
import { sentenceFixture } from "./sentence-fixture.ts";

async function until(check: () => boolean) {
  const end = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > end) throw new Error("Timed out");
    await Bun.sleep(10);
  }
}

test("socket refresh grows/removes preview atomically, controller discards disconnected authority, storage/notifications stay complete-only", async () => {
  const fixture = sentenceFixture();
  const errors: unknown[] = [];
  const host = await createChatHost(fixture.backend, (e) => errors.push(e));
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
  let notices = 0;
  class FakeNotice {
    static permission = "granted";
    constructor() {
      notices++;
    }
    close() {}
  }
  const notifications = new CompanionNotifications(
    { isSecureContext: true, Notification: FakeNotice } as unknown as Window &
      typeof globalThis,
    {
      addEventListener() {},
      removeEventListener() {},
      visibilityState: "hidden",
      hasFocus: () => false,
    } as unknown as Document,
    () => ({ title: "Test", body: "New reply" }),
  );
  const snapshots: {
    preview?: string;
    answers: string[];
    active: string | null;
    replyCompleted?: string;
  }[] = [];
  const controller = new ChatController(
    () => {},
    {
      getItem: (key) => saved.get(key) ?? null,
      setItem: (key, value) => {
        saved.set(key, value);
      },
    },
    (view) => {
      snapshots.push({
        preview: view.streamingReply?.text,
        active: view.activeTurnId,
        replyCompleted: view.replyCompletedTurnId,
        answers: view.messages
          .filter((m) => m.role === "agent")
          .map((m) => m.text),
      });
      notifications.observe(view);
    },
  );
  try {
    controller.start();
    await until(() => controller.connected);
    fixture.control({ action: "start", text: "First" });
    await host.refresh();
    await until(() => controller.view?.streamingReply?.text === "First");
    const id = controller.view!.streamingReply!.id;
    fixture.control({ action: "advance", text: "First sentence. Second" });
    await host.refresh();
    await until(
      () => controller.view?.streamingReply?.text === "First sentence. Second",
    );
    expect(controller.view!.streamingReply!.id).toBe(id);
    expect(notices).toBe(0);
    expect([...saved.values()].join("")).not.toContain("First");
    for (const channel of channels.values()) channel.disconnect();
    await until(() => !controller.connected);
    expect(controller.view?.streamingReply).toBeUndefined();
    await until(() => controller.connected);
    expect(controller.view?.streamingReply?.text).toBe(
      "First sentence. Second",
    );
    fixture.control({
      action: "body-complete",
      text: "First sentence. Second completed.",
    });
    await host.refresh();
    await until(
      () =>
        controller.view?.messages.some(
          (m) => m.text === "First sentence. Second completed.",
        ) === true,
    );
    const turn = controller.view!.activeTurnId;
    expect(turn).not.toBeNull();
    expect(controller.view?.replyCompletedTurnId).toBe(turn!);
    expect(
      snapshots
        .filter((s) => s.answers.includes("First sentence. Second completed."))
        .every((s) => s.replyCompleted === s.active && s.active === turn),
    ).toBe(true);
    for (const channel of channels.values()) channel.disconnect();
    await until(() => !controller.connected);
    await until(() => controller.connected);
    expect(controller.view?.replyCompletedTurnId).toBe(turn!);
    fixture.control({ action: "evidence" });
    await host.refresh();
    await until(() => controller.view?.replyCompletedTurnId === undefined);
    fixture.control({ action: "finish-execution" });
    await host.refresh();
    await until(() => controller.view?.activeTurnId === null);
    expect(controller.view?.streamingReply).toBeUndefined();
    expect(
      snapshots
        .filter((s) => s.answers.includes("First sentence. Second completed."))
        .every((s) => s.preview === undefined),
    ).toBe(true);
    expect(notices).toBe(1);
    expect(controller.older.some((m) => m.id.startsWith("attempt"))).toBe(
      false,
    );
    expect(errors).toEqual([]);
    fixture.control({ action: "start", text: "Discard on close" });
    await host.refresh();
    await until(() => !!controller.view?.streamingReply);
    controller.close();
    expect(controller.view?.streamingReply).toBeUndefined();
  } finally {
    controller.close();
    notifications.close();
    host.close();
    server.stop(true);
    if (previousLocation)
      Object.defineProperty(globalThis, "location", previousLocation);
    else Reflect.deleteProperty(globalThis, "location");
  }
});

test("sentence preference defaults on and tolerates unavailable storage", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const storage = new Map<string, string>();
  try {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
      },
    });
    expect(initialPreferences().sentenceReplies).toBe(true);
    writePreference(SENTENCE_STORAGE_KEY, "false");
    expect(initialPreferences().sentenceReplies).toBe(false);
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new Error("Unavailable storage");
      },
    });
    expect(initialPreferences().sentenceReplies).toBe(true);
    expect(() => writePreference(SENTENCE_STORAGE_KEY, "false")).not.toThrow();
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});

test("final-body evidence validates as an optional bounded turn identity", async () => {
  const view = await sentenceFixture().backend.read();
  expect(validate(ViewSchema, view).replyCompletedTurnId).toBeUndefined();
  expect(
    validate(ViewSchema, { ...view, replyCompletedTurnId: "turn" })
      .replyCompletedTurnId,
  ).toBe("turn");
  for (const invalid of [null, false, 1, "", "x".repeat(301)])
    expect(() =>
      validate(ViewSchema, { ...view, replyCompletedTurnId: invalid }),
    ).toThrow();
});
