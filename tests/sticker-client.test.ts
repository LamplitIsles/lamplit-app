import { expect, test, mock } from "bun:test";
import * as contracts from "../packages/contracts/src/index.ts";
// The repository's normal test script builds dist. Exercise current sources without building it.
mock.module("@lamplit/contracts", () => contracts);
const { StickerClient } = await import("../apps/web/src/lib/sticker-client.ts");
const { ChatController } =
  await import("../apps/web/src/lib/chat-controller.ts");
const version = "a".repeat(64);
const sticker = {
  id: "cat",
  version,
  name: "猫",
  tags: [],
  mediaType: "image/gif" as const,
  available: true,
};
const image = {
  attachmentId: "image",
  name: "cat.gif",
  mediaType: "image/gif" as const,
  availability: "available" as const,
  sticker: { id: "cat", version },
};
const json = (body: unknown) => Response.json(body);
// Bun adds preconnect to fetch; these fakes must never open real connections.
const fakeFetch = (handler: () => Promise<Response>): typeof fetch =>
  Object.assign(handler, { preconnect: () => {} });

test("default transport keeps the global receiver for picker list requests", async () => {
  const previousFetch = globalThis.fetch;
  const requests: {
    path: string;
    session: string | null;
    query: string | null;
  }[] = [];
  globalThis.fetch = Object.assign(
    async function (
      this: unknown,
      input: string | URL | Request,
      init?: RequestInit,
    ) {
      expect(this).toBe(globalThis);
      expect(typeof input).toBe("string");
      expect(init?.credentials).toBe("same-origin");
      expect(init?.cache).toBe("no-store");
      const url = new URL(String(input), "http://fixture");
      requests.push({
        path: url.pathname,
        session: url.searchParams.get("sessionId"),
        query: url.searchParams.get("query"),
      });
      if (url.pathname === "/api/stickers/packs")
        return json({ packs: [], nextCursor: null });
      if (
        url.pathname === "/api/stickers/favorites" ||
        url.pathname === "/api/stickers/search"
      )
        return json({ stickers: [sticker], nextCursor: null });
      throw new Error("Unexpected fake endpoint");
    },
    { preconnect: () => {} },
  );
  let client: InstanceType<typeof StickerClient> | undefined;
  try {
    client = new StickerClient("fixture-session", () => true);
    const packs = await client.page("packs");
    const [favorites1, favorites2, search1, search2] = await Promise.all([
      client.page("favorites"),
      client.page("favorites"),
      client.page("search", { query: "猫" }),
      client.page("search", { query: "cat" }),
    ]);
    expect(packs.nextCursor).toBeNull();
    for (const page of [favorites1, favorites2, search1, search2]) {
      expect("stickers" in page && page.stickers).toEqual([sticker]);
    }
    expect(requests).toEqual([
      { path: "/api/stickers/packs", session: "fixture-session", query: null },
      {
        path: "/api/stickers/favorites",
        session: "fixture-session",
        query: null,
      },
      {
        path: "/api/stickers/favorites",
        session: "fixture-session",
        query: null,
      },
      { path: "/api/stickers/search", session: "fixture-session", query: "猫" },
      {
        path: "/api/stickers/search",
        session: "fixture-session",
        query: "cat",
      },
    ]);
  } finally {
    client?.close();
    globalThis.fetch = previousFetch;
  }
});

test("client paginates, searches and favorites existing sticker identity without recreating it", async () => {
  const requests: { path: string; body?: any }[] = [];
  const transport = (async (path: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ path, body });
    if (path.startsWith("/api/stickers/packs?"))
      return json({ packs: [], nextCursor: "next" });
    if (path.startsWith("/api/stickers/search?"))
      return json({ stickers: [sticker], nextCursor: null });
    if (path === "/api/stickers/favorites")
      return json({ sticker, favorite: body.favorite });
    if (path === "/api/stickers/favorites/image")
      return json({ sticker, favorite: true });
    throw new Error(path);
  }) as typeof fetch;
  const c = new StickerClient("session", () => true, transport);
  expect((await c.page("packs")).nextCursor).toBe("next");
  await c.page("search", { cursor: "next", query: "猫" });
  await c.favoriteImage(image);
  await c.favoriteImage({ ...image, sticker: undefined });
  expect(requests[1]!.path).toContain("cursor=next");
  expect(requests[2]).toEqual({
    path: "/api/stickers/favorites",
    body: { sessionId: "session", stickerId: "cat", favorite: true },
  });
  expect(requests[3]!.body).toEqual({
    sessionId: "session",
    imageId: "image",
    name: "cat.gif",
    tags: [],
  });
});

