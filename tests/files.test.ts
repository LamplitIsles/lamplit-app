import { expect, test } from "bun:test";
import {
  FileRefSchema,
  MessageSchema,
  ViewSchema,
  capabilities,
  fileDownloadUrl,
  validate,
  validateFileManifest,
  validateFileUploadResult,
  validateRecovery,
  validateRetryFileMapping,
  validateSubmission,
} from "../packages/contracts/src/index.ts";
import { fileHttp, fileStreamHttp } from "../packages/contracts/src/server.ts";
import { fileLimits, filesFixture } from "./files-fixture.ts";
import {
  createFileDrafts,
  fileIntakeError,
} from "../apps/web/src/lib/file-upload.ts";

const operationId = () => crypto.randomUUID();
const upload = () => ({
  sessionId: "fixture-session",
  operationId: operationId(),
  files: [
    {
      id: "one",
      name: '../"\r\n<script>.bin',
      mediaType: "",
      size: 4,
    },
    {
      id: "empty",
      name: "空文件",
      mediaType: "application/x-unknown",
      size: 0,
    },
  ],
});
const request = (value: unknown, headers: Record<string, string> = {}) =>
  new Request("http://fixture/api/chat/file-operations", {
    method: "POST",
    headers: {
      origin: "http://fixture",
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(value),
  });
const owner = { ownerId: "owner", sessionId: "fixture-session" };
const auth = async () => ({
  ownerId: "owner",
  sessionId: "fixture-session",
  limits: fileLimits,
});

test("strict file limits, empty and arbitrary bytes, mixed submission, history and recovery", async () => {
  const value = upload();
  expect(validateFileManifest(value, fileLimits)).toEqual(value);
  for (const files of [
    [value.files[0], value.files[0]],
    Array.from({ length: 7 }, (_, order) => ({
      ...value.files[1],
      id: `f${order}`,
    })),
  ])
    expect(() =>
      validateFileManifest({ ...value, files }, fileLimits),
    ).toThrow();
  expect(() =>
    validateFileManifest(value, { ...fileLimits, maxFileBytes: 3 }),
  ).toThrow();
  expect(() =>
    validateFileManifest(value, { ...fileLimits, maxMessageFileBytes: 3 }),
  ).toThrow();
  expect(fileIntakeError([], [new File([], "empty")], undefined)).toBe(
    "unavailable",
  );
  const f = filesFixture();
  const result = await stage(f, value);
  const refs = result.files.map((file) => file.ref);
  expect(
    validateSubmission({
      operationId: value.operationId,
      text: "",
      files: refs,
    }).files,
  ).toEqual(refs);
  const image = {
    attachmentId: "img",
    name: "a.png",
    mediaType: "image/png",
    availability: "available",
  };
  expect(
    validateSubmission({
      operationId: value.operationId,
      text: "mixed",
      images: [image],
      files: refs,
    }).files,
  ).toEqual(refs);
  expect(
    validateRecovery({
      sourceId: "source",
      operationId: value.operationId,
      text: "",
      images: [],
      files: refs,
      replacementEligible: true,
    }).files,
  ).toEqual(refs);
  expect(
    validate(MessageSchema, {
      id: "msg",
      role: "user",
      text: "",
      createdAt: 1,
      operationId: value.operationId,
      turnId: null,
      files: refs,
    }).files,
  ).toEqual(refs);
  expect(
    validate(ViewSchema, {
      version: 2,
      sessionId: "s",
      name: "",
      activeTurnId: null,
      contextUsage: { tokens: null, capacity: null },
      compaction: null,
      messages: [],
      before: null,
      recovery: [],
      capabilities,
    }).capabilities.files,
  ).toBeUndefined();
  expect(() =>
    validate(FileRefSchema, { ...refs[0], attachmentId: "../escape" }),
  ).toThrow();
  expect(() => fileDownloadUrl("../escape")).toThrow();
  expect(() =>
    validateFileUploadResult(
      {
        ...result,
        files: [
          { ...result.files[0], ref: { ...refs[0], size: 0 } },
          result.files[1],
        ],
      },
      value,
    ),
  ).toThrow();
  expect(() =>
    validateRetryFileMapping(
      {
        sessionId: "fixture-session",
        sourceOperationId: value.operationId,
        files: refs.map((ref) => ({
          sourceAttachmentId: ref.attachmentId,
          ref: { ...ref, name: "changed" },
        })),
      },
      "fixture-session",
      value.operationId,
      refs,
    ),
  ).toThrow();
});

async function stage(
  f: ReturnType<typeof filesFixture>,
  value: ReturnType<typeof upload>,
) {
  const reserved = (await fileStreamHttp(request(value), f.backend, auth))!;
  expect(reserved.status).toBe(200);
  for (const [i, item] of value.files.entries()) {
    const bytes = i === 0 ? new Uint8Array([0, 255, 1, 128]) : new Uint8Array();
    const req = new Request(
      `http://fixture/api/chat/file-operations/${value.operationId}/files/${item!.id}`,
      {
        method: "PUT",
        headers: {
          origin: "http://fixture",
          "content-type": "application/octet-stream",
        },
        body: bytes,
      },
    );
    expect((await fileStreamHttp(req, f.backend, auth))!.status).toBe(204);
  }
  const complete = new Request(
    `http://fixture/api/chat/file-operations/${value.operationId}/complete`,
    { method: "POST", headers: { origin: "http://fixture" } },
  );
  return validateFileUploadResult(
    await (await fileStreamHttp(complete, f.backend, auth))!.json(),
    value,
  );
}

test("private streaming HTTP authenticates, checks origin/session and preserves bytes", async () => {
  const f = filesFixture(),
    value = upload();
  expect(
    (await fileStreamHttp(request(value), f.backend, async () => null))?.status,
  ).toBe(401);
  expect(
    (
      await fileStreamHttp(
        request(value, { origin: "http://other" }),
        f.backend,
        auth,
      )
    )?.status,
  ).toBe(403);
  expect(
    (
      await fileStreamHttp(
        request({ ...value, sessionId: "other" }),
        f.backend,
        auth,
      )
    )?.status,
  ).toBe(403);
  expect(
    (
      await fileStreamHttp(request(value), f.backend, async () => ({
        ...owner,
        limits: false,
      }))
    )?.status,
  ).toBe(503);
  const result = await stage(f, value);
  expect(
    (
      await fileStreamHttp(
        request({
          ...value,
          files: [{ ...value.files[0], name: "changed" }, value.files[1]],
        }),
        f.backend,
        auth,
      )
    )?.status,
  ).toBe(400);
  const get = new Request(
    `http://fixture${fileDownloadUrl(result.files[0]!.ref.attachmentId)}`,
  );
  expect((await fileHttp(get, f.backend, async () => null))?.status).toBe(401);
  expect(
    (
      await fileHttp(get, f.backend, async () => ({
        ...owner,
        ownerId: "other",
        limits: fileLimits,
      }))
    )?.status,
  ).toBe(404);
  let calls = 0;
  expect(
    (
      await fileHttp(get, f.backend, async () => ({
        ...owner,
        ownerId: ++calls === 1 ? "owner" : "other",
        limits: fileLimits,
      }))
    )?.status,
  ).toBe(403);
  const download = (await fileHttp(get, f.backend, auth))!;
  expect(download.headers.get("content-type")).toBe("application/octet-stream");
  expect(download.headers.get("content-disposition")).toBe("attachment");
  expect(download.headers.get("content-security-policy")).toContain("sandbox");
  expect([...new Uint8Array(await download.arrayBuffer())]).toEqual([
    0, 255, 1, 128,
  ]);
  expect(
    (
      await fileHttp(
        new Request("http://fixture/api/chat/files/missing"),
        f.backend,
        auth,
      )
    )?.status,
  ).toBe(404);
  expect(
    await fileHttp(
      new Request("http://fixture/api/chat/files", { method: "POST" }),
      f.backend,
      auth,
    ),
  ).toBeUndefined();
});

test("controller retains file identity through uncertain admission and explicit retry", async () => {
  const { ChatController } =
    await import("../apps/web/src/lib/chat-controller.ts");
  const f = filesFixture();
  const originalFetch = globalThis.fetch;
  const previousLocation = Object.getOwnPropertyDescriptor(
    globalThis,
    "location",
  );
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: { href: "http://fixture/" },
  });
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) =>
      (await fileStreamHttp(
        new Request(input, {
          ...init,
          // Bun's empty File reader differs from its HTTP byte-stream reader.
          ...(init?.body instanceof File && init.body.size === 0
            ? { body: new Uint8Array() }
            : {}),
          headers: { ...init?.headers, origin: "http://fixture" },
        }),
        f.backend,
        auth,
      ))!,
    { preconnect: originalFetch.preconnect },
  );
  const saved = new Map<string, string>();
  const storage = {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => {
      saved.set(key, value);
    },
  };
  const controller = new ChatController(() => {}, storage);
  const c = controller as any;
  const sessionId = "fixture-session";
  const view = {
    version: 2,
    sessionId,
    name: "",
    activeTurnId: null,
    contextUsage: { tokens: null, capacity: null },
    compaction: null,
    messages: [],
    before: null,
    recovery: [],
    capabilities: { ...capabilities, files: fileLimits },
  };
  let submits = 0,
    lookups = 0,
    retries = 0,
    input: any;
  const client = {
    close() {},
    async submit(value: any) {
      submits++;
      input = value;
      throw new Error("ack lost");
    },
    async lookup() {
      lookups++;
      return null;
    },
    async finalizeSubmission() {
      return null;
    },
    async retryFailed(value: any) {
      retries++;
      return {
        operationId: value.attemptId,
        state: "submitted",
        messageId: null,
        turnId: null,
        error: null,
        retryFiles: {
          sessionId,
          sourceOperationId: value.operationId,
          files: input.files.map((ref: any) => ({
            sourceAttachmentId: ref.attachmentId,
            ref: { ...ref, attachmentId: `retry_${ref.attachmentId}` },
          })),
        },
      };
    },
  };
  c.view = view;
  c.client = client;
  c.storageKey = `lamplit.pending:${sessionId}`;
  try {
    await controller.send(
      "",
      undefined,
      [],
      [],
      undefined,
      undefined,
      createFileDrafts([
        new File([new Uint8Array([0, 255])], "data.bin"),
        new File([], "empty"),
      ]),
    );
    expect(submits).toBe(1);
    expect(input.files.map((ref: any) => ref.size)).toEqual([2, 0]);
    expect(controller.pending[0]?.state).toBe("sending");
    expect(
      JSON.parse(saved.get(`lamplit.pending:${sessionId}`)!)[0].files,
    ).toEqual(input.files);
    await c.reconcile();
    expect(lookups).toBeGreaterThan(0);
    expect(submits).toBe(1);
    const reopened = new ChatController(() => {}, storage);
    const reopenedInternal = reopened as any;
    reopenedInternal.hydrate(sessionId);
    reopenedInternal.view = view;
    reopenedInternal.client = client;
    expect(reopened.pending[0]?.files).toEqual(input.files);
    await reopenedInternal.reconcile();
    expect(reopened.pending[0]?.state).toBe("sending");
    expect(submits).toBe(1);
    reopened.close();
    c.applyReceipt({
      operationId: input.operationId,
      state: "failed",
      messageId: null,
      turnId: null,
      error: "definite failure",
    });
    expect(controller.pending[0]?.state).toBe("failed");
    await controller.retryFailed(input.operationId);
    expect(retries).toBe(1);
    expect(controller.pending[0]?.files).toEqual(input.files);
    expect(controller.pending[0]?.state).toBe("sending");
    c.view = {
      ...view,
      messages: [
        {
          id: "retry",
          role: "user",
          text: "",
          createdAt: 1,
          operationId: controller.pending[0]!.operationId,
          turnId: null,
          files: input.files.map((ref: any) => ({
            ...ref,
            attachmentId: `retry_${ref.attachmentId}`,
          })),
        },
      ],
    };
    c.retireObserved();
    expect(controller.pending).toEqual([]);
  } finally {
    controller.close();
    globalThis.fetch = originalFetch;
    if (previousLocation)
      Object.defineProperty(globalThis, "location", previousLocation);
    else delete (globalThis as any).location;
  }
});

