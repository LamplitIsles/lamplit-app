import {
  validate,
  UploadResultSchema,
} from "../packages/contracts/src/index.ts";
import { expect, test } from "bun:test";
import { createChatHost } from "../packages/contracts/src/server.ts";
import { openChat } from "../packages/contracts/src/client.ts";
import { submissionsFixture } from "./submissions-fixture.ts";
import { fixtureImage } from "./panels-fixture.ts";

test("actual socket contract fences delayed admission, preserves rejection after delete, deduplicates retries and reassociates originals", async () => {
  const fixture = submissionsFixture();
  let host = await createChatHost(fixture.backend, () => {});
  const connections = new Map<object, ReturnType<typeof host.connect>>();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      if (server.upgrade(request)) return;
      return new Response(null, { status: 404 });
    },
    websocket: {
      open(ws) {
        connections.set(
          ws,
          host.connect(ws, async () => true),
        );
      },
      message(ws, raw) {
        void connections.get(ws)!.receive(String(raw));
      },
      close(ws) {
        connections.get(ws)?.close();
        connections.delete(ws);
      },
    },
  });
  let client = await openChat(
    new WebSocket(`ws://127.0.0.1:${server.port}`),
    () => {},
    () => {},
  );
  const sessionId = "fixture-session";
  try {
    const submission = { operationId: crypto.randomUUID(), text: "完整原文" };
    await fixture.control({ action: "mode", state: "slow" });
    const delayed = client.submit(submission);
    await Bun.sleep(20);
    expect(await client.lookup(submission.operationId)).toBeNull();
    expect(
      (await client.finalizeSubmission({ sessionId, submission }))?.state,
    ).toBe("failed");
    await fixture.control({ action: "release" });
    expect((await delayed).state).toBe("failed");
    await expect(
      client.finalizeSubmission({
        sessionId,
        submission: { ...submission, text: "changed" },
      }),
    ).rejects.toThrow();
    await expect(
      client.finalizeSubmission({ sessionId: "wrong", submission }),
    ).rejects.toThrow();
    const retry = {
      sessionId,
      operationId: submission.operationId,
      attemptId: crypto.randomUUID(),
    };
    const receipts = await Promise.all([
      client.retryFailed(retry),
      client.retryFailed(retry),
    ]);
    expect(receipts[0]).toEqual(receipts[1]);
    expect(receipts[0]!.state).toBe("submitted");
    expect(
      (
        await client.finalizeSubmission({
          sessionId,
          submission: { ...submission, operationId: retry.attemptId },
        })
      )?.state,
    ).toBe("submitted");
    expect(
      (await client.deleteFailed({ sessionId, operationId: retry.attemptId }))
        .deleted,
    ).toBe(false);
    expect(
      (
        await client.deleteFailed({
          sessionId,
          operationId: submission.operationId,
        })
      ).deleted,
    ).toBe(true);
    client.close();
    host.close();
    host = await createChatHost(fixture.backend, () => {});
    client = await openChat(
      new WebSocket(`ws://127.0.0.1:${server.port}`),
      () => {},
      () => {},
    );
    expect((await client.submit(submission)).state).toBe("failed");
    expect(
      (
        await client.deleteFailed({
          sessionId,
          operationId: submission.operationId,
        })
      ).deleted,
    ).toBe(true);
    const retrySource = {
      operationId: crypto.randomUUID(),
      text: "retry fence",
    };
    await client.finalizeSubmission({ sessionId, submission: retrySource });
    const unknownRetry = {
      sessionId,
      operationId: retrySource.operationId,
      attemptId: crypto.randomUUID(),
    };
    expect(
      (await client.finalizeSubmission({ sessionId, retry: unknownRetry }))
        ?.state,
    ).toBe("failed");
    expect((await client.retryFailed(unknownRetry)).state).toBe("failed");
    await expect(
      client.retryFailed({
        ...unknownRetry,
        operationId: submission.operationId,
      }),
    ).rejects.toThrow();
    const original = btoa(String.fromCharCode(...fixtureImage));
    const imageOperation = crypto.randomUUID();
    const uploaded = validate(
      UploadResultSchema,
      await fixture.imageBackend.upload({
        sessionId,
        operationId: imageOperation,
        images: [
          {
            id: "original",
            order: 0,
            name: "原图.png",
            mediaType: "image/png",
            original,
            preview: original,
            model: original,
          },
        ],
      }),
    );
    await fixture.control({ action: "mode", state: "failed" });
    expect(
      (
        await client.submit({
          operationId: imageOperation,
          text: "图片原文",
          images: uploaded.images,
        })
      ).state,
    ).toBe("failed");
    await fixture.control({ action: "mode", state: "submitted" });
    const imageRetry = {
      sessionId,
      operationId: imageOperation,
      attemptId: crypto.randomUUID(),
    };
    expect((await client.retryFailed(imageRetry)).state).toBe("submitted");
    const state = await fixture.control({ action: "state" });
    const retried = state.submissions.find(
      (input) => input.operationId === imageRetry.attemptId,
    )!;
    expect(retried.text).toBe("图片原文");
    expect(retried.images![0]!.attachmentId).not.toBe(
      uploaded.images[0]!.attachmentId,
    );
    expect(
      (await fixture.imageBackend.media(
        retried.images![0]!.attachmentId,
        "original",
      ))!.bytes,
    ).toEqual(fixtureImage);
    expect(
      state.messages.filter((m) => m.operationId === imageRetry.attemptId),
    ).toHaveLength(1);
    await fixture.control({ action: "mode", state: "failed" });
    const failedImageAttempt = crypto.randomUUID();
    expect(
      (
        await client.retryFailed({
          ...imageRetry,
          attemptId: failedImageAttempt,
        })
      ).state,
    ).toBe("failed");
    await fixture.control({ action: "missing" });
    const missingAttempt = crypto.randomUUID();
    const missing = await client.retryFailed({
      sessionId,
      operationId: failedImageAttempt,
      attemptId: missingAttempt,
    });
    expect(missing.state).toBe("failed");
    expect(missing.error).toContain("原图片不可用");
    expect(
      (await client.deleteFailed({ sessionId, operationId: missingAttempt }))
        .deleted,
    ).toBe(true);
    expect(
      (await fixture.imageBackend.media(
        retried.images![0]!.attachmentId,
        "original",
      ))!.bytes,
    ).toEqual(fixtureImage);
  } finally {
    client.close();
    host.close();
    server.stop(true);
  }
});