test("thumbnail cache is session local, revalidates, evicts on revocation, and ignores stale responses", async () => {
  let status = 200;
  let calls = 0;
  let live = true;
  const transport = (async (_path: string, init?: RequestInit) => {
    calls++;
    if (calls === 2)
      expect(new Headers(init?.headers).get("if-none-match")).toBe('"one"');
    return status === 200
      ? new Response(new Uint8Array([1, 2]), {
          headers: { "content-type": "image/webp", etag: '"one"' },
        })
      : new Response(null, { status });
  }) as typeof fetch;
  const updates: (Blob | null)[] = [];
  const c = new StickerClient("session", () => live, transport);
  await c.loadMedia(version, "thumbnail", (blob) => updates.push(blob));
  status = 304;
  const pending = c.loadMedia(version, "thumbnail", (blob) =>
    updates.push(blob),
  );
  expect(updates).toHaveLength(2);
  await pending;
  status = 404;
  await c.loadMedia(version, "thumbnail", (blob) => updates.push(blob));
  expect(updates.at(-1)).toBeNull();
  const otherUpdates: (Blob | null)[] = [];
  const other = new StickerClient("other", () => true, transport);
  status = 200;
  await other.loadMedia(version, "thumbnail", (blob) =>
    otherUpdates.push(blob),
  );
  expect(otherUpdates).toHaveLength(1);
  live = false;
  expect(() => c.loadMedia(version, "thumbnail", () => {})).toThrow();
});

test("staged sticker uses the submission operation ID and never replays an unknown outcome", async () => {
  const originalFetch = globalThis.fetch;
  let stage: any;
  let submissions: any[] = [];
  const saved = new Map<string, string>();
  const storage = {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => {
      saved.set(key, value);
    },
  };
  const c = new ChatController(() => {}, storage);
  const raw = c as any;
  const client = {
    submit: async (input: any) => {
      submissions.push(input);
      throw new Error("lost");
    },
    lookup: async () => null,
  };
  raw.client = client;
  raw.view = {
    sessionId: "session",
    capabilities: {},
    recovery: [],
    messages: [],
    compaction: null,
  };
  raw.storageKey = "lamplit.pending:session";
  globalThis.fetch = (async (_path: string, init?: RequestInit) => {
    stage = JSON.parse(String(init?.body));
    return json({
      sessionId: stage.sessionId,
      operationId: stage.operationId,
      image,
    });
  }) as typeof fetch;
  try {
    await c.sendSticker({ id: "cat", version });
    expect(submissions).toHaveLength(1);
    expect(submissions[0].operationId).toBe(stage.operationId);
    expect(submissions[0].text).toBe("");
    expect(submissions[0].images).toEqual([image]);
    expect(c.pending[0]?.state).toBe("sending");
    expect(JSON.parse(saved.get("lamplit.pending:session")!)[0].images).toEqual(
      [image],
    );
    c.recheckPending();
    await Promise.resolve();
    expect(submissions).toHaveLength(1);
  } finally {
    globalThis.fetch = originalFetch;
    raw.client = undefined;
    c.close();
  }
});

test("stale stage response cannot submit into another session", async () => {
  const originalFetch = globalThis.fetch;
  let release!: (r: Response) => void;
  let stage: any;
  const c = new ChatController(() => {}, {
    getItem: () => null,
    setItem: () => {},
  });
  const raw = c as any;
  let submissions = 0;
  raw.client = {
    submit: async () => {
      submissions++;
    },
  };
  raw.view = {
    sessionId: "session",
    capabilities: {},
    recovery: [],
    messages: [],
    compaction: null,
  };
  raw.storageKey = "lamplit.pending:session";
  globalThis.fetch = ((_path: string, init?: RequestInit) => {
    stage = JSON.parse(String(init?.body));
    return new Promise<Response>((resolve) => {
      release = resolve;
    });
  }) as typeof fetch;
  try {
    const sending = c.sendSticker({ id: "cat", version });
    raw.view = { ...raw.view, sessionId: "other" };
    release(
      json({ sessionId: "session", operationId: stage.operationId, image }),
    );
    await sending;
    expect(submissions).toBe(0);
  } finally {
    globalThis.fetch = originalFetch;
    raw.client = undefined;
    c.close();
  }
});

test("authorization failure evicts all cached media for the current client", async () => {
  let denied = false;
  const transport = fakeFetch(async () =>
    denied
      ? new Response(null, { status: 401 })
      : new Response(new Uint8Array([1]), {
          headers: { "content-type": "image/webp", etag: '"v"' },
        }),
  );
  const updates: (Blob | null)[] = [];
  const c = new StickerClient("session", () => true, transport);
  await c.loadMedia(version, "thumbnail", (value) => updates.push(value));
  denied = true;
  await c.loadMedia(version, "thumbnail", (value) => updates.push(value));
  expect(updates.at(-1)).toBeNull();
});

test("failed stage is retryable explicitly without consuming drafts", async () => {
  const originalFetch = globalThis.fetch;
  let attempts = 0;
  const submissions: any[] = [];
  const saved = new Map<string, string>();
  const c = new ChatController(() => {}, {
    getItem: (key) => saved.get(key) ?? null,
    setItem: (key, value) => {
      saved.set(key, value);
    },
  });
  const raw = c as any;
  raw.client = {
    submit: async (input: any) => {
      submissions.push(input);
      return {
        operationId: input.operationId,
        state: "submitted",
        messageId: null,
        turnId: null,
        error: null,
      };
    },
  };
  raw.view = {
    sessionId: "session",
    capabilities: {},
    recovery: [],
    messages: [],
    compaction: null,
  };
  raw.storageKey = "lamplit.pending:session";
  globalThis.fetch = (async (_path: string, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body));
    attempts++;
    return attempts === 1
      ? new Response(null, { status: 400 })
      : json({
          sessionId: request.sessionId,
          operationId: request.operationId,
          image,
        });
  }) as typeof fetch;
  try {
    await c.sendSticker({ id: "cat", version });
    expect(c.pending[0]?.state).toBe("failed");
    expect(submissions).toHaveLength(0);
    await c.retryFailed(c.pending[0]!.operationId);
    expect(attempts).toBe(2);
    expect(submissions).toHaveLength(1);
    expect(submissions[0].images).toEqual([image]);
  } finally {
    globalThis.fetch = originalFetch;
    raw.client = undefined;
    c.close();
  }
});

