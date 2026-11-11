import { test, expect } from "bun:test";
import { createHash } from "node:crypto";
import {
  fileStreamHttp,
  type FileStreamBackend,
  type FileStreamStatus,
} from "../packages/contracts/src/server.ts";
import {
  validateFileManifest,
  validateSubmission,
  type FileManifest,
} from "../packages/contracts/src/index.ts";

const limits = {
  maxFilesPerMessage: 6,
  maxFileBytes: 100_000_000,
  maxMessageFileBytes: 200_000_000,
};
const operationId = "00000000-0000-0000-0000-000000000001";
const manifest = (sizes: number[]): FileManifest => ({
  sessionId: "s",
  operationId,
  files: sizes.map((size, i) => ({
    id: `f${i}`,
    name: `file${i}`,
    mediaType: "",
    size,
  })),
});
function fixture(sessionId = "s") {
  let status: FileStreamStatus | null = null;
  const digests = new Map<string, string>();
  let authorized = true;
  const auth = async () =>
    authorized ? { ownerId: "o", sessionId, limits } : null;
  const backend: FileStreamBackend = {
    async reserve(input, _owner, check) {
      await check();
      if (status && JSON.stringify(status.manifest) !== JSON.stringify(input))
        throw Error("conflict");
      return (status ??= { manifest: input, uploaded: [] });
    },
    async status(_id, owner) {
      return owner.ownerId === "o" && owner.sessionId === sessionId
        ? status
        : null;
    },
    async receive(_manifest, id, bytes, _owner, check) {
      const hash = createHash("sha256");
      for await (const chunk of bytes) hash.update(chunk);
      const digest = hash.digest("hex");
      await check();
      if (digests.has(id) && digests.get(id) !== digest)
        throw Error("conflict");
      digests.set(id, digest);
      if (!status!.uploaded.includes(id)) status!.uploaded.push(id);
    },
    async complete(input, _owner, check) {
      await check();
      return (status!.result ??= {
        sessionId: input.sessionId,
        operationId: input.operationId,
        files: input.files.map((f, order) => ({
          id: f.id,
          order,
          ref: {
            attachmentId: `stored${order}`,
            name: f.name,
            mediaType: f.mediaType,
            size: f.size,
            availability: "available",
          },
        })),
      });
    },
  };
  const call = async (path: string, init: RequestInit = {}) =>
    (await fileStreamHttp(
      new Request(`http://test${path}`, init),
      backend,
      auth,
    ))!;
  return {
    call,
    revoke: () => {
      authorized = false;
    },
  };
}
const base = "/api/chat/file-operations";
const op = `${base}/${operationId}`;
const json = (value: unknown): RequestInit => ({
  method: "POST",
  headers: { origin: "http://test", "content-type": "application/json" },
  body: JSON.stringify(value),
});
function put(id: string, body: BodyInit): RequestInit {
  return {
    method: "PUT",
    headers: {
      origin: "http://test",
      "content-type": "application/octet-stream",
    },
    body,
    duplex: "half",
  } as RequestInit;
}

test("exact manifest boundaries, empty files, total and submission limits", () => {
  expect(
    validateFileManifest(manifest([100_000_000, 100_000_000, 0]), limits),
  ).toBeDefined();
  expect(() => validateFileManifest(manifest([100_000_001]), limits)).toThrow();
  expect(() =>
    validateFileManifest(manifest([100_000_000, 100_000_000, 1]), limits),
  ).toThrow();
  expect(() =>
    validateFileManifest(manifest([0, 0, 0, 0, 0, 0, 0]), limits),
  ).toThrow();
  expect(
    validateSubmission({
      operationId,
      text: "",
      files: [0, 1].map((i) => ({
        attachmentId: `f${i}`,
        name: "x",
        mediaType: "",
        size: 100_000_000,
        availability: "available",
      })),
    }),
  ).toBeDefined();
});

test("status, immutable duplicate bytes, incomplete and completed result", async () => {
  const f = fixture();
  expect((await f.call(op)).status).toBe(404);
  expect((await f.call(base, json(manifest([3, 0])))).status).toBe(200);
  expect(
    (
      await f.call(`${op}/complete`, {
        method: "POST",
        headers: { origin: "http://test" },
      })
    ).status,
  ).toBe(400);
  expect(
    (await f.call(`${op}/files/f0`, put("f0", new Uint8Array([1, 2, 3]))))
      .status,
  ).toBe(204);
  expect(
    (await f.call(`${op}/files/f0`, put("f0", new Uint8Array([1, 2, 3]))))
      .status,
  ).toBe(204);
  expect(
    (await f.call(`${op}/files/f0`, put("f0", new Uint8Array([1, 2, 4]))))
      .status,
  ).toBe(400);
  expect(
    (await f.call(`${op}/files/f1`, put("f1", new Uint8Array(0)))).status,
  ).toBe(204);
  const result = await (
    await f.call(`${op}/complete`, {
      method: "POST",
      headers: { origin: "http://test" },
    })
  ).json();
  expect(result.files.map((x: { id: string }) => x.id)).toEqual(["f0", "f1"]);
  const status = await (await f.call(op)).json();
  expect(status.uploaded).toEqual(["f0", "f1"]);
  expect(status.result).toEqual(result);
  expect((await f.call(base, json(manifest([2, 0])))).status).toBe(400);
  f.revoke();
  expect((await f.call(op)).status).toBe(401);
});

