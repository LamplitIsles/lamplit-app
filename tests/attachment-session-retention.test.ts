import { expect, test } from "bun:test";
import { ChatConnectionError } from "../packages/contracts/src/client.ts";
import { ChatController } from "../apps/web/src/lib/chat-controller.ts";
import { createFileDrafts } from "../apps/web/src/lib/file-upload.ts";
import { imageLimits } from "./images-fixture.ts";
import { fixtureImage } from "./panels-fixture.ts";
import { fileLimits } from "./files-fixture.ts";
import { capabilities } from "../packages/contracts/src/index.ts";

const view = (sessionId: string) => ({
  sessionId,
  capabilities: { ...capabilities, images: imageLimits, files: fileLimits },
  messages: [],
  recovery: [],
});
const storage = (saved = new Map<string, string>()) => ({
  getItem: (key: string) => saved.get(key) ?? null,
  setItem: (key: string, value: string) => {
    saved.set(key, value);
  },
});
const enter = (controller: ChatController, sessionId: string) => {
  const c = controller as any;
  c.hydrate(sessionId);
  c.view = view(sessionId);
};

test("failed and in-flight attachments survive A-B-A and retry without reselecting files", async () => {
  const properties = [
    "location",
    "document",
    "createImageBitmap",
    "fetch",
  ] as const;
  const descriptors = new Map(
    properties.map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: { href: "http://fixture.invalid/" },
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
        toBlob: (callback: (blob: Blob) => void) =>
          callback(
            new Blob([new Uint8Array([255, 216, 255, 224])], {
              type: "image/jpeg",
            }),
          ),
      }),
    },
  });
  try {
    for (const mode of ["failed", "in-flight"] as const)
      for (const mixed of [false, true]) {
        let uploads = 0,
          retirements = 0;
        const submissions: any[] = [],
          operations: string[] = [];
        let resolveOld!: (response: Response) => void, notify!: () => void;
        let oldSignal: AbortSignal | null | undefined;
        const entered = new Promise<void>((resolve) => {
          notify = resolve;
        });
        const manifests = new Map<string, any>();
        Object.defineProperty(globalThis, "fetch", {
          configurable: true,
          value: async (url: URL | string, init: RequestInit) => {
            const path = new URL(url.toString()).pathname;
            if (path === "/api/chat/images") {
              const input = JSON.parse(String(init.body));
              return Response.json({
                sessionId: input.sessionId,
                operationId: input.operationId,
                images: input.images.map((item: any) => ({
                  id: item.id,
                  order: item.order,
                  ref: {
                    attachmentId: `img_${input.operationId}`,
                    name: item.name,
                    mediaType: item.mediaType,
                    availability: "available",
                  },
                })),
              });
            }
            if (path === "/api/chat/file-operations") {
              const input = JSON.parse(String(init.body));
              uploads++;
              operations.push(input.operationId);
              expect(input.sessionId).toBe("A");
              manifests.set(input.operationId, input);
              if (uploads === 1) {
                oldSignal = init.signal;
                notify();
                if (mode === "failed")
                  return new Response(null, { status: 503 });
                return await new Promise<Response>((resolve) => {
                  resolveOld = resolve;
                });
              }
              return Response.json({ manifest: input, uploaded: [] });
            }
            const parts = path.split("/");
            const input = manifests.get(parts[4]!);
            if (init.method === "GET")
              return new Response(null, { status: 404 });
            if (init.method === "PUT") {
              expect([
                ...new Uint8Array(await (init.body as Blob).arrayBuffer()),
              ]).toEqual([1, 2, 3]);
              return new Response(null, { status: 204 });
            }
            if (path.endsWith("/complete"))
              return Response.json({
                sessionId: input.sessionId,
                operationId: input.operationId,
                files: input.files.map((f: any, order: number) => ({
                  id: f.id,
                  order,
                  ref: {
                    attachmentId: `file_${input.operationId}`,
                    name: f.name,
                    mediaType: f.mediaType,
                    size: f.size,
                    availability: "available",
                  },
                })),
              });
            throw new Error(`unexpected route ${path}`);
          },
        });
        const controller = new ChatController(() => {}, storage());
        const c = controller as any;
        c.client = {
          close() {},
          async submit(input: any) {
            submissions.push(input);
            return {
              operationId: input.operationId,
              attempt: 1,
              state: "submitted",
              messageId: null,
              turnId: null,
              error: null,
            };
          },
        };
        enter(controller, "A");
        const drafts = createFileDrafts([
          new File([new Uint8Array([1, 2, 3])], "original.bin"),
        ]);
        const image = {
          id: "image_1",
          file: new File([fixtureImage], "photo.png", { type: "image/png" }),
          previewUrl: "blob:fake-preview",
        };
        const sending = controller.send(
          "message",
          () => {
            retirements++;
          },
          mixed ? [image] : [],
          undefined,
          undefined,
          drafts,
        );
        await entered;
        if (mode === "failed") await sending;
        const originalId = controller.pending[0]!.operationId;
        enter(controller, "B");
        if (mode === "in-flight") expect(oldSignal?.aborted).toBe(true);
        expect(controller.pending).toEqual([]);
        expect(c.fileOriginals.size).toBe(0);
        expect(c.originals.size).toBe(0);
        expect(retirements).toBe(0);
        enter(controller, "A");
        expect(controller.pending[0]).toMatchObject({
          operationId: originalId,
          state: "failed",
          dispatched: false,
        });
        expect(c.fileOriginals.get(originalId)?.[0].file).toBe(drafts[0]!.file);
        if (mixed) {
          expect(c.originals.get(originalId)?.[0].file).toBe(image.file);
          expect(controller.pending[0]?.previews?.[0]?.previewUrl).toBe(
            image.previewUrl,
          );
        }
        expect(submissions).toHaveLength(0);
        await controller.retryFailed(originalId);
        expect(submissions).toHaveLength(1);
        expect(operations).toHaveLength(2);
        expect(operations[1]).not.toBe(originalId);
        expect(submissions[0].operationId).toBe(operations[1]);
        expect(controller.pending[0]?.logicalId).toBe(originalId);
        expect(retirements).toBe(0);
        if (mode === "in-flight") {
          resolveOld(
            Response.json({
              sessionId: "A",
              operationId: originalId,
              files: [],
            }),
          );
          await sending;
          expect(submissions).toHaveLength(1);
          expect(controller.pending[0]?.operationId).toBe(operations[1]);
        }
        controller.close();
        expect(retirements).toBe(1);
      }
  } finally {
    for (const [key, descriptor] of descriptors)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as any)[key];
  }
});

