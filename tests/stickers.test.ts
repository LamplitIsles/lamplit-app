import { expect, test } from "bun:test";
import {
  validate,
  validateSubmission,
  validateRecovery,
  MessageSchema,
  StickerPageSchema,
  StickerStageSchema,
  StickerStageResultSchema,
  stickerMediaUrl,
  validateStickerStageResult,
  type StickerBackend,
} from "../packages/contracts/src/index.ts";
import { stickerHttp } from "../packages/contracts/src/server.ts";

const version = "a".repeat(64);
const sticker = {
  id: "cat",
  version,
  name: "猫",
  tags: ["开心"],
  mediaType: "image/gif" as const,
  available: true,
};
const identity = { id: sticker.id, version };
const image = {
  attachmentId: "attachment",
  name: sticker.name,
  mediaType: sticker.mediaType,
  availability: "available" as const,
  sticker: identity,
};
const stage = {
  sessionId: "session",
  operationId: crypto.randomUUID(),
  sticker: identity,
};
const result = {
  sessionId: stage.sessionId,
  operationId: stage.operationId,
  image,
};
const origin = "http://fixture";
const auth = async () => ({ sessionId: "session" });
function backend(): StickerBackend {
  return {
    packs: async () => ({
      packs: [{ id: "cats", name: "猫", description: "表情", cover: sticker }],
      nextCursor: null,
    }),
    pack: async () => ({ stickers: [sticker], nextCursor: null }),
    search: async () => ({ stickers: [sticker], nextCursor: null }),
    favorites: async () => ({ stickers: [], nextCursor: null }),
    favorite: async (input, guard) => {
      if (!(await guard())) throw new Error("revoked");
      return { sticker, favorite: input.favorite };
    },
    favoriteImage: async (_input, guard) => {
      if (!(await guard())) throw new Error("revoked");
      return { sticker, favorite: true };
    },
    upload: async (_input, guard) => {
      if (!(await guard())) throw new Error("revoked");
      return { sticker, favorite: true };
    },
    importZip: async (_session, _bytes, guard) => {
      if (!(await guard())) throw new Error("revoked");
      return {
        pack: { id: "cats", name: "猫", description: "表情", cover: sticker },
        count: 1,
      };
    },
    stage: async (input, guard) => {
      if (!(await guard())) throw new Error("revoked");
      return {
        ...result,
        sessionId: input.sessionId,
        operationId: input.operationId,
      };
    },
    media: async (hash, variant) =>
      hash === version
        ? {
            bytes: new Uint8Array(
              variant === "original"
                ? [71, 73, 70, 56, 57, 97]
                : [255, 216, 255],
            ),
            mediaType: variant === "original" ? "image/gif" : "image/webp",
          }
        : null,
  };
}
function post(
  path: string,
  value: unknown,
  headers: Record<string, string> = {},
) {
  return new Request(origin + path, {
    method: "POST",
    headers: { origin, "content-type": "application/json", ...headers },
    body: JSON.stringify(value),
  });
}

test("sticker identity remains bound to durable submission, recovery and history", () => {
  expect(validateStickerStageResult(result, stage)).toEqual(result);
  expect(
    validateSubmission({
      operationId: stage.operationId,
      text: "",
      images: [image],
    }).images,
  ).toEqual([image]);
  expect(
    validateRecovery({
      sourceId: stage.operationId,
      operationId: stage.operationId,
      text: "",
      images: [image],
      replacementEligible: true,
    }).images,
  ).toEqual([image]);
  expect(
    validate(MessageSchema, {
      id: "m",
      role: "agent",
      text: "",
      images: [image],
      createdAt: 1,
      operationId: null,
      turnId: "t",
    }).images,
  ).toEqual([image]);
  expect(
    validateSubmission({ operationId: stage.operationId, text: "ordinary" })
      .text,
  ).toBe("ordinary");
  for (const bad of [
    { ...result, sessionId: "other" },
    {
      ...result,
      image: { ...image, sticker: { ...identity, version: "b".repeat(64) } },
    },
    { ...result, image: { ...image, availability: "missing" } },
  ])
    expect(() => validateStickerStageResult(bad, stage)).toThrow();
  expect(() =>
    validate(StickerStageSchema, { ...stage, path: "/etc/passwd" }),
  ).toThrow();
  expect(() =>
    validate(StickerStageResultSchema, {
      ...result,
      image: { ...image, sticker: { ...identity, version: "../x" } },
    }),
  ).toThrow();
  expect(() =>
    validate(StickerPageSchema, {
      stickers: [sticker],
      nextCursor: null,
      path: "/tmp",
    }),
  ).toThrow();
  expect(stickerMediaUrl(version, "thumbnail")).toBe(
    `/api/stickers/media/${version}/thumbnail`,
  );
  expect(() => stickerMediaUrl("../etc", "original")).toThrow();
});