test("rejects actual length mismatch and cross-session manifests", async () => {
  const f = fixture();
  expect(
    (await f.call(base, json({ ...manifest([2]), sessionId: "other" }))).status,
  ).toBe(403);
  await f.call(base, json(manifest([2])));
  expect(
    (await f.call(`${op}/files/f0`, put("f0", new Uint8Array([1])))).status,
  ).toBe(400);
  expect(
    (await f.call(`${op}/files/f0`, put("f0", new Uint8Array([1, 2, 3]))))
      .status,
  ).toBe(400);
  expect((await (await f.call(op)).json()).uploaded).toEqual([]);
});

test("two exact 100 MB files stream with measured bounded RSS", async () => {
  const f = fixture();
  await f.call(base, json(manifest([100_000_000, 100_000_000])));
  const chunk = new Uint8Array(64_000);
  const baseline = process.memoryUsage().rss;
  let peak = baseline;
  for (const id of ["f0", "f1"]) {
    let sent = 0,
      pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        if (pulls % 50 === 0) peak = Math.max(peak, process.memoryUsage().rss);
        const n = Math.min(chunk.length, 100_000_000 - sent);
        if (!n) return controller.close();
        sent += n;
        controller.enqueue(chunk.subarray(0, n));
      },
    });
    expect((await f.call(`${op}/files/${id}`, put(id, body))).status).toBe(204);
    expect(sent).toBe(100_000_000);
    expect(pulls).toBeGreaterThan(1000);
  }
  expect(
    (
      await f.call(`${op}/complete`, {
        method: "POST",
        headers: { origin: "http://test" },
      })
    ).status,
  ).toBe(200);
  console.log(
    `200 MB synthetic streaming peak RSS increase: ${peak - baseline} bytes`,
  );
  expect(peak - baseline).toBeLessThan(100_000_000);
}, 30_000);

test("slow backend propagates backpressure and revoked authorization blocks publication", async () => {
  let resolveRead!: () => void;
  const gate = new Promise<void>((resolve) => {
    resolveRead = resolve;
  });
  let started!: () => void;
  const reading = new Promise<void>((resolve) => {
    started = resolve;
  });
  let authorized = true,
    published = false,
    pulls = 0;
  const m = manifest([4]);
  const backend: FileStreamBackend = {
    async reserve() {
      throw Error();
    },
    async status() {
      return { manifest: m, uploaded: [] };
    },
    async complete() {
      throw Error();
    },
    async receive(_m, _id, bytes, _owner, check) {
      started();
      await gate;
      for await (const _chunk of bytes) {
      }
      await check();
      published = true;
    },
  };
  const body = new ReadableStream<Uint8Array>(
    {
      pull(c) {
        pulls++;
        if (pulls <= 4) c.enqueue(new Uint8Array([1]));
        else c.close();
      },
    },
    { highWaterMark: 1 },
  );
  const request = new Request(`http://test${op}/files/f0`, put("f0", body));
  const response = fileStreamHttp(request, backend, async () =>
    authorized ? { ownerId: "o", sessionId: "s", limits } : null,
  );
  await reading;
  expect(pulls).toBeLessThanOrEqual(1);
  authorized = false;
  resolveRead();
  expect((await response)!.status).toBe(403);
  expect(published).toBe(false);
});