const thumbnailResponse = (value: number) =>
  new Response(new Uint8Array([value]), {
    headers: { "content-type": "image/webp", etag: `"${value}"` },
  });

test.each([401, 403])(
  "a %s invalidation cannot resurrect an earlier in-flight thumbnail",
  async (status) => {
    const pending: ((response: Response) => void)[] = [];
    const transport = fakeFetch(
      () => new Promise<Response>((resolve) => pending.push(resolve)),
    );
    const c = new StickerClient("session", () => true, transport);
    const before: (Blob | null)[] = [];
    const after: (Blob | null)[] = [];
    const a = c.loadMedia(version, "thumbnail", (blob) => before.push(blob));
    const denied = c.loadMedia("b".repeat(64), "thumbnail", () => {});
    pending[1]!(new Response(null, { status }));
    await denied;
    expect(before).toEqual([null]);
    expect(() =>
      c.loadMedia(version, "thumbnail", (blob) => after.push(blob)),
    ).toThrow("Sticker authorization lost");
    const rejected = a.catch((error) => error);
    pending[0]!(thumbnailResponse(1));
    expect((await rejected).message).toBe("Sticker authorization lost");
    expect(before).toEqual([null]);
    expect(after).toEqual([]);
    expect((c as any).media.size).toBe(0);
    const freshClient = new StickerClient("session", () => true, transport);
    const next = freshClient.loadMedia(version, "thumbnail", (blob) =>
      after.push(blob),
    );
    pending[2]!(thumbnailResponse(2));
    await next;
    expect(after).toHaveLength(1);
    expect(await after[0]!.arrayBuffer()).toEqual(new Uint8Array([2]).buffer);
    expect((c as any).generations.size).toBe(0);
  },
);

test.each(["close", "session"])(
  "%s invalidates in-flight responses before they can update media",
  async (mode) => {
    let resolve!: (response: Response) => void;
    let current = true;
    const transport = fakeFetch(
      () =>
        new Promise<Response>((r) => {
          resolve = r;
        }),
    );
    const c = new StickerClient("session", () => current, transport);
    const updates: (Blob | null)[] = [];
    const pending = c.loadMedia(version, "thumbnail", (blob) =>
      updates.push(blob),
    );
    if (mode === "close") c.close();
    else current = false;
    resolve(thumbnailResponse(1));
    await expect(pending).rejects.toThrow("Stale sticker session");
    expect(updates).toEqual([null]);
    expect((c as any).media.size).toBe(0);
    expect((c as any).generations.size).toBe(0);
  },
);

test("404 evicts only its media and uncertain network failure preserves cached media", async () => {
  let outcome: "ok" | "missing" | "network" = "ok";
  const transport = fakeFetch(async () => {
    if (outcome === "network") throw new Error("offline");
    return outcome === "missing"
      ? new Response(null, { status: 404 })
      : thumbnailResponse(1);
  });
  const c = new StickerClient("session", () => true, transport);
  const a: (Blob | null)[] = [];
  const b: (Blob | null)[] = [];
  const listenerA = (value: Blob | null) => a.push(value);
  const listenerB = (value: Blob | null) => b.push(value);
  await c.loadMedia(version, "thumbnail", listenerA);
  await c.loadMedia("b".repeat(64), "thumbnail", listenerB);
  outcome = "network";
  await expect(c.loadMedia(version, "thumbnail", listenerA)).rejects.toThrow(
    "offline",
  );
  expect(a.at(-1)).not.toBeNull();
  outcome = "missing";
  await c.loadMedia(version, "thumbnail", listenerA);
  expect(a.at(-1)).toBeNull();
  expect(b.at(-1)).not.toBeNull();
  expect((c as any).media.size).toBe(1);
  expect((c as any).generations.size).toBe(0);
});

test("a new request after an observed session change cannot revive the old response", async () => {
  let current = true;
  const responses: ((response: Response) => void)[] = [];
  const transport = fakeFetch(
    () => new Promise<Response>((resolve) => responses.push(resolve)),
  );
  const c = new StickerClient("session", () => current, transport);
  const before: (Blob | null)[] = [];
  const after: (Blob | null)[] = [];
  const old = c.loadMedia(version, "thumbnail", (blob) => before.push(blob));
  current = false;
  expect(() => c.loadMedia(version, "thumbnail", () => {})).toThrow(
    "Stale sticker session",
  );
  current = true;
  const fresh = c.loadMedia(version, "thumbnail", (blob) => after.push(blob));
  const stale = old.catch((error) => error);
  responses[0]!(thumbnailResponse(1));
  expect((await stale).message).toBe("Stale sticker request");
  expect(before).toEqual([null]);
  expect(after).toEqual([]);
  expect((c as any).media.size).toBe(0);
  responses[1]!(thumbnailResponse(2));
  await fresh;
  expect(await after[0]!.arrayBuffer()).toEqual(new Uint8Array([2]).buffer);
  expect((c as any).generations.size).toBe(0);
});

