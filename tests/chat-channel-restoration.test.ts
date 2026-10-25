import { expect, test } from "bun:test";
import {
  createChatHost,
  type ChatSubscription,
} from "../packages/contracts/src/server.ts";
import { openChat } from "../packages/contracts/src/client.ts";
import type { ChatView } from "../packages/contracts/src/index.ts";
import {
  createServiceSubscribeCall,
  createServiceUnsubscribeCall,
} from "../packages/contracts/node_modules/@earendil-works/chord/dist/index.js";
import { fixtureBackend } from "./fixture.ts";

const checkpoint: ChatSubscription = {
  version: 1,
  subscriptionId: "original",
  serviceId: "lamplit.chat.v2",
  mode: "singleton",
};
const call = (id: string, value: unknown) =>
  JSON.stringify({ type: "call", version: 1, id, call: value });
async function until(check: () => boolean) {
  for (let i = 0; !check(); i++) {
    if (i > 200) throw new Error("Timed out");
    await Bun.sleep(5);
  }
}
// Can run the identical observable contract against the controlled compiled server/client.
const serverApi = process.env.RESTORATION_PACKAGE
  ? ((await import(`${process.env.RESTORATION_PACKAGE}/dist/server.js`)) as {
      createChatHost: typeof createChatHost;
    })
  : { createChatHost };
const clientApi = process.env.RESTORATION_PACKAGE
  ? ((await import(`${process.env.RESTORATION_PACKAGE}/dist/client.js`)) as {
      openChat: typeof openChat;
    })
  : { openChat };

test("original openChat socket accepts gap reset, future deltas and lookup without replay", async () => {
  const fixture = fixtureBackend();
  let name = "before",
    listeners = 0,
    calls = 0;
  const backend = {
    ...fixture.backend,
    async read() {
      return { ...(await fixture.backend.read()), name };
    },
    async lookup(id: string) {
      calls++;
      return fixture.backend.lookup(id);
    },
    subscribe(changed: () => void) {
      listeners++;
      const off = fixture.backend.subscribe(changed);
      return () => {
        listeners--;
        off();
      };
    },
  };
  let host = await serverApi.createChatHost(backend);
  let channel: ReturnType<typeof host.connect>;
  let socket: import("bun").ServerWebSocket<undefined>;
  let stored: ChatSubscription | null = null;
  const frames: {
    type: string;
    subscriptionId?: string;
    update?: { type: string };
  }[] = [];
  const connect = () =>
    host.connect(
      {
        send(raw) {
          frames.push(JSON.parse(raw));
          socket.send(raw);
        },
        close(code, reason) {
          socket.close(code, reason);
        },
      },
      async () => true,
      {
        onSubscriptionChange(value) {
          stored = structuredClone(value);
        },
      },
    );
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, server) {
      return server.upgrade(req)
        ? undefined
        : new Response("Missing", { status: 404 });
    },
    websocket: {
      open(ws) {
        socket = ws;
        channel = connect();
      },
      message(_ws, raw) {
        void channel.receive(String(raw));
      },
      close() {
        channel?.close();
      },
    },
  });
  const views: ChatView[] = [];
  const client = await clientApi.openChat(
    new WebSocket(`ws://127.0.0.1:${server.port}`),
    (view) => views.push(structuredClone(view)),
    () => {},
  );
  try {
    expect(views.at(-1)?.name).toBe("before");
    expect(stored).not.toBeNull();
    const saved = structuredClone(channel!.getSubscription());
    const copy = channel!.getSubscription()!;
    copy.subscriptionId = "mutated";
    expect(channel!.getSubscription()).toEqual(saved);
    channel!.close(); // Detach without closing the socket or deleting its checkpoint.
    host.close();
    expect(listeners).toBe(0);
    expect(stored as ChatSubscription | null).toEqual(saved);
    name = "during gap";
    host = await serverApi.createChatHost(backend);
    channel = connect();
    const restore = channel.restoreSubscription(saved);
    const lookup = client.lookup("lookup-after-restore");
    await restore;
    expect(await lookup).toBeNull();
    await until(() => views.at(-1)?.name === "during gap");
    expect(frames.find((f) => f.update?.type === "reset")?.subscriptionId).toBe(
      saved!.subscriptionId,
    );
    name = "future";
    await host.refresh();
    await until(() => views.at(-1)?.name === "future");
    expect(calls).toBe(1);
    expect(fixture.executions).toBe(0);
    expect(listeners).toBe(1);
  } finally {
    client.close();
    host.close();
    socket!.terminate();
    void server.stop(true);
  }
  expect(listeners).toBe(0);
});