test("client fails each uncertain or retired staging phase without lookup or replay", async () => {
  const { streamFileUploads } =
    await import("../apps/web/src/lib/file-upload.ts");
  const previous = Object.getOwnPropertyDescriptor(globalThis, "location");
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: new URL("http://test/"),
  });
  const file = new File(["abc"], "a");
  const m = {
    sessionId: "s",
    operationId,
    files: [{ id: "f0", name: "a", mediaType: "", size: 3 }],
  };
  try {
    for (const phase of ["reserve", "put", "complete"] as const) {
      for (const failure of ["lost", "retired"] as const) {
        const calls: string[] = [];
        const fake = async (
          url: string | URL | Request,
          init?: RequestInit,
        ) => {
          const path = new URL(String(url)).pathname;
          calls.push(`${init?.method ?? "GET"} ${path}`);
          const currentPhase =
            path === base
              ? "reserve"
              : path.endsWith("/complete")
                ? "complete"
                : "put";
          if (currentPhase === phase) {
            if (failure === "lost") throw Error("response lost");
            return Response.json(
              { error: { code: "file_operation_retired" } },
              { status: 410 },
            );
          }
          if (currentPhase === "reserve")
            return Response.json({ manifest: m, uploaded: [] });
          if (currentPhase === "put") {
            expect(init?.body).toBe(file);
            return new Response(null, { status: 204 });
          }
          throw Error("unexpected request");
        };
        await expect(
          streamFileUploads(
            "s",
            operationId,
            [{ id: "f0", file }],
            limits,
            () => true,
            undefined,
            fake as typeof fetch,
          ),
        ).rejects.toThrow();
        const expected = [
          `POST ${base}`,
          `PUT ${op}/files/f0`,
          `POST ${op}/complete`,
        ];
        expect(calls).toEqual(
          expected.slice(0, ["reserve", "put", "complete"].indexOf(phase) + 1),
        );
      }
    }
    for (const status of [
      {
        manifest: { ...m, files: [{ ...m.files[0], name: "other" }] },
        uploaded: [],
      },
      { manifest: m, uploaded: ["f0"] },
      { manifest: m, uploaded: [], result: {} },
    ]) {
      let calls = 0;
      const fake = async (
        _url: string | URL | Request,
        _init?: RequestInit,
      ) => {
        calls++;
        return Response.json(status);
      };
      await expect(
        streamFileUploads(
          "s",
          operationId,
          [{ id: "f0", file }],
          limits,
          () => true,
          undefined,
          fake as typeof fetch,
        ),
      ).rejects.toThrow();
      expect(calls).toBe(1);
    }
  } finally {
    if (previous) Object.defineProperty(globalThis, "location", previous);
    else delete (globalThis as any).location;
  }
});

test("stream download uses attachment without filename and enforces session and size", async () => {
  const { fileHttp } = await import("../packages/contracts/src/server.ts");
  let allowed = true;
  const backend = {
    async fileStream() {
      return {
        size: 3,
        body: new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(new Uint8Array([1, 2, 3]));
            c.close();
          },
        }),
      };
    },
  };
  const auth = async () =>
    allowed ? { ownerId: "o", sessionId: "s", limits } : null;
  const download = (await fileHttp(
    new Request("http://test/api/chat/files/f0"),
    backend,
    auth,
  ))!;
  expect(download.headers.get("content-disposition")).toBe("attachment");
  expect(download.headers.get("content-type")).toBe("application/octet-stream");
  expect([...new Uint8Array(await download.arrayBuffer())]).toEqual([1, 2, 3]);
  const interrupted = (await fileHttp(
    new Request("http://test/api/chat/files/f0"),
    backend,
    auth,
  ))!;
  allowed = false;
  await expect(interrupted.arrayBuffer()).rejects.toThrow();
});

test("client stops after uncertain upload and rejects changed session", async () => {
  const { streamFileUploads } =
    await import("../apps/web/src/lib/file-upload.ts");
  const prior = globalThis.location;
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: new URL("http://test/"),
  });
  const file = new File(["a"], "a");
  const manifest = {
    sessionId: "s",
    operationId,
    files: [{ id: "f0", name: "a", mediaType: "", size: 1 }],
  };
  const calls: string[] = [];
  let current = true;
  const transport = async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    calls.push(`${init?.method ?? "GET"} ${path}`);
    if (path.endsWith("/files/f0")) throw Error("lost response");
    return Response.json({ manifest, uploaded: [] });
  };
  try {
    await expect(
      streamFileUploads(
        "s",
        operationId,
        [{ id: "f0", file }],
        limits,
        () => current,
        undefined,
        transport as typeof fetch,
      ),
    ).rejects.toThrow();
    expect(calls).toEqual([`POST ${base}`, `PUT ${op}/files/f0`]);
    calls.length = 0;
    const changing = async (
      url: string | URL | Request,
      init?: RequestInit,
    ) => {
      const response = await transport(url, init);
      current = false;
      return response;
    };
    await expect(
      streamFileUploads(
        "s",
        operationId,
        [{ id: "f0", file }],
        limits,
        () => current,
        undefined,
        changing as typeof fetch,
      ),
    ).rejects.toThrow();
    expect(calls).toEqual([`POST ${base}`]);
  } finally {
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: prior,
    });
  }
});

