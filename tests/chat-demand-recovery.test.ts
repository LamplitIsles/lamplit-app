import { expect, test } from "bun:test";
import { openChat } from "../packages/contracts/src/client.ts";
import { createChatHost } from "../packages/contracts/src/server.ts";
import { ChatController } from "../apps/web/src/lib/chat-controller.ts";
import { fixtureBackend } from "./fixture.ts";

const api = process.env.DEMAND_PACKAGE
  ? ((await import(`${process.env.DEMAND_PACKAGE}/dist/client.js`)) as {
      openChat: typeof openChat;
    })
  : { openChat };
const until = async (check: () => boolean) => {
  for (let n = 0; !check(); n++) {
    if (n > 400) throw new Error("Timed out");
    await Bun.sleep(5);
  }
};
// Record real timers and advance only the test-owned request/retry bounds.
function clock() {
  const original = globalThis.setTimeout;
  const jobs: {
    delay: number;
    run: () => void;
    id: ReturnType<typeof setTimeout>;
  }[] = [];
  globalThis.setTimeout = ((fn: () => void, delay: number) => {
    const id = original(fn, delay);
    if (delay >= 1500) jobs.push({ delay, run: fn, id });
    return id;
  }) as typeof setTimeout;
  return {
    jobs,
    fire(delay: number) {
      const job = jobs.findLast((j) => j.delay === delay);
      if (!job) throw new Error(`Missing timer ${delay}`);
      clearTimeout(job.id);
      job.run();
    },
    close() {
      globalThis.setTimeout = original;
      for (const job of jobs) clearTimeout(job.id);
    },
  };
}
async function harness() {
  const fixture = fixtureBackend();
  let authorized = true,
    blackhole = false,
    dropAck = false,
    calls = 0,
    opens = 0,
    submits = 0;
  let held: Promise<void> | undefined;
  const host = await createChatHost(
    {
      ...fixture.backend,
      async read() {
        await held;
        return fixture.backend.read();
      },
      async submit(input) {
        submits++;
        return fixture.backend.submit(input);
      },
      async history() {
        throw new Error("valid domain rejection");
      },
    },
    () => {},
  );
  const sockets = new Map<
    import("bun").ServerWebSocket<undefined>,
    ReturnType<typeof host.connect>
  >();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, server) {
      if (!server.upgrade(req)) return new Response(null, { status: 404 });
    },
    websocket: {
      open(ws) {
        opens++;
        sockets.set(
          ws,
          host.connect(
            {
              send(raw) {
                if (!dropAck) ws.send(raw);
              },
              close(code, reason) {
                ws.close(code, reason);
              },
            },
            async () => {
              await held;
              return authorized;
            },
          ),
        );
      },
      message(ws, raw) {
        calls++;
        if (!blackhole) void sockets.get(ws)!.receive(String(raw));
      },
      close(ws) {
        sockets.get(ws)?.close();
        sockets.delete(ws);
      },
    },
  });
  const saved = new Map<string, string>();
  const previous = Object.getOwnPropertyDescriptor(globalThis, "location");
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: { href: `http://127.0.0.1:${server.port}` },
  });
  const controllers: ChatController[] = [];
  return {
    fixture,
    host,
    sockets,
    get calls() {
      return calls;
    },
    get opens() {
      return opens;
    },
    get submits() {
      return submits;
    },
    set authorized(value: boolean) {
      authorized = value;
    },
    set blackhole(value: boolean) {
      blackhole = value;
    },
    set dropAck(value: boolean) {
      dropAck = value;
    },
    set held(value: Promise<void> | undefined) {
      held = value;
    },
    socket: () => new WebSocket(`ws://127.0.0.1:${server.port}`),
    controller(changed = () => {}) {
      const c = new ChatController(changed, {
        getItem: (k) => saved.get(k) ?? null,
        setItem: (k, v) => {
          saved.set(k, v);
        },
      });
      controllers.push(c);
      c.start();
      return c;
    },
    close() {
      controllers.forEach((c) => c.close());
      host.close();
      void server.stop(true);
      if (previous) Object.defineProperty(globalThis, "location", previous);
      else Reflect.deleteProperty(globalThis, "location");
    },
  };
}

test("healthy idle has zero RPC beyond initialization; live updates and domain errors retain carrier", async () => {
  const h = await harness();
  let messages = 0,
    offline = 0;
  const c = await api.openChat(
    h.socket(),
    (v) => {
      messages = v.messages.length;
    },
    () => offline++,
  );
  try {
    const initial = h.calls;
    await Bun.sleep(16050);
    expect(h.calls).toBe(initial);
    await expect(c.history("missing")).rejects.toThrow();
    expect(offline).toBe(0);
    await h.fixture.backend.submit({
      operationId: crypto.randomUUID(),
      text: "live after idle",
    });
    await h.host.refresh();
    await until(() => messages === 1);
    expect(messages).toBe(1);
    expect(h.opens).toBe(1);
  } finally {
    c.close();
    h.close();
  }
}, 20000);

