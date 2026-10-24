import { expect, test } from "bun:test";
import { createChatHost } from "../packages/contracts/src/server.ts";
import { openChat } from "../packages/contracts/src/client.ts";
import type { ChatView } from "../packages/contracts/src/index.ts";
import { fixtureBackend } from "./fixture.ts";

const deferred = <T>() => Promise.withResolvers<T>();
async function until(check: () => boolean) {
  for (let n = 0; !check(); n++) {
    if (n > 300) throw new Error("Timed out");
    await Bun.sleep(5);
  }
}
async function harness(windowChange = false, throwOnError = false) {
  const fixture = fixtureBackend();
  const reads: ReturnType<typeof deferred<ChatView>>[] = [];
  const errors: unknown[] = [];
  let notify = () => {},
    subscriptions = 0;
  let name = "initial",
    admissions = 0;
  const snapshot = async () => ({ ...(await fixture.backend.read()), name });
  const host = await createChatHost(
    {
      ...fixture.backend,
      read() {
        if (!subscriptions) return snapshot();
        const read = deferred<ChatView>();
        reads.push(read);
        return read.promise;
      },
      async submit(input) {
        const receipt = await fixture.backend.submit(input);
        admissions++;
        return receipt;
      },
      subscribe(changed) {
        subscriptions++;
        notify = changed;
        if (windowChange) name = "window";
        const off = fixture.backend.subscribe(changed);
        return () => {
          subscriptions--;
          off();
        };
      },
    },
    (error) => {
      errors.push(error);
      if (throwOnError) throw new Error("observer failed");
    },
  );
  const channels = new Map<object, ReturnType<typeof host.connect>>();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, server) {
      if (server.upgrade(req)) return;
      return new Response("Not found", { status: 404 });
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
  const views: ChatView[] = [];
  const client = await openChat(
    new WebSocket(`ws://127.0.0.1:${server.port}`),
    (view) => views.push(structuredClone(view)),
    () => {},
  );
  return {
    host,
    client,
    reads,
    views,
    errors,
    notify: () => notify(),
    snapshot,
    get admissions() {
      return admissions;
    },
    get subscriptions() {
      return subscriptions;
    },
    close() {
      client.close();
      host.close();
      for (const ws of channels.keys())
        (ws as import("bun").ServerWebSocket<undefined>).terminate();
      server.unref();
      void server.stop(true);
    },
  };
}

// Held reads exercise scheduling contracts, not a reproduction of the live incident.
test("host and real socket are ready while catch-up is held; subscription window converges", async () => {
  const h = await harness(true);
  try {
    expect(h.views.at(-1)?.name).toBe("initial");
    expect(h.reads).toHaveLength(1);
    for (let i = 0; i < 100; i++) h.notify();
    h.reads[0]!.resolve(await h.snapshot());
    await until(
      () => h.reads.length === 2 && h.views.at(-1)?.name === "window",
    );
    expect(h.reads).toHaveLength(2);
    h.reads[1]!.resolve(await h.snapshot());
    expect(h.errors).toHaveLength(0);
  } finally {
    h.close();
  }
});

test("submit and overlapping refreshes require a new read but ignore later notifications", async () => {
  const h = await harness();
  try {
    const old = await h.snapshot();
    let refreshed = false,
      submitted = false;
    const refresh = h.host.refresh().then(() => {
      refreshed = true;
    });
    const input = { operationId: crypto.randomUUID(), text: "new" };
    const submit = h.client.submit(input).then(() => {
      submitted = true;
    });
    // Admission is durable before its post-operation refresh is requested.
    await until(() => h.admissions === 1);
    h.reads[0]!.resolve(old);
    await until(() => h.reads.length === 2);
    expect(refreshed).toBe(false);
    expect(submitted).toBe(false);
    h.notify();
    h.reads[1]!.resolve(await h.snapshot());
    await Promise.all([refresh, submit]);
    expect(h.reads).toHaveLength(3);
    expect(h.views.at(-1)?.messages.at(-1)?.text).toBe("new");
    h.reads[2]!.resolve(await h.snapshot());
    expect(h.errors).toHaveLength(0);
  } finally {
    h.close();
  }
});

test("failed reads reject covered callers, report background errors and recover", async () => {
  const h = await harness();
  try {
    h.reads[0]!.reject(new Error("background"));
    await until(() => h.errors.length === 1);
    const failed = h.host.refresh().then(
      () => null,
      (error: unknown) => error,
    );
    h.reads[1]!.reject(new Error("explicit"));
    expect(await failed).toEqual(new Error("explicit"));
    h.notify();
    h.reads[2]!.resolve({ ...(await h.snapshot()), name: "recovered" });
    await until(() => h.views.at(-1)?.name === "recovered");
    expect(h.subscriptions).toBe(1);
  } finally {
    h.close();
  }
});

test("close releases subscription and pending refreshes without delivering late reads", async () => {
  const h = await harness();
  try {
    const pending = h.host.refresh();
    const count = h.views.length;
    h.host.close();
    await pending;
    expect(h.subscriptions).toBe(0);
    h.reads[0]!.resolve({ ...(await h.snapshot()), name: "late" });
    await Bun.sleep(10);
    expect(h.views).toHaveLength(count);
    h.notify();
    await h.host.refresh();
    expect(h.reads).toHaveLength(1);
  } finally {
    h.close();
  }
});

test("invalid initial snapshot rejects before subscribing", async () => {
  const fixture = fixtureBackend();
  let subscribed = false;
  await expect(
    createChatHost({
      ...fixture.backend,
      async read() {
        return {
          ...(await fixture.backend.read()),
          version: 1,
        } as unknown as ChatView;
      },
      subscribe() {
        subscribed = true;
        return () => {};
      },
    }),
  ).rejects.toThrow();
  expect(subscribed).toBe(false);
});

test("throwing error observer cannot strand covered or queued refreshes", async () => {
  const h = await harness(false, true);
  try {
    const covered = h.host.refresh().then(
      () => null,
      (error: unknown) => error,
    );
    h.reads[0]!.reject(new Error("background"));
    await until(() => h.reads.length === 2);
    const later = h.host.refresh();
    h.reads[1]!.reject(new Error("covered"));
    expect(await covered).toEqual(new Error("covered"));
    await until(() => h.reads.length === 3);
    h.reads[2]!.resolve({
      ...(await h.snapshot()),
      name: "observer recovered",
    });
    await later;
    await until(() => h.views.at(-1)?.name === "observer recovered");
    expect(h.errors.map((error) => (error as Error).message)).toEqual([
      "background",
      "covered",
    ]);
  } finally {
    h.close();
  }
});