test("controller streams even with small advertised limits and persists refs before uncertain admission", async () => {
  const { ChatController } =
    await import("../apps/web/src/lib/chat-controller.ts");
  const previousLocation = Object.getOwnPropertyDescriptor(
    globalThis,
    "location",
  );
  const previousFetch = globalThis.fetch;
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: { href: "http://test/" },
  });
  let manifest: FileManifest;
  let puts = 0,
    submits = 0,
    saved = "";
  globalThis.fetch = Object.assign(
    async (url: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      if (path === base) {
        manifest = JSON.parse(String(init!.body));
        return Response.json({ manifest, uploaded: [] });
      }
      if (path.includes("/files/")) {
        puts++;
        expect(init!.body).toBeInstanceOf(File);
        return new Response(null, { status: 204 });
      }
      if (path.endsWith("/complete"))
        return Response.json({
          sessionId: manifest.sessionId,
          operationId: manifest.operationId,
          files: manifest.files.map((f, order) => ({
            id: f.id,
            order,
            ref: {
              attachmentId: `ref${order}`,
              name: f.name,
              mediaType: f.mediaType,
              size: f.size,
              availability: "available",
            },
          })),
        });
      throw Error("Unexpected request");
    },
    { preconnect: previousFetch.preconnect },
  );
  const controller = new ChatController(() => {}, {
    getItem: () => null,
    setItem: (_key: string, value: string) => {
      saved = value;
    },
  });
  const c = controller as any;
  c.view = {
    version: 2,
    sessionId: "s",
    name: "",
    activeTurnId: null,
    contextUsage: { tokens: null, capacity: null },
    compaction: null,
    messages: [],
    before: null,
    recovery: [],
    capabilities: {
      images: false,
      files: {
        maxFilesPerMessage: 6,
        maxFileBytes: 8_000_000,
        maxMessageFileBytes: 24_000_000,
      },
    },
  };
  c.storageKey = "lamplit.pending:s";
  c.client = {
    async submit(value: { files: unknown[] }) {
      submits++;
      expect(JSON.parse(saved)[0].files).toEqual(value.files);
      throw Error("unknown admission");
    },
    async lookup() {
      return null;
    },
    async finalizeSubmission() {
      return null;
    },
    close() {},
  };
  try {
    await controller.send("", undefined, [], undefined, undefined, [
      { id: "f0", file: new File(["abc"], "a") },
    ]);
    expect(puts).toBe(1);
    expect(submits).toBe(1);
    expect(controller.pending[0]?.state).toBe("sending");
    await c.reconcile();
    expect(submits).toBe(1);
  } finally {
    controller.close();
    globalThis.fetch = previousFetch;
    if (previousLocation)
      Object.defineProperty(globalThis, "location", previousLocation);
    else delete (globalThis as { location?: unknown }).location;
  }
});

test("download releases acquired streams when authorization changes or size is invalid", async () => {
  const { fileHttp } = await import("../packages/contracts/src/server.ts");
  for (const scenario of [
    "revoked",
    "changed-owner",
    "changed-session",
    "auth-error",
    "negative",
    "fractional",
    "oversized",
  ] as const) {
    let canceled = 0;
    let authorizations = 0;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        canceled++;
      },
    });
    const size =
      scenario === "negative"
        ? -1
        : scenario === "fractional"
          ? 1.5
          : scenario === "oversized"
            ? 100_000_001
            : 1;
    const backend = {
      async fileStream() {
        return { body, size };
      },
    };
    const auth = async () => {
      authorizations++;
      if (authorizations > 1) {
        if (scenario === "revoked") return null;
        if (scenario === "auth-error") throw Error("authorization failed");
        if (scenario === "changed-owner")
          return { ownerId: "other", sessionId: "s", limits };
        if (scenario === "changed-session")
          return { ownerId: "o", sessionId: "other", limits };
      }
      return { ownerId: "o", sessionId: "s", limits };
    };
    const response = await fileHttp(
      new Request("http://test/api/chat/files/f0"),
      backend,
      auth,
    );
    expect(response?.status).toBe(
      ["revoked", "changed-owner", "changed-session"].includes(scenario)
        ? 403
        : 400,
    );
    expect(canceled).toBe(1);
  }
});

test("download hands stream ownership to response and releases it on cancellation", async () => {
  const { fileHttp } = await import("../packages/contracts/src/server.ts");
  let canceled = 0;
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      canceled++;
    },
  });
  const response = await fileHttp(
    new Request("http://test/api/chat/files/f0"),
    {
      async fileStream() {
        return { body, size: 1 };
      },
    },
    async () => ({ ownerId: "o", sessionId: "s", limits }),
  );
  expect(response?.status).toBe(200);
  expect(canceled).toBe(0);
  await response!.body!.cancel();
  expect(canceled).toBe(1);
});