test("HTTP validates authorization, session, pages, versioned media and staging", async () => {
  const b = backend();
  const run = (req: Request) => stickerHttp(req, b, auth);
  expect(
    (
      await stickerHttp(
        new Request(origin + "/api/stickers/packs?sessionId=session"),
        b,
        async () => null,
      )
    )?.status,
  ).toBe(401);
  expect(
    (await run(new Request(origin + "/api/stickers/packs?sessionId=other")))
      ?.status,
  ).toBe(403);
  expect(
    (
      await run(
        new Request(origin + "/api/stickers/packs?sessionId=session&limit=31"),
      )
    )?.status,
  ).toBe(400);
  expect(
    (
      await run(
        new Request(
          origin + "/api/stickers/packs?sessionId=session&limit=1&limit=2",
        ),
      )
    )?.status,
  ).toBe(400);
  expect(
    (
      await (await run(
        new Request(origin + "/api/stickers/packs?sessionId=session&limit=1"),
      ))!.json()
    ).packs[0].cover,
  ).toEqual(sticker);
  expect(
    (
      await (await run(
        new Request(origin + "/api/stickers/packs/cats?sessionId=session"),
      ))!.json()
    ).stickers,
  ).toEqual([sticker]);
  expect(
    (
      await (await run(
        new Request(origin + "/api/stickers/favorites?sessionId=session"),
      ))!.json()
    ).stickers,
  ).toEqual([]);
  expect(
    (await run(post("/api/stickers/stage", stage, { origin: "http://evil" })))
      ?.status,
  ).toBe(403);
  expect(await (await run(post("/api/stickers/stage", stage)))!.json()).toEqual(
    result,
  );
  expect(
    (
      await run(
        post("/api/stickers/favorites", {
          sessionId: "session",
          stickerId: "cat",
          favorite: true,
          participant: "agent",
        }),
      )
    )?.status,
  ).toBe(400);
  expect(
    (
      await run(
        post("/api/stickers/favorites", {
          sessionId: "session",
          stickerId: "cat",
          favorite: true,
        }),
      )
    )?.status,
  ).toBe(200);
  const original = await run(
    new Request(origin + stickerMediaUrl(version, "original")),
  );
  expect(original?.headers.get("content-type")).toBe("image/gif");
  expect(original?.headers.get("cache-control")).toContain("private");
  expect(original?.headers.get("x-content-type-options")).toBe("nosniff");
  expect(
    (
      await run(new Request(origin + stickerMediaUrl(version, "thumbnail")))
    )?.headers.get("content-type"),
  ).toBe("image/webp");
  expect(
    (await run(new Request(origin + `/api/stickers/media/${version}/preview`)))
      ?.status,
  ).toBe(404);
  expect(
    (
      await run(
        new Request(origin + stickerMediaUrl("b".repeat(64), "original")),
      )
    )?.status,
  ).toBe(404);
  expect(
    (
      await stickerHttp(
        post("/api/stickers/stage", stage),
        b,
        (() => {
          let calls = 0;
          return async () => (++calls === 1 ? { sessionId: "session" } : null);
        })(),
      )
    )?.status,
  ).toBe(403);
});

