import {
  capabilities,
  mediaUrl,
  type ChatMessage,
  type ChatView,
  type ImageUpload,
  type ImageRef,
  type ImageLimits,
  type InputRecovery,
  type Receipt,
  type Submission,
} from "../packages/contracts/src/index.ts";
import type {
  ChatBackend,
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
  const listeners = new Set<() => void>();
  const panels = panelsFixture();
  const uploads = new Map<string, { input: ImageUpload; refs: ImageRef[] }>();
  const media = new Map<string, ImageUpload["images"][number]>();
  const submissions = new Map<string, Submission>();
  const receipts = new Map<string, Receipt>();
  const messages: ChatMessage[] = [];
  let recovery: InputRecovery[] = [],
    active: string | null = null,
    executions = 0,
    mode = "consumed",
    disabled = false,
    failUpload = false;
  const changed = () => {
    for (const fn of listeners) fn();
  };
  const missingReceipt = (id: string): Receipt => ({
    operationId: id,
    state: "missing",
    messageId: null,
    turnId: null,
    error: null,
  });
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
          images: old.refs,
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
        images: refs,
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
    async album() {
      return { images: album().slice(-30), nextCursor: null };
    },
    async read(): Promise<ChatView> {
      return {
        version: 1,
        sessionId: "fixture-session",
        name: "Mica",
        activeTurnId: active,
        messages: messages.slice(-30),
        before: messages.length > 30 ? messages.at(-30)!.id : null,
        capabilities: {
          ...capabilities,
          images: disabled ? false : imageLimits,
        },
        recovery: [...recovery],
      };
    },
    async history(before) {
      const end = messages.findIndex((m) => m.id === before);
      if (end < 0) throw new Error("Invalid cursor");
      return {
        messages: messages.slice(Math.max(0, end - 30), end),
        before: end > 30 ? messages[end - 30]!.id : null,
      };
    },
    async submit(input) {
      const old = submissions.get(input.operationId);
      if (old) {
        if (JSON.stringify(old) !== JSON.stringify(input))
          throw new Error("Identity conflict");
        return receipts.get(input.operationId)!;
      }
      if (!input.text.trim() && !input.images?.length) throw new Error("Empty");
      if (
        input.images?.length &&
        (disabled ||
          JSON.stringify(uploads.get(input.operationId)?.refs) !==
            JSON.stringify(input.images))
      )
        throw new Error("Images not owned by operation");
      if (
        input.replacementSourceIds?.some(
          (id) =>
            !recovery.some(
              (r) =>
                r.sourceId === id &&
                r.replacementEligible &&
                r.state !== "uncertain",
            ),
        )
      )
        throw new Error("Ineligible replacement");
      submissions.set(input.operationId, structuredClone(input));
      recovery = recovery.filter(
        (r) => !input.replacementSourceIds?.includes(r.sourceId),
      );
      const state = mode as Receipt["state"];
      const receipt: Receipt = {
        operationId: input.operationId,
        state,
        messageId: input.operationId,
        turnId: active,
        error: state === "rejected" ? "输入未被接收" : null,
      };
      receipts.set(input.operationId, receipt);
      messages.push({
        id: input.operationId,
        role: "user",
        text: input.text,
        ...(input.images ? { images: input.images } : {}),
        delivery:
          state === "accepted"
            ? "pending"
            : state === "missing"
              ? "uncertain"
              : state,
        createdAt: Date.now(),
        operationId: input.operationId,
        turnId: active,
      });
      if (["unconsumed", "rejected", "uncertain"].includes(state))
        recovery.push({
          sourceId: input.operationId,
          operationId: input.operationId,
          text: input.text,
          images: input.images ?? [],
          state: state as InputRecovery["state"],
          replacementEligible: state !== "uncertain",
        });
      if (state === "consumed") {
        if (!active) active = input.operationId;
        executions++;
      }
      changed();
      return receipt;
    },
    async lookup(id) {
      return receipts.get(id) ?? missingReceipt(id);
    },
    async stop(id) {
      if (id !== active) return { stopped: false };
      active = null;
      changed();
      return { stopped: true };
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
  const control = async (input: Record<string, unknown>) => {
    switch (input.action) {
      case "reset":
        uploads.clear();
        media.clear();
        submissions.clear();
        receipts.clear();
        messages.length = 0;
        recovery = [];
        executions = 0;
        active = null;
        mode = "consumed";
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
      case "missing":
        for (const r of recovery)
          for (const image of r.images) media.delete(image.attachmentId);
        break;
      case "complete": {
        const id = crypto.randomUUID();
        const original = btoa(String.fromCharCode(...fixtureImage));
        media.set(id, {
          id,
          order: 0,
          name: "generated.png",
          mediaType: "image/png",
          original,
          preview: original,
          model: original,
        });
        messages.push({
          id: crypto.randomUUID(),
          role: "agent",
          text: "完整图片回复",
          images: [
            {
              attachmentId: id,
              name: "generated.png",
              mediaType: "image/png",
              availability: "available",
            },
          ],
          createdAt: Date.now(),
          operationId: null,
          turnId: active,
        });
        active = null;
        break;
      }
      case "consume":
        for (const r of recovery) {
          const receipt = receipts.get(r.operationId);
          if (receipt) receipt.state = "consumed";
          const message = messages.find((m) => m.operationId === r.operationId);
          if (message) message.delivery = "consumed";
        }
        recovery = [];
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
      case "nativeRecovery": {
        const id = crypto.randomUUID();
        const attachmentId = crypto.randomUUID();
        const png = btoa(String.fromCharCode(...fixtureImage));
        media.set(attachmentId, {
          id: attachmentId,
          order: 0,
          name: "native.png",
          mediaType: "image/png",
          original: png,
          preview: png,
          model: png,
        });
        recovery.push({
          sourceId: id,
          operationId: id,
          text: "原生恢复输入",
          images: [
            {
              attachmentId,
              name: "native.png",
              mediaType: "image/png",
              availability: "available",
            },
          ],
          state: "unconsumed",
          replacementEligible: true,
        });
        break;
      }
      case "state":
        break;
      default:
        throw new Error("Unknown control");
    }
    changed();
    return {
      executions,
      submissions: [...submissions.values()],
      recovery,
      messages,
      limits: disabled ? false : imageLimits,
      album: album(),
    };
  };
  return {
    backend,
    imageBackend,
    panels,
    control,
    get limits() {
      return disabled ? (false as const) : imageLimits;
    },
  };
}