test("download keeps authorization failure when source cancellation rejects", async () => {
  const { fileHttp } = await import("../packages/contracts/src/server.ts");
  let authorizations = 0,
    cancellations = 0;
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      cancellations++;
      throw Error("close failed");
    },
  });
  const response = await fileHttp(
    new Request("http://test/api/chat/files/f0"),
    {
      async fileStream() {
        return { body, size: 1 };
      },
    },
    async () =>
      ++authorizations === 1 ? { ownerId: "o", sessionId: "s", limits } : null,
  );
  expect(response?.status).toBe(403);
  expect(cancellations).toBe(1);
});

test("manifest supports maximum escaped metadata and rejects over-cap streaming bodies", async () => {
  const sessionId = "\u0000".repeat(300);
  const f = fixture(sessionId);
  const maxManifest = {
    sessionId,
    operationId,
    files: Array.from({ length: 6 }, (_, i) => ({
      id: `f${i}${"x".repeat(98)}`,
      name: "\u0000".repeat(200),
      mediaType: "\u0000".repeat(255),
      size: 0,
    })),
  };
  const encoded = new TextEncoder().encode(JSON.stringify(maxManifest));
  expect(encoded.byteLength).toBeGreaterThan(16_384);
  expect((await f.call(base, json(maxManifest))).status).toBe(200);
  let canceled = false;
  const oversized = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(32_769));
    },
    cancel() {
      canceled = true;
    },
  });
  const response = await f.call(base, {
    method: "POST",
    headers: { origin: "http://test", "content-type": "application/json" },
    body: oversized,
    duplex: "half",
  } as RequestInit);
  expect(response.status).toBe(400);
  expect(canceled).toBe(true);
});

test("retired operations return scoped 410 at reservation, status, upload and completion, including races", async () => {
  const { FileOperationRetiredError, FileOperationNotFoundError } =
    await import("../packages/contracts/src/server.ts");
  const m = manifest([1]);
  for (const phase of [
    "reserve",
    "status",
    "receive",
    "complete",
    "revoked",
    "changed-owner",
    "changed-session",
    "other-scope",
  ] as const) {
    let revoked = false,
      changed = false;
    const backend: FileStreamBackend = {
      async reserve(_m, owner, check) {
        await check();
        if (owner.ownerId !== "o") throw new FileOperationNotFoundError();
        if (phase === "reserve") throw new FileOperationRetiredError();
        return { manifest: m, uploaded: [] };
      },
      async status(_id, owner) {
        if (owner.ownerId !== "o") return null;
        if (phase === "status") throw new FileOperationRetiredError();
        return { manifest: m, uploaded: phase === "complete" ? ["f0"] : [] };
      },
      async receive(_m, _id, bytes, _owner, check) {
        for await (const _chunk of bytes) {
        }
        await check();
        if (phase === "revoked") revoked = true;
        if (phase === "changed-owner" || phase === "changed-session")
          changed = true;
        throw new FileOperationRetiredError();
      },
      async complete(_m, _owner, check) {
        await check();
        throw new FileOperationRetiredError();
      },
    };
    const auth = async () =>
      revoked
        ? null
        : {
            ownerId:
              phase === "other-scope" || (changed && phase === "changed-owner")
                ? "other"
                : "o",
            sessionId:
              changed && phase === "changed-session" ? "other-session" : "s",
            limits,
          };
    const [path, init] =
      phase === "reserve" || phase === "other-scope"
        ? [base, json(m)]
        : phase === "status"
          ? [op, {}]
          : phase === "complete"
            ? [
                `${op}/complete`,
                { method: "POST", headers: { origin: "http://test" } },
              ]
            : [`${op}/files/f0`, put("f0", new Uint8Array([1]))];
    const response = (await fileStreamHttp(
      new Request(`http://test${path}`, init),
      backend,
      auth,
    ))!;
    expect(response.status).toBe(
      ["revoked", "changed-owner", "changed-session"].includes(phase)
        ? 403
        : phase === "other-scope"
          ? 404
          : 410,
    );
    if (response.status === 410)
      expect(await response.json()).toEqual({
        error: {
          code: "file_operation_retired",
          message: "File operation retired; start a new attempt explicitly.",
        },
      });
  }
});