test("controller does not submit after session changes away and back while upload is in flight", async () => {
  const { ChatController } =
    await import("../apps/web/src/lib/chat-controller.ts");
  const originalFetch = globalThis.fetch;
  const previousLocation = Object.getOwnPropertyDescriptor(
    globalThis,
    "location",
  );
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: { href: "http://fixture/" },
  });
  let finish!: (response: Response) => void;
  let uploaded: any;
  globalThis.fetch = Object.assign(
    async (_input: RequestInfo | URL, init?: RequestInit) => {
      uploaded = JSON.parse(String(init?.body));
      return await new Promise<Response>((resolve) => {
        finish = resolve;
      });
    },
    { preconnect: originalFetch.preconnect },
  );
  let submits = 0;
  const c = new ChatController(() => {}, {
    getItem: () => null,
    setItem: () => {},
  });
  const internal = c as any;
  internal.view = {
    sessionId: "fixture-session",
    capabilities: { files: fileLimits },
    recovery: [],
  };
  internal.storageKey = "lamplit.pending:fixture-session";
  internal.client = {
    close() {},
    async submit() {
      submits++;
    },
  };
  try {
    const sending = c.send(
      "x",
      undefined,
      [],
      [],
      undefined,
      undefined,
      createFileDrafts([new File(["a"], "file")]),
    );
    while (!finish) await new Promise((resolve) => setTimeout(resolve, 0));
    internal.hydrate("other");
    internal.view = {
      sessionId: "other",
      capabilities: { files: fileLimits },
      recovery: [],
    };
    internal.hydrate("fixture-session");
    internal.view = {
      sessionId: "fixture-session",
      capabilities: { files: fileLimits },
      recovery: [],
    };
    finish(Response.json({ manifest: uploaded, uploaded: [] }));
    await sending;
    expect(submits).toBe(0);
  } finally {
    c.close();
    globalThis.fetch = originalFetch;
    if (previousLocation)
      Object.defineProperty(globalThis, "location", previousLocation);
    else delete (globalThis as any).location;
  }
});