async function direct(
  options: Parameters<
    Awaited<ReturnType<typeof createChatHost>>["connect"]
  >[2] = {},
  authorize = async () => true,
) {
  const errors: unknown[] = [],
    frames: unknown[] = [],
    closes: number[] = [];
  const fixture = fixtureBackend();
  const host = await serverApi.createChatHost(fixture.backend, (error) =>
    errors.push(error),
  );
  const channel = host.connect(
    {
      send(raw) {
        frames.push(JSON.parse(raw));
      },
      close(code) {
        closes.push(code!);
      },
    },
    authorize,
    options,
  );
  return { channel, host, frames, closes, errors };
}
const subscribe = () =>
  call(
    "subscribe",
    createServiceSubscribeCall(
      checkpoint.subscriptionId,
      checkpoint.serviceId,
      checkpoint.mode,
    ),
  );

test("subscribe and unsubscribe persist before ack; updates follow the snapshot", async () => {
  const held = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  const changes: (ChatSubscription | null)[] = [];
  const h = await direct({
    onSubscriptionChange(value) {
      changes.push(value);
      return held[changes.length - 1]!.promise;
    },
  });
  try {
    const accepted = h.channel.receive(subscribe());
    await until(() => changes.length === 1);
    expect(h.frames).toEqual([]);
    held[0]!.resolve();
    await accepted;
    await until(() => h.frames.length === 1);
    expect(h.channel.getSubscription()).toEqual(checkpoint);
    changes[0]!.subscriptionId = "callback-mutated";
    expect(h.channel.getSubscription()).toEqual(checkpoint);
    const removed = h.channel.receive(
      call(
        "unsubscribe",
        createServiceUnsubscribeCall(checkpoint.subscriptionId),
      ),
    );
    await until(() => changes.length === 2);
    expect(changes[1]).toBeNull();
    expect(h.frames).toHaveLength(1);
    held[1]!.resolve();
    await removed;
    await until(() => h.frames.length === 2);
    expect(h.channel.getSubscription()).toBeNull();
  } finally {
    h.host.close();
  }
});

test("persistence failure closes without ack; close during persistence cannot resurrect", async () => {
  for (const reject of [true, false]) {
    const held = Promise.withResolvers<void>();
    let entered = false;
    const h = await direct({
      onSubscriptionChange() {
        entered = true;
        return held.promise;
      },
    });
    try {
      const pending = h.channel.receive(subscribe());
      await until(() => entered);
      if (reject) held.reject(new Error("storage failed"));
      else {
        h.channel.close();
        held.resolve();
      }
      await pending;
      expect(h.frames).toEqual([]);
      expect(h.channel.getSubscription()).toBeNull();
      if (reject) expect(h.closes).toEqual([1011]);
    } finally {
      h.host.close();
    }
  }
});

test("empty restore stays empty; malformed checkpoint closes without state or calls", async () => {
  for (const value of [
    null,
    {},
    { ...checkpoint, extra: [] },
    { ...checkpoint, subscriptionId: "x".repeat(101) },
    { ...checkpoint, mode: "keyed" },
  ]) {
    const h = await direct();
    try {
      if (value === null) await h.channel.restoreSubscription(value);
      else await expect(h.channel.restoreSubscription(value)).rejects.toThrow();
      expect(h.channel.getSubscription()).toBeNull();
      expect(h.frames).toEqual([]);
      expect(h.closes).toEqual(value === null ? [] : [1011]);
    } finally {
      h.host.close();
    }
  }
});

test("revoked authorization prevents reset; close during authorization stays disposed", async () => {
  for (const close of [false, true]) {
    const held = Promise.withResolvers<boolean>();
    let entered = false;
    const h = await direct({}, () => {
      entered = true;
      return held.promise;
    });
    try {
      const restoring = h.channel.restoreSubscription(checkpoint);
      await until(() => entered);
      if (close) h.channel.close();
      held.resolve(close);
      if (close) await restoring;
      else await expect(restoring).rejects.toThrow("Unauthorized");
      expect(h.frames).toEqual([]);
      expect(h.channel.getSubscription()).toBeNull();
      expect(h.closes).toEqual(close ? [] : [1008]);
    } finally {
      h.host.close();
    }
  }
});