test("controller rejects non-204 successful PUT responses before completion and submit", async () => {
  const { ChatController } =
    await import("../apps/web/src/lib/chat-controller.ts");
  const previousLocation = Object.getOwnPropertyDescriptor(
    globalThis,
    "location",
  );
  const previousFetch = globalThis.fetch;
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: { href: "http://test/" },
  });
  try {
    for (const status of [200, 201, 202]) {
      const calls: string[] = [];
      let submissions = 0;
      globalThis.fetch = Object.assign(
        async (url: RequestInfo | URL, init?: RequestInit) => {
          const path = new URL(String(url)).pathname;
          calls.push(`${init?.method ?? "GET"} ${path}`);
          if (path === base) {
            return Response.json({
              manifest: JSON.parse(String(init!.body)),
              uploaded: [],
            });
          }
          if (init?.method === "PUT") return new Response(null, { status });
          throw Error("unexpected staging request");
        },
        { preconnect: previousFetch.preconnect },
      );
      const c = new ChatController(() => {}, {
        getItem: () => null,
        setItem: () => {},
      });
      const internal = c as any;
      internal.view = {
        sessionId: "s",
        capabilities: { files: limits },
        recovery: [],
      };
      internal.storageKey = "lamplit.pending:s";
      internal.client = {
        close() {},
        async submit() {
          submissions++;
        },
      };
      try {
        await c.send("text", undefined, [], undefined, undefined, [
          { id: "f0", file: new File(["a"], "a") },
        ]);
        expect(c.pending[0]).toMatchObject({
          state: "failed",
          dispatched: false,
        });
        expect(calls).toHaveLength(2);
        expect(calls[0]).toBe(`POST ${base}`);
        expect(calls[1]).toMatch(
          /^PUT \/api\/chat\/file-operations\/[^/]+\/files\/f0$/,
        );
        expect(submissions).toBe(0);
      } finally {
        c.close();
      }
    }
  } finally {
    globalThis.fetch = previousFetch;
    if (previousLocation)
      Object.defineProperty(globalThis, "location", previousLocation);
    else delete (globalThis as any).location;
  }
});

test("controller retries an incomplete upload with a fresh operation and no automatic replay", async () => {
  const { ChatController } =
    await import("../apps/web/src/lib/chat-controller.ts");
  const previousLocation = Object.getOwnPropertyDescriptor(
      globalThis,
      "location",
    ),
    previousFetch = globalThis.fetch;
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: { href: "http://test/" },
  });
  const manifests = new Map<string, any>(),
    reservations: string[] = [],
    saved = new Map<string, string>();
  let submissions = 0,
    lookups = 0;
  globalThis.fetch = Object.assign(
    async (url: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      if (path === base) {
        const m = JSON.parse(String(init!.body));
        reservations.push(m.operationId);
        manifests.set(m.operationId, m);
        if (reservations.length === 1)
          return Response.json(
            {
              error: {
                code: "file_operation_retired",
                message:
                  "File operation retired; start a new attempt explicitly.",
              },
            },
            { status: 410 },
          );
        return Response.json({ manifest: m, uploaded: [] });
      }
      if (init?.method === "PUT") return new Response(null, { status: 204 });
      if (path.endsWith("/complete")) {
        const m = manifests.get(path.split("/")[4]!);
        return Response.json({
          sessionId: m.sessionId,
          operationId: m.operationId,
          files: m.files.map((f: any, order: number) => ({
            id: f.id,
            order,
            ref: {
              attachmentId: "saved",
              name: f.name,
              mediaType: f.mediaType,
              size: f.size,
              availability: "available",
            },
          })),
        });
      }
      throw Error("unexpected staging replay");
    },
    { preconnect: previousFetch.preconnect },
  );
  const storage = {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => {
      saved.set(key, value);
    },
  };
  const c = new ChatController(() => {}, storage),
    internal = c as any;
  internal.view = {
    sessionId: "s",
    capabilities: { files: limits },
    recovery: [],
  };
  internal.storageKey = "lamplit.pending:s";
  internal.client = {
    close() {},
    async submit() {
      submissions++;
      throw Error("message admission unknown");
    },
    async lookup() {
      lookups++;
      return null;
    },
    async finalizeSubmission() {
      return null;
    },
  };
  const draft = { id: "f0", file: new File(["a"], "a") };
  try {
    await c.send("text", undefined, [], undefined, undefined, [draft]);
    const failed = c.pending[0]!;
    expect(failed).toMatchObject({
      state: "failed",
      dispatched: false,
    });
    expect(internal.fileOriginals.get(failed.operationId)?.[0].file).toBe(
      draft.file,
    );
    expect(reservations).toHaveLength(1);
    expect(submissions).toBe(0);
    await c.retryFailed(failed.operationId);
    expect(reservations).toHaveLength(2);
    expect(reservations[1]).not.toBe(reservations[0]);
    expect(submissions).toBe(1);
    expect(c.pending[0]!.logicalId).toBe(failed.operationId);
    expect(c.pending[0]!.state).toBe("sending");
  } finally {
    c.close();
    globalThis.fetch = previousFetch;
    if (previousLocation)
      Object.defineProperty(globalThis, "location", previousLocation);
    else delete (globalThis as any).location;
  }
});

