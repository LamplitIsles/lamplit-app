import type {
  PanelBackend,
  SearchBackend,
  Relationship,
  RelationshipHistory,
} from "@lamplit/contracts";
import {
  CHAT_PATH,
  OperationIdSchema,
  validateSubmission,
  UPLOAD_PATH,
  UploadResultSchema,
  type InputRecovery,
  validate,
  type ChatView,
  type ChatMessage,
  type Receipt,
  type Submission,
} from "@lamplit/contracts";
import { openChat } from "@lamplit/contracts/client";
import { preparePhotoUploads } from "./photo-upload.ts";
import type { CompanionImageDraft } from "./companion/client/image-drafts.ts";
import type { PendingSubmissionRetirement } from "./companion/client/contracts.ts";
export type PendingSend = Submission & {
  previews?: readonly { id: string; name: string; previewUrl: string }[];
  logicalId?: string;
  retrySource?: string;
  dispatched?: boolean;
  localImageCount?: number;
  createdAt: number;
  state: "sending" | "sent" | "failed";
};
export class ChatController {
  view?: ChatView;
  older: ChatMessage[] = [];
  pending: PendingSend[] = [];
  connected = false;
  compactPending = false;
  private compactGeneration = 0;
  recovery: InputRecovery[] = [];
  private dismissed = new Set<string>();
  loadingOlder = false;
  before: string | null = null;
  error = "";
  private client?: Awaited<ReturnType<typeof openChat>>;
  private socket?: WebSocket;
  private timer?: ReturnType<typeof setTimeout>;
  private closed = false;
  private connecting = false;
  private connectionGeneration = 0;
  private storageKey = "";
  private deadlineTimer?: ReturnType<typeof setTimeout>;
  private checks = new Set<string>();
  private finalized = new Set<string>();
  private originals = new Map<string, readonly CompanionImageDraft[]>();
  private retirements = new Map<
    string,
    (result: PendingSubmissionRetirement) => void
  >();
  private inFlight = new Set<string>();
  private failedActions = new Map<string, symbol>();
  constructor(
    private changed: () => void,
    private storage: Pick<Storage, "getItem" | "setItem"> = localStorage,
    private liveView?: (view: ChatView) => void,
  ) {}
  relationship?: Relationship;
  relationshipHistory: RelationshipHistory = {
    scope: "unloaded",
    records: [],
    nextCursor: null,
    predecessor: null,
  };
  relationshipStatus: "loading" | "ready" | "error" = "loading";
  loadingRelationshipHistory = false;
  panelRevision = 0;
  private relationshipGeneration = 0;
  async readPanel<K extends keyof PanelBackend>(
    method: K,
    input: Omit<Parameters<PanelBackend[K]>[0], "sessionId">,
  ): Promise<Awaited<ReturnType<PanelBackend[K]>>> {
    const client = this.client,
      sessionId = this.view?.sessionId;
    if (!client || !sessionId) throw new Error("Offline");
    const result = await (
      client[method] as (input: unknown) => Promise<unknown>
    )({ ...input, sessionId });
    if (
      this.client !== client ||
      this.view?.sessionId !== sessionId ||
      this.closed
    )
      throw new Error("Stale request");
    return result as Awaited<ReturnType<PanelBackend[K]>>;
  }
  async readSearch<K extends keyof SearchBackend>(
    method: K,
    input: Parameters<SearchBackend[K]>[0],
  ): Promise<Awaited<ReturnType<SearchBackend[K]>>> {
    const client = this.client,
      sessionId = this.view?.sessionId;
    if (!client || !sessionId) throw new Error("Offline");
    const result = await (
      client[method] as (input: unknown) => Promise<unknown>
    )(input);
    if (
      this.client !== client ||
      this.view?.sessionId !== sessionId ||
      this.closed
    )
      throw new Error("Stale request");
    return result as Awaited<ReturnType<SearchBackend[K]>>;
  }
  async refreshRelationship(history = false) {
    const generation = ++this.relationshipGeneration;
    this.relationshipStatus = "loading";
    this.loadingRelationshipHistory = false;
    this.changed();
    try {
      const current = await this.readPanel("relationship", {});
      const page = history
        ? await this.readPanel("relationshipHistory", { cursor: null })
        : undefined;
      if (generation !== this.relationshipGeneration) return;
      this.relationship = current;
      if (page && page.scope !== current.scope)
        throw new Error("Wrong relationship scope");
      if (page) this.relationshipHistory = page;
      this.relationshipStatus = "ready";
    } catch {
      if (generation === this.relationshipGeneration)
        this.relationshipStatus = "error";
    } finally {
      if (generation === this.relationshipGeneration) this.changed();
    }
  }
  async loadRelationshipHistory() {
    const cursor = this.relationshipHistory.nextCursor;
    if (!cursor || this.loadingRelationshipHistory) return;
    const generation = this.relationshipGeneration;
    this.loadingRelationshipHistory = true;
    this.changed();
    try {
      const page = await this.readPanel("relationshipHistory", { cursor });
      if (generation !== this.relationshipGeneration) return;
      if (page.scope !== this.relationshipHistory.scope)
        throw new Error("Wrong scope");
      this.relationshipHistory = {
        ...page,
        records: [...this.relationshipHistory.records, ...page.records],
      };
      this.relationshipStatus = "ready";
    } catch {
      if (generation === this.relationshipGeneration)
        this.relationshipStatus = "error";
    } finally {
      if (generation === this.relationshipGeneration) {
        this.loadingRelationshipHistory = false;
        this.changed();
      }
    }
  }
  start() {
    void this.connect();
  }
  close() {
    this.closed = true;
    this.connectionGeneration++;
    this.compactGeneration++;
    this.compactPending = false;
    for (const retire of this.retirements.values())
      retire({ reason: "observed" });
    this.retirements.clear();
    this.originals.clear();
    this.inFlight.clear();
    this.failedActions.clear();
    this.relationshipGeneration++;
    clearTimeout(this.timer);
    clearTimeout(this.deadlineTimer);
    this.client?.close();
    this.socket?.close();
  }
  private save() {
    try {
      this.storage.setItem(
        this.storageKey,
        JSON.stringify(
          this.pending
            .filter((p) => !p.previews || p.images || p.state === "failed")
            .slice(-20)
            .map(({ previews: _previews, ...input }) => input),
        ),
      );
    } catch {
      this.error = "无法保存发送状态，请保持此页面打开。";
    }
  }
  private hydrate(sessionId: string) {
    const key = `lamplit.pending:${sessionId}`;
    if (this.storageKey === key) return;
    this.storageKey = key;
    this.error = "";
    this.compactGeneration++;
    this.compactPending = false;
    this.pending = [];
    this.older = [];
    this.before = null;
    for (const retire of this.retirements.values())
      retire({ reason: "observed" });
    this.retirements.clear();
    this.inFlight.clear();
    this.failedActions.clear();
    this.checks.clear();
    this.finalized.clear();
    this.originals.clear();
    clearTimeout(this.deadlineTimer);
    this.recovery = [];
    this.dismissed.clear();
    this.relationshipGeneration++;
    this.relationship = undefined;
    this.relationshipHistory = {
      scope: "unloaded",
      records: [],
      nextCursor: null,
      predecessor: null,
    };
    try {
      const stored = this.storage.getItem(key) ?? "[]";
      if (stored.length > 1_000_000) throw new Error("Pending state too large");
      const raw: unknown = JSON.parse(stored);
      if (Array.isArray(raw))
        for (const item of raw.slice(0, 20)) {
          validate(OperationIdSchema, item.operationId);
          if (
            typeof item.text !== "string" ||
            item.text.length > 16000 ||
            (item.localImageCount &&
              (!Number.isInteger(item.localImageCount) ||
                item.localImageCount < 1 ||
                item.localImageCount > 6))
          )
            throw new Error("Invalid pending input");
          const input =
            item.localImageCount && !item.dispatched
              ? { operationId: item.operationId, text: item.text }
              : validateSubmission({
                  operationId: item.operationId,
                  text: item.text,
                  ...(item.images ? { images: item.images } : {}),
                  ...(item.replacementSourceIds
                    ? { replacementSourceIds: item.replacementSourceIds }
                    : {}),
                });
          if (
            typeof item.createdAt === "number" &&
            Number.isFinite(item.createdAt)
          )
            this.pending.push({
              ...input,
              logicalId:
                typeof item.logicalId === "string"
                  ? item.logicalId
                  : input.operationId,
              retrySource:
                typeof item.retrySource === "string"
                  ? item.retrySource
                  : undefined,
              dispatched: item.dispatched !== false,
              localImageCount: item.localImageCount,
              createdAt: item.createdAt,
              // One-time local draft normalization; unknown transport outcomes remain pending.
              state:
                item.state === "failed" ||
                (item.state === "rejected" && item.admitted !== true)
                  ? "failed"
                  : item.state === "sent" ||
                      ["accepted", "consumed", "unconsumed"].includes(
                        item.state,
                      ) ||
                      item.admitted === true
                    ? "sent"
                    : "sending",
            });
        }
    } catch {
      this.error = "无法读取上次发送状态，请先检查聊天记录。";
    }
  }
  private observe(view: ChatView) {
    this.hydrate(view.sessionId);
    const previous = this.view;
    const liveIds = new Set(view.messages.map((message) => message.id));
    const evicted = (
      previous?.sessionId === view.sessionId ? previous.messages : []
    ).filter((message) => !liveIds.has(message.id));
    this.older = [
      ...new Map(
        [...this.older, ...evicted].map((message) => [message.id, message]),
      ).values(),
    ].filter((message) => !liveIds.has(message.id));
    this.view = view;
    this.liveView?.(view);

    if (!previous || previous.sessionId !== view.sessionId)
      this.before = view.before;
    else if (!this.older.length) this.before = view.before;
    this.retireObserved();
    this.updateRecovery();
    if (
      (previous?.activeTurnId && !view.activeTurnId) ||
      (previous && previous.sessionId !== view.sessionId && this.client)
    ) {
      this.panelRevision++;
      void this.refreshRelationship();
    }
    this.save();
    this.changed();
    for (const id of this.finalized)
      if (!this.checks.has(id)) this.finalized.delete(id);
    this.scheduleDeadline();
    if (this.pending.length && this.client)
      void this.reconcile().catch(() => {
        this.error = "部分消息尚未核对，连接恢复后会继续核对。";
        this.changed();
      });
  }
  private retireObserved() {
    const observed = new Set(
      [...this.older, ...(this.view?.messages ?? [])]
        .filter((m) => m.role === "user")
        .map((m) => m.operationId),
    );
    this.pending = this.pending.filter((p) => {
      if (!observed.has(p.operationId)) return true;
      this.retirements.get(p.operationId)?.({ reason: "observed" });
      this.retirements.delete(p.operationId);
      this.originals.delete(p.operationId);
      return false;
    });
  }
  recheckPending() {
    for (const id of this.finalized)
      if (!this.checks.has(id)) this.finalized.delete(id);
    void this.reconcile().catch(() => {});
  }
  private scheduleDeadline() {
    clearTimeout(this.deadlineTimer);
    if (
      !this.connected ||
      this.closed ||
      (typeof navigator !== "undefined" && navigator.onLine === false)
    )
      return;
    const deadlines = this.pending.filter(
      (p) =>
        p.state === "sending" &&
        p.dispatched !== false &&
        !this.checks.has(p.operationId) &&
        !this.finalized.has(p.operationId),
    );
    if (deadlines.length)
      this.deadlineTimer = setTimeout(
        () => void this.reconcile().catch(() => {}),
        Math.max(
          0,
          Math.min(...deadlines.map((p) => p.createdAt + 60000)) - Date.now(),
        ),
      );
  }
  private async reconcile() {
    const client = this.client,
      key = this.storageKey,
      sessionId = this.view?.sessionId;
    if (
      !client ||
      !sessionId ||
      (typeof navigator !== "undefined" && navigator.onLine === false)
    )
      return;
    await Promise.all(
      this.pending.map(async (input) => {
        if (
          input.state !== "sending" ||
          input.dispatched === false ||
          this.checks.has(input.operationId)
        )
          return;
        const expired = Date.now() - input.createdAt >= 60000;
        if (!expired && this.inFlight.has(input.operationId)) return;
        this.checks.add(input.operationId);
        if (expired) this.finalized.add(input.operationId);
        try {
          const receipt = expired
            ? await client.finalizeSubmission(
                input.retrySource
                  ? {
                      sessionId,
                      retry: {
                        sessionId,
                        operationId: input.retrySource,
                        attemptId: input.operationId,
                      },
                    }
                  : { sessionId, submission: this.submission(input) },
              )
            : await client.lookup(input.operationId);
          if (this.client === client && this.storageKey === key && receipt)
            this.applyReceipt(receipt);
        } finally {
          this.checks.delete(input.operationId);
          this.scheduleDeadline();
        }
      }),
    );
    this.scheduleDeadline();
  }
  private submission(input: PendingSend): Submission {
    return {
      operationId: input.operationId,
      text: input.text,
      ...(input.images ? { images: input.images } : {}),
      ...(input.replacementSourceIds
        ? { replacementSourceIds: input.replacementSourceIds }
        : {}),
    };
  }
  async retryFailed(id: string) {
    const input = this.pending.find(
      (p) => (p.logicalId ?? p.operationId) === id,
    );
    const client = this.client,
      sessionId = this.view?.sessionId;
    if (
      !input ||
      input.state !== "failed" ||
      !client ||
      !sessionId ||
      this.failedActions.has(input.operationId)
    )
      return;
    const originals = this.originals.get(input.operationId);
    if (input.dispatched === false) {
      if (input.localImageCount && !originals) {
        this.error = "原图片不可用，请删除这条消息后重新选择图片发送。";
        this.changed();
        return;
      }
      try {
        await this.send(
          input.text,
          this.retirements.get(input.operationId),
          originals ?? [],
          input.replacementSourceIds,
          input,
        );
      } catch {
        this.error = "重试失败，请检查连接和原图片后再试。";
        this.changed();
      }
      return;
    }
    const retry = {
      sessionId,
      operationId: input.operationId,
      attemptId: crypto.randomUUID(),
    };
    const pending: PendingSend = {
      ...input,
      operationId: retry.attemptId,
      retrySource: input.operationId,
      logicalId: input.logicalId ?? input.operationId,
      state: "sending",
      createdAt: Date.now(),
      dispatched: true,
    };
    this.pending = this.pending.map((p) => (p === input ? pending : p));
    const retire = this.retirements.get(input.operationId);
    this.retirements.delete(input.operationId);
    if (retire) this.retirements.set(pending.operationId, retire);
    this.originals.delete(input.operationId);
    if (originals) this.originals.set(pending.operationId, originals);
    this.inFlight.add(pending.operationId);
    this.error = "";
    this.save();
    this.changed();
    this.scheduleDeadline();
    try {
      const receipt = await client.retryFailed(retry);
      if (this.view?.sessionId === sessionId && !this.closed)
        this.applyReceipt(receipt);
    } catch {
      if (this.view?.sessionId === sessionId) {
        this.error = "重试结果尚未确认，连接恢复后会继续核对。";
        this.changed();
      }
    } finally {
      this.inFlight.delete(pending.operationId);
    }
  }
  async deleteFailed(id: string) {
    const input = this.pending.find(
      (p) => (p.logicalId ?? p.operationId) === id,
    );
    const client = this.client,
      sessionId = this.view?.sessionId;
    if (
      !input ||
      input.state !== "failed" ||
      !client ||
      !sessionId ||
      this.failedActions.has(input.operationId)
    )
      return;
    const action = Symbol();
    this.failedActions.set(input.operationId, action);
    try {
      // Preparation never dispatched an immutable submission; it has no native admission to delete.
      const result =
        input.dispatched === false
          ? { deleted: true }
          : await client.deleteFailed({
              sessionId,
              operationId: input.operationId,
            });
      if (this.view?.sessionId !== sessionId || this.closed) return;
      if (!result.deleted) {
        const receipt = await client.lookup(input.operationId);
        if (this.view?.sessionId === sessionId) {
          if (receipt) this.applyReceipt(receipt);
          if (!receipt || receipt.state === "failed") {
            this.error = "暂时无法删除，请等待连接恢复后重试。";
            this.changed();
          }
        }
        return;
      }
      if (!this.pending.includes(input) || input.state !== "failed") return;
      this.pending = this.pending.filter((p) => p !== input);
      this.retirements.get(input.operationId)?.({ reason: "observed" });
      this.retirements.delete(input.operationId);
      this.originals.delete(input.operationId);
      this.updateRecovery();
      this.save();
      this.changed();
    } catch {
      if (this.view?.sessionId === sessionId) {
        this.error = "删除失败，请在连接恢复后重试。";
        this.changed();
      }
    } finally {
      if (this.failedActions.get(input.operationId) === action)
        this.failedActions.delete(input.operationId);
    }
  }
  private disconnected = () => {
    if (this.closed) return;
    this.connected = false;
    this.updateRecovery();
    if (this.storageKey) this.save();
    if (this.compactPending) {
      this.compactGeneration++;
      this.compactPending = false;
      this.error = "对话整理结果尚未确认，请等待连接恢复后检查。";
    }
    this.relationshipGeneration++;
    this.client = undefined;
    this.changed();
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.connect();
    }, 1500);
  };
  private async connect() {
    if (this.closed || this.connecting) return;
    this.connecting = true;
    const generation = ++this.connectionGeneration;
    try {
      const url = new URL(CHAT_PATH, location.href);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(url);
      this.socket = socket;
      const client = await openChat(
        socket,
        (view) => {
          if (!this.closed && generation === this.connectionGeneration)
            this.observe(view);
        },
        () => {
          if (generation === this.connectionGeneration) this.disconnected();
        },
      );
      if (
        this.closed ||
        generation !== this.connectionGeneration ||
        socket.readyState !== 1
      ) {
        client.close();
        return;
      }
      this.client = client;
      this.connected = true;
      this.finalized.clear();
      this.panelRevision++;
      void this.refreshRelationship();
      if (!this.error.includes("整理结果尚未确认")) this.error = "";
      this.changed();
      await this.reconcile().catch(() => {});
    } catch {
      this.disconnected();
    } finally {
      this.connecting = false;
    }
  }
  private applyReceipt(receipt: Receipt) {
    const pending = this.pending.find(
      (p) => p.operationId === receipt.operationId,
    );
    if (!pending) return; // Native observation or a session change already retired it.
    // Durable submission/observation cannot be revoked by a later result.
    if (
      pending.state === "sent" ||
      (pending.state === "failed" && receipt.state === "failed")
    )
      return;
    this.pending = this.pending.map((p) =>
      p === pending
        ? { ...p, state: receipt.state === "submitted" ? "sent" : "failed" }
        : p,
    );
    if (receipt.state === "failed")
      this.error = receipt.error || "发送失败，请重试或删除这条消息。";
    this.updateRecovery();
    this.save();
    this.changed();
  }
  private updateRecovery() {
    this.recovery = (this.view?.recovery ?? []).filter(
      (r) =>
        !this.dismissed.has(r.sourceId) &&
        !this.pending.some(
          (p) =>
            (p.state !== "sent" && p.operationId === r.operationId) ||
            p.retrySource === r.operationId,
        ),
    );
  }
  dismissRecovery(sourceId: string) {
    const local = this.pending.find(
      (p) => p.operationId === sourceId && p.state === "failed",
    );
    if (local) {
      this.retirements.get(sourceId)?.({ reason: "observed" });
      this.retirements.delete(sourceId);
    }
    this.pending = this.pending.filter(
      (p) => !(p.operationId === sourceId && p.state === "failed"),
    );
    this.save();
    this.dismissed.add(sourceId);
    this.recovery = this.recovery.filter((r) => r.sourceId !== sourceId);
    this.changed();
  }
  async compact() {
    const client = this.client,
      sessionId = this.view?.sessionId;
    if (!client || !sessionId) throw new Error("连接已断开");
    if (
      this.compactPending ||
      this.view?.activeTurnId ||
      this.view?.compaction?.status === "running"
    )
      throw new Error("请等待当前工作完成后整理对话。");
    const generation = ++this.compactGeneration;
    this.compactPending = true;
    this.error = "";
    this.changed();
    const current = () =>
      !this.closed &&
      this.client === client &&
      this.view?.sessionId === sessionId &&
      generation === this.compactGeneration;
    try {
      const result = await client.compact({ sessionId });
      if (!current()) throw new Error("连接已改变，请检查对话整理状态。");
      if (!result.accepted) throw new Error("请等待当前工作完成后整理对话。");
    } catch (error) {
      if (current()) {
        this.error =
          error instanceof Error && error.message.includes("等待当前")
            ? error.message
            : "对话整理结果尚未确认，请检查当前状态。";
        this.changed();
      }
      throw error;
    } finally {
      if (current()) {
        this.compactPending = false;
        this.changed();
      }
    }
  }
  async send(
    text: string,
    retired?: (result: PendingSubmissionRetirement) => void,
    images: readonly CompanionImageDraft[] = [],
    replacementSourceIds: readonly string[] = [],
    previous?: PendingSend,
  ) {
    if (text === "/compact") {
      if (images.length) throw new Error("compact-with-images");
      await this.compact();
      retired?.({ reason: "observed" });
      return;
    }
    if (this.compactPending || this.view?.compaction?.status === "running")
      throw new Error("请等待对话整理完成。");
    const client = this.client,
      sessionId = this.view?.sessionId;
    if (!client || !sessionId) throw new Error("连接已断开");
    if (this.pending.length >= 20 && !previous)
      throw new Error("请先核对尚未确认的消息");
    const operationId = crypto.randomUUID();
    const current = () =>
      this.client === client &&
      this.view?.sessionId === sessionId &&
      !this.closed;
    const replacements = [...replacementSourceIds];
    const checkReplacement = () => {
      if (
        replacements.some(
          (id) =>
            !this.view?.recovery.some(
              (r) => r.sourceId === id && r.replacementEligible,
            ),
        )
      )
        throw new Error("恢复状态已改变，请检查聊天记录。");
    };
    checkReplacement();
    const pending: PendingSend = {
      operationId,
      logicalId: previous?.logicalId ?? previous?.operationId ?? operationId,
      dispatched: false,
      localImageCount: images.length,
      text,
      createdAt: Date.now(),
      state: "sending",
      ...(replacements.length ? { replacementSourceIds: replacements } : {}),
      ...(images.length
        ? {
            previews: images.map((draft) => ({
              id: draft.id,
              name: draft.file.name,
              previewUrl: draft.previewUrl,
            })),
          }
        : {}),
    };
    this.pending = [...this.pending.filter((p) => p !== previous), pending];
    if (previous) {
      this.originals.delete(previous.operationId);
      this.retirements.delete(previous.operationId);
    }
    if (images.length) this.originals.set(operationId, images);
    if (retired) this.retirements.set(operationId, retired);
    this.inFlight.add(operationId);
    this.error = "";
    this.updateRecovery();
    this.save();
    this.changed();
    let submitted = false;
    const sameSession = () =>
      this.view?.sessionId === sessionId && !this.closed;
    try {
      let refs: Submission["images"];
      if (images.length) {
        const limits = this.view!.capabilities.images;
        if (!limits) throw new Error("图片暂不可用");
        const upload = await preparePhotoUploads(
          sessionId,
          operationId,
          images,
          limits,
        );
        if (!current()) throw new Error("连接已改变，请重新发送");
        const response = await fetch(new URL(UPLOAD_PATH, location.href), {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(upload),
        });
        if (!response.ok) throw new Error("图片上传失败，请重试。");
        const result = validate(UploadResultSchema, await response.json());
        if (
          result.sessionId !== sessionId ||
          result.operationId !== operationId ||
          result.images.length !== images.length ||
          result.images.some((r) => r.availability !== "available")
        )
          throw new Error("图片上传结果无效");
        refs = result.images;
      }
      if (!current()) throw new Error("连接已改变，请重新发送");
      checkReplacement();
      const input = validateSubmission({
        operationId,
        text,
        ...(refs ? { images: refs } : {}),
        ...(replacements.length ? { replacementSourceIds: replacements } : {}),
      });
      this.pending = this.pending.map((p) =>
        p.operationId === operationId
          ? { ...p, ...input, dispatched: true }
          : p,
      );
      this.save();
      this.changed();
      submitted = true;
      this.scheduleDeadline();
      const receipt = await client.submit(input);
      if (sameSession()) this.applyReceipt(receipt);
    } catch (error) {
      if (!submitted) {
        if (sameSession()) {
          this.pending = this.pending.map((p) =>
            p.operationId === operationId
              ? { ...p, state: "failed", dispatched: false }
              : p,
          );
          this.error =
            error instanceof Error ? error.message : "消息未发送，请重试。";
          this.updateRecovery();
          this.save();
          this.changed();
        }
      } else if (sameSession()) {
        // A transport error cannot undo durable admission or native observation.
        this.updateRecovery();
        this.save();
        this.changed();
      }
    } finally {
      this.inFlight.delete(operationId);
      if (
        sameSession() &&
        this.client &&
        this.pending.some(
          (p) => p.operationId === operationId && p.state === "sending",
        )
      )
        void this.reconcile().catch(() => {});
    }
  }
  async stop() {
    const turn = this.view?.activeTurnId;
    if (!this.client || !turn) return;
    try {
      await this.client.stop(turn);
      await this.reconcile().catch(() => {
        this.error = "部分消息尚未核对，连接恢复后会继续核对。";
        this.changed();
      });
    } catch {
      this.error = "停止结果尚未确认，请等待连接恢复。";
      this.changed();
    }
  }
  async loadOlder() {
    if (!this.client || !this.before || this.loadingOlder) return;
    const client = this.client,
      sessionId = this.view?.sessionId;
    this.loadingOlder = true;
    this.changed();
    try {
      const page = await client.history(this.before);
      if (this.client !== client || this.view?.sessionId !== sessionId) return;
      this.older = [
        ...new Map(
          [...page.messages, ...this.older].map((m) => [m.id, m]),
        ).values(),
      ];
      this.retireObserved();
      this.save();
      this.updateRecovery();
      this.before = page.before;
    } catch {
      this.error = "加载历史失败，请重试。";
    } finally {
      this.loadingOlder = false;
      this.changed();
    }
  }
}
