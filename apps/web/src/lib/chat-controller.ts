import type {
  PanelBackend,
  SearchBackend,
  Relationship,
  RelationshipHistory,
} from "@lamplit/contracts";
import {
  CHAT_PATH,
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
export type PendingSend = Submission & {
  createdAt: number;
  state: "uncertain" | "missing" | "accepted" | "unconsumed" | "rejected";
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
  private receiptChecks = Promise.resolve();
  private retirements = new Map<string, () => void>();
  constructor(
    private changed: () => void,
    private storage: Pick<Storage, "getItem" | "setItem"> = localStorage,
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
    for (const retire of this.retirements.values()) retire();
    this.retirements.clear();
    this.relationshipGeneration++;
    clearTimeout(this.timer);
    this.client?.close();
    this.socket?.close();
  }
  private save() {
    try {
      this.storage.setItem(
        this.storageKey,
        JSON.stringify(this.pending.slice(-20)),
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
    for (const retire of this.retirements.values()) retire();
    this.retirements.clear();
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
          const input = validateSubmission({
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
              createdAt: item.createdAt,
              state: "uncertain",
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
    this.recovery = view.recovery.filter(
      (r) => !this.dismissed.has(r.sourceId),
    );
    if (!previous || previous.sessionId !== view.sessionId)
      this.before = view.before;
    else if (!this.older.length) this.before = view.before;
    const observed = new Set(view.messages.map((m) => m.operationId));
    this.pending = this.pending.filter((p) => {
      if (!observed.has(p.operationId)) return true;
      this.retirements.get(p.operationId)?.();
      this.retirements.delete(p.operationId);
      return false;
    });
    if (
      (previous?.activeTurnId && !view.activeTurnId) ||
      (previous && previous.sessionId !== view.sessionId && this.client)
    ) {
      this.panelRevision++;
      void this.refreshRelationship();
    }
    this.save();
    this.changed();
    if (this.pending.length && this.client)
      void this.reconcile().catch(() => {
        this.error = "部分消息尚未核对，连接恢复后会继续核对。";
        this.changed();
      });
  }
  private reconcile() {
    const client = this.client,
      key = this.storageKey;
    const task = this.receiptChecks.then(async () => {
      if (!client || this.client !== client || this.storageKey !== key) return;
      for (const input of this.pending) {
        const receipt = await client.lookup(input.operationId);
        if (this.client !== client || this.storageKey !== key) return;
        this.applyReceipt(receipt);
      }
    });
    this.receiptChecks = task.catch(() => {});
    return task;
  }
  private disconnected = () => {
    if (this.closed) return;
    this.connected = false;
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
      this.panelRevision++;
      void this.refreshRelationship();
      if (!this.error.includes("整理结果尚未确认")) this.error = "";
      this.changed();
      await this.reconcile();
    } catch {
      this.disconnected();
    } finally {
      this.connecting = false;
    }
  }
  private applyReceipt(receipt: Receipt) {
    if (receipt.state === "consumed") {
      this.pending = this.pending.filter(
        (p) => p.operationId !== receipt.operationId,
      );
      this.retirements.get(receipt.operationId)?.();
      this.retirements.delete(receipt.operationId);
    } else {
      this.pending = this.pending.map((p) =>
        p.operationId === receipt.operationId
          ? {
              ...p,
              state:
                receipt.state === "rejected"
                  ? "rejected"
                  : receipt.state === "unconsumed"
                    ? "unconsumed"
                    : receipt.state === "accepted"
                      ? "accepted"
                      : receipt.state === "missing"
                        ? "missing"
                        : "uncertain",
            }
          : p,
      );
      if (receipt.state === "rejected")
        this.error = receipt.error ?? "消息未被接收，请检查聊天记录。";
    }
    this.save();
    this.changed();
  }
  dismissRecovery(sourceId: string) {
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
    retired?: () => void,
    images: readonly CompanionImageDraft[] = [],
    replacementSourceIds: readonly string[] = [],
  ) {
    if (text === "/compact") {
      if (images.length) throw new Error("compact-with-images");
      await this.compact();
      retired?.();
      return;
    }
    if (this.compactPending || this.view?.compaction?.status === "running")
      throw new Error("请等待对话整理完成。");
    const client = this.client,
      sessionId = this.view?.sessionId;
    if (!client || !sessionId) throw new Error("连接已断开");
    if (this.pending.length >= 20) throw new Error("请先核对尚未确认的消息");
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
              (r) =>
                r.sourceId === id &&
                r.replacementEligible &&
                r.state !== "uncertain",
            ),
        )
      )
        throw new Error("恢复状态已改变，请检查聊天记录。");
    };
    checkReplacement();
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
    if (this.pending.length >= 20) throw new Error("请先核对尚未确认的消息");
    const input = validateSubmission({
      operationId,
      text,
      ...(refs ? { images: refs } : {}),
      ...(replacements.length ? { replacementSourceIds: replacements } : {}),
    });
    this.pending = [
      ...this.pending,
      { ...input, createdAt: Date.now(), state: "uncertain" },
    ];
    if (retired) this.retirements.set(input.operationId, retired);
    this.error = "";
    this.save();
    this.changed();
    try {
      const receipt = await client.submit(input);
      if (current()) this.applyReceipt(receipt);
    } catch {
      if (current()) {
        this.error = "消息尚未确认，连接恢复后会核对发送结果。";
        this.changed();
      }
    }
  }
  async retryMissing() {
    const client = this.client,
      key = this.storageKey;
    if (!client) return;
    for (const p of [...this.pending].filter((p) => p.state === "missing")) {
      try {
        const receipt = await client.lookup(p.operationId);
        if (this.client !== client || this.storageKey !== key) return;
        if (receipt.state === "missing") {
          const next = await client.submit(
            validateSubmission({
              operationId: p.operationId,
              text: p.text,
              ...(p.images ? { images: p.images } : {}),
              ...(p.replacementSourceIds
                ? { replacementSourceIds: p.replacementSourceIds }
                : {}),
            }),
          );
          if (this.client !== client || this.storageKey !== key) return;
          this.applyReceipt(next);
        } else this.applyReceipt(receipt);
      } catch {
        this.error = "消息尚未确认，请稍后再试。";
        this.changed();
        break;
      }
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
      this.older = [...page.messages, ...this.older];
      this.before = page.before;
    } catch {
      this.error = "加载历史失败，请重试。";
    } finally {
      this.loadingOlder = false;
      this.changed();
    }
  }
}