test("unknown and other-owner operations do not expose retirement", async () => {
  const { FileOperationNotFoundError } =
    await import("../packages/contracts/src/server.ts");
  const backend: FileStreamBackend = {
    async reserve() {
      throw new FileOperationNotFoundError();
    },
    async status() {
      return null;
    },
    async receive() {
      throw Error("unexpected");
    },
    async complete() {
      throw Error("unexpected");
    },
  };
  const auth = async () => ({ ownerId: "other", sessionId: "s", limits });
  for (const [path, init] of [
    [base, json(manifest([1]))],
    [op, {}],
    [`${op}/files/f0`, put("f0", new Uint8Array([1]))],
    [`${op}/complete`, { method: "POST", headers: { origin: "http://test" } }],
  ] as [string, RequestInit][]) {
    expect(
      (await fileStreamHttp(
        new Request(`http://test${path}`, init),
        backend,
        auth,
      ))!.status,
    ).toBe(404);
  }
});

test("status lookup remains scoped and valid when intake is disabled or reduced", async () => {
  const { FileOperationRetiredError } =
    await import("../packages/contracts/src/server.ts");
  const stored = manifest([90_000_000, 90_000_000]);
  const completed = {
    sessionId: stored.sessionId,
    operationId,
    files: stored.files.map((f, order) => ({
      id: f.id,
      order,
      ref: {
        attachmentId: `ref${order}`,
        name: f.name,
        mediaType: f.mediaType,
        size: f.size,
        availability: "available" as const,
      },
    })),
  };
  let mode:
    | "uploading"
    | "completed"
    | "retired"
    | "missing"
    | "invalid"
    | "invalid-total"
    | "invalid-result" = "uploading";
  const backend: FileStreamBackend = {
    async reserve() {
      throw Error("unexpected mutation");
    },
    async status(_id, owner) {
      if (owner.ownerId !== "o" || mode === "missing") return null;
      if (mode === "retired") throw new FileOperationRetiredError();
      if (mode === "invalid")
        return {
          manifest: { ...stored, files: [stored.files[0]!, stored.files[0]!] },
          uploaded: [],
        };
      if (mode === "invalid-total")
        return {
          manifest: manifest([100_000_000, 100_000_000, 1]),
          uploaded: [],
        };
      if (mode === "invalid-result")
        return {
          manifest: stored,
          uploaded: ["f0", "f1"],
          result: { ...completed, files: [...completed.files].reverse() },
        };
      return {
        manifest: stored,
        uploaded: mode === "completed" ? ["f0", "f1"] : ["f0"],
        ...(mode === "completed" ? { result: completed } : {}),
      };
    },
    async receive() {
      throw Error("unexpected mutation");
    },
    async complete() {
      throw Error("unexpected mutation");
    },
  };
  for (const intake of [
    false,
    {
      maxFilesPerMessage: 1,
      maxFileBytes: 8_000_000,
      maxMessageFileBytes: 24_000_000,
    },
  ] as const) {
    const auth = async () => ({ ownerId: "o", sessionId: "s", limits: intake });
    for (const item of [
      "uploading",
      "completed",
      "retired",
      "missing",
      "invalid",
      "invalid-total",
      "invalid-result",
    ] as const) {
      mode = item;
      const response = (await fileStreamHttp(
        new Request(`http://test${op}`),
        backend,
        auth,
      ))!;
      expect(response.status).toBe(
        item === "retired"
          ? 410
          : item === "missing"
            ? 404
            : item.startsWith("invalid")
              ? 400
              : 200,
      );
      if (item === "completed")
        expect((await response.json()).result).toEqual(completed);
    }
    const other = (await fileStreamHttp(
      new Request(`http://test${op}`),
      backend,
      async () => ({ ownerId: "other", sessionId: "s", limits: intake }),
    ))!;
    expect(other.status).toBe(404);
  }
});

