import { test, expect } from "bun:test";
import {
  ChatController,
  ATTACHMENT_CAPACITY_ERROR,
} from "../apps/web/src/lib/chat-controller.ts";
import { ChatConnectionError } from "../packages/contracts/src/client.ts";
import { createFileDrafts } from "../apps/web/src/lib/file-upload.ts";
import { fixtureImage } from "./panels-fixture.ts";
import { imageLimits } from "./images-fixture.ts";
import { fileLimits } from "./files-fixture.ts";
import { capabilities } from "../packages/contracts/src/index.ts";
const view = (sessionId: string) => ({
  sessionId,
  capabilities: { ...capabilities, images: imageLimits, files: fileLimits },
  messages: [],
  recovery: [],
});
const storage = () => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => {
      m.set(k, v);
    },
  };
};
const enter = (c: any, s: string) => {
  c.hydrate(s);
  c.view = view(s);
};
const props = ["location", "document", "createImageBitmap", "fetch"] as const;
const save = () =>
  new Map(
    props.map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]),
  );
const restore = (d: Map<string, PropertyDescriptor | undefined>) => {
  for (const [k, v] of d)
    if (v) Object.defineProperty(globalThis, k, v);
    else delete (globalThis as any)[k];
};
const set = (k: string, v: any) =>
  Object.defineProperty(globalThis, k, { configurable: true, value: v });
for (const mode of ["unknown", "failed"])
  for (const mixed of [false, true])
    test(`auth loss ${mode} ${mixed ? "mixed" : "image"}: clears revoked preview and retains references`, async () => {
      const desc = save(),
        realFetch = globalThis.fetch;
      set("location", { href: "http://fixture.invalid/" });
      set("createImageBitmap", async () => ({
        width: 1,
        height: 1,
        close() {},
      }));
      set("document", {
        createElement: () => ({
          getContext: () => ({ drawImage() {} }),
          toBlob: (cb: any) =>
            cb(
              new Blob([new Uint8Array([255, 216, 255, 224])], {
                type: "image/jpeg",
              }),
            ),
        }),
      });
      let imageBytes = "",
        fileBytes = "",
        submits = 0,
        retries = 0,
        lookups = 0,
        released = 0;
      set("fetch", async (url: any, init: any) => {
        const path = new URL(String(url)).pathname,
          input = JSON.parse(init.body);
        if (path === "/api/chat/images") {
          imageBytes = input.images[0].original;
          return Response.json({
            sessionId: input.sessionId,
            operationId: input.operationId,
            images: input.images.map((x: any) => ({
              id: x.id,
              order: x.order,
              ref: {
                attachmentId: "image-ref",
                name: x.name,
                mediaType: x.mediaType,
                availability: "available",
              },
            })),
          });
        }
        if (path === "/api/chat/files") {
          fileBytes = input.files[0].data;
          return Response.json({
            sessionId: input.sessionId,
            operationId: input.operationId,
            files: input.files.map((x: any) => ({
              id: x.id,
              order: x.order,
              ref: {
                attachmentId: "file-ref",
                name: x.name,
                mediaType: x.mediaType,
                size: x.size,
                availability: "available",
              },
            })),
          });
        }
        throw Error(`unexpected route ${path}`);
      });
      const c = new ChatController(() => {}, storage()),
        x = c as any;
      const client = {
        close() {},
        async submit(input: any) {
          submits++;
          if (mode === "unknown") throw Error("ack lost");
          return {
            operationId: input.operationId,
            state: "failed",
            messageId: null,
            turnId: null,
            error: "failed",
          };
        },
        async lookup() {
          lookups++;
          return null;
        },
        async retryFailed() {
          retries++;
          throw Error("unexpected retry");
        },
      };
      x.client = client;
      enter(x, "A");
      const file = new File([fixtureImage], "image.png", { type: "image/png" });
      const previewUrl = URL.createObjectURL(file);
      const image = { id: "image1", file, previewUrl };
      try {
        expect((await realFetch(previewUrl)).ok).toBe(true);
        await c.send(
          "message",
          () => {
            released++;
            URL.revokeObjectURL(previewUrl);
          },
          [image],
          [],
          undefined,
          undefined,
          mixed
            ? createFileDrafts([
                new File([new Uint8Array([0, 1, 255])], "original.bin"),
              ])
            : [],
        );
        const p = c.pending[0]!;
        expect(p.dispatched).toBe(true);
        expect(p.state).toBe(mode === "failed" ? "failed" : "sending");
        expect(p.images?.[0]?.attachmentId).toBe("image-ref");
        expect(imageBytes).toBe(Buffer.from(fixtureImage).toString("base64"));
        if (mixed) expect(fileBytes).toBe("AAH/");
        x.disconnected(new ChatConnectionError("revoked", false));
        expect(released).toBe(1);
        await expect(realFetch(previewUrl)).rejects.toThrow();
        x.client = client;
        x.observe(view("A"));
        await x.reconcile();
        expect(c.pending[0]?.previews).toBeUndefined();
        expect(c.pending[0]?.images?.[0]?.attachmentId).toBe("image-ref");
        expect(submits).toBe(1);
        expect(retries).toBe(0);
        if (mode === "unknown") expect(lookups).toBeGreaterThan(0);
      } finally {
        c.close();
        URL.revokeObjectURL(previewUrl);
        restore(desc);
      }
    });