test("controller stages mixed image and file independently and submits both", async () => {
  const { ChatController } =
    await import("../apps/web/src/lib/chat-controller.ts");
  const { imagesFixture, imageLimits } = await import("./images-fixture.ts");
  const { fixtureImage } = await import("./panels-fixture.ts");
  const { imageHttp } = await import("../packages/contracts/src/server.ts");
  const imageFixture = imagesFixture();
  const fileFixture = filesFixture();
  const descriptors = new Map(
    ["location", "document", "createImageBitmap", "fetch"].map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: { href: "http://fixture/" },
  });
  Object.defineProperty(globalThis, "createImageBitmap", {
    configurable: true,
    value: async () => ({ width: 1, height: 1, close() {} }),
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      createElement: () => ({
        getContext: () => ({ drawImage() {} }),
        toBlob: (cb: (blob: Blob) => void) =>
          cb(
            new Blob([new Uint8Array([255, 216, 255, 224])], {
              type: "image/jpeg",
            }),
          ),
      }),
    },
  });
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, {
        ...init,
        headers: { ...init?.headers, origin: "http://fixture" },
      });
      return new URL(request.url).pathname === "/api/chat/images"
        ? await imageHttp(request, imageFixture.imageBackend, async () => ({
            sessionId: "fixture-session",
            limits: imageLimits,
          }))
        : await fileStreamHttp(request, fileFixture.backend, auth);
    },
  });
  let submission: any;
  const controller = new ChatController(() => {}, {
    getItem: () => null,
    setItem: () => {},
  });
  const c = controller as any;
  c.storageKey = "lamplit.pending:fixture-session";
  c.view = {
    sessionId: "fixture-session",
    capabilities: { images: imageLimits, files: fileLimits },
    recovery: [],
  };
  c.client = {
    close() {},
    async submit(input: any) {
      submission = input;
      return {
        operationId: input.operationId,
        state: "submitted",
        messageId: null,
        turnId: null,
        error: null,
      };
    },
  };
  try {
    const photo = new File([fixtureImage], "photo.png", { type: "image/png" });
    await controller.send(
      "mixed",
      undefined,
      [{ id: "photo", file: photo, previewUrl: "blob:preview" }],
      [],
      undefined,
      undefined,
      createFileDrafts([new File([new Uint8Array([0, 255])], "data.bin")]),
    );
    expect(submission.text).toBe("mixed");
    expect(submission.images[0].name).toBe("photo.png");
    expect(submission.files[0].name).toBe("data.bin");
    expect(submission.files[0].size).toBe(2);
    expect(controller.pending[0]?.state).toBe("sent");
    expect(fileFixture.uploads.size).toBe(1);
  } finally {
    controller.close();
    for (const [key, descriptor] of descriptors)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as any)[key];
  }
});

