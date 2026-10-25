import {
  validateSearchInput,
  validateSearchResult,
  validateSearchReadResult,
  SearchReadInputSchema,
  type SearchBackend,
} from "./search.ts";
import {
  panelMethods,
  validatePanelResult,
  type PanelBackend,
} from "./panels.ts";
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
  FinalizeSubmissionSchema,
  RetryFailedSchema,
  DeleteFailedSchema,
  DeleteFailedResultSchema,
  type FinalizeSubmission,
  type RetryFailed,
  type DeleteFailed,
  type DeleteFailedResult,
  Chat,
  ViewSchema,
  PageSchema,
  validateSubmission,
  ReceiptSchema,
  LookupSchema,
  validate,
  validateId,
  validateRecovery,
  type ChatView,
  type HistoryPage,
  type Receipt,
  type Submission,
} from "./index.ts";
import {
  CompactInputSchema,
  CompactResultSchema,
  type CompactInput,
  type CompactResult,
} from "./compact.ts";
import { decodeFrame, readCall, type WireSocket } from "./wire.ts";

/** Engine adapters own durable admission and execution. Socket disposal never cancels them. */
export interface ChatBackend extends PanelBackend, SearchBackend {
  read(): Promise<ChatView>;
  compact(input: CompactInput): Promise<CompactResult>;
  history(before: string): Promise<HistoryPage>;
  submit(input: Submission): Promise<Receipt>;
  lookup(operationId: string): Promise<Receipt | null>;
  finalizeSubmission(input: FinalizeSubmission): Promise<Receipt | null>;
  retryFailed(input: RetryFailed): Promise<Receipt>;
  deleteFailed(input: DeleteFailed): Promise<DeleteFailedResult>;
  stop(turnId: string): Promise<{ stopped: boolean }>;
  subscribe(changed: () => void): () => void;
}
/** Bounded identity only; never contains state, calls, or codec dictionaries. */
export interface ChatSubscription {
  version: 1;
  subscriptionId: string;
  serviceId: "lamplit.chat.v2";
  mode: "singleton";
}
export interface ChatConnectionOptions {
  /** Persist before acknowledging subscribe/unsubscribe. Throwing closes the channel. */
  onSubscriptionChange?(
    subscription: ChatSubscription | null,
  ): void | Promise<void>;
}
function readSubscription(value: unknown): ChatSubscription | null {
  if (value === null) return null;
  if (
    typeof value !== "object" ||
    !value ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !==
      "mode,serviceId,subscriptionId,version"
  )
    throw new Error("Invalid subscription");
  const record = value as ChatSubscription;
  if (
    record.version !== 1 ||
    record.serviceId !== Chat.id ||
    record.mode !== "singleton" ||
    typeof record.subscriptionId !== "string" ||
    !record.subscriptionId.length ||
    record.subscriptionId.length > 100
  )
    throw new Error("Invalid subscription");
  return {
    version: 1,
    subscriptionId: record.subscriptionId,
    serviceId: "lamplit.chat.v2",
    mode: "singleton",
  };
}
export async function createChatHost(
  backend: ChatBackend,
  onError: (error: unknown) => void = console.error,
) {
  const initial = validate(ViewSchema, await backend.read());
  initial.recovery.forEach(validateRecovery);
  const view = replicatedState(initial);
  const provider = new RemoteServiceProvider([Chat]);
  let closed = false,
    dirty = false;
  type Waiter = { resolve(): void; reject(error: unknown): void };
  let running = false;
  let pending: Waiter[] = [],
    active: Waiter[] = [];
  const drain = async () => {
    running = true;
    try {
      while (dirty && !closed) {
        dirty = false;
        // Only callers present before this read starts are covered by it.
        active = pending;
        pending = [];
        try {
          const next = validate(ViewSchema, await backend.read());
          next.recovery.forEach(validateRecovery);
          if (closed) return;
          if (JSON.stringify(next) !== JSON.stringify(view.value))
            view.change(BACKGROUND_CONTEXT, (draft) => {
              draft.messages = next.messages;
              if (next.streamingReply)
                draft.streamingReply = next.streamingReply;
              else delete draft.streamingReply;
              if (next.replyCompletedTurnId !== undefined)
                draft.replyCompletedTurnId = next.replyCompletedTurnId;
              else delete draft.replyCompletedTurnId;
              draft.before = next.before;
              draft.activeTurnId = next.activeTurnId;
              draft.name = next.name;
              draft.sessionId = next.sessionId;
              draft.capabilities = next.capabilities;
              draft.recovery = next.recovery;
              draft.contextUsage = next.contextUsage;
              draft.compaction = next.compaction;
            });
          for (const waiter of active) waiter.resolve();
        } catch (error) {
          if (closed) return;
          for (const waiter of active) waiter.reject(error);
          try {
            onError(error);
          } catch {
            // Error observers must not interrupt draining or strand later callers.
          }
        } finally {
          active = [];
        }
      }
    } finally {
      running = false;
    }
  };
  const invalidate = () => {
    if (closed) return;
    dirty = true;
    if (!running) void drain();
  };
  const refresh = (): Promise<void> => {
    if (closed) return Promise.resolve();
    const result = new Promise<void>((resolve, reject) => {
      pending.push({ resolve, reject });
    });
    invalidate();
    return result;
  };
  const panels = Object.fromEntries(
    Object.entries(panelMethods).map(([method, schemas]) => [
      method,
      async (input: unknown) => {
        const read = validate(schemas[0], input);
        if (read.sessionId !== view.value.sessionId)
          throw new Error("Wrong session");
        const result = await (
          backend[method as keyof PanelBackend] as (
            input: unknown,
          ) => Promise<unknown>
        )(read);
        return validatePanelResult(method as keyof PanelBackend, result);
      },
    ]),
  ) as unknown as PanelBackend;
  provider.provide(Chat, {
    ...panels,
    view,
    async search(input) {
      return validateSearchResult(
        await backend.search(validateSearchInput(input)),
      );
    },
    async searchRead(input) {
      const value = validate(SearchReadInputSchema, input);
      return validateSearchReadResult(
        await backend.searchRead(value),
        value.id,
      );
    },
    async compact(input: CompactInput) {
      const value = validate(CompactInputSchema, input);
      await refresh();
      if (value.sessionId !== view.value.sessionId)
        throw new Error("Wrong session");
      if (
        view.value.activeTurnId ||
        view.value.compaction?.status === "running"
      )
        return { sessionId: value.sessionId, accepted: false };
      const result = validate(
        CompactResultSchema,
        await backend.compact(value),
      );
      if (result.sessionId !== value.sessionId)
        throw new Error("Wrong compact session");
      await refresh();
      return result;
    },
    async history(before: string) {
      return validate(PageSchema, await backend.history(validateId(before)));
    },
    async submit(input: Submission) {
      const value = validateSubmission(input);
      const receipt = validate(ReceiptSchema, await backend.submit(value));
      if (receipt.operationId !== value.operationId)
        throw new Error("Wrong operation receipt");
      await refresh();
      return receipt;
    },
    async lookup(id: string) {
      const receipt = validate(
        LookupSchema,
        await backend.lookup(validateId(id)),
      );
      if (receipt && receipt.operationId !== id)
        throw new Error("Wrong operation receipt");
      return receipt;
    },
    async finalizeSubmission(input) {
      const value = validate(FinalizeSubmissionSchema, input);
      if ("submission" in value) validateSubmission(value.submission);
      else if (value.retry.sessionId !== value.sessionId)
        throw new Error("Wrong retry session");
      await refresh();
      if (value.sessionId !== view.value.sessionId)
        throw new Error("Wrong session");
      const receipt = validate(
        LookupSchema,
        await backend.finalizeSubmission(value),
      );
      if (
        receipt &&
        receipt.operationId !==
          ("submission" in value
            ? value.submission.operationId
            : value.retry.attemptId)
      )
        throw new Error("Wrong operation receipt");
      await refresh();
      return receipt;
    },
    async retryFailed(input) {
      const value = validate(RetryFailedSchema, input);
      if (value.attemptId === value.operationId)
        throw new Error("Retry requires new attempt");
      await refresh();
      if (value.sessionId !== view.value.sessionId)
        throw new Error("Wrong session");
      const receipt = validate(ReceiptSchema, await backend.retryFailed(value));
      if (receipt.operationId !== value.attemptId)
        throw new Error("Wrong operation receipt");
      await refresh();
      return receipt;
    },
    async deleteFailed(input) {
      const value = validate(DeleteFailedSchema, input);
      await refresh();
      if (value.sessionId !== view.value.sessionId)
        throw new Error("Wrong session");
      const result = validate(
        DeleteFailedResultSchema,
        await backend.deleteFailed(value),
      );
      if (
        result.sessionId !== value.sessionId ||
        result.operationId !== value.operationId
      )
        throw new Error("Wrong deletion acknowledgement");
      await refresh();
      return result;
    },
    async stop(id: string) {
      const result = await backend.stop(validateId(id));
      await refresh();
      return result;
    },
  });
  let off: () => void;
  try {
    off = backend.subscribe(invalidate);
  } catch (error) {
    closed = true;
    provider.dispose();
    throw error;
  }
  const connections = new Set<ReturnType<typeof connect>>();
  function connect(
    socket: WireSocket,
    authorize: () => Promise<boolean>,
    options: ChatConnectionOptions = {},
  ) {
    let disposed = false;
    const subscriptions = new Map<string, ServiceSubscription>();
    let subscription: ChatSubscription | null = null;
    let incoming: Promise<void> = Promise.resolve();
    const enqueue = (work: () => Promise<void>) => {
      const next = incoming.then(work);
      incoming = next.catch(() => {});
      return next;
    };
    const fail = () => {
      socket.close(1011, "Connection failed");
      dispose();
    };
    async function persist(next: ChatSubscription | null) {
      try {
        await options.onSubscriptionChange?.(next && { ...next });
        if (!disposed) subscription = next;
      } catch (error) {
        fail();
        throw error;
      }
    }
    function subscribe(record: ChatSubscription) {
      const encoder = createServiceStateEncoder();
      const sub = provider.subscribe(record.serviceId, record.mode, (update) =>
        deliver({
          type: "update",
          subscriptionId: record.subscriptionId,
          update: encoder.encodeUpdate(update),
        }),
      );
      subscriptions.set(record.subscriptionId, sub);
      return { encoder, sub };
    }
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
      subscription = null;
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
          const record = readSubscription({
            version: 1,
            subscriptionId: control.subscriptionId,
            serviceId: control.serviceId,
            mode: control.mode,
          })!;
          const { encoder, sub } = subscribe(record);
          result = encoder.encodeSnapshot(sub.snapshot);
          await persist(record);
          if (disposed) return;
          deliver({ type: "result", id, result });
          sub.activate();
          return;
        } else if (control?.type === "unsubscribe") {
          subscriptions.get(control.subscriptionId)?.close();
          subscriptions.delete(control.subscriptionId);
          await persist(subscriptions.size ? subscription : null);
          if (disposed) return;
          result = null;
        } else if (control?.type === "catalogue") result = provider.catalogue;
        else {
          if (
            call.serviceId !== Chat.id ||
            call.instance ||
            ![
              "history",
              "submit",
              "lookup",
              "finalizeSubmission",
              "retryFailed",
              "deleteFailed",
              "stop",
              "compact",
              "search",
              "searchRead",
              ...Object.keys(panelMethods),
            ].includes(call.member) ||
            call.args.length !== 1
          )
            throw new Error("Invalid method");
          result = (await provider.invoke(
            call,
            BACKGROUND_CONTEXT,
          )) as JsonValue;
        }
        const reply = { type: "result", id, result: result ?? null };
        // Method results fail in isolation before the transport would disconnect.
        if (
          new TextEncoder().encode(JSON.stringify(reply)).byteLength >
          2 * 1024 * 1024
        )
          throw new Error("Method result exceeds frame limit");
        deliver(reply);
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
        return enqueue(() => process(raw)).catch(onError);
      },
      getSubscription(): ChatSubscription | null {
        return subscription && { ...subscription };
      },
      restoreSubscription(value: unknown): Promise<void> {
        return enqueue(async () => {
          if (disposed) throw new Error("Connection closed");
          try {
            const record = readSubscription(value);
            if (subscriptions.size) throw new Error("Already subscribed");
            if (!(await authorize())) {
              socket.close(1008, "Session expired");
              dispose();
              throw new Error("Unauthorized subscription");
            }
            if (disposed || !record) return;
            const { encoder, sub } = subscribe(record);
            subscription = record;
            deliver({
              type: "update",
              subscriptionId: record.subscriptionId,
              update: encoder.encodeUpdate({
                type: "reset",
                snapshot: sub.snapshot,
              }),
            });
            sub.activate();
            await outgoing;
          } catch (error) {
            if (!disposed) fail();
            throw error;
          }
        });
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
  // Catch up the initial read/subscription window without delaying readiness.
  invalidate();
  return {
    connect,
    refresh,
    close() {
      if (closed) return;
      closed = true;
      for (const waiter of [...active, ...pending]) waiter.resolve();
      pending = [];
      off();
      for (const c of connections) c.disconnect();
      provider.dispose();
    },
  };
}

export { imageHttp, type ImageBackend } from "./image-http.ts";