test("import and Human favorite creation use bounded inputs and the commit guard", async () => {
  const b = backend();
  let calls = 0;
  b.importZip = async (session, bytes, guard) => {
    calls++;
    expect(session).toBe("session");
    expect([...bytes]).toEqual([80, 75, 3, 4]);
    expect(await guard()).toBe(true);
    return {
      pack: { id: "cats", name: "猫", description: "表情", cover: sticker },
      count: 1,
    };
  };
  const run = (req: Request) => stickerHttp(req, b, auth);
  const upload = () =>
    new Request(origin + "/api/stickers/imports?sessionId=session", {
      method: "POST",
      headers: { origin, "content-type": "application/zip" },
      body: new Uint8Array([80, 75, 3, 4]),
    });
  expect((await run(upload()))?.status).toBe(200);
  expect(calls).toBe(1);
  expect(
    (
      await run(
        new Request(origin + "/api/stickers/imports?sessionId=session", {
          method: "POST",
          headers: {
            origin,
            "content-type": "application/zip",
            "content-length": "33554433",
          },
          body: "a",
        }),
      )
    )?.status,
  ).toBe(400);
  expect(calls).toBe(1);
  expect(
    (
      await run(
        post("/api/stickers/favorites/image", {
          sessionId: "session",
          imageId: "photo",
          name: "猫",
          tags: [],
        }),
      )
    )?.status,
  ).toBe(200);
  expect(
    (
      await run(
        post("/api/stickers/favorites/upload", {
          sessionId: "session",
          name: "猫",
          tags: [],
          mediaType: "image/gif",
          data: "R0lGODlh",
        }),
      )
    )?.status,
  ).toBe(200);
  expect(
    (
      await run(
        post("/api/stickers/favorites/upload", {
          sessionId: "session",
          name: "猫",
          tags: [],
          mediaType: "image/gif",
          data: "A===",
        }),
      )
    )?.status,
  ).toBe(400);
  expect(
    (
      await run(
        post("/api/stickers/favorites/image", {
          sessionId: "session",
          imageId: "../../etc",
          name: "猫",
          tags: [],
        }),
      )
    )?.status,
  ).toBe(400);
});