test("closing during notification prevents later listeners receiving stale bytes", async () => {
  const responses: ((response: Response) => void)[] = [];
  const transport = fakeFetch(
    () => new Promise<Response>((resolve) => responses.push(resolve)),
  );
  const c = new StickerClient("session", () => true, transport);
  const second: (Blob | null)[] = [];
  const first = c.loadMedia(version, "thumbnail", (blob) => {
    if (blob) c.close();
  });
  const next = c.loadMedia(version, "thumbnail", (blob) => second.push(blob));
  responses[1]!(thumbnailResponse(1));
  await next;
  expect(second).toEqual([null]);
  expect((c as any).media.size).toBe(0);
  responses[0]!(thumbnailResponse(2));
  await expect(first).rejects.toThrow("Stale sticker session");
});

test.each(["200-after-404", "404-after-200", "network-before-404"])(
  "concurrent media %s honors 404 and isolates other versions",
  async (order) => {
    const requests: {
      resolve: (r: Response) => void;
      reject: (e: Error) => void;
    }[] = [];
    const transport = fakeFetch(
      () =>
        new Promise<Response>((resolve, reject) =>
          requests.push({ resolve, reject }),
        ),
    );
    const c = new StickerClient("session", () => true, transport);
    const cover: (Blob | null)[] = [];
    const grid: (Blob | null)[] = [];
    const other: (Blob | null)[] = [];
    const seed = c.loadMedia(version, "thumbnail", (value) =>
      cover.push(value),
    );
    requests[0]!.resolve(thumbnailResponse(1));
    await seed;
    const unrelated = c.loadMedia("b".repeat(64), "thumbnail", (value) =>
      other.push(value),
    );
    requests[1]!.resolve(thumbnailResponse(3));
    await unrelated;
    const early = c.loadMedia(version, "thumbnail", (value) =>
      cover.push(value),
    );
    const late = c.loadMedia(version, "thumbnail", (value) => grid.push(value));
    if (order === "404-after-200") {
      requests[3]!.resolve(thumbnailResponse(2));
      await late;
      requests[2]!.resolve(new Response(null, { status: 404 }));
      await early;
    } else {
      if (order === "network-before-404") {
        requests[3]!.reject(new Error("offline"));
        await expect(late).rejects.toThrow("offline");
      }
      requests[2]!.resolve(new Response(null, { status: 404 }));
      await early;
      if (order === "200-after-404") {
        requests[3]!.resolve(thumbnailResponse(2));
        await late;
      }
    }
    expect(cover.at(-1)).toBeNull();
    expect(grid.at(-1)).toBeNull();
    expect(other.at(-1)).not.toBeNull();
    expect((c as any).media.size).toBe(1);
  },
);

test.each([401, 403])(
  "authorization %s invalidates in-flight JSON and notifies once",
  async (status) => {
    const requests: ((response: Response) => void)[] = [];
    const transport = fakeFetch(
      () => new Promise<Response>((resolve) => requests.push(resolve)),
    );
    const c = new StickerClient("session", () => true, transport);
    const events: number[] = [];
    const unsubscribe = c.onAuthorizationLost((code) => events.push(code));
    const page = c.page("packs");
    const favorite = c.favorite("cat", true);
    const denied = c.loadMedia(version, "thumbnail", () => {});
    requests[2]!(new Response(null, { status }));
    await denied;
    const pageRejected = page.catch((error) => error);
    const favoriteRejected = favorite.catch((error) => error);
    requests[0]!(json({ packs: [], nextCursor: null }));
    requests[1]!(json({ sticker, favorite: true }));
    expect((await pageRejected).message).toBe("Sticker authorization lost");
    expect((await favoriteRejected).message).toBe("Sticker authorization lost");
    expect(events).toEqual([status]);
    expect(() => c.loadMedia(version, "thumbnail", () => {})).toThrow();
    unsubscribe();
    const refreshed = new StickerClient(
      "session",
      () => true,
      fakeFetch(async () => json({ packs: [], nextCursor: null })),
    );
    expect((await refreshed.page("packs")).nextCursor).toBeNull();
  },
);

