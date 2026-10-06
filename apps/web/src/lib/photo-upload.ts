import { imageIntakeError } from "./companion/client/image-drafts.ts";
import type { CompanionImageDraft } from "./companion/client/image-drafts.ts";
import {
  validateUpload,
  type ImageLimits,
  type ImageUpload,
} from "@lamplit/contracts";

async function base64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}

async function jpegVariant(
  file: File,
  maxSide: number,
  maxBytes: number,
): Promise<string> {
  const image = await createImageBitmap(file);
  try {
    let side = maxSide;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const scale = Math.min(1, side / Math.max(image.width, image.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(image.width * scale));
      canvas.height = Math.max(1, Math.round(image.height * scale));
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Photo processing is unavailable.");
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, "image/jpeg", 0.76),
      );
      if (blob && blob.size <= maxBytes) return base64(blob);
      side = Math.round(side * 0.7);
    }
    throw new Error("Photo cannot fit the message size limit.");
  } finally {
    image.close();
  }
}

export async function preparePhotoUploads(
  sessionId: string,
  operationId: string,
  drafts: readonly CompanionImageDraft[],
  limits: ImageLimits,
): Promise<ImageUpload> {
  if (
    imageIntakeError(
      [],
      drafts.map((d) => d.file),
      limits,
    ) ||
    drafts.some((d) => d.file.name.length > 200 || !d.file.size)
  )
    throw new Error("图片不符合当前发送限制，请检查选择。");
  const images = await Promise.all(
    drafts.map(async (draft, order) => ({
      id: draft.id,
      order,
      name: draft.file.name || `photo-${order + 1}`,
      mediaType: draft.file.type as ImageUpload["images"][number]["mediaType"],
      original: await base64(draft.file),
      preview: await jpegVariant(draft.file, 480, 160_000),
      model: await jpegVariant(draft.file, 1200, 320_000),
    })),
  ).catch((error: unknown) => {
    if (error instanceof DOMException && error.name === "NotReadableError")
      throw new Error("图片暂时无法读取，请重试；仍失败时请移除后重新选择。", {
        cause: error,
      });
    throw error;
  });
  return validateUpload({ sessionId, operationId, images }, limits);
}
