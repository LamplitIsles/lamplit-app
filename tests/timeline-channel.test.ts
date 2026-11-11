import { expect, test } from "bun:test";

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