test("parked attachments have a page-wide bound and release on delete, close, and authorization loss", async () => {
  const oldLocation = Object.getOwnPropertyDescriptor(globalThis, "location"),
    oldFetch = Object.getOwnPropertyDescriptor(globalThis, "fetch");
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: { href: "http://fixture.invalid/" },
  });
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async () => new Response(null, { status: 503 }),
  });
  const c = new ChatController(() => {}, storage());
  const inner = c as any;
  inner.client = { close() {} };
  let retired = 0;
  try {
    for (let i = 0; i < 20; i++) {
      enter(c, `session_${i}`);
      await c.send(
        "",
        () => {
          retired++;
        },
        [],
        undefined,
        undefined,
        createFileDrafts([new File([], `file_${i}`)]),
      );
      expect(c.pending[0]?.state).toBe("failed");
    }
    enter(c, "overflow");
    await expect(
      c.send(
        "",
        undefined,
        [],
        undefined,
        undefined,
        createFileDrafts([new File([], "extra")]),
      ),
    ).rejects.toThrow("附件准备尚未结束，或待确认附件过多");
    expect(retired).toBe(0);
    enter(c, "session_0");
    await c.deleteFailed(c.pending[0]!.operationId);
    expect(retired).toBe(1);
    enter(c, "overflow");
    await c.send(
      "",
      () => {
        retired++;
      },
      [],
      undefined,
      undefined,
      createFileDrafts([new File([], "extra")]),
    );
    expect(c.pending[0]?.state).toBe("failed");
    inner.disconnected(new ChatConnectionError("revoked", false));
    expect(retired).toBe(21);
    expect(inner.parkedAttachments.size).toBe(0);
    expect(inner.fileOriginals.size).toBe(0);
    c.close();
    expect(retired).toBe(21);
  } finally {
    c.close();
    if (oldLocation) Object.defineProperty(globalThis, "location", oldLocation);
    else delete (globalThis as any).location;
    if (oldFetch) Object.defineProperty(globalThis, "fetch", oldFetch);
    else delete (globalThis as any).fetch;
  }
});

test("memory-only originals survive storage failure but are released when the controller closes", async () => {
  const oldLocation = Object.getOwnPropertyDescriptor(globalThis, "location"),
    oldFetch = Object.getOwnPropertyDescriptor(globalThis, "fetch");
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: { href: "http://fixture.invalid/" },
  });
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async () => new Response(null, { status: 503 }),
  });
  const c = new ChatController(() => {}, {
    getItem: () => null,
    setItem: () => {
      throw new Error("quota");
    },
  });
  (c as any).client = { close() {} };
  let retired = 0;
  try {
    enter(c, "A");
    await c.send(
      "",
      () => {
        retired++;
      },
      [],
      undefined,
      undefined,
      createFileDrafts([new File([], "x")]),
    );
    const operation = c.pending[0]!.operationId;
    enter(c, "B");
    enter(c, "A");
    expect(c.pending[0]?.operationId).toBe(operation);
    expect((c as any).fileOriginals.has(operation)).toBe(true);
    enter(c, "B");
    c.close();
    expect(retired).toBe(1);
  } finally {
    c.close();
    if (oldLocation) Object.defineProperty(globalThis, "location", oldLocation);
    else delete (globalThis as any).location;
    if (oldFetch) Object.defineProperty(globalThis, "fetch", oldFetch);
    else delete (globalThis as any).fetch;
  }
});

