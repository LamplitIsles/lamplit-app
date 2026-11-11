import type {
  PanelBackend,
  SearchBackend,
  Relationship,
  RelationshipHistory,
} from "@lamplit/contracts";
import {
  CHAT_PATH,
  MAX_FILES_PER_MESSAGE,
  MAX_FILE_BYTES,
  OperationIdSchema,
  validateSubmission,
  UPLOAD_PATH,
  validateUploadResult,
  StickerIdentitySchema,
  type StickerIdentity,
  validate,
  type ChatView,
  type ChatMessage,
  type Receipt,
  type Submission,
} from "@lamplit/contracts";
import { ChatConnectionError, openChat } from "@lamplit/contracts/client";
import { StickerClient } from "./sticker-client.ts";
import { streamFileUploads, type ChatFileDraft } from "./file-upload.ts";
import { preparePhotoUploads } from "./photo-upload.ts";
import type { CompanionImageDraft } from "./companion/client/image-drafts.ts";
export type PendingSend = Submission & {
  previews?: readonly { id: string; name: string; previewUrl: string }[];
  logicalId?: string;
  dispatched?: boolean;
  localImageCount?: number;
  localFileCount?: number;
  fileDrafts?: readonly { id: string; name: string; size: number }[];
  stickerInput?: StickerIdentity;
  attempt?: number;
  retryAfter?: number;
  createdAt: number;
  state: "sending" | "sent" | "failed";
};
// Files and previews remain page-owned; reserve a bounded number of operations
// across sessions rather than silently evicting retryable input.
const MAX_RETAINED_ATTACHMENT_OPERATIONS = 20;
export const ATTACHMENT_CAPACITY_ERROR = "attachment-capacity";
export const PENDING_MESSAGE_CAPACITY_ERROR = "pending-message-capacity";
export const FILE_RESELECT_ERROR = "file-reselect";
const ATTACHMENT_CAPACITY_MESSAGE =
  "附件准备尚未结束，或待确认附件过多；请稍候，或处理其他会话中的待确认消息后重试。";
type ChatCapacityCode =
  | typeof ATTACHMENT_CAPACITY_ERROR
  | typeof PENDING_MESSAGE_CAPACITY_ERROR
  | typeof FILE_RESELECT_ERROR;
