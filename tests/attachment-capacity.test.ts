import { expect, test } from "bun:test";
import {
  ATTACHMENT_CAPACITY_ERROR,
  PENDING_MESSAGE_CAPACITY_ERROR,
  ChatController,
} from "../apps/web/src/lib/chat-controller.ts";
import { ChatConnectionError } from "../packages/contracts/src/client.ts";
import { capabilities } from "../packages/contracts/src/index.ts";
import { createFileDrafts } from "../apps/web/src/lib/file-upload.ts";
import { fileLimits } from "./files-fixture.ts";
import { imageLimits } from "./images-fixture.ts";

function fixture() {
  const saved = new Map<string, string>();
  const controller = new ChatController(() => {}, {
    getItem: (key) => saved.get(key) ?? null,
    setItem: (key, value) => void saved.set(key, value),
  });
  const inner = controller as any;
  let submissions = 0;
  inner.client = {
    close() {},
    async submit() {
      submissions++;
      throw new Error("unexpected submit");
    },
  };
  const enter = (sessionId: string) => {
    inner.hydrate(sessionId);
    inner.view = {
      sessionId,
      capabilities: { ...capabilities, images: imageLimits, files: fileLimits },
      messages: [],
      recovery: [],
    };
  };
  enter("A");
  return { controller, inner, enter, submissions: () => submissions };
}
const image = () => ({
  id: "image",
  file: new File([new Uint8Array([1])], "photo.png", { type: "image/png" }),
  previewUrl: "blob:fixture",
});
const files = () => createFileDrafts([new File(["file"], "file.txt")]);
const pending = () =>
  Array.from({ length: 20 }, (_, index) => ({
    operationId: crypto.randomUUID(),
    text: `pending ${index}`,
    state: "failed" as const,
    dispatched: true,
    createdAt: Date.now(),
  }));
async function rejected(
  work: Promise<unknown>,
): Promise<Error & { code?: string }> {
  try {
    await work;
    throw new Error("expected rejection");
  } catch (error) {
    return error as Error & { code?: string };
  }
}

for (const kind of ["image", "file", "mixed", "text", "sticker"] as const) {
  test(`same-session pending limit: ${kind}`, async () => {
    const { controller: c, inner, submissions } = fixture();
    inner.pending = pending();
    let retired = 0;
    const images = kind === "image" || kind === "mixed" ? [image()] : [];
    const drafts = kind === "file" || kind === "mixed" ? files() : [];
    const sticker =
      kind === "sticker"
        ? ({ pack: "unused", id: "unused" } as any)
        : undefined;
    try {
      const error = await rejected(
        c.send(
          "draft",
          () => retired++,
          images,
          [],
          undefined,
          sticker,
          drafts,
        ),
      );
      if (images.length || drafts.length) {
        expect(error.code).toBe(PENDING_MESSAGE_CAPACITY_ERROR);
        expect(error.message).toBe(
          "当前会话的待确认消息已达上限，请先处理这些消息后再重试。",
        );
      } else {
        expect(error.code).toBeUndefined();
        expect(error.message).toBe("请先核对尚未确认的消息");
      }
      expect(c.pending).toHaveLength(20);
      expect(retired).toBe(0);
      expect(submissions()).toBe(0);
    } finally {
      c.close();
    }
  });
}

test("typed capacity state survives different wording and clears on replacement, session switch and authorization loss", async () => {
  const { controller: c, inner, enter } = fixture();
  try {
    inner.pending = pending();
    const current = await rejected(
      c.send("", undefined, [], [], undefined, undefined, files()),
    );
    current.message = "independently changed message";
    c.setError(current);
    expect(c.error).toBe("independently changed message");
    expect(c.errorCode).toBe(PENDING_MESSAGE_CAPACITY_ERROR);
    c.error = "当前会话的待确认消息已达上限，请先处理这些消息后再重试。";
    expect(c.errorCode).toBeUndefined();
    c.setError(current);
    c.error = "普通失败";
    expect(c.errorCode).toBeUndefined();
    c.setError(current);
    c.error = "";
    expect(c.errorCode).toBeUndefined();
    c.setError(current);
    enter("B");
    expect(c.error).toBe("");
    expect(c.errorCode).toBeUndefined();
    for (let i = 0; i < 20; i++)
      inner.fileOriginals.set(`retained-${i}`, files());
    const retained = await rejected(
      c.send("", undefined, [], [], undefined, undefined, files()),
    );
    expect(retained.code).toBe(ATTACHMENT_CAPACITY_ERROR);
    retained.message = "another wording";
    c.setError(retained);
    expect(c.error).toBe("another wording");
    expect(c.errorCode).toBe(ATTACHMENT_CAPACITY_ERROR);
    c.setError(new Error("ordinary error"));
    expect(c.errorCode).toBeUndefined();
    c.setError(retained);
    inner.disconnected(new ChatConnectionError("authorization lost", false));
    expect(c.error).toBe("");
    expect(c.errorCode).toBeUndefined();
  } finally {
    c.close();
  }
});

test("a successful send clears prior capacity state", async () => {
  const { controller: c, inner } = fixture();
  try {
    inner.pending = pending();
    const error = await rejected(
      c.send("", undefined, [], [], undefined, undefined, files()),
    );
    c.setError(error);
    expect(c.errorCode).toBe(PENDING_MESSAGE_CAPACITY_ERROR);
    inner.pending = [];
    inner.client = {
      close() {},
      async submit(input: any) {
        return {
          operationId: input.operationId,
          state: "submitted",
          messageId: null,
          turnId: null,
          error: null,
        };
      },
    };
    await c.send("ordinary text");
    expect(c.error).toBe("");
    expect(c.errorCode).toBeUndefined();
  } finally {
    c.close();
  }
});

test("an explicit pre-dispatch retry replaces its pending item at the same-session limit", async () => {
  const originalLocation = Object.getOwnPropertyDescriptor(
    globalThis,
    "location",
  );
  const originalFetch = Object.getOwnPropertyDescriptor(globalThis, "fetch");
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: { href: "http://fixture.invalid/" },
  });
  let uploads = 0;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (_url: URL, init?: RequestInit) => {
      if (!init?.method || init.method === "GET") return new Response(null, { status: 404 });
      uploads++;
      return new Response(null, { status: 503 });
    },
  });
  const { controller: c, inner, submissions } = fixture();
  const drafts = files();
  const all = pending();
  const first = { ...all[0]!, dispatched: false, localFileCount: 1 };
  inner.pending = [first, ...all.slice(1)];
  inner.fileOriginals.set(first.operationId, drafts);
  try {
    await c.retryFailed(first.operationId);
    expect(uploads).toBe(1);
    expect(c.pending).toHaveLength(20);
    expect(c.pending.at(-1)?.operationId).not.toBe(first.operationId);
    expect(c.pending.at(-1)?.logicalId).toBe(first.operationId);
    expect(c.pending.at(-1)?.state).toBe("failed");
    expect(c.error).toBe("文件上传失败，请重试。");
    expect(c.errorCode).toBeUndefined();
    expect(submissions()).toBe(0);
  } finally {
    c.close();
    if (originalLocation)
      Object.defineProperty(globalThis, "location", originalLocation);
    else delete (globalThis as any).location;
    if (originalFetch)
      Object.defineProperty(globalThis, "fetch", originalFetch);
    else delete (globalThis as any).fetch;
  }
});