test("a 404 invalidates both variants of its version, including a pending 304", async () => {
  const requests: ((response: Response) => void)[] = [];
  const transport = fakeFetch(
    () => new Promise<Response>((resolve) => requests.push(resolve)),
  );
  const c = new StickerClient("session", () => true, transport);
  const thumbnail: (Blob | null)[] = [];
  const original: (Blob | null)[] = [];
  const thumb = c.loadMedia(version, "thumbnail", (blob) =>
    thumbnail.push(blob),
  );
  requests[0]!(thumbnailResponse(1));
  await thumb;
  const orig = c.loadMedia(version, "original", (blob) => original.push(blob));
  requests[1]!(
    new Response(new Uint8Array([3]), {
      headers: { "content-type": "image/gif", etag: '"orig"' },
    }),
  );
  await orig;
  const checkOriginal = c.loadMedia(version, "original", (blob) =>
    original.push(blob),
  );
  const missingThumb = c.loadMedia(version, "thumbnail", (blob) =>
    thumbnail.push(blob),
  );
  requests[3]!(new Response(null, { status: 404 }));
  await missingThumb;
  requests[2]!(new Response(null, { status: 304 }));
  await checkOriginal;
  expect(thumbnail.at(-1)).toBeNull();
  expect(original.at(-1)).toBeNull();
  expect((c as any).media.size).toBe(0);
});

test("media 404 and network errors never emit the authorization loss event", async () => {
  let offline = false;
  const c = new StickerClient(
    "session",
    () => true,
    fakeFetch(async () => {
      if (offline) throw new Error("offline");
      return new Response(null, { status: 404 });
    }),
  );
  const events: number[] = [];
  c.onAuthorizationLost((status) => events.push(status));
  await c.loadMedia(version, "thumbnail", () => {});
  offline = true;
  await expect(c.loadMedia(version, "thumbnail", () => {})).rejects.toThrow(
    "offline",
  );
  expect(events).toEqual([]);
});

test("old 404 after observed session change cannot evict the refreshed session", async () => {
  let current = true;
  const requests: ((response: Response) => void)[] = [];
  const c = new StickerClient(
    "session",
    () => current,
    fakeFetch(() => new Promise<Response>((resolve) => requests.push(resolve))),
  );
  const old = c.loadMedia(version, "thumbnail", () => {});
  current = false;
  expect(() => c.loadMedia(version, "thumbnail", () => {})).toThrow();
  current = true;
  const updates: (Blob | null)[] = [];
  const fresh = c.loadMedia(version, "thumbnail", (blob) => updates.push(blob));
  requests[1]!(thumbnailResponse(2));
  await fresh;
  const oldError = old.catch((error) => error);
  requests[0]!(new Response(null, { status: 404 }));
  expect((await oldError).message).toBe("Stale sticker request");
  expect(updates).toHaveLength(1);
  expect(updates[0]).not.toBeNull();
});

test("authorization loss while JSON body is pending prevents its delivery", async () => {
  let release!: (value: unknown) => void;
  let call = 0;
  const transport = fakeFetch(async () => {
    if (++call === 1)
      return {
        ok: true,
        status: 200,
        json: () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      } as Response;
    return new Response(null, { status: 401 });
  });
  const c = new StickerClient("session", () => true, transport);
  const page = c.page("packs");
  await Promise.resolve();
  await Promise.resolve();
  await c.loadMedia(version, "thumbnail", () => {});
  const pageError = page.catch((error) => error);
  release({ packs: [], nextCursor: null });
  expect((await pageError).message).toBe("Sticker authorization lost");
});

test.each([401, 403])(
  "stage %s revokes the current picker and its delayed list",
  async (status) => {
    const originalFetch = globalThis.fetch;
    let resolvePage!: (response: Response) => void;
    let resolveStage!: (response: Response) => void;
    const c = new ChatController(() => {}, {
      getItem: () => null,
      setItem: () => {},
    });
    const raw = c as any;
    let submissions = 0;
    raw.client = {
      submit: async () => {
        submissions++;
      },
    };
    raw.view = {
      sessionId: "session",
      capabilities: {},
      recovery: [],
      messages: [],
      compaction: null,
    };
    raw.storageKey = "lamplit.pending:session";
    globalThis.fetch = ((path: string) => {
      if (path.includes("/media/"))
        return Promise.resolve(thumbnailResponse(1));
      if (path.includes("/packs?"))
        return new Promise<Response>((resolve) => {
          resolvePage = resolve;
        });
      if (path === "/api/stickers/stage")
        return new Promise<Response>((resolve) => {
          resolveStage = resolve;
        });
      throw new Error(path);
    }) as typeof fetch;
    try {
      const picker = c.openStickers();
      const anotherPicker = c.openStickers();
      const otherStatuses: number[] = [];
      anotherPicker.onAuthorizationLost((status) => otherStatuses.push(status));
      const displayed: (Blob | null)[] = [];
      const statuses: number[] = [];
      picker.onAuthorizationLost((status) => statuses.push(status));
      await picker.loadMedia(version, "thumbnail", (blob) =>
        displayed.push(blob),
      );
      const list = picker.page("packs");
      const listError = list.catch((error) => error);
      const sending = c.sendSticker({ id: "cat", version });
      resolveStage(new Response(null, { status }));
      await sending;
      resolvePage(json({ packs: [], nextCursor: null }));
      expect((await listError).message).toBe("Sticker authorization lost");
      expect(displayed.at(-1)).toBeNull();
      expect(statuses).toEqual([status]);
      expect(otherStatuses).toEqual([status]);
      expect(submissions).toBe(0);
      expect(c.pending[0]?.state).toBe("failed");
    } finally {
      globalThis.fetch = originalFetch;
      raw.client = undefined;
      c.close();
    }
  },
);