test("reload cannot recover browser File objects but keeps failure metadata", async () => {
  const oldLocation = Object.getOwnPropertyDescriptor(globalThis, "location"),
    oldFetch = Object.getOwnPropertyDescriptor(globalThis, "fetch");
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: { href: "http://fixture.invalid/" },
  });
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async () => new Response(null, { status: 503 }),
  });
  const saved = new Map<string, string>();
  const first = new ChatController(() => {}, storage(saved));
  (first as any).client = { close() {} };
  const reopened = new ChatController(() => {}, storage(saved));
  (reopened as any).client = { close() {} };
  try {
    enter(first, "A");
    await first.send(
      "",
      undefined,
      [],
      undefined,
      undefined,
      createFileDrafts([new File([], "x")]),
    );
    first.close();
    enter(reopened, "A");
    expect(reopened.pending[0]?.fileDrafts?.[0]?.name).toBe("x");
    await reopened.retryFailed(reopened.pending[0]!.operationId);
    expect(reopened.error).toContain("原文件不可用");
  } finally {
    first.close();
    reopened.close();
    if (oldLocation) Object.defineProperty(globalThis, "location", oldLocation);
    else delete (globalThis as any).location;
    if (oldFetch) Object.defineProperty(globalThis, "fetch", oldFetch);
    else delete (globalThis as any).fetch;
  }
});

test("dispatched unknown outcomes still only look up after A-B-A", async () => {
  const attempt = crypto.randomUUID();
  const ref = {
    attachmentId: "file",
    name: "x",
    mediaType: "",
    size: 0,
    availability: "available" as const,
  };
  const saved = new Map<string, string>([
    [
      "lamplit.pending:A",
      JSON.stringify([
        {
          operationId: attempt,
          text: "",
          files: [ref],
          state: "sending",
          dispatched: true,
          createdAt: Date.now(),
        },
      ]),
    ],
  ]);
  const c = new ChatController(() => {}, storage(saved));
  const inner = c as any;
  let lookups = 0,
    submissions = 0;
  inner.client = {
    close() {},
    async lookup() {
      lookups++;
      return null;
    },
    async submit() {
      submissions++;
    },
    async retryFailed() {
      submissions++;
    },
  };
  try {
    enter(c, "A");
    enter(c, "B");
    enter(c, "A");
    await inner.reconcile();
    expect(lookups).toBe(1);
    expect(submissions).toBe(0);
    expect(c.pending[0]?.state).toBe("sending");
    expect(c.pending[0]?.files).toEqual([ref]);
  } finally {
    c.close();
  }
});

test("aborted but unsettled preparations still count toward the page bound", async () => {
  const oldLocation = Object.getOwnPropertyDescriptor(globalThis, "location"),
    oldFetch = Object.getOwnPropertyDescriptor(globalThis, "fetch");
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: { href: "http://fixture.invalid/" },
  });
  const releases: Array<(response: Response) => void> = [];
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (_url: URL, init?: RequestInit) =>
      !init?.method || init.method === "GET"
        ? new Response(null, { status: 404 })
        : await new Promise<Response>((resolve) => {
            releases.push(resolve);
          }),
  });
  const c = new ChatController(() => {}, storage());
  (c as any).client = { close() {} };
  const work: Promise<void>[] = [];
  try {
    for (let i = 0; i < 20; i++) {
      enter(c, `s${i}`);
      work.push(
        c.send(
          "",
          undefined,
          [],
          undefined,
          undefined,
          createFileDrafts([new File([], `f${i}`)]),
        ),
      );
      while (releases.length <= i)
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
    enter(c, "s0");
    await c.deleteFailed(c.pending[0]!.operationId);
    enter(c, "new");
    await expect(
      c.send(
        "",
        undefined,
        [],
        undefined,
        undefined,
        createFileDrafts([new File([], "extra")]),
      ),
    ).rejects.toThrow("附件准备尚未结束，或待确认附件过多");
    releases[0]!(new Response(null, { status: 503 }));
    await work[0];
    const last = c.send(
      "",
      undefined,
      [],
      undefined,
      undefined,
      createFileDrafts([new File([], "extra")]),
    );
    while (releases.length < 21)
      await new Promise((resolve) => setTimeout(resolve, 0));
    releases[20]!(new Response(null, { status: 503 }));
    await last;
    expect(c.pending[0]?.state).toBe("failed");
  } finally {
    c.close();
    for (const resolve of releases)
      resolve(new Response(null, { status: 503 }));
    await Promise.all(work);
    if (oldLocation) Object.defineProperty(globalThis, "location", oldLocation);
    else delete (globalThis as any).location;
    if (oldFetch) Object.defineProperty(globalThis, "fetch", oldFetch);
    else delete (globalThis as any).fetch;
  }
});

