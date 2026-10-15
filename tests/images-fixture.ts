import { searchFixture } from "./search-fixture.ts";
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
  const deleted = new Set<string>();
  const retries = new Map<string, string>();
  const messages: ChatMessage[] = [];
  let recovery: InputRecovery[] = [],
    active: string | null = null,
    executions = 0,
    mode = "submitted",
    disabled = false,
    failUpload = false;
  const changed = () => {
    for (const fn of listeners) fn();
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
        recovery: [...recovery],
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
            !recovery.some((r) => r.sourceId === id && r.replacementEligible),
        )
      )
        throw new Error("Ineligible replacement");
      submissions.set(input.operationId, structuredClone(input));
      recovery = recovery.filter(
        (r) => !input.replacementSourceIds?.includes(r.sourceId),
      );
      const state: Receipt["state"] =
        mode === "failed" ? "failed" : "submitted";
      const receipt: Receipt = {
        operationId: input.operationId,
        state,
        messageId: state === "submitted" ? input.operationId : null,
        turnId: active,
        error: state === "failed" ? "输入未被接收" : null,
      };
      receipts.set(input.operationId, receipt);
      if (state === "submitted")
        messages.push({
          id: input.operationId,
          role: "user",
          text: input.text,
          ...(input.images ? { images: input.images } : {}),
          createdAt: Date.now(),
          operationId: input.operationId,
          turnId: active,
        });
      if (mode === "withdrawn" || state === "failed")
        recovery.push({
          sourceId: input.operationId,
          operationId: input.operationId,
          text: input.text,
          images: input.images ?? [],
          replacementEligible: true,
        });
      if (mode === "submitted") {
        if (!active) {
          active = input.operationId;
          executions++;
        }
      }
      changed();
      return receipt;
    },
    async finalizeSubmission(input) {
      const { sessionId } = input;
      if ("retry" in input) {
        const { operationId, attemptId } = input.retry;
        if (
          sessionId !== "fixture-session" ||
          input.retry.sessionId !== sessionId
        )
          throw new Error("Wrong session");
        const source = retries.get(attemptId);
        if (source && source !== operationId)
          throw new Error("Retry identity conflict");
        if (source) return backend.lookup(attemptId);
        if (
          deleted.has(operationId) ||
          receipts.get(operationId)?.state !== "failed" ||
          submissions.has(attemptId)
        )
          return null;
        retries.set(attemptId, operationId);
        recovery = recovery.filter((r) => r.operationId !== operationId);
        return backend.finalizeSubmission({
          sessionId,
          submission: {
            ...submissions.get(operationId)!,
            operationId: attemptId,
          },
        });
      }
      const { submission } = input;
      if (sessionId !== "fixture-session") throw new Error("Wrong session");
      const old = submissions.get(submission.operationId);
      if (old && JSON.stringify(old) !== JSON.stringify(submission))
        throw new Error("Identity conflict");
      const receipt = receipts.get(submission.operationId);
      if (receipt) return receipt;
      // No await between checking native admission and durable rejection in this owned fake.
      submissions.set(submission.operationId, structuredClone(submission));
      const failed: Receipt = {
        operationId: submission.operationId,
        state: "failed",
        messageId: null,
        turnId: null,
        error: "消息未被接收",
      };
      receipts.set(submission.operationId, failed);
      recovery.push({
        sourceId: submission.operationId,
        operationId: submission.operationId,
        text: submission.text,
        images: submission.images ?? [],
        replacementEligible: true,
      });
      changed();
      return failed;
    },
    async retryFailed({ sessionId, operationId, attemptId }) {
      if (sessionId !== "fixture-session" || operationId === attemptId)
        throw new Error("Invalid retry");
      const priorSource = retries.get(attemptId);
      if (priorSource) {
        if (priorSource !== operationId)
          throw new Error("Retry identity conflict");
        return receipts.get(attemptId)!;
      }
      if (
        deleted.has(operationId) ||
        receipts.get(operationId)?.state !== "failed"
      )
        throw new Error("Not a failed submission");
      if (submissions.has(attemptId)) throw new Error("Attempt already exists");
      const source = submissions.get(operationId)!;
      const originals = (source.images ?? []).map((ref) =>
        media.get(ref.attachmentId),
      );
      if (originals.some((image) => !image)) {
        retries.set(attemptId, operationId);
        submissions.set(attemptId, { ...source, operationId: attemptId });
        const failed: Receipt = {
          operationId: attemptId,
          state: "failed",
          messageId: null,
          turnId: null,
          error: "原图片不可用，请删除这条消息后重新选择图片发送。",
        };
        receipts.set(attemptId, failed);
        recovery = recovery.filter((r) => r.operationId !== operationId);
        changed();
        return failed;
      }
      let images: ImageRef[] | undefined;
      if (originals.length) {
        // Reassociate exact stored bytes with the new attempt under the existing owner/session.
        const input: ImageUpload = {
          sessionId,
          operationId: attemptId,
          images: structuredClone(originals) as ImageUpload["images"],
        };
        images = originals.map((image) => {
          const attachmentId = crypto.randomUUID();
          media.set(attachmentId, structuredClone(image!));
          return {
            attachmentId,
            name: image!.name,
            mediaType: image!.mediaType,
            availability: "available" as const,
          };
        });
        uploads.set(attemptId, { input, refs: images });
      }
      retries.set(attemptId, operationId);
      recovery = recovery.filter((r) => r.operationId !== operationId);
      const receipt = await backend.submit({
        ...source,
        operationId: attemptId,
        ...(images ? { images } : {}),
      });
      changed();
      return receipt;
    },
    async deleteFailed({ sessionId, operationId }) {
      if (sessionId !== "fixture-session") throw new Error("Wrong session");
      if (
        !deleted.has(operationId) &&
        receipts.get(operationId)?.state !== "failed"
      )
        return { sessionId, operationId, deleted: false };
      deleted.add(operationId);
      recovery = recovery.filter((r) => r.operationId !== operationId);
      changed();
      return { sessionId, operationId, deleted: true };
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
        deleted.clear();
        retries.clear();
        messages.length = 0;
        recovery = [];
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
      case "missing":
        for (const r of recovery)
          for (const image of r.images) media.delete(image.attachmentId);
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
      case "consume":
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