test("capacity retry distinguishes unsettled cancellation from an ordinary upload failure", async () => {
  const desc = save();
  set("location", { href: "http://fixture.invalid/" });
  const releases: ((v: Response) => void)[] = [];
  set(
    "fetch",
    async () => await new Promise<Response>((r) => releases.push(r)),
  );
  const c = new ChatController(() => {}, storage()),
    x = c as any;
  let submits = 0;
  x.client = {
    close() {},
    async submit() {
      submits++;
    },
  };
  const work: Promise<void>[] = [];
  try {
    for (let i = 0; i < 20; i++) {
      enter(x, `s${i}`);
      work.push(
        c.send(
          "",
          undefined,
          [],
          [],
          undefined,
          undefined,
          createFileDrafts([new File([new Uint8Array([i])], `f${i}`)]),
        ),
      );
      while (releases.length <= i) await new Promise((r) => setTimeout(r, 0));
    }
    enter(x, "s0");
    const id = c.pending[0]!.operationId;
    expect(c.pending[0]?.state).toBe("failed");
    expect(x.attachmentPreparations.has(id)).toBe(true);
    expect(x.retainedAttachmentCount()).toBe(20);
    await expect(
      c.send(
        "",
        undefined,
        [],
        [],
        undefined,
        undefined,
        createFileDrafts([new File([], "overflow")]),
      ),
    ).rejects.toMatchObject({ code: ATTACHMENT_CAPACITY_ERROR });
    await c.retryFailed(id);
    expect(c.error).toBe(
      "附件准备尚未结束，或待确认附件过多；请稍候，或处理其他会话中的待确认消息后重试。",
    );
    expect(c.errorCode).toBe(ATTACHMENT_CAPACITY_ERROR);
    expect(releases.length).toBe(20);
    expect(submits).toBe(0);
    releases[0]!(new Response(null, { status: 503 }));
    await work[0];
    const normalRetry = c.retryFailed(id);
    while (releases.length < 21) await new Promise((r) => setTimeout(r, 0));
    releases[20]!(new Response(null, { status: 503 }));
    await normalRetry;
    expect(c.error).toBe("文件上传失败，请重试。");
    expect(c.errorCode).toBeUndefined();
    expect(submits).toBe(0);
  } finally {
    c.close();
    for (const r of releases) r(new Response(null, { status: 503 }));
    await Promise.all(work);
    restore(desc);
  }
});

test("authorization loss clears previews even when no image references exist", () => {
  for (const images of [undefined, []]) {
    const c = new ChatController(() => {}, storage());
    const inner = c as any;
    inner.client = { close() {} };
    enter(inner, "A");
    const operationId = crypto.randomUUID();
    inner.pending = [
      {
        operationId,
        text: "",
        createdAt: Date.now(),
        state: "sending",
        dispatched: true,
        localImageCount: 1,
        images,
        previews: [
          { id: "local", name: "image.png", previewUrl: "blob:revoked" },
        ],
      },
    ];
    try {
      inner.disconnected(new ChatConnectionError("revoked", false));
      expect(c.pending[0]?.previews).toBeUndefined();
      expect(c.pending[0]?.images).toBeUndefined();
      expect(c.pending[0]?.localImageCount).toBe(1);
      expect(c.pending[0]?.state).toBe("sending");
    } finally {
      c.close();
    }
  }
});