test.each(["session", "connection"])(
  "old stage denial cannot revoke a new %s",
  async (change) => {
    const originalFetch = globalThis.fetch;
    let resolveStage!: (response: Response) => void;
    const c = new ChatController(() => {}, {
      getItem: () => null,
      setItem: () => {},
    });
    const raw = c as any;
    raw.client = {
      submit: async () => {
        throw new Error("unexpected submit");
      },
    };
    raw.view = {
      sessionId: "session",
      capabilities: {},
      recovery: [],
      messages: [],
      compaction: null,
    };
    raw.storageKey = "lamplit.pending:session";
    globalThis.fetch = ((path: string) =>
      path === "/api/stickers/stage"
        ? new Promise<Response>((resolve) => {
            resolveStage = resolve;
          })
        : Promise.resolve(
            json({ packs: [], nextCursor: null }),
          )) as typeof fetch;
    try {
      const sending = c.sendSticker({ id: "cat", version });
      if (change === "session")
        raw.view = { ...raw.view, sessionId: "new-session" };
      else raw.client = { submit: async () => {} };
      const picker = c.openStickers();
      const statuses: number[] = [];
      picker.onAuthorizationLost((status) => statuses.push(status));
      const pendingState = c.pending[0]?.state;
      resolveStage(new Response(null, { status: 401 }));
      await sending;
      expect(c.pending[0]?.state).toBe(pendingState);
      expect(statuses).toEqual([]);
      expect((await picker.page("packs")).nextCursor).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
      raw.client = undefined;
      c.close();
    }
  },
);

test("stage network failure does not revoke the active picker", async () => {
  const originalFetch = globalThis.fetch;
  const c = new ChatController(() => {}, {
    getItem: () => null,
    setItem: () => {},
  });
  const raw = c as any;
  let stageCalls = 0;
  raw.client = {
    submit: async () => {
      throw new Error("unexpected submit");
    },
  };
  raw.view = {
    sessionId: "session",
    capabilities: {},
    recovery: [],
    messages: [],
    compaction: null,
  };
  raw.storageKey = "lamplit.pending:session";
  globalThis.fetch = (async (path: string) => {
    if (path === "/api/stickers/stage") {
      stageCalls++;
      throw new Error("offline");
    }
    if (path.includes("/media/")) return thumbnailResponse(1);
    return json({ packs: [], nextCursor: null });
  }) as typeof fetch;
  try {
    const picker = c.openStickers();
    const statuses: number[] = [];
    const displayed: (Blob | null)[] = [];
    picker.onAuthorizationLost((status) => statuses.push(status));
    await picker.loadMedia(version, "thumbnail", (blob) =>
      displayed.push(blob),
    );
    await c.sendSticker({ id: "cat", version });
    expect(statuses).toEqual([]);
    expect(stageCalls).toBe(1);
    expect(displayed.at(-1)).not.toBeNull();
    expect((await picker.page("packs")).nextCursor).toBeNull();
  } finally {
    globalThis.fetch = originalFetch;
    raw.client = undefined;
    c.close();
  }
});

test("a prior stage cannot revoke a new picker after a session lifecycle returns to the same id", async () => {
  const originalFetch = globalThis.fetch;
  let resolveStage!: (response: Response) => void;
  const c = new ChatController(() => {}, {
    getItem: () => null,
    setItem: () => {},
  });
  const raw = c as any;
  raw.client = {
    submit: async () => {
      throw new Error("unexpected submit");
    },
  };
  raw.view = {
    sessionId: "session",
    capabilities: {},
    recovery: [],
    messages: [],
    compaction: null,
  };
  raw.storageKey = "lamplit.pending:session";
  globalThis.fetch = ((path: string) =>
    path === "/api/stickers/stage"
      ? new Promise<Response>((resolve) => {
          resolveStage = resolve;
        })
      : Promise.resolve(json({ packs: [], nextCursor: null }))) as typeof fetch;
  try {
    const sending = c.sendSticker({ id: "cat", version });
    raw.closeStickers();
    const picker = c.openStickers();
    const statuses: number[] = [];
    picker.onAuthorizationLost((status) => statuses.push(status));
    const pendingState = c.pending[0]?.state;
    resolveStage(new Response(null, { status: 403 }));
    await sending;
    expect(c.pending[0]?.state).toBe(pendingState);
    expect(statuses).toEqual([]);
    expect((await picker.page("packs")).nextCursor).toBeNull();
  } finally {
    globalThis.fetch = originalFetch;
    raw.client = undefined;
    c.close();
  }
});