test("silent blackhole demand deadline invalidates once; send failure also invalidates", async () => {
  const h = await harness();
  const time = clock();
  let offline = 0;
  const socket = h.socket();
  const c = await api.openChat(
    socket,
    () => {},
    () => offline++,
  );
  try {
    const initial = h.calls;
    h.blackhole = true;
    const lost = c.lookup(crypto.randomUUID()).catch((e) => e);
    await until(() => h.calls > initial);
    time.fire(30000);
    expect((await lost).retryable).toBe(true);
    expect(offline).toBe(1);
    socket.dispatchEvent(new Event("error"));
    expect(offline).toBe(1);
    h.blackhole = false;
    const freshSocket = h.socket();
    const fresh = await api.openChat(
      freshSocket,
      () => {},
      () => offline++,
    );
    freshSocket.send = () => {
      throw new Error("send unavailable");
    };
    await expect(fresh.lookup(crypto.randomUUID())).rejects.toThrow(
      "send unavailable",
    );
    expect(offline).toBe(2);
    fresh.close();
  } finally {
    c.close();
    h.close();
    time.close();
  }
});

test("accepted ack loss reconnects immediately and reconciles original receipt without submit replay", async () => {
  const h = await harness();
  const time = clock();
  let offline = 0;
  const c = h.controller(() => {
    if (!c?.connected) offline++;
  });
  try {
    await until(() => c.connected);
    h.dropAck = true;
    const sending = c.send("accepted but acknowledgement lost");
    await until(() => h.submits === 1);
    const id = c.pending[0]!.operationId;
    h.dropAck = false;
    time.fire(30000);
    await sending;
    await until(() => h.opens === 2 && c.connected);
    await until(() => c.pending.length === 0 || c.pending[0]?.state === "sent");
    expect(h.submits).toBe(1);
    expect((await h.fixture.backend.lookup(id))?.state).toBe("submitted");
    expect(offline).toBeGreaterThan(0);
    expect(time.jobs.some((j) => j.delay === 1500)).toBe(false);
  } finally {
    h.close();
    time.close();
  }
});

test("initial failure backs off; passive hints coalesce, auth1008 stays closed until explicit recovery", async () => {
  const h = await harness();
  const time = clock();
  h.blackhole = true;
  const c = h.controller();
  try {
    await until(() => h.calls > 0);
    time.fire(30000);
    await until(() => time.jobs.some((j) => j.delay === 1500));
    expect(h.opens).toBe(1);
    c.recover(false);
    c.recover(false);
    await until(() => h.opens === 2);
    expect(h.opens).toBe(2);
    time.fire(30000);
    await until(() => time.jobs.some((j) => j.delay === 3000));
    h.blackhole = false;
    h.authorized = false;
    c.recover(false);
    await until(() => h.opens === 3);
    await Bun.sleep(30);
    const count = time.jobs.length;
    c.setVisible(false);
    c.setVisible(true);
    c.recover(false);
    await Bun.sleep(30);
    expect(h.opens).toBe(3);
    expect(time.jobs.length).toBe(count);
    h.authorized = true;
    c.recover();
    await until(() => c.connected);
    const opened = h.opens;
    c.recover(false);
    c.setVisible(true);
    c.recover(false);
    await Bun.sleep(30);
    expect(h.opens).toBe(opened);
    c.setVisible(false);
    c.setVisible(true);
    c.setVisible(true);
    c.recover(false);
    await until(() => h.opens === opened + 1 && c.connected);
  } finally {
    h.close();
    time.close();
  }
});

test("hidden retry and closed in-flight readiness cannot reconnect or deliver late snapshot", async () => {
  const h = await harness();
  const time = clock();
  const gate = Promise.withResolvers<void>();
  h.held = gate.promise;
  const c = h.controller();
  try {
    await until(() => h.calls > 0);
    c.setVisible(false);
    time.fire(30000);
    await Bun.sleep(30);
    expect(time.jobs.some((j) => j.delay === 1500)).toBe(false);
    c.setVisible(true);
    await until(() => h.opens === 2);
    c.close();
    gate.resolve();
    h.held = undefined;
    await Bun.sleep(30);
    expect(c.connected).toBe(false);
    expect(c.view).toBeUndefined();
    c.recover();
    c.setVisible(false);
    c.setVisible(true);
    expect(h.opens).toBe(2);
  } finally {
    gate.resolve();
    h.close();
    time.close();
  }
});