test("sticker references survive Chord submission, refresh and history without a second execution", async () => {
  const { imagesFixture } = await import("./images-fixture.ts");
  const { createUiTestHost } = await import("./ui-test-host.ts");
  const { openChat } = await import("../packages/contracts/src/client.ts");
  const fixture = imagesFixture();
  let admitted: unknown;
  let executions = 0;
  const message = {
    id: stage.operationId,
    role: "user" as const,
    text: "",
    images: [image],
    createdAt: 1,
    operationId: stage.operationId,
    turnId: "t",
  };
  const host = await createUiTestHost({
    ...fixture.backend,
    async submit(input) {
      if (admitted && JSON.stringify(admitted) !== JSON.stringify(input))
        throw new Error("identity conflict");
      if (!admitted) {
        admitted = structuredClone(input);
        executions++;
      }
      return {
        operationId: input.operationId,
        state: "submitted",
        messageId: input.operationId,
        turnId: "t",
        error: null,
      };
    },
    async read() {
      return {
        ...(await fixture.backend.read()),
        messages: admitted ? [message] : [],
      };
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
  let view: import("../packages/contracts/src/index.ts").ChatView | undefined;
  const client = await openChat(
    new WebSocket(`ws://127.0.0.1:${server.port}`),
    (v) => {
      view = v;
    },
    () => {},
  );
  try {
    const input = { operationId: stage.operationId, text: "", images: [image] };
    expect((await client.submit(input)).state).toBe("submitted");
    expect((await client.submit(input)).state).toBe("submitted");
    expect(executions).toBe(1);
    await host.publish();
    const end = Date.now() + 3000;
    while (!view?.messages.length && Date.now() < end) await Bun.sleep(10);
    expect(view?.messages[0]?.images).toEqual([image]);
    expect((await client.history("older")).messages[0]?.images).toEqual([
      image,
    ]);
    await expect(
      client.submit({
        ...input,
        images: [
          { ...image, sticker: { ...identity, version: "b".repeat(64) } },
        ],
      }),
    ).rejects.toThrow();
    expect(executions).toBe(1);
  } finally {
    client.close();
    host.close();
    for (const ws of channels.keys())
      (ws as import("bun").ServerWebSocket<undefined>).terminate();
    server.unref();
    void server.stop(true);
  }
});

test("cached sticker media is revalidated only after authorization", async () => {
  const b = backend();
  const url = origin + stickerMediaUrl(version, "original");
  const first = await stickerHttp(new Request(url), b, auth);
  expect(first?.status).toBe(200);
  expect(first?.headers.get("cache-control")).toBe("private, no-cache");
  const etag = first!.headers.get("etag")!;
  expect(etag).toMatch(/^"[a-f0-9]{64}-original-gif"$/);
  const conditional = (tag = etag) =>
    new Request(url, { headers: { "if-none-match": tag } });
  const unchanged = await stickerHttp(conditional(), b, auth);
  expect(unchanged?.status).toBe(304);
  expect(unchanged?.headers.get("etag")).toBe(etag);
  expect((await unchanged!.arrayBuffer()).byteLength).toBe(0);
  expect((await stickerHttp(conditional(`W/${etag}`), b, auth))?.status).toBe(
    304,
  );
  expect((await stickerHttp(conditional('"other"'), b, auth))?.status).toBe(
    200,
  );
  const revoked = await stickerHttp(conditional(), b, async () => null);
  expect(revoked?.status).toBe(401);
  expect(revoked?.headers.get("cache-control")).toBe("no-store");
  expect(await revoked!.text()).not.toContain("GIF89a");
  let authorizations = 0;
  const withdrawn = await stickerHttp(conditional(), b, async () =>
    ++authorizations === 1 ? { sessionId: "session" } : null,
  );
  expect(withdrawn?.status).toBe(403);
  let afterHashChecks = 0;
  const afterHash = await stickerHttp(conditional(), b, async () =>
    ++afterHashChecks <= 2 ? { sessionId: "session" } : null,
  );
  expect(afterHash?.status).toBe(403);
  const preview = await stickerHttp(
    new Request(origin + stickerMediaUrl(version, "thumbnail")),
    b,
    auth,
  );
  expect(preview?.headers.get("etag")).not.toBe(etag);
});

test("failed sticker retry and reimport keep the sent version in real socket history", async () => {
  const { imagesFixture } = await import("./images-fixture.ts");
  const { fixtureImage } = await import("./panels-fixture.ts");
  const { createChatHost } =
    await import("../packages/contracts/src/server.ts");
  const { openChat } = await import("../packages/contracts/src/client.ts");
  const f = imagesFixture();
  let current = { id: "cat", version: "a".repeat(64) };
  const bytesByVersion = new Map([
    [current.version, fixtureImage],
    ["b".repeat(64), Uint8Array.from([...fixtureImage, 1])],
  ]);
  const b = backend();
  b.importZip = async (session, bytes, guard) => {
    if (session !== "fixture-session" || !(await guard()) || bytes.length !== 4)
      throw new Error("import rejected");
    current = { ...current, version: "b".repeat(64) };
    return {
      pack: {
        id: "cats",
        name: "猫",
        description: "表情",
        cover: { ...sticker, version: current.version },
      },
      count: 1,
    };
  };
  b.stage = async (input, guard) => {
    if (
      !(await guard()) ||
      JSON.stringify(input.sticker) !== JSON.stringify(current)
    )
      throw new Error("stale sticker");
    const bytes = bytesByVersion.get(current.version)!;
    const encoded = btoa(String.fromCharCode(...bytes));
    return f.stageSticker(
      {
        sessionId: input.sessionId,
        operationId: input.operationId,
        images: [
          {
            id: "cat",
            order: 0,
            name: "cat.png",
            mediaType: "image/png",
            original: encoded,
            preview: encoded,
            model: encoded,
          },
        ],
      },
      current,
    );
  };
  const makeStage = async (operationId: string) => {
    const request = {
      sessionId: "fixture-session",
      operationId,
      sticker: { ...current },
    };
    const response = await stickerHttp(
      post("/api/stickers/stage", request),
      b,
      async () => ({ sessionId: "fixture-session" }),
    );
    expect(response?.status).toBe(200);
    return validateStickerStageResult(await response!.json(), request).image;
  };
  let host = await createChatHost(f.backend);
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
  const connect = () =>
    openChat(
      new WebSocket(`ws://127.0.0.1:${server.port}`),
      () => {},
      () => {},
    );
  let client = await connect();
  try {
    const operationId = crypto.randomUUID();
    const oldImage = await makeStage(operationId);
    await f.control({ action: "mode", state: "failed" });
    expect(
      (await client.submit({ operationId, text: "", images: [oldImage] }))
        .state,
    ).toBe("failed");
    await f.control({ action: "mode", state: "submitted" });
    const attemptId = crypto.randomUUID();
    const retry = { sessionId: "fixture-session", operationId, attemptId };
    expect((await client.retryFailed(retry)).state).toBe("submitted");
    expect((await client.retryFailed(retry)).state).toBe("submitted");
    let state = await f.control({ action: "state" });
    const retryImage = state.submissions.find(
      (input) => input.operationId === attemptId,
    )!.images![0]!;
    expect(retryImage.attachmentId).not.toBe(oldImage.attachmentId);
    expect(retryImage.sticker).toEqual(oldImage.sticker);
    expect(
      (await f.imageBackend.media(retryImage.attachmentId, "original"))?.bytes,
    ).toEqual(fixtureImage);
    expect(
      state.messages.filter((message) => message.operationId === attemptId),
    ).toHaveLength(1);
    const imported = await stickerHttp(
      new Request(origin + "/api/stickers/imports?sessionId=fixture-session", {
        method: "POST",
        headers: { origin, "content-type": "application/zip" },
        body: new Uint8Array([80, 75, 3, 4]),
      }),
      b,
      async () => ({ sessionId: "fixture-session" }),
    );
    expect(imported?.status).toBe(200);
    expect((await imported!.json()).pack.cover.version).toBe("b".repeat(64));
    const nextOperation = crypto.randomUUID();
    const newImage = await makeStage(nextOperation);
    expect(
      (
        await client.submit({
          operationId: nextOperation,
          text: "",
          images: [newImage],
        })
      ).state,
    ).toBe("submitted");
    await f.control({ action: "history" });
    state = await f.control({ action: "state" });
    expect(
      state.messages.find((message) => message.operationId === attemptId)
        ?.images?.[0]?.sticker,
    ).toEqual(oldImage.sticker);
    client.close();
    host.close();
    host = await createChatHost(f.backend);
    client = await connect();
    let page = await f.backend.read();
    const history = [...page.messages];
    let before = page.before;
    while (before) {
      const next = await client.history(before);
      history.push(...next.messages);
      before = next.before;
    }
    expect(
      history.find((message) => message.operationId === attemptId)?.images?.[0]
        ?.sticker,
    ).toEqual(oldImage.sticker);
    expect(
      history.find((message) => message.operationId === nextOperation)
        ?.images?.[0]?.sticker,
    ).toEqual(newImage.sticker);
    expect(
      (await f.imageBackend.media(retryImage.attachmentId, "original"))?.bytes,
    ).toEqual(fixtureImage);
    expect(
      (await f.imageBackend.media(newImage.attachmentId, "original"))?.bytes,
    ).toEqual(bytesByVersion.get(current.version));
  } finally {
    client.close();
    host.close();
    for (const ws of channels.keys())
      (ws as import("bun").ServerWebSocket<undefined>).terminate();
    server.unref();
    void server.stop(true);
  }
});

test("thumbnail enforces WebP and size and derives ETag from returned bytes", async () => {
  const b = backend();
  const url = origin + stickerMediaUrl(version, "thumbnail");
  const read = () => stickerHttp(new Request(url), b, auth);
  const first = await read();
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new Uint8Array([255, 216, 255])),
  );
  const hash = Array.from(digest, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  expect(first?.headers.get("etag")).toBe(`"${hash}-thumbnail-webp"`);
  b.media = async () => ({
    bytes: new Uint8Array(160_001),
    mediaType: "image/webp",
  });
  expect((await read())?.status).toBe(400);
  b.media = async () => ({
    bytes: new Uint8Array([1]),
    mediaType: "image/jpeg",
  });
  expect((await read())?.status).toBe(400);
});
