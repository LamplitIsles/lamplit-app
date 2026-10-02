import { expect, test } from "bun:test";
import {
  validateUpload,
  validateRecovery,
  UploadResultSchema,
  ImageRefSchema,
  validate,
  mediaUrl,
  validateSubmission,
} from "../packages/contracts/src/index.ts";
import { imageHttp } from "../packages/contracts/src/server.ts";
import { imagesFixture, imageLimits } from "./images-fixture.ts";
import { fixtureImage } from "./panels-fixture.ts";
const png = btoa(String.fromCharCode(...fixtureImage));
const jpeg = btoa(String.fromCharCode(255, 216, 255, 224));
const upload = () => ({
  sessionId: "fixture-session",
  operationId: crypto.randomUUID(),
  images: [
    {
      id: crypto.randomUUID(),
      order: 0,
      name: "test.png",
      mediaType: "image/png" as const,
      original: png,
      preview: jpeg,
      model: jpeg,
    },
  ],
});
const request = (input: unknown, headers = {}) =>
  new Request("http://fixture/api/chat/images", {
    method: "POST",
    headers: {
      origin: "http://fixture",
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(input),
  });
test("bounded strict image upload and non-executable uncertain recovery", () => {
  const value = upload();
  expect(() =>
    validateSubmission({ operationId: value.operationId, text: " " }),
  ).toThrow();
  expect(validateUpload(value, imageLimits)).toEqual(value);
  for (const bad of [
    { ...value, extra: true },
    { ...value, images: [{ ...value.images[0], original: "abcd" }] },
    { ...value, images: [{ ...value.images[0], preview: png }] },
    { ...value, images: [{ ...value.images[0], order: 1 }] },
    { ...value, images: [{ ...value.images[0], name: "n".repeat(201) }] },
    { ...value, images: [value.images[0], value.images[0]] },
  ])
    expect(() => validateUpload(bad, imageLimits)).toThrow();
  expect(() =>
    validateUpload(value, { ...imageLimits, maxImageBytes: 1 }),
  ).toThrow();
  expect(() =>
    validateUpload(value, { ...imageLimits, maxMessageImageBytes: 1 }),
  ).toThrow();
  expect(() =>
    validate(ImageRefSchema, {
      attachmentId: "../../file",
      name: "bad",
      mediaType: "image/png",
      availability: "available",
    }),
  ).toThrow();
  expect(() => mediaUrl("https://example.com/a")).toThrow();
  expect(() =>
    validateRecovery({
      sourceId: "x",
      operationId: value.operationId,
      text: "x",
      images: [],
      state: "uncertain",
      replacementEligible: true,
    }),
  ).toThrow();
});
test("HTTP upload authorization, session/order/identity, no admission, media owner isolation and bounds", async () => {
  const fixture = imagesFixture();
  const auth = async () => ({
    sessionId: "fixture-session",
    limits: imageLimits,
  });
  const value = upload();
  expect(
    (await imageHttp(request(value), fixture.imageBackend, async () => null))
      ?.status,
  ).toBe(401);
  expect(
    (
      await imageHttp(
        request(value, { origin: "http://other" }),
        fixture.imageBackend,
        auth,
      )
    )?.status,
  ).toBe(403);
  expect(
    (
      await imageHttp(
        request({ ...value, sessionId: "other" }),
        fixture.imageBackend,
        auth,
      )
    )?.status,
  ).toBe(403);
  expect(
    (
      await imageHttp(
        request(value, { "content-length": "36000001" }),
        fixture.imageBackend,
        auth,
      )
    )?.status,
  ).toBe(413);
  expect(
    (
      await imageHttp(request(value), fixture.imageBackend, async () => ({
        sessionId: "fixture-session",
        limits: false,
      }))
    )?.status,
  ).toBe(503);
  let authCalls = 0;
  expect(
    (
      await imageHttp(request(value), fixture.imageBackend, async () =>
        ++authCalls === 1
          ? { sessionId: "fixture-session", limits: imageLimits }
          : null,
      )
    )?.status,
  ).toBe(403);
  const result = validate(
    UploadResultSchema,
    await (await imageHttp(request(value), fixture.imageBackend, auth))!.json(),
  );
  expect((await fixture.control({ action: "state" })).executions).toBe(0);
  expect(
    await (await imageHttp(request(value), fixture.imageBackend, auth))!.json(),
  ).toEqual(result);
  expect(
    (
      await imageHttp(
        request({
          ...value,
          images: [{ ...value.images[0], name: "changed.png" }],
        }),
        fixture.imageBackend,
        auth,
      )
    )?.status,
  ).toBe(400);
  const get = new Request(
    `http://fixture${mediaUrl(result.images[0]!.attachmentId)}`,
  );
  expect(
    (await imageHttp(get, fixture.imageBackend, async () => null))?.status,
  ).toBe(401);
  expect(
    new Uint8Array(
      await (await imageHttp(get, fixture.imageBackend, auth))!.arrayBuffer(),
    ),
  ).toEqual(fixtureImage);
  expect(
    (
      await imageHttp(
        new Request("http://fixture/api/chat/media/missing/original"),
        fixture.imageBackend,
        auth,
      )
    )?.status,
  ).toBe(404);
});
test("image admission, immutable ordered references, steering, native recovery, replacement and consumption", async () => {
  const fixture = imagesFixture();
  const value = upload();
  const result = validate(
    UploadResultSchema,
    await fixture.imageBackend.upload(value),
  );
  const input = {
    operationId: value.operationId,
    text: "",
    images: result.images,
  };
  expect((await fixture.backend.submit(input)).state).toBe("consumed");
  await fixture.backend.submit(input);
  expect((await fixture.control({ action: "state" })).executions).toBe(1);
  await expect(
    fixture.backend.submit({ ...input, text: "changed" }),
  ).rejects.toThrow();
  await expect(
    fixture.backend.submit({ ...input, operationId: crypto.randomUUID() }),
  ).rejects.toThrow();
  await fixture.control({ action: "mode", state: "unconsumed" });
  const failed = { operationId: crypto.randomUUID(), text: "failed" };
  await fixture.backend.submit(failed);
  const source = (await fixture.backend.read()).recovery[0]!;
  expect(source.replacementEligible).toBe(true);
  await fixture.control({ action: "mode", state: "consumed" });
  const replacement = {
    operationId: crypto.randomUUID(),
    text: "edited",
    replacementSourceIds: [source.sourceId],
  };
  await fixture.backend.submit(replacement);
  const afterReplacement = (await fixture.control({ action: "state" }))
    .executions;
  await fixture.backend.submit(replacement);
  expect((await fixture.control({ action: "state" })).executions).toBe(
    afterReplacement,
  );
  expect((await fixture.backend.read()).recovery).toEqual([]);
  await expect(
    fixture.backend.submit({
      operationId: crypto.randomUUID(),
      text: "again",
      replacementSourceIds: [source.sourceId],
    }),
  ).rejects.toThrow();
  await fixture.control({ action: "mode", state: "uncertain" });
  await fixture.backend.submit({
    operationId: crypto.randomUUID(),
    text: "uncertain",
  });
  const uncertain = (await fixture.backend.read()).recovery[0]!;
  await expect(
    fixture.backend.submit({
      operationId: crypto.randomUUID(),
      text: "unsafe",
      replacementSourceIds: [uncertain.sourceId],
    }),
  ).rejects.toThrow();
  await fixture.control({ action: "consume" });
  expect((await fixture.backend.read()).recovery).toEqual([]);
  await fixture.control({ action: "nativeRecovery" });
  expect((await fixture.backend.read()).recovery[0]!.images).toHaveLength(1);
  await fixture.control({ action: "complete" });
  await fixture.control({ action: "history" });
  const view = await fixture.backend.read();
  expect(
    (await fixture.backend.history(view.before!)).messages.some(
      (m) => m.images?.length,
    ),
  ).toBe(true);
  const album = await fixture.backend.album({
    sessionId: view.sessionId,
    cursor: null,
  });
  expect(album.images.map((i) => i.origin)).toContain("human");
  expect(album.images.map((i) => i.origin)).toContain("agent");
});

test("original media has a finite read bound independent of intake limits", async () => {
  const auth = async () => ({
    sessionId: "fixture-session",
    limits: { ...imageLimits, maxImageBytes: 5 * 1024 * 1024 },
  });
  const get = new Request("http://fixture/api/chat/media/generated/original");
  for (const [size, status] of [
    [6 * 1024 * 1024, 200],
    [32 * 1024 * 1024, 200],
    [32 * 1024 * 1024 + 1, 400],
  ]) {
    const bytes = new Uint8Array(size!);
    bytes.set(fixtureImage);
    const response = await imageHttp(
      get,
      {
        upload: async () => {
          throw new Error("Not an upload");
        },
        media: async () => ({ bytes, mediaType: "image/png" }),
      },
      auth,
    );
    expect(response?.status).toBe(status!);
    if (status === 200)
      expect((await response!.arrayBuffer()).byteLength).toBe(size!);
  }
});