test("paginated history transports available and missing file references", async () => {
  const { fixtureBackend } = await import("./fixture.ts");
  const { createChatHost } =
    await import("../packages/contracts/src/server.ts");
  const { openChat } = await import("../packages/contracts/src/client.ts");
  const refs = [
    {
      attachmentId: "kept",
      name: "history.bin",
      mediaType: "application/octet-stream",
      size: 2,
      availability: "available" as const,
    },
    {
      attachmentId: "lost",
      name: "missing.txt",
      mediaType: "text/plain",
      size: 0,
      availability: "missing" as const,
    },
  ];
  const message = {
    id: "history-file",
    role: "user" as const,
    text: "older",
    createdAt: 1,
    operationId: operationId(),
    turnId: null,
    files: refs,
  };
  const host = await createChatHost({
    ...fixtureBackend().backend,
    async history() {
      return { messages: [message], before: null };
    },
  });
  const channels = new Map<object, ReturnType<typeof host.connect>>();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, server) {
      return server.upgrade(req)
        ? undefined
        : new Response(null, { status: 404 });
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
  const client = await openChat(
    new WebSocket(`ws://127.0.0.1:${server.port}`),
    () => {},
    () => {},
  );
  try {
    expect(await client.history("cursor")).toEqual({
      messages: [message],
      before: null,
    });
  } finally {
    client.close();
    host.close();
    void server.stop(true);
  }
});

