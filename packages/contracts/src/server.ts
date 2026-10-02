import {
  RemoteServiceProvider,
  replicatedState,
  createServiceStateEncoder,
  decodeServiceControlCall,
  type ServiceSubscription,
  type JsonValue,
} from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  Chat,
  ViewSchema,
  PageSchema,
  SubmissionSchema,
  ReceiptSchema,
  validate,
  validateId,
  type ChatView,
  type HistoryPage,
  type Receipt,
  type Submission,
} from "./index.ts";
import { decodeFrame, readCall, type WireSocket } from "./wire.ts";

/** Engine adapters own durable admission and execution. Socket disposal never cancels them. */
export interface ChatBackend {
  read(): Promise<ChatView>;
  history(before: string): Promise<HistoryPage>;
  submit(input: Submission): Promise<Receipt>;
  lookup(operationId: string): Promise<Receipt>;
  stop(turnId: string): Promise<{ stopped: boolean }>;
  subscribe(changed: () => void): () => void;
}
export async function createChatHost(
  backend: ChatBackend,
  onError: (error: unknown) => void = console.error,
) {
  const view = replicatedState(validate(ViewSchema, await backend.read()));
  const provider = new RemoteServiceProvider([Chat]);
  let closed = false,
    dirty = false;
  let refreshTask: Promise<void> | undefined;
  const refresh = (): Promise<void> => {
    if (closed) return Promise.resolve();
    dirty = true;
    if (refreshTask) return refreshTask;
    refreshTask = (async () => {
      try {
        while (dirty && !closed) {
          dirty = false;
          const next = validate(ViewSchema, await backend.read());
          if (closed) return;
          if (JSON.stringify(next) !== JSON.stringify(view.value))
            view.change(BACKGROUND_CONTEXT, (draft) => {
              draft.messages = next.messages;
              draft.before = next.before;
              draft.activeTurnId = next.activeTurnId;
              draft.name = next.name;
            });
        }
      } finally {
        refreshTask = undefined;
      }
    })();
    return refreshTask;
  };
  provider.provide(Chat, {
    view,
    async history(before: string) {
      return validate(PageSchema, await backend.history(validateId(before)));
    },
    async submit(input: Submission) {
      const value = validate(SubmissionSchema, input);
      if (!value.text.trim()) throw new Error("Empty message");
      const receipt = validate(ReceiptSchema, await backend.submit(value));
      await refresh();
      return receipt;
    },
    async lookup(id: string) {
      return validate(ReceiptSchema, await backend.lookup(validateId(id)));
    },
    async stop(id: string) {
      const result = await backend.stop(validateId(id));
      await refresh();
      return result;
    },
  });
  const off = backend.subscribe(() => {
    void refresh().catch(onError);
  });
  const connections = new Set<ReturnType<typeof connect>>();
  function connect(socket: WireSocket, authorize: () => Promise<boolean>) {
    let disposed = false;
    const subscriptions = new Map<string, ServiceSubscription>();
    let outgoing: Promise<void> = Promise.resolve();
    let queuedBytes = 0;
    const deliver = (frame: unknown) => {
      if (disposed) return;
      const raw = JSON.stringify(frame);
      const bytes = new TextEncoder().encode(raw).byteLength;
      if (
        bytes > 2 * 1024 * 1024 ||
        queuedBytes + bytes + (socket.bufferedAmount ?? 0) > 4 * 1024 * 1024
      ) {
        socket.close(1013, "Reconnect");
        dispose();
        return;
      }
      queuedBytes += bytes;
      outgoing = outgoing
        .then(async () => {
          try {
            if (disposed) return;
            if (!(await authorize())) {
              socket.close(1008, "Session expired");
              dispose();
              return;
            }
            if (!disposed) socket.send(raw);
          } finally {
            queuedBytes -= bytes;
          }
        })
        .catch((error) => {
          onError(error);
          socket.close(1011, "Connection failed");
          dispose();
        });
    };
    function dispose() {
      if (disposed) return;
      disposed = true;
      for (const sub of subscriptions.values()) sub.close();
      subscriptions.clear();
      connections.delete(connection);
    }
    async function process(raw: string) {
      if (disposed) return;
      if (!(await authorize())) {
        socket.close(1008, "Session expired");
        dispose();
        return;
      }
      if (disposed) return;
      let id: string | undefined;
      try {
        const frame = decodeFrame(raw);
        if (
          frame.type !== "call" ||
          frame.version !== 1 ||
          typeof frame.id !== "string" ||
          frame.id.length > 100
        )
          throw new Error("Invalid request");
        id = frame.id;
        const call = readCall(frame.call);
        const control = decodeServiceControlCall(call);
        let result: unknown;
        if (control?.type === "subscribe") {
          if (subscriptions.size || subscriptions.has(control.subscriptionId))
            throw new Error("Already subscribed");
          const encoder = createServiceStateEncoder();
          const sub = provider.subscribe(
            control.serviceId,
            control.mode,
            (update) =>
              deliver({
                type: "update",
                subscriptionId: control.subscriptionId,
                update: encoder.encodeUpdate(update),
              }),
          );
          subscriptions.set(control.subscriptionId, sub);
          result = encoder.encodeSnapshot(sub.snapshot);
          deliver({ type: "result", id, result });
          sub.activate();
          return;
        } else if (control?.type === "unsubscribe") {
          subscriptions.get(control.subscriptionId)?.close();
          subscriptions.delete(control.subscriptionId);
          result = null;
        } else if (control?.type === "catalogue") result = provider.catalogue;
        else {
          if (
            call.serviceId !== Chat.id ||
            call.instance ||
            !["history", "submit", "lookup", "stop"].includes(call.member) ||
            call.args.length !== 1
          )
            throw new Error("Invalid method");
          result = (await provider.invoke(
            call,
            BACKGROUND_CONTEXT,
          )) as JsonValue;
        }
        deliver({ type: "result", id, result: result ?? null });
      } catch (error) {
        if (!id) {
          socket.close(1002, "Invalid frame");
          dispose();
        } else
          deliver({
            type: "error",
            id,
            error: "Request could not be completed",
          });
        onError(error);
      }
    }
    const connection = {
      receive(raw: string) {
        return process(raw).catch(onError);
      },
      close: dispose,
      disconnect() {
        socket.close(1012, "Reconnect");
        dispose();
      },
    };
    connections.add(connection);
    return connection;
  }
  await refresh();
  return {
    connect,
    refresh,
    close() {
      closed = true;
      off();
      for (const c of connections) c.disconnect();
      provider.dispose();
    },
  };
}
