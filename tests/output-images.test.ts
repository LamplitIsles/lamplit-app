import { expect, test } from "bun:test";
import { createChatHost } from "../packages/contracts/src/server.ts";
import { openChat } from "../packages/contracts/src/client.ts";
import {
  MessageSchema,
  validate,
  validateRecovery,
  validateSubmission,
  validateUpload,
  type ChatView,
} from "../packages/contracts/src/index.ts";
import { imagesFixture, imageLimits } from "./images-fixture.ts";

for (const count of [6, 7, 11])
  for (const historyOnly of [false, true])
    test(`output ${count} (${historyOnly ? "history" : "initial"}) references survive public host, wire client, history and refresh`, async () => {
      const fixture = imagesFixture();
      const state = await fixture.control({ action: "complete", count });
      const message = state.messages[0]!;
      const host = await createChatHost({
        ...fixture.backend,
        async read() {
          const view = await fixture.backend.read();
          return historyOnly ? { ...view, messages: [] } : view;
        },
        async history() {
          return { messages: [message], before: null };
        },
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
      let view: ChatView | undefined,
        offline = false;
      const client = await openChat(
        new WebSocket(`ws://127.0.0.1:${server.port}`),
        (v) => {
          view = v;
        },
        () => {
          offline = true;
        },
      );
      try {
        expect(view!.messages).toEqual(historyOnly ? [] : [message]);
        expect((await client.history(message.id)).messages).toEqual([message]);
        expect(offline).toBe(false);
        if (historyOnly) return;
        const next = await fixture.control({ action: "complete", count });
        await host.refresh();
        const end = Date.now() + 3000;
        while (view!.messages.length !== 2 && Date.now() < end)
          await Bun.sleep(10);
        expect(view!.messages).toEqual(next.messages);
        expect(offline).toBe(false);
        for (const role of ["agent", "user", "notice"] as const)
          expect(validate(MessageSchema, { ...message, role })).toEqual({
            ...message,
            role,
          });
      } finally {
        client.close();
        host.close();
        for (const ws of channels.keys())
          (ws as import("bun").ServerWebSocket<undefined>).terminate();
        server.unref();
        void server.stop(true);
      }
    });

test("output references stay strict while submission, upload and recovery retain six-image bounds", async () => {
  const fixture = imagesFixture();
  const { messages } = await fixture.control({ action: "complete", count: 7 });
  const message = messages[0]!,
    images = message.images!;
  const operationId = crypto.randomUUID();
  for (const bad of [
    { ...images[0], attachmentId: "../bad" },
    { ...images[0], extra: true },
    { ...images[0], mediaType: "text/html" },
  ])
    expect(() =>
      validate(MessageSchema, {
        ...message,
        images: [...images.slice(0, 6), bad],
      }),
    ).toThrow();
  const submission = { operationId, text: "owned", images };
  const recovery = {
    sourceId: operationId,
    ...submission,
    replacementEligible: true,
  };
  const original = btoa("\x89PNG\r\n\x1a\n");
  const upload = {
    sessionId: "fixture-session",
    operationId,
    images: images.map((ref, order) => ({
      id: ref.attachmentId,
      name: ref.name,
      order,
      mediaType: ref.mediaType,
      original,
      preview: "/9j/4A==",
      model: "/9j/4A==",
    })),
  };
  expect(
    validateSubmission({ ...submission, images: images.slice(0, 6) }).images,
  ).toHaveLength(6);
  expect(
    validateRecovery({ ...recovery, images: images.slice(0, 6) }).images,
  ).toHaveLength(6);
  expect(
    validateUpload(
      { ...upload, images: upload.images.slice(0, 6) },
      imageLimits,
    ).images,
  ).toHaveLength(6);
  expect(() => validateSubmission(submission)).toThrow();
  expect(() => validateRecovery(recovery)).toThrow();
  expect(() => validateUpload(upload, imageLimits)).toThrow();
});

test("output metadata still obeys 2 MiB frames and 4 MiB backpressure", async () => {
  for (const [count, bufferedAmount] of [
    [8000, 0],
    [11, 4 * 1024 * 1024],
  ]) {
    const fixture = imagesFixture();
    const { messages } = await fixture.control({ action: "complete", count });
    messages[0]!.images!.forEach((ref) => {
      ref.name = "n".repeat(200);
    });
    const host = await createChatHost(fixture.backend);
    const sent: string[] = [],
      closed: number[] = [];
    const connection = host.connect(
      {
        bufferedAmount,
        send(raw) {
          sent.push(raw);
        },
        close(code) {
          closed.push(code!);
        },
      },
      async () => true,
    );
    try {
      await connection.receive(
        JSON.stringify({
          type: "call",
          version: 1,
          id: "1",
          call: {
            serviceId: "$chord.service",
            member: "subscribe",
            args: ["guard", "lamplit.chat.v2", "singleton"],
          },
        }),
      );
      expect(closed).toEqual([1013]);
      expect(sent).toEqual([]);
    } finally {
      connection.close();
      host.close();
    }
  }
});