test("file retries retain original references until mapped observation agrees", async () => {
  const { ChatController } =
    await import("../apps/web/src/lib/chat-controller.ts");
  for (const mixed of [false, true]) {
    const sessionId = "retry-session",
      source = operationId(),
      attempt = operationId();
    const originalFile = {
      attachmentId: "old_file",
      name: "original.txt",
      mediaType: "text/plain",
      size: 1,
      availability: "available" as const,
    };
    const mappedFile = { ...originalFile, attachmentId: "new_file" };
    const image = {
      attachmentId: "old_image",
      name: "photo.png",
      mediaType: "image/png" as const,
      availability: "available" as const,
    };
    const mappedImage = { ...image, attachmentId: "new_image" };
    const message = {
      id: "observed",
      role: "user" as const,
      text: "retry",
      createdAt: 1,
      operationId: attempt,
      turnId: null,
      files: [{ ...mappedFile, name: "unverified.txt" }],
      ...(mixed ? { images: [mappedImage] } : {}),
    };
    const receipt = {
      operationId: attempt,
      state: "submitted" as const,
      messageId: "observed",
      turnId: null,
      error: null,
      retryFiles: {
        sessionId,
        sourceOperationId: source,
        files: [
          { sourceAttachmentId: originalFile.attachmentId, ref: mappedFile },
        ],
      },
      ...(mixed
        ? {
            retryImages: {
              sessionId,
              sourceOperationId: source,
              images: [
                { sourceAttachmentId: image.attachmentId, ref: mappedImage },
              ],
            },
          }
        : {}),
    };
    const saved = new Map<string, string>();
    const controller = new ChatController(() => {}, {
      getItem: (key) => saved.get(key) ?? null,
      setItem: (key, value) => {
        saved.set(key, value);
      },
    });
    const c = controller as any;
    let lookups = 0,
      resends = 0;
    c.client = {
      close() {},
      async lookup() {
        lookups++;
        return null;
      },
      async submit() {
        resends++;
      },
      async retryFailed() {
        resends++;
      },
    };
    c.storageKey = `lamplit.pending:${sessionId}`;
    c.view = { sessionId, messages: [message], recovery: [] };
    c.pending = [
      {
        operationId: attempt,
        retrySource: source,
        logicalId: source,
        text: "retry",
        files: [originalFile],
        ...(mixed ? { images: [image] } : {}),
        state: "sending",
        dispatched: true,
        createdAt: Date.now(),
      },
    ];
    if (mixed)
      c.localPreviews = [
        {
          sessionId,
          operationId: source,
          draftId: "draft",
          order: 0,
          attachmentId: image.attachmentId,
          previewUrl: "blob:photo",
        },
      ];
    try {
      c.retireObserved();
      expect(controller.pending[0]?.files).toEqual([originalFile]);
      await c.reconcile();
      expect(lookups).toBe(1);
      expect(resends).toBe(0);
      c.applyReceipt({ ...receipt, retryFiles: undefined });
      expect(controller.pending[0]?.state).toBe("sending");
      c.applyReceipt({
        ...receipt,
        retryFiles: {
          ...receipt.retryFiles,
          files: [{ sourceAttachmentId: "wrong", ref: mappedFile }],
        },
      });
      expect(controller.pending[0]?.files).toEqual([originalFile]);
      if (mixed) {
        c.applyReceipt({ ...receipt, retryImages: undefined });
        expect(controller.pending[0]?.state).toBe("sending");
      }
      c.applyReceipt(receipt);
      expect(controller.pending[0]?.state).toBe("sending");
      expect(controller.pending[0]?.files).toEqual([originalFile]);
      c.view = {
        ...c.view,
        messages: [
          { ...message, files: [{ ...mappedFile, availability: "missing" }] },
        ],
      };
      c.retireObserved();
      expect(controller.pending).toHaveLength(0);
      if (mixed)
        expect(controller.localPreviews[0]).toMatchObject({
          operationId: attempt,
          attachmentId: mappedImage.attachmentId,
        });
      expect(resends).toBe(0);
    } finally {
      controller.close();
    }
  }
});