test("disconnect settles a pending sticker stage and reconnect requires explicit retry", async () => {
  const previousFetch = globalThis.fetch;
  const saved = new Map<string, string>();
  const requests: { input: any; resolve: (response: Response) => void }[] = [];
  const submissions: any[] = [];
  const c = new ChatController(() => {}, {
    getItem: (key) => saved.get(key) ?? null,
    setItem: (key, value) => {
      saved.set(key, value);
    },
  });
  const raw = c as any;
  raw.client = {
    submit: async (input: any) => {
      submissions.push(input);
      return {
        operationId: input.operationId,
        state: "submitted",
        messageId: null,
        turnId: null,
        error: null,
      };
    },
    lookup: async () => null,
  };
  raw.view = {
    sessionId: "session",
    capabilities: {},
    recovery: [],
    messages: [],
    compaction: null,
  };
  raw.storageKey = "lamplit.pending:session";
  globalThis.fetch = ((_path: string, init?: RequestInit) =>
    new Promise<Response>((resolve) =>
      requests.push({ input: JSON.parse(String(init?.body)), resolve }),
    )) as typeof fetch;
  try {
    const old = c.sendSticker({ id: "cat", version });
    const originalId = c.pending[0]!.operationId;
    raw.disconnected();
    expect(c.pending[0]?.state).toBe("failed");
    expect(JSON.parse(saved.get("lamplit.pending:session")!)[0].state).toBe(
      "failed",
    );
    raw.client = {
      submit: async (input: any) => {
        submissions.push(input);
        return {
          operationId: input.operationId,
          state: "submitted",
          messageId: null,
          turnId: null,
          error: null,
        };
      },
      lookup: async () => null,
    };
    raw.hydrate("session");
    await raw.reconcile();
    expect(requests).toHaveLength(1);
    expect(submissions).toHaveLength(0);
    const retry = c.retryFailed(originalId);
    expect(requests).toHaveLength(2);
    expect(requests[1]!.input.operationId).not.toBe(originalId);
    requests[1]!.resolve(
      json({
        sessionId: "session",
        operationId: requests[1]!.input.operationId,
        image,
      }),
    );
    await retry;
    expect(submissions).toHaveLength(1);
    const retryState = c.pending[0]?.state;
    // The old stage may already have created an attachment, but never dispatched a message.
    requests[0]!.resolve(
      json({ sessionId: "session", operationId: originalId, image }),
    );
    await old;
    expect(submissions).toHaveLength(1);
    expect(c.pending[0]?.state).toBe(retryState);
    expect(c.pending[0]?.operationId).toBe(requests[1]!.input.operationId);
  } finally {
    globalThis.fetch = previousFetch;
    raw.client = undefined;
    c.close();
  }
});

test("stage timeout may leave an attachment but never replays or submits without explicit retry", async () => {
  const previousFetch = globalThis.fetch;
  const c = new ChatController(() => {}, {
    getItem: () => null,
    setItem: () => {},
  });
  const raw = c as any;
  const stages: any[] = [];
  const submissions: any[] = [];
  raw.client = {
    submit: async (input: any) => {
      submissions.push(input);
      return {
        operationId: input.operationId,
        state: "submitted",
        messageId: null,
        turnId: null,
        error: null,
      };
    },
  };
  raw.view = {
    sessionId: "session",
    capabilities: {},
    recovery: [],
    messages: [],
    compaction: null,
  };
  raw.storageKey = "lamplit.pending:session";
  globalThis.fetch = (async (_path: string, init?: RequestInit) => {
    const input = JSON.parse(String(init?.body));
    stages.push(input);
    if (stages.length === 1) throw new Error("timeout after stage created");
    return json({
      sessionId: "session",
      operationId: input.operationId,
      image,
    });
  }) as typeof fetch;
  try {
    await c.sendSticker({ id: "cat", version });
    expect(c.pending[0]?.state).toBe("failed");
    expect(stages).toHaveLength(1);
    expect(submissions).toHaveLength(0);
    await c.retryFailed(c.pending[0]!.operationId);
    expect(stages).toHaveLength(2);
    expect(stages[1].operationId).not.toBe(stages[0].operationId);
    expect(submissions).toHaveLength(1);
  } finally {
    globalThis.fetch = previousFetch;
    raw.client = undefined;
    c.close();
  }
});

test("disconnect preserves a dispatched sticker submission for reconciliation", async () => {
  const previousFetch = globalThis.fetch;
  const saved = new Map<string, string>();
  const c = new ChatController(() => {}, {
    getItem: (key) => saved.get(key) ?? null,
    setItem: (key, value) => {
      saved.set(key, value);
    },
  });
  const raw = c as any;
  let rejectSubmit!: (error: Error) => void;
  let signalSubmit!: () => void;
  const started = new Promise<void>((resolve) => {
    signalSubmit = resolve;
  });
  let submits = 0;
  raw.client = {
    submit: () => {
      submits++;
      signalSubmit();
      return new Promise((_resolve, reject) => {
        rejectSubmit = reject;
      });
    },
  };
  raw.view = {
    sessionId: "session",
    capabilities: {},
    recovery: [],
    messages: [],
    compaction: null,
  };
  raw.storageKey = "lamplit.pending:session";
  globalThis.fetch = (async (_path: string, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body));
    return json({
      sessionId: "session",
      operationId: request.operationId,
      image,
    });
  }) as typeof fetch;
  try {
    const send = c.sendSticker({ id: "cat", version });
    await started;
    expect(c.pending[0]?.dispatched).toBe(true);
    raw.disconnected();
    expect(c.pending[0]?.state).toBe("sending");
    expect(
      JSON.parse(saved.get("lamplit.pending:session")!)[0].dispatched,
    ).toBe(true);
    raw.client = { lookup: async () => null };
    await raw.reconcile();
    rejectSubmit(new Error("lost acknowledgement"));
    await send;
    expect(c.pending[0]?.state).toBe("sending");
    expect(submits).toBe(1);
  } finally {
    globalThis.fetch = previousFetch;
    raw.client = undefined;
    c.close();
  }
});

