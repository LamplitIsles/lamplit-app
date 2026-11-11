import { searchFixture } from "./search-fixture.ts";
import {
  capabilities,
  mediaUrl,
  type ChatMessage,
  type ChatView,
  type ImageUpload,
  type ImageRef,
  type ImageLimits,
  type StickerIdentity,
  type Receipt,
  type Submission,
} from "../packages/contracts/src/index.ts";
import type {
  ChatBackend,
  ChatChange,
  ImageBackend,
} from "../packages/contracts/src/server.ts";
import { panelsFixture, fixtureImage } from "./panels-fixture.ts";
export const imageLimits: ImageLimits = {
  mediaTypes: ["image/png", "image/jpeg", "image/webp", "image/gif"],
  maxImagesPerMessage: 6,
  maxImageBytes: 8_000_000,
  maxMessageImageBytes: 24_000_000,
};
export function imagesFixture() {
  const listeners = new Set<(change: ChatChange) => void>();
  const scope = Symbol("image fixture session");
  const panels = panelsFixture();
  const uploads = new Map<string, { input: ImageUpload; refs: ImageRef[] }>();
  const media = new Map<string, ImageUpload["images"][number]>();
  const submissions = new Map<string, Submission>();
  const receipts = new Map<string, Receipt>();
  const attempts = new Map<string, number>();
  const fingerprints = new Map<string, string>();
  const queued = new Set<string>();
  const messages: ChatMessage[] = [];
  let active: string | null = null,
    executions = 0,
    mode = "submitted",
    disabled = false,
    failUpload = false;
  const changed = () => {
    for (const fn of listeners) fn({ type: "update", scope,
      window: { messages: messages.slice(-15), before: messages.length > 15 ? messages.at(-15)!.id : null },
      state: { activeTurnId: active, capabilities: { ...capabilities, images: disabled ? false : imageLimits } } });
  };
  const deliveryResult = (receipt: Receipt) => {
    for (const fn of listeners) fn({ type: "deliveryResult", scope, receipt });
  };
  const imageBackend: ImageBackend = {
    async upload(input) {
      if (failUpload) throw new Error("Upload unavailable");
      const old = uploads.get(input.operationId);
      if (old && JSON.stringify(old.input) !== JSON.stringify(input))
        throw new Error("Upload identity conflict");
      if (old)
        return {
          sessionId: input.sessionId,
          operationId: input.operationId,
          images: old.refs.map((ref, order) => ({
            id: input.images[order]!.id,
            order,
            ref,
          })),
        };
      const refs = input.images.map((image) => {
        const attachmentId = crypto.randomUUID();
        media.set(attachmentId, image);
        return {
          attachmentId,
          mediaType: image.mediaType,
          name: image.name,
          availability: "available" as const,
        };
      });
      uploads.set(input.operationId, { input, refs });
      return {
        sessionId: input.sessionId,
        operationId: input.operationId,
        images: refs.map((ref, order) => ({
          id: input.images[order]!.id,
          order,
          ref,
        })),
      };
    },
    async media(id, variant) {
      const image = media.get(id);
      if (!image) return null;
      return {
        bytes: Uint8Array.from(atob(image[variant]), (c) => c.charCodeAt(0)),
        mediaType: variant === "original" ? image.mediaType : "image/jpeg",
      };
    },
  };
  const album = () => [
    ...new Map(
      messages.flatMap((m) =>
        (m.images ?? []).map(
          (image) =>
            [
              image.attachmentId,
              {
                id: image.attachmentId,
                filename: image.name,
                createdAt: m.createdAt,
                origin:
                  m.role === "agent" ? ("agent" as const) : ("human" as const),
                available: media.has(image.attachmentId),
                previewUrl: media.has(image.attachmentId)
                  ? mediaUrl(image.attachmentId, "original")
                  : null,
                originalUrl: media.has(image.attachmentId)
                  ? mediaUrl(image.attachmentId)
                  : null,
              },
            ] as const,
        ),
      ),
    ).values(),
  ];
  const backend: ChatBackend = {
    ...panels.backend,
    ...searchFixture().backend,
    async album() {
      return { images: album().slice(-30), nextCursor: null };
    },
    async read(): Promise<ChatView> {
      return {
        version: 2,
        sessionId: "fixture-session",
        name: "Mica",
        activeTurnId: active,
        contextUsage: { tokens: null, capacity: null },
        compaction: null,
        messages: messages.slice(-15),
        before: messages.length > 15 ? messages.at(-15)!.id : null,
        capabilities: {
          ...capabilities,
          images: disabled ? false : imageLimits,
        },
      };
    },
    async compact(input) {
      return { sessionId: input.sessionId, accepted: false };
    },
    async history(before) {
      const end = messages.findIndex((m) => m.id === before);
      if (end < 0) throw new Error("Invalid cursor");
      return {
        messages: messages.slice(Math.max(0, end - 15), end),
        before: end > 15 ? messages[end - 15]!.id : null,
      };
    },
    async submit(input) {
      const fingerprint = new Bun.CryptoHasher("sha256")
        .update(JSON.stringify(input)).digest("hex");
      const prior = fingerprints.get(input.operationId);
      if (prior && prior !== fingerprint) throw new Error("Identity conflict");
      const old = receipts.get(input.operationId);
      if (old?.state === "submitted") return old;
      if (queued.has(input.operationId)) throw new Error("Outcome unknown");
      if (!input.text.trim() && !input.images?.length && !input.files?.length)
        throw new Error("Empty");
      if (
        input.images?.length &&
        (disabled || JSON.stringify(uploads.get(input.operationId)?.refs) !==
          JSON.stringify(input.images))
      ) throw new Error("Images not owned by operation");
      fingerprints.set(input.operationId, fingerprint);
      // A new call after definite failure models an explicit user retry.
      const attempt = (attempts.get(input.operationId) ?? 0) + 1;
      attempts.set(input.operationId, attempt);
      receipts.delete(input.operationId);
      if (mode === "queued") {
        queued.add(input.operationId);
        throw new Error("Native outcome unknown");
      }
      const state: Receipt["state"] = mode === "failed" ? "failed" : "submitted";
      const receipt: Receipt = {
        operationId: input.operationId, attempt, state,
        messageId: state === "submitted" ? input.operationId : null,
        turnId: state === "submitted" ? active : null,
        error: state === "failed" ? "输入未被接收" : null,
      };
      receipts.set(input.operationId, receipt);
      if (state === "submitted") {
        submissions.set(input.operationId, structuredClone(input));
        messages.push({
          id: input.operationId, role: "user", text: input.text,
          ...(input.images ? { images: input.images } : {}),
          ...(input.files ? { files: input.files } : {}),
          createdAt: Date.now(), operationId: input.operationId, turnId: active,
        });
        if (!active) { active = input.operationId; executions++; }
      }
      changed();
      deliveryResult(receipt);
      return receipt;
    },
    async lookup(id) {
      return receipts.get(id) ?? null;
    },
    async stop(id) {
      if (id !== active) return { stopped: false };
      messages.push({
        id: `turn:${id}:status`,
        role: "notice",
        text: "已停止回复",
        createdAt: Date.now(),
        operationId: null,
        turnId: id,
      });
      active = null;
      for (const operationId of queued) {
        const receipt: Receipt = { operationId, attempt: attempts.get(operationId)!, state: "failed", messageId: null,
          turnId: null, error: "排队输入已取消" };
        receipts.set(operationId, receipt);
        deliveryResult(receipt);
      }
      queued.clear();
      changed();
      return { stopped: true };
    },
    subscribe(fn) {
      listeners.add(fn);
      return { scope, close() { listeners.delete(fn); } };
    },
  };
  const control = async (input: Record<string, unknown>) => {
    switch (input.action) {
      case "reset":
        uploads.clear();
        media.clear();
        submissions.clear();
        receipts.clear();
        attempts.clear();
        fingerprints.clear();
        queued.clear();
        messages.length = 0;
        executions = 0;
        active = null;
        mode = "submitted";
        disabled = failUpload = false;
        break;
      case "mode":
        mode = String(input.state);
        break;
      case "uploadFailure":
        failUpload = input.enabled === true;
        break;
      case "disabled":
        disabled = input.enabled === true;
        break;
      case "complete": {
        const images: ImageRef[] = [];
        for (let i = 0; i < Number(input.count ?? 1); i++) {
          const id = crypto.randomUUID();
          const original = btoa(String.fromCharCode(...fixtureImage));
          const name =
            input.count === undefined ? "generated.png" : `generated-${i}.png`;
          media.set(id, {
            id,
            order: i,
            name,
            mediaType: "image/png",
            original,
            preview: original,
            model: original,
          });
          images.push({
            attachmentId: id,
            name,
            mediaType: "image/png",
            availability: "available",
          });
        }
        messages.push({
          id: crypto.randomUUID(),
          role: "agent",
          text: "完整图片回复",
          images,
          createdAt: Date.now(),
          operationId: null,
          turnId: active,
        });
        active = null;
        break;
      }
      case "replyFailure":
        messages.push({
          id: crypto.randomUUID(),
          role: "notice",
          text: "回复失败",
          createdAt: Date.now(),
          operationId: null,
          turnId: active,
        });
        active = null;
        break;
      case "history":
        for (let i = 0; i < 32; i++)
          messages.push({
            id: crypto.randomUUID(),
            role: "agent",
            text: `历史 ${i}`,
            createdAt: Date.now(),
            operationId: null,
            turnId: null,
          });
        break;
      case "state":
        break;
      default:
        throw new Error("Unknown control");
    }
    changed();
    return {
      executions,
      submissions: [...submissions.values()],
      messages,
      limits: disabled ? false : imageLimits,
      album: album(),
    };
  };
  return {
    backend,
    imageBackend,
    async stageSticker(input: ImageUpload, sticker: StickerIdentity) {
      if (input.images.length !== 1) throw new Error("One sticker per stage");
      await imageBackend.upload(input);
      const staged = uploads.get(input.operationId)!;
      const previous = staged.refs[0]!.sticker;
      if (previous && JSON.stringify(previous) !== JSON.stringify(sticker))
        throw new Error("Stage identity conflict");
      staged.refs = staged.refs.map((ref) => ({
        ...ref,
        sticker: structuredClone(sticker),
      }));
      return {
        sessionId: input.sessionId,
        operationId: input.operationId,
        image: structuredClone(staged.refs[0]!),
      };
    },
    panels,
    control,
    get limits() {
      return disabled ? (false as const) : imageLimits;
    },
  };
}