test("status rechecks owner and session even for 404 and retired outcomes", async () => {
  const { FileOperationRetiredError } =
    await import("../packages/contracts/src/server.ts");
  for (const outcome of ["existing", "missing", "retired"] as const)
    for (const change of ["owner", "session", "revoked"] as const) {
      let changed = false;
      const backend: FileStreamBackend = {
        async reserve() {
          throw Error();
        },
        async status() {
          changed = true;
          if (outcome === "retired") throw new FileOperationRetiredError();
          return outcome === "missing"
            ? null
            : { manifest: manifest([0]), uploaded: [] };
        },
        async receive() {
          throw Error();
        },
        async complete() {
          throw Error();
        },
      };
      const auth = async () =>
        changed && change === "revoked"
          ? null
          : {
              ownerId: changed && change === "owner" ? "other" : "o",
              sessionId: changed && change === "session" ? "other" : "s",
              limits: false as const,
            };
      expect(
        (await fileStreamHttp(new Request(`http://test${op}`), backend, auth))!
          .status,
      ).toBe(403);
    }
});

test("mutations enforce disabled or reduced current intake limits", async () => {
  const stored = manifest([90_000_000, 90_000_000]);
  let mutations = 0;
  const backend: FileStreamBackend = {
    async reserve() {
      mutations++;
      throw Error("unexpected");
    },
    async status() {
      return { manifest: stored, uploaded: ["f0", "f1"] };
    },
    async receive() {
      mutations++;
      throw Error("unexpected");
    },
    async complete() {
      mutations++;
      throw Error("unexpected");
    },
  };
  for (const intake of [
    false,
    {
      maxFilesPerMessage: 1,
      maxFileBytes: 8_000_000,
      maxMessageFileBytes: 24_000_000,
    },
  ] as const) {
    const auth = async () => ({ ownerId: "o", sessionId: "s", limits: intake });
    for (const [path, init] of [
      [base, json(stored)],
      [`${op}/files/f0`, put("f0", new Uint8Array())],
      [
        `${op}/complete`,
        { method: "POST", headers: { origin: "http://test" } },
      ],
    ] as [string, RequestInit][]) {
      const response = (await fileStreamHttp(
        new Request(`http://test${path}`, init),
        backend,
        auth,
      ))!;
      expect(response.status).toBe(intake === false ? 503 : 400);
    }
  }
  expect(mutations).toBe(0);
});

test("status remains observable if intake changes while lookup is in flight", async () => {
  const { FileOperationRetiredError } =
    await import("../packages/contracts/src/server.ts");
  for (const next of [
    false,
    { maxFilesPerMessage: 1, maxFileBytes: 1, maxMessageFileBytes: 1 },
  ] as const)
    for (const retired of [false, true]) {
      let currentLimits: typeof limits | false = limits;
      const backend: FileStreamBackend = {
        async reserve() {
          throw Error();
        },
        async status() {
          currentLimits = next;
          if (retired) throw new FileOperationRetiredError();
          return {
            manifest: manifest([100_000_000, 100_000_000]),
            uploaded: [],
          };
        },
        async receive() {
          throw Error();
        },
        async complete() {
          throw Error();
        },
      };
      const response = (await fileStreamHttp(
        new Request(`http://test${op}`),
        backend,
        async () => ({ ownerId: "o", sessionId: "s", limits: currentLimits }),
      ))!;
      expect(response.status).toBe(retired ? 410 : 200);
    }
});

test("mutation commit checks reject capability removal or limit reduction during work", async () => {
  for (const operation of ["reserve", "receive", "complete"] as const)
    for (const next of [
      false,
      { maxFilesPerMessage: 1, maxFileBytes: 1, maxMessageFileBytes: 1 },
    ] as const) {
      const stored = manifest([2]);
      let currentLimits: typeof limits | false = limits,
        commits = 0;
      const backend: FileStreamBackend = {
        async reserve(_m, _owner, check) {
          currentLimits = next;
          await check();
          commits++;
          return { manifest: stored, uploaded: [] };
        },
        async status() {
          return {
            manifest: stored,
            uploaded: operation === "complete" ? ["f0"] : [],
          };
        },
        async receive(_m, _id, bytes, _owner, check) {
          for await (const _chunk of bytes) {
          }
          currentLimits = next;
          await check();
          commits++;
        },
        async complete(_m, _owner, check) {
          currentLimits = next;
          await check();
          commits++;
          throw Error("unexpected");
        },
      };
      const [path, init] =
        operation === "reserve"
          ? [base, json(stored)]
          : operation === "receive"
            ? [`${op}/files/f0`, put("f0", new Uint8Array([1, 2]))]
            : [
                `${op}/complete`,
                { method: "POST", headers: { origin: "http://test" } },
              ];
      const response = (await fileStreamHttp(
        new Request(`http://test${path}`, init),
        backend,
        async () => ({ ownerId: "o", sessionId: "s", limits: currentLimits }),
      ))!;
      expect(response.status).toBe(400);
      expect(commits).toBe(0);
    }
});
