import { expect, test } from "bun:test";
import {
  validateUpload,
  UploadResultSchema,
  ImageRefSchema,
  MessageSchema,
  PageSchema,
  ViewSchema,
  capabilities,
  validate,
  mediaUrl,
  chatImageThumbnailUrl,
  albumImageThumbnailUrl,
  validateSubmission,
  validateUploadResult,
  validateStickerStageResult,
  validateReceipt,
  type ImageRef,
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
test("animation evidence is positive-only across image reference contexts", () => {
  const input = upload();
  const source = input.images[0]!;
  const ref: ImageRef = {
    attachmentId: "attachment",
    name: source.name,
    mediaType: source.mediaType,
    availability: "available",
  };
  const markedRef: ImageRef = { ...ref, animated: true };
  // @ts-expect-error The public type accepts only positive animation evidence.
  const falseRef: ImageRef = { ...ref, animated: false };
  const sticker = { id: "sticker", version: "a".repeat(64) };
  const stage = {
    sessionId: input.sessionId,
    operationId: input.operationId,
    sticker,
  };
  const check = (value: unknown) => {
    const candidate = value as ImageRef;
    const message = {
      id: "message",
      role: "user",
      text: "",
      createdAt: 1,
      operationId: input.operationId,
      turnId: null,
      images: [candidate],
    };
    const page = { messages: [message], before: null };
    const view = {
      version: 2,
      sessionId: input.sessionId,
      name: "fixture",
      activeTurnId: null,
      contextUsage: { tokens: null, capacity: null },
      compaction: null,
      messages: [message],
      before: null,
      capabilities,
    };
    const submission = {
      operationId: input.operationId,
      text: "",
      images: [candidate],
    };
    const result = {
      sessionId: input.sessionId,
      operationId: input.operationId,
      images: [{ id: source.id, order: 0, ref: candidate }],
    };
    const stickerResult = {
      sessionId: input.sessionId,
      operationId: input.operationId,
      image: { ...candidate, sticker },
    };
    return [
      () => validate(ImageRefSchema, candidate),
      () => validate(MessageSchema, message).images![0],
      () => validate(PageSchema, page).messages[0]!.images![0],
      () => validate(ViewSchema, view).messages[0]!.images![0],
      () => validateSubmission(submission).images![0],
      () => validateUploadResult(result, input).images[0]!.ref,
      () => {
        const { sticker: _, ...image } = validateStickerStageResult(
          stickerResult,
          stage,
        ).image;
        return image;
      },
    ];
  };
  for (const value of [ref, markedRef])
    for (const run of check(value)) expect(run()).toEqual(value);
  expect(() => validate(ImageRefSchema, falseRef)).toThrow();
  for (const bad of [false, "true", 1, null, {}, []])
    for (const run of check({ ...ref, animated: bad })) expect(run).toThrow();
  for (const invalid of [
    { ...ref, extra: true },
    { ...ref, attachmentId: "../bad" },
    { ...ref, mediaType: "text/html" },
  ])
    for (const run of check(invalid)) expect(run).toThrow();
  expect(() =>
    validateUpload(
      { ...input, images: [{ ...source, animated: true }] },
      imageLimits,
    ),
  ).toThrow();
  const receipt = {
    operationId: input.operationId,
    attempt: 1,
    state: "submitted" as const,
    messageId: "message",
    turnId: null,
    error: null,
  };
  expect(validateReceipt(receipt)).toEqual(receipt);
  expect(() => validateReceipt({ ...receipt, images: [ref] })).toThrow();
});
test("bounded strict image upload", () => {
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
  expect(chatImageThumbnailUrl("abc_12-X")).toBe(
    "/api/image-thumbnails/chat/abc_12-X",
  );
  expect(albumImageThumbnailUrl("a".repeat(64))).toBe(
    `/api/image-thumbnails/album/${"a".repeat(64)}`,
  );
  for (const bad of ["", "../x", "a".repeat(101), "abc\n"])
    expect(() => chatImageThumbnailUrl(bad)).toThrow();
  for (const bad of [
    "A".repeat(64),
    "a".repeat(63),
    "z".repeat(64),
    "../x",
    `${"a".repeat(64)}\n`,
  ])
    expect(() => albumImageThumbnailUrl(bad)).toThrow();
});
test("single WebP and paired legacy images share validation and HTTP admission", async () => {
  const fixture = imagesFixture();
  const legacy = upload();
  const { preview, model, ...original } = legacy.images[0]!;
  const single = {
    ...legacy,
    operationId: crypto.randomUUID(),
    images: [
      {
        ...original,
        name: "photo.webp",
        mediaType: "image/webp" as const,
        original: btoa("RIFF\x04\x00\x00\x00WEBP"),
      },
    ],
  };
  const auth = async () => ({
    sessionId: "fixture-session",
    limits: imageLimits,
  });
  expect(validateUpload(single, imageLimits)).toEqual(single);
  expect(
    (await imageHttp(request(single), fixture.imageBackend, auth))?.status,
  ).toBe(200);
  expect(
    (await imageHttp(request(legacy), fixture.imageBackend, auth))?.status,
  ).toBe(200);
  for (const image of [
    { ...original, preview },
    { ...original, model },
    { ...original, preview, model: png },
    { ...single.images[0], original: png },
  ]) {
    expect(() =>
      validateUpload({ ...legacy, images: [image] }, imageLimits),
    ).toThrow();
    expect(
      (
        await imageHttp(
          request({ ...legacy, images: [image] }),
          fixture.imageBackend,
          auth,
        )
      )?.status,
    ).toBe(400);
  }
  expect(() =>
    validateUpload(single, { ...imageLimits, maxImageBytes: 1 }),
  ).toThrow();
  expect(() =>
    validateUpload(single, { ...imageLimits, maxMessageImageBytes: 1 }),
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
    `http://fixture${mediaUrl(result.images[0]!.ref.attachmentId)}`,
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
test("image admission preserves immutable references and history", async () => {
  const fixture = imagesFixture();
  const value = upload();
  const result = validate(
    UploadResultSchema,
    await fixture.imageBackend.upload(value),
  );
  const input = {
    operationId: value.operationId,
    text: "",
    images: result.images.map((item) => item.ref),
  };
  expect((await fixture.backend.submit(input)).state).toBe("submitted");
  await fixture.backend.submit(input);
  expect((await fixture.control({ action: "state" })).executions).toBe(1);
  await expect(
    fixture.backend.submit({ ...input, text: "changed" }),
  ).rejects.toThrow();
  await expect(
    fixture.backend.submit({ ...input, operationId: crypto.randomUUID() }),
  ).rejects.toThrow();
  await fixture.control({ action: "complete" });
  await fixture.control({ action: "history" });
  const view = await fixture.backend.read();
  const history = [...view.messages];
  const cursors = new Set<string>();
  let before = view.before;
  for (let page = 0; before && page < 40; page++) {
    expect(cursors.has(before)).toBe(false);
    cursors.add(before);
    const older = await fixture.backend.history(before);
    expect(older.before).not.toBe(before);
    history.push(...older.messages);
    before = older.before;
  }
  expect(before).toBeNull();
  expect(new Set(history.map((message) => message.id)).size).toBe(
    history.length,
  );
  expect(
    history.find((message) => message.operationId === input.operationId)
      ?.images,
  ).toEqual(input.images);
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