test("session change saves interrupted preparation only to its original session", async () => {
  const previousFetch = globalThis.fetch;
  const saved = new Map<string, string>();
  const c = new ChatController(() => {}, {
    getItem: (key) => saved.get(key) ?? null,
    setItem: (key, value) => {
      saved.set(key, value);
    },
  });
  const raw = c as any;
  const requests: { input: any; resolve: (response: Response) => void }[] = [];
  raw.client = {
    submit: async () => {
      throw new Error("unexpected submit");
    },
  };
  raw.view = {
    sessionId: "session",
    capabilities: {},
    recovery: [],
    messages: [],
    compaction: null,
  };
  raw.storageKey = "lamplit.pending:session";
  globalThis.fetch = ((_path: string, init?: RequestInit) =>
    new Promise<Response>((resolve) =>
      requests.push({ input: JSON.parse(String(init?.body)), resolve }),
    )) as typeof fetch;
  try {
    const old = c.sendSticker({ id: "cat", version });
    const oldId = c.pending[0]!.operationId;
    raw.hydrate("other");
    raw.view = { ...raw.view, sessionId: "other" };
    expect(JSON.parse(saved.get("lamplit.pending:session")!)[0].state).toBe(
      "failed",
    );
    expect(c.pending).toHaveLength(0);
    const fresh = c.sendSticker({ id: "cat", version });
    const freshId = c.pending[0]!.operationId;
    requests[0]!.resolve(
      json({ sessionId: "session", operationId: oldId, image }),
    );
    await old;
    expect(c.pending[0]?.operationId).toBe(freshId);
    expect(c.pending[0]?.state).toBe("sending");
    requests[1]!.resolve(new Response(null, { status: 400 }));
    await fresh;
    expect(c.pending[0]?.state).toBe("failed");
    raw.hydrate("session");
    raw.view = { ...raw.view, sessionId: "session" };
    expect(c.pending[0]?.operationId).toBe(oldId);
    expect(c.pending[0]?.state).toBe("failed");
  } finally {
    globalThis.fetch = previousFetch;
    raw.client = undefined;
    c.close();
  }
});

test("lifecycle cleanup leaves existing failures, ordinary images, and dispatched stickers untouched", () => {
  const saved = new Map<string, string>();
  const c = new ChatController(() => {}, {
    getItem: (key) => saved.get(key) ?? null,
    setItem: (key, value) => {
      saved.set(key, value);
    },
  });
  const raw = c as any;
  raw.storageKey = "lamplit.pending:session";
  raw.view = { sessionId: "session", recovery: [], messages: [] };
  const base = { text: "", createdAt: 1, localImageCount: 1 };
  const failed = {
    ...base,
    operationId: crypto.randomUUID(),
    stickerInput: { id: "cat", version },
    dispatched: false,
    state: "failed" as const,
  };
  const imagePending = {
    ...base,
    operationId: crypto.randomUUID(),
    dispatched: false,
    state: "sending" as const,
  };
  const submitted = {
    ...base,
    operationId: crypto.randomUUID(),
    stickerInput: { id: "cat", version },
    dispatched: true,
    state: "sending" as const,
    images: [image],
  };
  const preparing = {
    ...base,
    operationId: crypto.randomUUID(),
    stickerInput: { id: "cat", version },
    dispatched: false,
    state: "sending" as const,
  };
  c.pending = [failed, imagePending, submitted, preparing];
  raw.closeStickers();
  expect(c.pending[0]).toBe(failed);
  expect(c.pending[1]).toBe(imagePending);
  expect(c.pending[2]).toBe(submitted);
  expect(c.pending[3]?.state).toBe("failed");
  expect(
    JSON.parse(saved.get("lamplit.pending:session")!).map(
      (item: any) => item.state,
    ),
  ).toEqual(["failed", "sending", "sending", "failed"]);
  c.close();
});

test("lifecycle change during pending notification does not start a stale stage", async () => {
  const previousFetch = globalThis.fetch;
  let c!: InstanceType<typeof ChatController>;
  let interrupted = false;
  c = new ChatController(
    () => {
      if (!interrupted && c.pending[0]?.state === "sending") {
        interrupted = true;
        (c as any).closeStickers();
      }
    },
    { getItem: () => null, setItem: () => {} },
  );
  const raw = c as any;
  raw.client = {
    submit: async () => {
      throw new Error("unexpected submit");
    },
  };
  raw.view = {
    sessionId: "session",
    capabilities: {},
    recovery: [],
    messages: [],
    compaction: null,
  };
  raw.storageKey = "lamplit.pending:session";
  let calls = 0;
  globalThis.fetch = fakeFetch(async () => {
    calls++;
    throw new Error("unexpected stage");
  });
  try {
    await c.sendSticker({ id: "cat", version });
    expect(c.pending[0]?.state).toBe("failed");
    expect(calls).toBe(0);
  } finally {
    globalThis.fetch = previousFetch;
    raw.client = undefined;
    c.close();
  }
});