test("file retry receipt before message retires after observation; stale A-B-A lookup cannot verify it", async () => {
  const { ChatController } =
    await import("../apps/web/src/lib/chat-controller.ts");
  const source = operationId(),
    attempt = operationId();
  const original = {
    attachmentId: "original",
    name: "x",
    mediaType: "",
    size: 0,
    availability: "available" as const,
  };
  const mapped = { ...original, attachmentId: "new" };
  const receipt = {
    operationId: attempt,
    state: "submitted" as const,
    messageId: "m",
    turnId: null,
    error: null,
    retryFiles: {
      sessionId: "A",
      sourceOperationId: source,
      files: [{ sourceAttachmentId: original.attachmentId, ref: mapped }],
    },
  };
  const pending = {
    operationId: attempt,
    retrySource: source,
    text: "",
    files: [original],
    state: "sending",
    dispatched: true,
    createdAt: Date.now(),
  };
  const saved = new Map<string, string>([
    ["lamplit.pending:A", JSON.stringify([pending])],
  ]);
  const controller = new ChatController(() => {}, {
    getItem: (key) => saved.get(key) ?? null,
    setItem: (key, value) => {
      saved.set(key, value);
    },
  });
  const c = controller as any;
  let resolveLookup!: (value: typeof receipt) => void;
  c.client = {
    close() {},
    lookup: () =>
      new Promise((resolve) => {
        resolveLookup = resolve;
      }),
  };
  c.hydrate("A");
  c.view = { sessionId: "A", messages: [], recovery: [] };
  try {
    const lookup = c.reconcile();
    c.hydrate("B");
    c.view = { sessionId: "B", messages: [], recovery: [] };
    c.hydrate("A");
    c.view = { sessionId: "A", messages: [], recovery: [] };
    resolveLookup(receipt);
    await lookup;
    c.view = {
      ...c.view,
      messages: [
        {
          id: "m",
          role: "user",
          text: "",
          createdAt: 1,
          operationId: attempt,
          turnId: null,
          files: [mapped],
        },
      ],
    };
    c.retireObserved();
    expect(controller.pending[0]?.files).toEqual([original]);
    c.view = { ...c.view, messages: [] };
    c.applyReceipt(receipt);
    expect(controller.pending[0]?.state).toBe("sending");
    c.view = {
      ...c.view,
      messages: [
        {
          id: "m",
          role: "user",
          text: "",
          createdAt: 1,
          operationId: attempt,
          turnId: null,
          files: [mapped],
        },
      ],
    };
    c.retireObserved();
    expect(controller.pending).toEqual([]);
  } finally {
    controller.close();
  }
});