class ChatCapacityError extends Error {
  constructor(
    readonly code: ChatCapacityCode,
    message: string,
  ) {
    super(message);
  }
}
type ParkedAttachment = {
  pending: PendingSend;
  images?: readonly CompanionImageDraft[];
  files?: readonly ChatFileDraft[];
  retire?: () => void;
};
export type LocalImagePreview = {
  sessionId: string;
  operationId: string;
  draftId: string;
  order: number;
  attachmentId: string;
  previewUrl: string;
};
/** A visible discontinuity between retained sources; IDs locate its marker. */
export type ChatHistoryGap = {
  id: number;
  afterId: string;
  beforeId: string;
  status: "pending" | "loading" | "error" | "unavailable";
};
type GapState = ChatHistoryGap & {
  cursor: string | null;
  visited: ReadonlySet<string>;
};
export class ChatController {
  view?: ChatView;
  older: ChatMessage[] = [];
  pending: PendingSend[] = [];
  localPreviews: readonly LocalImagePreview[] = [];
  connected = false;
  compactPending = false;
  private compactGeneration = 0;
  loadingOlder = false;
  before: string | null = null;
  private errorMessage = "";
  private capacityErrorCode?: ChatCapacityCode;
  get error() {
    return this.errorMessage;
  }
  set error(message: string) {
    this.errorMessage = message;
    this.capacityErrorCode = undefined;
  }
  get errorCode(): ChatCapacityCode | undefined {
    return this.capacityErrorCode;
  }
  setError(error: unknown) {
    this.error = error instanceof Error ? error.message : "发送失败";
    if (error instanceof ChatCapacityError) this.capacityErrorCode = error.code;
  }
  private stickerClients = new Set<StickerClient>();
  private stickerGeneration = 0;
  private client?: Awaited<ReturnType<typeof openChat>>;
  private socket?: WebSocket;
  private timer?: ReturnType<typeof setTimeout>;
  private closed = false;
  private connecting = false;
  private visible = true;
  private retryFailures = 0;
  private retryable = true;
  private connectionGeneration = 0;
  private historyEpoch = 0;
  private historyLoadingToken?: symbol;
  private gaps: GapState[] = [];
  private nextGapId = 0;
  private historySources = new Set<string>();
  private unconfirmedInputs = new Set<string>();
  /** `pending` may be triggered once when visible; `error` needs explicit retry. */
  get historyGaps(): readonly ChatHistoryGap[] {
    return this.gaps.map(
      ({ cursor: _cursor, visited: _visited, ...gap }) => gap,
    );
  }
  historySyncFailed = false;
  private storageKey = "";
  private sessionGeneration = 0;
  private checks = new Set<string>();
  private generations = new Map<string, number>();
  private parkedAttachments = new Map<string, Map<string, ParkedAttachment>>();
  private attachmentPreparations = new Map<string, AbortController>();
  private fileOriginals = new Map<string, readonly ChatFileDraft[]>();
  private originals = new Map<string, readonly CompanionImageDraft[]>();
  private retirements = new Map<string, () => void>();
  private inFlight = new Set<string>();
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
  openStickers(): StickerClient {
    const client = this.client,
      sessionId = this.view?.sessionId;
    if (!client || !sessionId || this.closed) throw new Error("Offline");
    const stickers = new StickerClient(
      sessionId,
      () =>
        !this.closed &&
        this.client === client &&
        this.view?.sessionId === sessionId,
    );
    this.stickerClients.add(stickers);
    return stickers;
  }
  private closeStickers() {
    this.stickerGeneration++;
    let interrupted = false;
    this.pending = this.pending.map((pending) => {
      if (
        pending.stickerInput &&
        pending.state === "sending" &&
        pending.dispatched === false
      ) {
        interrupted = true;
        this.generations.set(
          pending.operationId,
          (this.generations.get(pending.operationId) ?? 0) + 1,
        );
        this.inFlight.delete(pending.operationId);
        return { ...pending, state: "failed" };
      }
      return pending;
    });
    if (interrupted) {
      if (this.storageKey) this.save();
    }
    for (const stickers of this.stickerClients) stickers.close();
    this.stickerClients.clear();
  }
  async sendSticker(sticker: StickerIdentity) {
    await this.send(
      "",
      undefined,
      [],
      undefined,
      validate(StickerIdentitySchema, sticker),
    );
  }
  async readPanel<K extends keyof PanelBackend>(
    method: K,
    input: Omit<Parameters<PanelBackend[K]>[0], "sessionId">,
  ): Promise<Awaited<ReturnType<PanelBackend[K]>>> {
    const client = this.client,
      sessionId = this.view?.sessionId;
    if (!client || !sessionId) {
      this.recover();
      throw new Error("Offline");
    }
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
    if (!client || !sessionId) {
      this.recover();
      throw new Error("Offline");
    }
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
  recover(explicit = true) {
    if (this.closed || !this.visible) return;
    clearTimeout(this.timer);
    if (explicit) this.retryable = true;
    if (!this.retryable) return;
    if (!this.connected) void this.connect();
  }
  setVisible(visible: boolean) {
    if (this.closed || this.visible === visible) return;
    this.visible = visible;
    clearTimeout(this.timer);
    if (!visible) return;
    // A lifecycle suspension can leave an open but unusable carrier.
    if (this.connected) {
      this.connectionGeneration++;
      const client = this.client;
      this.disconnected();
      client?.close();
    } else this.recover(false);
  }
  private scheduleReconnect() {
    clearTimeout(this.timer);
    if (this.closed || !this.visible || !this.retryable) return;
    const delay = Math.min(
      30000,
      1500 * 2 ** Math.min(this.retryFailures++, 5),
    );
    this.timer = setTimeout(() => void this.connect(), delay);
  }
  private releaseParkedAttachments() {
    for (const entries of this.parkedAttachments.values())
      for (const entry of entries.values())
        entry.retire?.();
    this.parkedAttachments.clear();
  }
  private retainedAttachmentCount() {
    const operations = new Set([
      ...this.originals.keys(),
      ...this.fileOriginals.keys(),
      ...this.attachmentPreparations.keys(),
    ]);
    for (const entries of this.parkedAttachments.values())
      for (const operationId of entries.keys()) operations.add(operationId);
    return operations.size;
  }
  close() {
    this.closeStickers();
    this.releaseParkedAttachments();
    for (const preparation of this.attachmentPreparations.values())
      preparation.abort();
    this.attachmentPreparations.clear();
    this.discardPreview();
    this.closed = true;
    this.connected = false;
    this.connectionGeneration++;
    this.historyEpoch++;
    this.gaps = [];
    this.historySources.clear();
    this.unconfirmedInputs.clear();
    this.historyLoadingToken = undefined;
    this.loadingOlder = false;
    this.compactGeneration++;
    this.compactPending = false;
    for (const retire of this.retirements.values())
      retire();
    this.retirements.clear();
    this.localPreviews = [];
    this.originals.clear();
    this.fileOriginals.clear();
    this.inFlight.clear();
    this.relationshipGeneration++;
    clearTimeout(this.timer);
    this.client?.close();
    this.socket?.close();
  }
  private save() {
    try {
      this.storage.setItem(
        this.storageKey,
        JSON.stringify(
          this.pending.slice(-20).map(({ previews: _previews, ...input }) => ({
            ...input,
            deliveryVersion: 2,
          })),
        ),
      );
    } catch {
      this.error = "无法保存发送状态，请保持此页面打开。";
    }
  }
  private hydrate(sessionId: string) {
    const key = `lamplit.pending:${sessionId}`;
    if (this.storageKey === key) return;
    this.sessionGeneration++;
    this.closeStickers();
    // Only pre-dispatch inputs are locally retryable. Stale uploads remain
    // fenced by sessionGeneration; parking their originals never resends them.
    const parked = new Map<string, ParkedAttachment>();
    for (const pending of this.pending) {
      const images = this.originals.get(pending.operationId);
      const files = this.fileOriginals.get(pending.operationId);
      if (pending.dispatched === false && (images || files)) {
        this.attachmentPreparations.get(pending.operationId)?.abort();
        parked.set(pending.operationId, {
          pending: { ...pending, state: "failed" },
          images,
          files,
          retire: this.retirements.get(pending.operationId),
        });
        this.retirements.delete(pending.operationId);
      }
    }
    if (parked.size && this.storageKey)
      this.parkedAttachments.set(this.storageKey, parked);
    this.storageKey = key;
    this.error = "";
    this.compactGeneration++;
    this.compactPending = false;
    this.pending = [];
    this.older = [];
    this.before = null;
    this.gaps = [];
    this.historySources.clear();
    this.unconfirmedInputs.clear();
    this.historyEpoch++;
    this.historyLoadingToken = undefined;
    this.loadingOlder = false;
    this.historySyncFailed = false;
    for (const retire of this.retirements.values())
      retire();
    this.retirements.clear();
    this.localPreviews = [];
    this.inFlight.clear();
    this.checks.clear();
    this.originals.clear();
    this.fileOriginals.clear();
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
            (item.localFileCount &&
              (!Number.isInteger(item.localFileCount) ||
                item.localFileCount < 1 ||
                item.localFileCount > MAX_FILES_PER_MESSAGE)) ||
            (item.localImageCount &&
              (!Number.isInteger(item.localImageCount) ||
                item.localImageCount < 1 ||
                item.localImageCount > 6))
          )
            throw new Error("Invalid pending input");
          const input =
            (item.localImageCount || item.localFileCount) && !item.dispatched
              ? {
                  operationId: item.operationId,
                  text: item.text,
                }
              : validateSubmission({
                  operationId: item.operationId,
                  text: item.text,
                  ...(item.images ? { images: item.images } : {}),
                  ...(item.files ? { files: item.files } : {}),
                });
          if (
            typeof item.createdAt === "number" &&
            Number.isFinite(item.createdAt)
          )
            this.pending.push({
              ...input,
              logicalId: item.logicalId === undefined
                ? input.operationId
                : validate(OperationIdSchema, item.logicalId),
              dispatched: item.dispatched !== false,
              localImageCount: item.localImageCount,
              localFileCount: item.localFileCount,
              ...(Array.isArray(item.fileDrafts) &&
              item.fileDrafts.length <= MAX_FILES_PER_MESSAGE &&
              item.fileDrafts.every(
                (f: any) =>
                  typeof f.id === "string" &&
                  typeof f.name === "string" &&
                  typeof f.size === "number" &&
                  Number.isSafeInteger(f.size) &&
                  f.size >= 0 &&
                  f.size <= MAX_FILE_BYTES,
              )
                ? { fileDrafts: item.fileDrafts }
                : {}),
              ...(item.stickerInput
                ? {
                    stickerInput: validate(
                      StickerIdentitySchema,
                      item.stickerInput,
                    ),
                  }
                : {}),
              createdAt: item.createdAt,
              ...(Number.isSafeInteger(item.attempt) && item.attempt > 0
                ? { attempt: item.attempt }
                : {}),
              ...(Number.isSafeInteger(item.retryAfter) && item.retryAfter > 0
                ? { retryAfter: item.retryAfter }
                : {}),
              // Older local records used host admission as success; reconcile them again.
              state:
                item.dispatched === false
                  ? "failed"
                  : item.deliveryVersion === 2 && item.state === "failed" &&
                      Number.isSafeInteger(item.attempt) && item.attempt > 0
                    ? "failed"
                    : item.deliveryVersion === 2 && item.state === "sent"
                      ? "sent"
                      : "sending",
            });
        }
    } catch {
      this.error = "无法读取上次发送状态，请先检查聊天记录。";
    }
    const restored = this.parkedAttachments.get(key);
    if (restored) {
      this.parkedAttachments.delete(key);
      for (const [operationId, entry] of restored) {
        const existing = this.pending.findIndex(
          (p) => p.operationId === operationId,
        );
        if (existing >= 0 && this.pending[existing]!.dispatched !== false) {
          entry.retire?.();
          continue;
        }
        if (existing >= 0) this.pending[existing] = entry.pending;
        else this.pending.push(entry.pending);
        if (entry.images) this.originals.set(operationId, entry.images);
        if (entry.files) this.fileOriginals.set(operationId, entry.files);
        if (entry.retire) this.retirements.set(operationId, entry.retire);
      }
    }
  }
  private observe(view: ChatView) {
    this.hydrate(view.sessionId);
    const previous = this.view;
    const liveIds = new Set(view.messages.map((message) => message.id));
    const oldIds = new Set(previous?.messages.map((message) => message.id));
    const localPending = new Set(this.pending.map((item) => item.operationId));
    const eligible = (message: ChatMessage) =>
      !message.operationId ||
      (!localPending.has(message.operationId) &&
        !this.unconfirmedInputs.has(message.operationId));
    const oldWindow = previous?.messages.filter(eligible) ?? [];
    const newWindow = view.messages.filter(eligible);
    // A shared item alone can be a long-lived pending input. A contiguous old
    // suffix and new prefix gives the existing window a meaningful overlap.
    const overlapAt = oldWindow.findIndex(
      (message) => message.id === newWindow[0]?.id,
    );
    const overlap =
      overlapAt >= 0 &&
      oldWindow.length - overlapAt <= newWindow.length &&
      oldWindow
        .slice(overlapAt)
        .every((message, index) => message.id === newWindow[index]?.id);
    const sameWindow =
      previous !== undefined &&
      JSON.stringify(previous) === JSON.stringify(view);
    const previousTail =
      previous?.messages.findLast(
        (message) => !liveIds.has(message.id) && eligible(message),
      ) ??
      (previous?.sessionId === view.sessionId
        ? this.older.findLast(
            (message) => !liveIds.has(message.id) && eligible(message),
          )
        : undefined);
    const nextHead = view.messages.find(
      (message) => !oldIds.has(message.id) && eligible(message),
    );
    if (
      previous?.sessionId === view.sessionId &&
      previousTail &&
      nextHead &&
      !sameWindow &&
      !overlap
    ) {
      this.gaps.push({
        id: ++this.nextGapId,
        afterId: previousTail.id,
        beforeId: nextHead.id,
        cursor: view.before,
        visited: new Set(view.before ? [view.before] : []),
        status: view.before ? "pending" : "unavailable",
      });
    }
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
  retryHistory() {
    void this.loadOlder();
  }
  private noteHistory(messages: ChatMessage[]) {
    for (const message of messages) {
      this.historySources.add(message.id);
      if (message.operationId)
        this.unconfirmedInputs.delete(message.operationId);
    }
  }
  private retireObserved() {
    const observed = new Map(
      [...this.older, ...(this.view?.messages ?? [])]
        .filter((message) => message.role === "user")
        .map((message) => [message.operationId, message]),
    );
    this.pending = this.pending.filter((pending) => {
      const message = observed.get(pending.operationId);
      if (!message || pending.state !== "sent") return true;
      if (
        !this.localPreviews.some(
          (preview) =>
            preview.sessionId === this.view?.sessionId &&
            preview.operationId === pending.operationId,
        )
      ) {
        this.retirements.get(pending.operationId)?.();
        this.retirements.delete(pending.operationId);
      }
      this.originals.delete(pending.operationId);
      this.fileOriginals.delete(pending.operationId);
      if (!this.historySources.has(message.id))
        this.unconfirmedInputs.add(pending.operationId);
      return false;
    });
  }
  releasePreviews(sessionId: string, operationId: string): boolean {
    if (
      this.view?.sessionId !== sessionId ||
      this.pending.some((item) => item.operationId === operationId)
    )
      return false;
    const retained = this.localPreviews.filter(
      (item) =>
        item.sessionId === sessionId && item.operationId === operationId,
    );
    if (!retained.length) return false;
    this.localPreviews = this.localPreviews.filter(
      (item) =>
        item.sessionId !== sessionId || item.operationId !== operationId,
    );
    this.retirements.get(operationId)?.();
    this.retirements.delete(operationId);
    this.changed();
    return true;
  }
  recheckPending() {
    void this.reconcile().catch(() => {});
  }
  private async reconcile() {
    const client = this.client,
      sessionId = this.view?.sessionId;
    const sessionGeneration = this.sessionGeneration;
    if (!client || !sessionId) return;
    await Promise.all(
      this.pending.map(async (input) => {
        const id = input.operationId;
        if (
          input.state !== "sending" ||
          input.dispatched === false ||
          this.checks.has(id) ||
          this.inFlight.has(id)
        )
          return;
        const generation = this.generations.get(id) ?? 0;
        this.checks.add(id);
        try {
          const receipt = await client.lookup(id);
          if (
            receipt &&
            this.client === client &&
            this.sessionGeneration === sessionGeneration &&
            this.view?.sessionId === sessionId &&
            (this.generations.get(id) ?? 0) === generation
          )
            this.applyReceipt(receipt);
        } finally {
          if (this.sessionGeneration === sessionGeneration)
            this.checks.delete(id);
        }
      }),
    );
  }
  private submission(input: PendingSend): Submission {
    return {
      operationId: input.operationId,
      text: input.text,
      ...(input.images ? { images: input.images } : {}),
      ...(input.files ? { files: input.files } : {}),
    };
  }
  async retryFailed(id: string) {
    const input = this.pending.find((p) => p.operationId === id);
    const client = this.client,
      sessionId = this.view?.sessionId;
    if (
      !input ||
      input.state !== "failed" ||
      !client ||
      !sessionId ||
      this.inFlight.has(id)
    )
      return;
    if (
      input.dispatched === false &&
      (input.localFileCount || input.localImageCount || input.stickerInput)
    ) {
      const originals = this.originals.get(id);
      const files = this.fileOriginals.get(id);
      if (input.localFileCount && !files) {
        this.setError(new ChatCapacityError(FILE_RESELECT_ERROR,
          "原文件不可用，请删除这条消息后重新选择文件发送。"));
        this.changed();
        return;
      }
      if (input.localImageCount && !originals && !input.stickerInput) {
        this.error = "原图片不可用，请删除这条消息后重新选择图片发送。";
        this.changed();
        return;
      }
      try {
        await this.send(
          input.text,
          this.retirements.get(id),
          originals ?? [],
          input,
          input.stickerInput,
          files ?? [],
        );
      } catch (error) {
        this.setError(error);
        this.changed();
      }
      return;
    }
    const sessionGeneration = this.sessionGeneration;
    const generation = (this.generations.get(id) ?? 0) + 1;
    this.generations.set(id, generation);
    this.inFlight.add(id);
    this.pending = this.pending.map((p) =>
      p === input ? { ...p, state: "sending", dispatched: true, ...(p.attempt ? { retryAfter: p.attempt } : {}) } : p,
    );
    this.error = "";
    this.save();
    this.changed();
    try {
      const receipt = await client.submit(this.submission(input));
      if (
        this.sessionGeneration === sessionGeneration &&
        this.view?.sessionId === sessionId &&
        (this.generations.get(id) ?? 0) === generation &&
        !this.closed
      )
        this.applyReceipt(receipt);
    } catch {
      // The outcome is unknown; only a later explicit receipt can settle it.
    } finally {
      if (
        this.sessionGeneration === sessionGeneration &&
        (this.generations.get(id) ?? 0) === generation
      ) {
        this.inFlight.delete(id);
        if (!this.closed) this.changed();
        if (this.client) void this.reconcile().catch(() => {});
      }
    }
  }
  async deleteFailed(id: string) {
    const input = this.pending.find((p) => p.operationId === id);
    if (!input || input.state !== "failed") return;
    this.removePending(input);
  }
  canDiscardPending(id: string) {
    return this.pending.some((p) => p.operationId === id && p.state === "sending" && p.dispatched !== false) && !this.inFlight.has(id);
  }
  discardPending(id: string) {
    if (!this.canDiscardPending(id)) return;
    const input = this.pending.find((p) => p.operationId === id);
    if (input) this.removePending(input);
  }
  private removePending(input: PendingSend) {
    const id = input.operationId;
    this.generations.set(id, (this.generations.get(id) ?? 0) + 1);
    this.pending = this.pending.filter((p) => p !== input);
    this.retirements.get(id)?.();
    this.retirements.delete(id);
    this.originals.delete(id);
    this.fileOriginals.delete(id);
    this.attachmentPreparations.get(id)?.abort();
    this.localPreviews = this.localPreviews.filter(
      (item) =>
        item.operationId !== id || item.sessionId !== this.view?.sessionId,
    );
    this.save();
    this.changed();
  }
  private discardPreview() {
    if (!this.view?.streamingReply) return;
    const { streamingReply: _, ...completed } = this.view;
    this.view = completed;
  }
  private disconnected = (error?: ChatConnectionError) => {
    if (this.closed) return;
    const wasConnected = this.connected;
    this.connected = false;
    this.retryable = error?.retryable !== false;
    if (!this.retryable) {
      if (this.errorCode) this.error = "";
      this.releaseParkedAttachments();
      for (const preparation of this.attachmentPreparations.values())
        preparation.abort();
      for (const retire of this.retirements.values())
        retire();
      this.retirements.clear();
      this.originals.clear();
      this.fileOriginals.clear();
      this.localPreviews = [];
      this.pending = this.pending.map((p) => ({
        ...p,
        previews: undefined,
        // An empty reference array must not suppress the missing-image state.
        ...(p.localImageCount && !p.images?.length
          ? { images: undefined }
          : {}),
        ...(p.dispatched === false && (p.localImageCount || p.localFileCount)
          ? { state: "failed" as const }
          : {}),
      }));
    }
    if (!this.view) this.error = "连接未能建立，请重试。";
    this.discardPreview();
    if (this.storageKey) this.save();
    if (this.compactPending) {
      this.compactGeneration++;
      this.compactPending = false;
      this.error = "对话整理结果尚未确认，请等待连接恢复后检查。";
    }
    this.relationshipGeneration++;
    this.closeStickers();
    this.client = undefined;
    this.historyEpoch++;
    this.gaps = this.gaps.map((gap) =>
      gap.status === "loading" ? { ...gap, status: "pending" } : gap,
    );
    this.historyLoadingToken = undefined;
    this.loadingOlder = false;
    this.changed();
    clearTimeout(this.timer);
    if (wasConnected && this.retryable && this.visible) void this.connect();
  };
  private async connect() {
    if (this.closed || this.connecting || this.connected || !this.visible)
      return;
    clearTimeout(this.timer);
    this.connecting = true;
    const generation = ++this.connectionGeneration;
    try {
      const url = new URL(CHAT_PATH, location.href);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(url);
      this.socket = socket;
      let initialView = false;
      const earlyReceipts: Receipt[] = [];
      const client = await openChat(
        socket,
        (view) => {
          if (!this.closed && generation === this.connectionGeneration) {
            this.observe(view);
            initialView = true;
            for (const receipt of earlyReceipts.splice(0)) this.applyReceipt(receipt);
          }
        },
        (error) => {
          if (generation === this.connectionGeneration)
            this.disconnected(error);
        },
        (receipt) => {
          if (this.closed || generation !== this.connectionGeneration) return;
          if (initialView) this.applyReceipt(receipt);
          else if (earlyReceipts.length < 100) earlyReceipts.push(receipt);
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
      this.retryFailures = 0;
      this.connecting = false;
      this.panelRevision++;
      void this.refreshRelationship();
      if (!this.error.includes("整理结果尚未确认")) this.error = "";
      this.changed();
      await this.reconcile().catch(() => {});
    } catch (error) {
      if (generation === this.connectionGeneration && !this.closed)
        this.disconnected(
          error instanceof ChatConnectionError ? error : undefined,
        );
    } finally {
      if (generation === this.connectionGeneration) {
        this.connecting = false;
        if (!this.connected) this.scheduleReconnect();
      }
    }
  }
  private applyReceipt(receipt: Receipt) {
    const pending = this.pending.find(
      (p) => p.operationId === receipt.operationId,
    );
    if (!pending || pending.state === "sent") return;
    if ((pending.attempt && receipt.attempt < pending.attempt) ||
        (pending.retryAfter && receipt.attempt <= pending.retryAfter)) return;
    // A definitive result settles this attempt even if its original RPC reply
    // is delayed; a retry gets a new local generation before dispatch.
    this.inFlight.delete(receipt.operationId);
    this.pending = this.pending.map((p) =>
      p === pending
        ? { ...p, attempt: receipt.attempt, retryAfter: undefined, state: receipt.state === "submitted" ? "sent" : "failed" }
        : p,
    );
    if (receipt.state === "failed")
      this.error = receipt.error || "发送失败，请重试或删除这条消息。";
    this.retireObserved();
    this.save();
    this.changed();
  }
  async compact() {
    const client = this.client,
      sessionId = this.view?.sessionId;
    if (!client || !sessionId) {
      this.recover();
      throw new Error("连接已断开");
    }
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
    previous?: PendingSend,
    stickerInput?: StickerIdentity,
    files: readonly ChatFileDraft[] = [],
  ) {
    if (text === "/compact") {
      if (images.length || files.length)
        throw new Error("compact-with-attachments");
      await this.compact();
      retired?.();
      return;
    }
    if (this.compactPending || this.view?.compaction?.status === "running")
      throw new Error("请等待对话整理完成。");
    const client = this.client,
      sessionId = this.view?.sessionId;
    if (!client || !sessionId) {
      this.recover();
      throw new Error("连接已断开");
    }
    if (this.pending.length >= 20 && !previous) {
      if (images.length || files.length)
        throw new ChatCapacityError(
          PENDING_MESSAGE_CAPACITY_ERROR,
          "当前会话的待确认消息已达上限，请先处理这些消息后再重试。",
        );
      throw new Error("请先核对尚未确认的消息");
    }
    const replacingRetained =
      previous &&
      !this.attachmentPreparations.has(previous.operationId) &&
      (this.originals.has(previous.operationId) ||
        this.fileOriginals.has(previous.operationId));
    if (
      (images.length || files.length) &&
      this.retainedAttachmentCount() - (replacingRetained ? 1 : 0) >=
        MAX_RETAINED_ATTACHMENT_OPERATIONS
    )
      throw new ChatCapacityError(
        ATTACHMENT_CAPACITY_ERROR,
        ATTACHMENT_CAPACITY_MESSAGE,
      );
    const operationId = previous?.dispatched === false && files.length
      ? crypto.randomUUID()
      : previous?.operationId ?? crypto.randomUUID();
    const sendGeneration = (this.generations.get(operationId) ?? 0) + 1;
    this.generations.set(operationId, sendGeneration);
    const stickerGeneration = this.stickerGeneration;
    const sessionGeneration = this.sessionGeneration;
    const current = () =>
      this.sessionGeneration === sessionGeneration &&
      this.client === client &&
      this.view?.sessionId === sessionId &&
      !this.closed;
    const pending: PendingSend = {
      operationId,
      logicalId: previous?.logicalId ?? previous?.operationId ?? operationId,
      dispatched: false,
      localImageCount: stickerInput ? 1 : images.length,
      localFileCount: files.length,
      ...(files.length
        ? {
            fileDrafts: files.map(({ id, file }) => ({
              id,
              name: file.name,
              size: file.size,
            })),
          }
        : {}),
      ...(stickerInput ? { stickerInput } : {}),
      text,
      createdAt: Date.now(),
      state: "sending",
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
      this.fileOriginals.delete(previous.operationId);
      this.retirements.delete(previous.operationId);
      this.localPreviews = this.localPreviews.filter(
        (item) =>
          item.sessionId !== sessionId ||
          item.operationId !== previous.operationId,
      );
    }
    const preparation =
      images.length || files.length ? new AbortController() : undefined;
    if (preparation) this.attachmentPreparations.set(operationId, preparation);
    if (images.length) this.originals.set(operationId, images);
    if (files.length) this.fileOriginals.set(operationId, files);
    if (retired) this.retirements.set(operationId, retired);
    this.inFlight.add(operationId);
    this.error = "";
    this.save();
    this.changed();
    let submitted = false;
    const sameSession = () =>
      this.sessionGeneration === sessionGeneration &&
      this.view?.sessionId === sessionId &&
      (this.generations.get(operationId) ?? 0) === sendGeneration &&
      !this.closed &&
      (submitted ||
        !stickerInput ||
        (this.client === client &&
          this.stickerGeneration === stickerGeneration));
    try {
      let refs: Submission["images"];
      if (stickerInput) {
        const stageCurrent = () =>
          current() && this.stickerGeneration === stickerGeneration;
        const stickers = new StickerClient(sessionId, stageCurrent);
        stickers.onAuthorizationLost((status) => {
          if (!stageCurrent()) return;
          for (const picker of [...this.stickerClients]) {
            if (!stageCurrent()) break;
            picker.revokeAuthorization(status);
          }
        });
        try {
          refs = [
            await stickers.stage({
              sessionId,
              operationId,
              sticker: stickerInput,
            }),
          ];
        } finally {
          stickers.close();
        }
      } else if (images.length) {
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
          signal: preparation?.signal,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(upload),
        });
        if (!response.ok) throw new Error("图片上传失败，请重试。");
        const result = validateUploadResult(await response.json(), upload);
        if (!current()) throw new Error("连接已改变，请重新发送");
        this.localPreviews = [
          ...this.localPreviews,
          ...result.images.map((item, order) => ({
            sessionId,
            operationId,
            draftId: item.id,
            order,
            attachmentId: item.ref.attachmentId,
            previewUrl: images[order]!.previewUrl,
          })),
        ];
        refs = result.images.map((item) => item.ref);
      }
      let fileRefs: Submission["files"];
      if (files.length) {
        const limits = this.view!.capabilities.files;
        if (!limits) throw new Error("文件暂不可用");
        const result = await streamFileUploads(
          sessionId,
          operationId,
          files,
          limits,
          current,
          preparation?.signal,
        ).catch((error: unknown) => {
          if (!current()) throw error;
          throw new Error("文件上传失败，请重试。");
        });
        if (!current()) throw new Error("连接已改变，请重新发送");
        fileRefs = result.files.map((item) => item.ref);
      }
      if (!current()) throw new Error("连接已改变，请重新发送");
      const input = validateSubmission({
        operationId,
        text,
        ...(refs ? { images: refs } : {}),
        ...(fileRefs ? { files: fileRefs } : {}),
      });
      this.pending = this.pending.map((p) =>
        p.operationId === operationId
          ? { ...p, ...input, dispatched: true }
          : p,
      );
      this.save();
      this.changed();
      submitted = true;
      this.attachmentPreparations.delete(operationId);
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
          this.save();
          this.changed();
        }
      } else if (sameSession()) {
        // A transport error cannot undo durable admission or native observation.
        this.save();
        this.changed();
      }
    } finally {
      if (this.attachmentPreparations.get(operationId) === preparation)
        this.attachmentPreparations.delete(operationId);
      if ((this.generations.get(operationId) ?? 0) === sendGeneration) {
        this.inFlight.delete(operationId);
        if (!this.closed) this.changed();
      }
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
    if (!this.client) this.recover();
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
    const epoch = this.historyEpoch;
    if (!this.client || !this.before || this.loadingOlder) return;
    const client = this.client,
      sessionId = this.view?.sessionId,
      token = Symbol();
    this.historyLoadingToken = token;
    this.loadingOlder = true;
    this.changed();
    try {
      const page = await client.history(this.before);
      if (
        this.client !== client ||
        this.view?.sessionId !== sessionId ||
        this.historyEpoch !== epoch ||
        this.closed
      )
        return;
      const liveIds = new Set(this.view?.messages.map((message) => message.id));
      this.older = [
        ...new Map(
          [...page.messages, ...this.older]
            .filter((message) => !liveIds.has(message.id))
            .map((message) => [message.id, message]),
        ).values(),
      ];
      this.noteHistory(page.messages);
      this.retireObserved();
      this.save();
      this.before = page.before;
      this.historySyncFailed = false;
      if (this.error === "加载历史失败，请重试。") this.error = "";
    } catch {
      if (
        !this.closed &&
        this.historyEpoch === epoch &&
        this.client === client
      ) {
        this.historySyncFailed = true;
        this.error = "加载历史失败，请重试。";
      }
    } finally {
      if (this.historyLoadingToken === token) {
        this.historyLoadingToken = undefined;
        this.loadingOlder = false;
        this.changed();
      }
    }
  }
  /** Read at most one page for this gap; never schedules another read. */
  async fillGap(id: number) {
    const gap = this.gaps.find((item) => item.id === id);
    if (
      !gap ||
      gap.status === "loading" ||
      gap.status === "unavailable" ||
      !gap.cursor ||
      !this.client ||
      this.closed
    )
      return;
    // Match the host's bounded concurrent history limit; expose overload for retry.
    if (this.gaps.filter((item) => item.status === "loading").length >= 8) {
      this.gaps = this.gaps.map((item) =>
        item.id === id ? { ...item, status: "error" } : item,
      );
      this.changed();
      return;
    }
    const client = this.client,
      epoch = this.historyEpoch,
      session = this.view?.sessionId;
    const cursor = gap.cursor;
    const update = (patch: Partial<GapState>) => {
      this.gaps = this.gaps.map((item) =>
        item.id === id ? { ...item, ...patch } : item,
      );
      this.changed();
    };
    update({ status: "loading" });
    try {
      const page = await client.history(cursor);
      if (
        this.closed ||
        this.client !== client ||
        this.historyEpoch !== epoch ||
        this.view?.sessionId !== session ||
        !this.gaps.some(
          (item) =>
            item.id === id &&
            item.cursor === cursor &&
            item.status === "loading",
        )
      )
        return;
      const anchor = this.older.findIndex((item) => item.id === gap.afterId);
      if (anchor < 0) {
        update({ status: "error" });
        return;
      }
      const boundary = page.messages.findIndex(
        (item) => item.id === gap.afterId,
      );
      if (
        new Set(page.messages.map((item) => item.id)).size !==
        page.messages.length
      ) {
        update({ status: "error" });
        return;
      }
      const known = new Map(
        [...this.older, ...(this.view?.messages ?? [])].map((item, index) => [
          item.id,
          index,
        ]),
      );
      const candidates =
        boundary < 0 ? page.messages : page.messages.slice(boundary + 1);
      const fresh: ChatMessage[] = [];
      let overlap = false,
        lastKnown = anchor;
      for (const item of candidates) {
        const position = known.get(item.id);
        if (position === undefined) {
          if (overlap) {
            update({ status: "error" });
            return;
          }
          fresh.push(item);
        } else {
          if (position <= lastKnown) {
            update({ status: "error" });
            return;
          }
          overlap = true;
          lastKnown = position;
        }
      }
      if (boundary < 0 && (!page.before || gap.visited.has(page.before))) {
        update({ status: "unavailable" });
        return;
      }
      this.older = [
        ...this.older.slice(0, anchor + 1),
        ...fresh,
        ...this.older.slice(anchor + 1),
      ];
      this.noteHistory(page.messages);
      if (boundary >= 0) this.gaps = this.gaps.filter((item) => item.id !== id);
      else
        this.gaps = this.gaps.map((item) =>
          item.id === id
            ? {
                ...item,
                beforeId: fresh[0]?.id ?? item.beforeId,
                cursor: page.before,
                visited: new Set([...item.visited, page.before!]),
                status: "pending",
              }
            : item,
        );
      this.retireObserved();
      this.save();
      this.changed();
    } catch {
      if (
        !this.closed &&
        this.client === client &&
        this.historyEpoch === epoch &&
        this.view?.sessionId === session &&
        this.gaps.some((item) => item.id === id && item.status === "loading")
      )
        update({ status: "error" });
    }
  }
}