test("photo-only preparation failure remains retryable after a session switch", async () => {
  const keys = ["location", "document", "createImageBitmap", "fetch"] as const;
  const original = new Map(
    keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: { href: "http://fixture.invalid/" },
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
          cb(new Blob([new Uint8Array([255, 216, 255, 224])])),
      }),
    },
  });
  let requests = 0,
    sent = 0,
    released = 0;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (_url: URL, init: RequestInit) => {
      requests++;
      if (requests === 1) return new Response(null, { status: 503 });
      const input = JSON.parse(String(init.body));
      return Response.json({
        sessionId: input.sessionId,
        operationId: input.operationId,
        images: input.images.map((img: any) => ({
          id: img.id,
          order: img.order,
          ref: {
            attachmentId: "photo",
            name: img.name,
            mediaType: img.mediaType,
            availability: "available",
          },
        })),
      });
    },
  });
  const c = new ChatController(() => {}, storage());
  (c as any).client = {
    close() {},
    async submit(input: any) {
      sent++;
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
    enter(c, "A");
    const image = {
      id: "image",
      file: new File([fixtureImage], "photo.png", { type: "image/png" }),
      previewUrl: "blob:photo",
    };
    await c.send(
      "",
      () => {
        released++;
      },
      [image],
    );
    const id = c.pending[0]!.operationId;
    enter(c, "B");
    enter(c, "A");
    expect(c.pending[0]?.previews?.[0]?.previewUrl).toBe(image.previewUrl);
    expect(released).toBe(0);
    await c.retryFailed(id);
    expect(sent).toBe(1);
    expect(requests).toBe(2);
  } finally {
    c.close();
    for (const [key, descriptor] of original)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as any)[key];
  }
  expect(released).toBe(1);
});

test("reload validates pending file metadata at protocol boundaries", () => {
  const drafts = Array.from({ length: 6 }, (_, i) => ({
    id: `file${i}`,
    name: `file${i}`,
    size: i === 0 ? 100_000_000 : 0,
  }));
  const pending = {
    operationId: crypto.randomUUID(),
    text: "",
    state: "failed",
    dispatched: false,
    localFileCount: 6,
    fileDrafts: drafts,
    createdAt: 1,
  };
  const saved = new Map([["lamplit.pending:A", JSON.stringify([pending])]]);
  const controller = new ChatController(() => {}, storage(saved));
  try {
    enter(controller, "A");
    expect(controller.pending[0]?.fileDrafts).toEqual(drafts);
    const oversize = new ChatController(
      () => {},
      storage(
        new Map([
          [
            "lamplit.pending:A",
            JSON.stringify([
              { ...pending, fileDrafts: [{ ...drafts[0], size: 100_000_001 }] },
            ]),
          ],
        ]),
      ),
    );
    try {
      enter(oversize, "A");
      expect(oversize.pending[0]?.fileDrafts).toBeUndefined();
    } finally {
      oversize.close();
    }
    const tooManyDrafts = new ChatController(
      () => {},
      storage(
        new Map([
          [
            "lamplit.pending:A",
            JSON.stringify([
              {
                ...pending,
                fileDrafts: [
                  ...drafts,
                  { id: "extra", name: "extra", size: 0 },
                ],
              },
            ]),
          ],
        ]),
      ),
    );
    try {
      enter(tooManyDrafts, "A");
      expect(tooManyDrafts.pending[0]?.fileDrafts).toBeUndefined();
    } finally {
      tooManyDrafts.close();
    }
    const overcount = new ChatController(
      () => {},
      storage(
        new Map([
          [
            "lamplit.pending:A",
            JSON.stringify([{ ...pending, localFileCount: 7 }]),
          ],
        ]),
      ),
    );
    try {
      enter(overcount, "A");
      expect(overcount.pending).toEqual([]);
      expect(overcount.error).toBe("无法读取上次发送状态，请先检查聊天记录。");
    } finally {
      overcount.close();
    }
  } finally {
    controller.close();
  }
});