test("observed file retry is released by a valid receipt and unresolved fences are rechecked without replay", async () => {
  const { ChatController } =
    await import("../apps/web/src/lib/chat-controller.ts");
  const source = operationId(),
    attempt = operationId();
  const original = {
    attachmentId: "old",
    name: "file.bin",
    mediaType: "",
    size: 0,
    availability: "available" as const,
  };
  const mapped = { ...original, attachmentId: "mapped" };
  const message = {
    id: "m",
    role: "user",
    operationId: attempt,
    text: "",
    turnId: null,
    createdAt: 1,
    files: [mapped],
  };
  const receipt = {
    operationId: attempt,
    state: "submitted",
    messageId: "m",
    turnId: null,
    error: null,
    retryFiles: {
      sessionId: "s",
      sourceOperationId: source,
      files: [{ sourceAttachmentId: "old", ref: mapped }],
    },
  };
  const c = new ChatController(() => {}, {
    getItem: () => null,
    setItem: () => {},
  });
  const internal = c as any;
  let finalizations = 0,
    resends = 0;
  internal.storageKey = "lamplit.pending:s";
  internal.view = { sessionId: "s", messages: [message], recovery: [] };
  internal.pending = [
    {
      operationId: attempt,
      retrySource: source,
      text: "",
      files: [original],
      state: "sending",
      dispatched: true,
      createdAt: Date.now() - 61000,
    },
  ];
  internal.client = {
    close() {},
    async finalizeSubmission() {
      finalizations++;
      return finalizations === 1 ? null : receipt;
    },
    async retryFailed() {
      resends++;
    },
    async submit() {
      resends++;
    },
  };
  try {
    internal.retireObserved();
    await internal.reconcile();
    expect(c.pending).toHaveLength(1);
    expect(finalizations).toBe(1);
    await internal.reconcile();
    expect(finalizations).toBe(1); // Backoff prevents a busy loop.
    internal.fileRetryCheckAfter.set(attempt, Date.now() - 1);
    await internal.reconcile();
    expect(finalizations).toBe(2);
    expect(c.pending).toEqual([]);
    expect(resends).toBe(0);
  } finally {
    c.close();
  }
});
