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
  validateRetryImageMapping,
  validateRetryFileMapping,
  StickerIdentitySchema,
  type StickerIdentity,
  type InputRecovery,
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
import type { PendingSubmissionRetirement } from "./companion/client/contracts.ts";
export type PendingSend = Submission & {
  previews?: readonly { id: string; name: string; previewUrl: string }[];
  logicalId?: string;
  retrySource?: string;
  dispatched?: boolean;
  localImageCount?: number;
  localFileCount?: number;
  fileDrafts?: readonly { id: string; name: string; size: number }[];
  stickerInput?: StickerIdentity;
  createdAt: number;
  state: "sending" | "sent" | "failed";
};
// Files and previews remain page-owned; reserve a bounded number of operations
// across sessions rather than silently evicting retryable input.
const MAX_RETAINED_ATTACHMENT_OPERATIONS = 20;
export const ATTACHMENT_CAPACITY_ERROR = "attachment-capacity";
export const PENDING_MESSAGE_CAPACITY_ERROR = "pending-message-capacity";
const ATTACHMENT_CAPACITY_MESSAGE =
  "附件准备尚未结束，或待确认附件过多；请稍候，或处理其他会话中的待确认消息后重试。";
type ChatCapacityCode =
  | typeof ATTACHMENT_CAPACITY_ERROR
  | typeof PENDING_MESSAGE_CAPACITY_ERROR;
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
  retire?: (result: PendingSubmissionRetirement) => void;
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
  recovery: InputRecovery[] = [];
  private dismissed = new Set<string>();
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
    return this.gaps.map(({ cursor: _cursor, visited: _visited, ...gap }) => gap);
  }
  historySyncFailed = false;
  private storageKey = "";
  private sessionGeneration = 0;
  private deadlineTimer?: ReturnType<typeof setTimeout>;
  private checks = new Set<string>();
  private finalized = new Set<string>();
  private fileRetryCheckAfter = new Map<string, number>();
  private verifiedFileRetries = new Map<
    string,
    { files: NonNullable<Submission["files"]>; images?: Submission["images"] }
  >();
  private parkedAttachments = new Map<string, Map<string, ParkedAttachment>>();
  private attachmentPreparations = new Map<string, AbortController>();
  private fileOriginals = new Map<string, readonly ChatFileDraft[]>();
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
        return { ...pending, state: "failed" };
      }
      return pending;
    });
    if (interrupted) {
      this.updateRecovery();
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
        entry.retire?.({ reason: "observed" });
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
      retire({ reason: "observed" });
    this.retirements.clear();
    this.localPreviews = [];
    this.originals.clear();
    this.fileOriginals.clear();
    this.verifiedFileRetries.clear();
    this.fileRetryCheckAfter.clear();
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
      retire({ reason: "observed" });
    this.retirements.clear();
    this.localPreviews = [];
    this.inFlight.clear();
    this.failedActions.clear();
    this.checks.clear();
    this.finalized.clear();
    this.originals.clear();
    this.fileOriginals.clear();
    this.verifiedFileRetries.clear();
    this.fileRetryCheckAfter.clear();
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
            (item.replacementSourceIds !== undefined &&
              (!Array.isArray(item.replacementSourceIds) ||
                item.replacementSourceIds.length > 20 ||
                item.replacementSourceIds.some(
                  (id: unknown) =>
                    typeof id !== "string" || !id.length || id.length > 300,
                ) ||
                new Set(item.replacementSourceIds).size !==
                  item.replacementSourceIds.length)) ||
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
                  ...(item.replacementSourceIds
                    ? { replacementSourceIds: item.replacementSourceIds }
                    : {}),
                }
              : validateSubmission({
                  operationId: item.operationId,
                  text: item.text,
                  ...(item.images ? { images: item.images } : {}),
                  ...(item.files ? { files: item.files } : {}),
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
              // One-time local draft normalization; unknown transport outcomes remain pending.
              state:
                item.state === "failed" ||
                ((item.localFileCount || item.localImageCount) &&
                  item.dispatched === false &&
                  !item.stickerInput) ||
                (item.stickerInput && item.dispatched === false) ||
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
    const restored = this.parkedAttachments.get(key);
    if (restored) {
      this.parkedAttachments.delete(key);
      for (const [operationId, entry] of restored) {
        const existing = this.pending.findIndex(
          (p) => p.operationId === operationId,
        );
        if (existing >= 0 && this.pending[existing]!.dispatched !== false) {
          entry.retire?.({ reason: "observed" });
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
      (!localPending.has(message.operationId) && !this.unconfirmedInputs.has(message.operationId));
    const oldWindow = previous?.messages.filter(eligible) ?? [];
    const newWindow = view.messages.filter(eligible);
    // A shared item alone can be a long-lived pending input. A contiguous old
    // suffix and new prefix gives the existing window a meaningful overlap.
    const overlapAt = oldWindow.findIndex((message) => message.id === newWindow[0]?.id);
    const overlap = overlapAt >= 0 && oldWindow.length - overlapAt <= newWindow.length &&
      oldWindow.slice(overlapAt).every((message, index) => message.id === newWindow[index]?.id);
    const sameWindow = previous !== undefined &&
      JSON.stringify(previous) === JSON.stringify(view);
    const previousTail = previous?.messages.findLast((message) => !liveIds.has(message.id) && eligible(message)) ??
      (previous?.sessionId === view.sessionId
        ? this.older.findLast((message) => !liveIds.has(message.id) && eligible(message))
        : undefined);
    const nextHead = view.messages.find((message) => !oldIds.has(message.id) && eligible(message));
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
  retryHistory() {
    void this.loadOlder();
  }
  private noteHistory(messages: ChatMessage[]) {
    for (const message of messages) {
      this.historySources.add(message.id);
      if (message.operationId) this.unconfirmedInputs.delete(message.operationId);
    }
  }
  private retireObserved() {
    const observed = new Map(
      [...this.older, ...(this.view?.messages ?? [])]
        .filter((m) => m.role === "user")
        .map((m) => [m.operationId, m]),
    );
    this.pending = this.pending.filter((p) => {
      const message = observed.get(p.operationId);
      if (!message) return true;
      if (p.retrySource && p.files?.length) {
        const verified = this.verifiedFileRetries.get(p.operationId);
        const filesMatch =
          verified &&
          message.files?.length === verified.files.length &&
          verified.files.every((ref, index) => {
            const actual = message.files?.[index];
            return (
              actual?.attachmentId === ref.attachmentId &&
              actual.name === ref.name &&
              actual.mediaType === ref.mediaType &&
              actual.size === ref.size
            );
          });
        const imagesMatch =
          !verified?.images ||
          (message.images?.length === verified.images.length &&
            verified.images.every((ref, index) => {
              const actual = message.images?.[index];
              return (
                actual?.attachmentId === ref.attachmentId &&
                actual.name === ref.name &&
                actual.mediaType === ref.mediaType &&
                actual.sticker?.id === ref.sticker?.id &&
                actual.sticker?.version === ref.sticker?.version
              );
            }));
        if (!verified || !filesMatch || !imagesMatch) return true;
        if (verified.images && p.images) {
          const refs = new Map(
            p.images.map((image, index) => [
              image.attachmentId,
              verified.images![index]!,
            ]),
          );
          this.localPreviews = this.localPreviews.map((item) =>
            item.sessionId === this.view?.sessionId &&
            item.operationId === p.retrySource
              ? {
                  ...item,
                  operationId: p.operationId,
                  attachmentId: refs.get(item.attachmentId)!.attachmentId,
                }
              : item,
          );
        }
        this.verifiedFileRetries.delete(p.operationId);
      }
      if (
        p.retrySource &&
        this.localPreviews.some(
          (preview) =>
            preview.operationId === p.retrySource &&
            preview.sessionId === this.view?.sessionId,
        )
      )
        return true;
      if (
        !this.localPreviews.some(
          (preview) =>
            preview.sessionId === this.view?.sessionId &&
            preview.operationId === p.operationId,
        )
      ) {
        this.retirements.get(p.operationId)?.({ reason: "observed" });
        this.retirements.delete(p.operationId);
      }
      this.originals.delete(p.operationId);
      this.fileOriginals.delete(p.operationId);
      this.verifiedFileRetries.delete(p.operationId);
      this.fileRetryCheckAfter.delete(p.operationId);
      if (!this.historySources.has(message.id))
        this.unconfirmedInputs.add(p.operationId);
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
    this.retirements.get(operationId)?.({ reason: "observed" });
    this.retirements.delete(operationId);
    this.changed();
    return true;
  }
  recheckPending() {
    this.fileRetryCheckAfter.clear();
    for (const id of this.finalized)
      if (!this.checks.has(id)) this.finalized.delete(id);
    void this.reconcile().catch(() => {});
  }
  private scheduleDeadline() {
    clearTimeout(this.deadlineTimer);
    if (!this.connected || this.closed) return;
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
          Math.min(
            ...deadlines.map((p) =>
              Math.max(
                p.createdAt + 60000,
                this.fileRetryCheckAfter.get(p.operationId) ?? 0,
              ),
            ),
          ) - Date.now(),
        ),
      );
  }
  private async reconcile() {
    const client = this.client,
      key = this.storageKey,
      sessionId = this.view?.sessionId,
      sessionGeneration = this.sessionGeneration;
    if (!client || !sessionId) return;
    await Promise.all(
      this.pending.map(async (input) => {
        if (
          input.state !== "sending" ||
          input.dispatched === false ||
          this.checks.has(input.operationId) ||
          (this.fileRetryCheckAfter.get(input.operationId) ?? 0) > Date.now()
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
          if (
            this.client === client &&
            this.storageKey === key &&
            this.sessionGeneration === sessionGeneration &&
            receipt
          )
            this.applyReceipt(receipt);
        } finally {
          if (this.sessionGeneration === sessionGeneration) {
            this.checks.delete(input.operationId);
            // A missing or invalid file mapping must remain inspectable after
            // the usual finalization fence, without replaying the retry.
            if (
              expired &&
              input.retrySource &&
              input.files?.length &&
              this.pending.some(
                (p) =>
                  p.operationId === input.operationId && p.state === "sending",
              ) &&
              !this.verifiedFileRetries.has(input.operationId)
            ) {
              this.finalized.delete(input.operationId);
              this.fileRetryCheckAfter.set(
                input.operationId,
                Date.now() + 5000,
              );
            }
            this.scheduleDeadline();
          }
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
      ...(input.files ? { files: input.files } : {}),
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
    const sessionGeneration = this.sessionGeneration;
    const originals = this.originals.get(input.operationId);
    const fileOriginals = this.fileOriginals.get(input.operationId);
    if (input.dispatched === false) {
      if (input.localImageCount && !originals && !input.stickerInput) {
        this.error = "原图片不可用，请删除这条消息后重新选择图片发送。";
        this.changed();
        return;
      }
      if (input.localFileCount && !fileOriginals) {
        this.error = "原文件不可用，请删除这条消息后重新选择文件发送。";
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
          input.stickerInput,
          fileOriginals ?? [],
        );
      } catch (error) {
        if (error instanceof ChatCapacityError) this.setError(error);
        else this.error = "重试失败，请检查连接和原图片后再试。";
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
    this.fileOriginals.delete(input.operationId);
    if (fileOriginals)
      this.fileOriginals.set(pending.operationId, fileOriginals);
    this.inFlight.add(pending.operationId);
    this.error = "";
    this.save();
    this.changed();
    this.scheduleDeadline();
    try {
      const receipt = await client.retryFailed(retry);
      if (
        this.sessionGeneration === sessionGeneration &&
        this.view?.sessionId === sessionId &&
        !this.closed
      )
        this.applyReceipt(receipt);
    } catch {
      if (
        this.sessionGeneration === sessionGeneration &&
        this.view?.sessionId === sessionId
      ) {
        this.error = "重试结果尚未确认，连接恢复后会继续核对。";
        this.changed();
      }
    } finally {
      if (this.sessionGeneration === sessionGeneration)
        this.inFlight.delete(pending.operationId);
      if (
        this.client &&
        this.sessionGeneration === sessionGeneration &&
        this.view?.sessionId === sessionId &&
        this.pending.some(
          (p) => p.operationId === pending.operationId && p.state === "sending",
        )
      )
        void this.reconcile().catch(() => {});
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
      this.fileOriginals.delete(input.operationId);
      this.attachmentPreparations.get(input.operationId)?.abort();
      this.verifiedFileRetries.delete(input.operationId);
      this.fileRetryCheckAfter.delete(input.operationId);
      this.localPreviews = this.localPreviews.filter(
        (item) =>
          item.sessionId !== sessionId ||
          item.operationId !== input.operationId,
      );
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
        retire({ reason: "observed" });
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
    clearTimeout(this.deadlineTimer);
    this.discardPreview();
    this.updateRecovery();
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
      const client = await openChat(
        socket,
        (view) => {
          if (!this.closed && generation === this.connectionGeneration)
            this.observe(view);
        },
        (error) => {
          if (generation === this.connectionGeneration)
            this.disconnected(error);
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
      this.finalized.clear();
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
    if (!pending) return; // Native observation or a session change already retired it.
    // A confirmed result cannot be revoked or remapped by a later receipt.
    if (
      pending.state === "sent" ||
      (pending.state === "failed" && receipt.state === "failed")
    )
      return;
    let retryImages: Submission["images"];
    if (pending.retrySource && pending.images?.length && this.view?.sessionId) {
      const sourcePreviews = this.localPreviews.filter(
        (item) =>
          item.sessionId === this.view!.sessionId &&
          item.operationId === pending.retrySource,
      );
      try {
        const mapping = validateRetryImageMapping(
          receipt.retryImages,
          this.view.sessionId,
          pending.retrySource,
          pending.images ?? [],
        );
        const refs = new Map(
          mapping.images.map((item) => [item.sourceAttachmentId, item.ref]),
        );
        if (
          sourcePreviews.length &&
          (sourcePreviews.length !== refs.size ||
            sourcePreviews.some((item) => !refs.has(item.attachmentId)))
        )
          throw new Error("Unmatched local preview");
        retryImages = pending.images.map((image) =>
          refs.get(image.attachmentId)!,
        );
      } catch {
        this.error = "重试图片关联尚未确认，请等待连接恢复后检查。";
        this.changed();
        return;
      }
    }
    let retryFiles: Submission["files"];
    if (pending.retrySource && pending.files?.length && this.view?.sessionId) {
      try {
        const mapping = validateRetryFileMapping(
          receipt.retryFiles,
          this.view.sessionId,
          pending.retrySource,
          pending.files,
        );
        const refs = new Map(
          mapping.files.map((item) => [item.sourceAttachmentId, item.ref]),
        );
        retryFiles = pending.files.map((file) => refs.get(file.attachmentId)!);
      } catch {
        this.error = "重试文件关联尚未确认，请等待连接恢复后检查。";
        this.changed();
        return;
      }
    }
    if (retryFiles && receipt.state === "submitted") {
      this.verifiedFileRetries.set(pending.operationId, {
        files: retryFiles,
        ...(retryImages ? { images: retryImages } : {}),
      });
      this.retireObserved();
      this.updateRecovery();
      this.save();
      this.changed();
      return;
    }
    if (
      retryFiles &&
      receipt.state === "failed" &&
      this.verifiedFileRetries.has(pending.operationId)
    )
      return;
    if (
      retryFiles &&
      receipt.state === "failed" &&
      [...this.older, ...(this.view?.messages ?? [])].some(
        (message) =>
          message.role === "user" &&
          message.operationId === pending.operationId,
      )
    ) {
      this.error = "重试结果与聊天记录不一致，请等待连接恢复后检查。";
      this.changed();
      return;
    }
    if (retryImages && pending.images) {
      const refs = new Map(
        pending.images.map((image, index) => [
          image.attachmentId,
          retryImages![index]!,
        ]),
      );
      this.localPreviews = this.localPreviews.map((item) =>
        item.sessionId === this.view!.sessionId &&
        item.operationId === pending.retrySource
          ? {
              ...item,
              operationId: pending.operationId,
              attachmentId: refs.get(item.attachmentId)!.attachmentId,
            }
          : item,
      );
    }
    this.pending = this.pending.map((p) =>
      p === pending
        ? {
            ...p,
            ...(retryImages ? { images: retryImages } : {}),
            ...(retryFiles ? { files: retryFiles } : {}),
            state: receipt.state === "submitted" ? "sent" : "failed",
          }
        : p,
    );
    if (receipt.state === "failed")
      this.error = receipt.error || "发送失败，请重试或删除这条消息。";
    this.updateRecovery();
    this.retireObserved();
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
      this.originals.delete(sourceId);
      this.fileOriginals.delete(sourceId);
      this.attachmentPreparations.get(sourceId)?.abort();
      this.localPreviews = this.localPreviews.filter(
        (item) =>
          item.sessionId !== this.view?.sessionId ||
          item.operationId !== sourceId,
      );
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
    retired?: (result: PendingSubmissionRetirement) => void,
    images: readonly CompanionImageDraft[] = [],
    replacementSourceIds: readonly string[] = [],
    previous?: PendingSend,
    stickerInput?: StickerIdentity,
    files: readonly ChatFileDraft[] = [],
  ) {
    if (text === "/compact") {
      if (images.length || files.length)
        throw new Error("compact-with-attachments");
      await this.compact();
      retired?.({ reason: "observed" });
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
    const operationId = crypto.randomUUID();
    const stickerGeneration = this.stickerGeneration;
    const sessionGeneration = this.sessionGeneration;
    const current = () =>
      this.sessionGeneration === sessionGeneration &&
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
    this.updateRecovery();
    this.save();
    this.changed();
    let submitted = false;
    const sameSession = () =>
      this.sessionGeneration === sessionGeneration &&
      this.view?.sessionId === sessionId &&
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
      checkReplacement();
      const input = validateSubmission({
        operationId,
        text,
        ...(refs ? { images: refs } : {}),
        ...(fileRefs ? { files: fileRefs } : {}),
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
      this.attachmentPreparations.delete(operationId);
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
      this.attachmentPreparations.delete(operationId);
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
      const liveIds = new Set(this.view?.messages.map(message => message.id));
      this.older = [
        ...new Map(
          [...page.messages, ...this.older]
            .filter(message => !liveIds.has(message.id))
            .map(message => [message.id, message]),
        ).values(),
      ];
      this.noteHistory(page.messages);
      this.retireObserved();
      this.save();
      this.updateRecovery();
      this.before = page.before;
      this.historySyncFailed = false;
      if (this.error === "加载历史失败，请重试。") this.error = "";
    } catch {
      if (!this.closed && this.historyEpoch === epoch && this.client === client) {
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
      !gap || gap.status === "loading" || gap.status === "unavailable" ||
      !gap.cursor || !this.client || this.closed
    ) return;
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
      this.gaps = this.gaps.map((item) => item.id === id ? { ...item, ...patch } : item);
      this.changed();
    };
    update({ status: "loading" });
    try {
      const page = await client.history(cursor);
      if (
        this.closed || this.client !== client || this.historyEpoch !== epoch ||
        this.view?.sessionId !== session ||
        !this.gaps.some((item) => item.id === id && item.cursor === cursor && item.status === "loading")
      ) return;
      const anchor = this.older.findIndex((item) => item.id === gap.afterId);
      if (anchor < 0) { update({ status: "error" }); return; }
      const boundary = page.messages.findIndex((item) => item.id === gap.afterId);
      if (new Set(page.messages.map((item) => item.id)).size !== page.messages.length) {
        update({ status: "error" });
        return;
      }
      const known = new Map(
        [...this.older, ...(this.view?.messages ?? [])].map((item, index) => [item.id, index]),
      );
      const candidates = boundary < 0 ? page.messages : page.messages.slice(boundary + 1);
      const fresh: ChatMessage[] = [];
      let overlap = false,
        lastKnown = anchor;
      for (const item of candidates) {
        const position = known.get(item.id);
        if (position === undefined) {
          if (overlap) { update({ status: "error" }); return; }
          fresh.push(item);
        } else {
          if (position <= lastKnown) { update({ status: "error" }); return; }
          overlap = true;
          lastKnown = position;
        }
      }
      if (boundary < 0 && (!page.before || gap.visited.has(page.before))) {
        update({ status: "unavailable" });
        return;
      }
      this.older = [...this.older.slice(0, anchor + 1), ...fresh, ...this.older.slice(anchor + 1)];
      this.noteHistory(page.messages);
      if (boundary >= 0) this.gaps = this.gaps.filter((item) => item.id !== id);
      else this.gaps = this.gaps.map((item) => item.id === id
        ? {
            ...item,
            beforeId: fresh[0]?.id ?? item.beforeId,
            cursor: page.before,
            visited: new Set([...item.visited, page.before!]),
            status: "pending",
          }
        : item);
      this.retireObserved();
      this.updateRecovery();
      this.save();
      this.changed();
    } catch {
      if (!this.closed && this.client === client && this.historyEpoch === epoch &&
        this.view?.sessionId === session && this.gaps.some((item) => item.id === id && item.status === "loading"))
        update({ status: "error" });
    }
  }
}
