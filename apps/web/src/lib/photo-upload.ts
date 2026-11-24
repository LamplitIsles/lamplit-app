import { imageIntakeError } from "./companion/client/image-drafts.ts";
import type { CompanionImageDraft } from "./companion/client/image-drafts.ts";
import type { WebPModule } from "@jsquash/webp/codec/enc/webp_enc.js";
import {
  validateUpload,
  type ImageLimits,
  type ImageUpload,
} from "@lamplit/contracts";

const MAX_DECODE_PIXELS = 40_000_000;
const MAX_DECODE_SIDE = 16_384;

// Load the portable libwebp encoder only when canvas cannot encode WebP.
let encoderPromise:
  | Promise<{
      encode: WebPModule;
      defaults: (typeof import("@jsquash/webp/meta.js"))["defaultOptions"];
    }>
  | undefined;

async function encodeWebpFallback(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
): Promise<Blob> {
  if (!encoderPromise) {
    encoderPromise = Promise.all([
      import("@jsquash/webp/codec/enc/webp_enc.js"),
      import("@jsquash/webp/meta.js"),
    ])
      .then(async ([codec, meta]) => ({
        encode: await codec.default({ noInitialRun: true }),
        defaults: meta.defaultOptions,
      }))
      .catch((error: unknown) => {
        encoderPromise = undefined;
        throw error;
      });
  }
  const { encode, defaults } = await encoderPromise;
  const pixels = context.getImageData(0, 0, width, height);
  const bytes = encode.encode(pixels.data, width, height, {
    ...defaults,
    quality: 80,
  });
  if (!bytes) throw new Error("WebP photo processing is unavailable.");
  return new Blob([Uint8Array.from(bytes)], { type: "image/webp" });
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}

function webpName(name: string, order: number): string {
  let stem = name.replace(/\.[^.]*$/, "").slice(0, 155);
  if (/[\uD800-\uDBFF]$/.test(stem)) stem = stem.slice(0, -1);
  return `${stem || `photo-${order + 1}`}.webp`;
}

// Inspect bounded input before decoding, including animation chunks which can
// occur after image data. Reject malformed containers instead of flattening them.
function inspectPhoto(
  bytes: Uint8Array,
  type: string,
): { animated: boolean; width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = (offset: number, length: number) =>
    String.fromCharCode(...bytes.subarray(offset, offset + length));
  const fail = (): never => {
    throw new Error("图片格式无法处理，请重新选择。");
  };
  if (type === "image/gif") {
    if (bytes.length < 10 || !/^GIF8[79]a$/.test(text(0, 6))) return fail();
    return { animated: true, width: 0, height: 0 };
  }
  if (type === "image/png") {
    if (
      bytes.length < 33 ||
      ![137, 80, 78, 71, 13, 10, 26, 10].every((n, i) => bytes[i] === n) ||
      text(12, 4) !== "IHDR" ||
      view.getUint32(8) !== 13
    )
      return fail();
    const width = view.getUint32(16),
      height = view.getUint32(20);
    let animated = false,
      ended = false;
    for (let pos = 8; pos + 12 <= bytes.length;) {
      const size = view.getUint32(pos),
        end = pos + 12 + size;
      if (end > bytes.length) return fail();
      const chunk = text(pos + 4, 4);
      if (chunk === "acTL") animated = true;
      if (chunk === "IEND") {
        ended = true;
        break;
      }
      pos = end;
    }
    if (!ended) return fail();
    return { animated, width, height };
  }
  if (type === "image/webp") {
    if (
      bytes.length < 20 ||
      text(0, 4) !== "RIFF" ||
      text(8, 4) !== "WEBP" ||
      view.getUint32(4, true) + 8 !== bytes.length
    )
      return fail();
    let width = 0,
      height = 0,
      animated = false;
    for (let pos = 12; pos + 8 <= bytes.length;) {
      const size = view.getUint32(pos + 4, true),
        start = pos + 8,
        end = start + size;
      if (end + (size % 2) > bytes.length) return fail();
      const chunk = text(pos, 4);
      if (chunk === "ANIM" || chunk === "ANMF") animated = true;
      if (chunk === "VP8X" && size >= 10) {
        animated ||= !!(bytes[start]! & 2);
        width =
          1 +
          bytes[start + 4]! +
          (bytes[start + 5]! << 8) +
          (bytes[start + 6]! << 16);
        height =
          1 +
          bytes[start + 7]! +
          (bytes[start + 8]! << 8) +
          (bytes[start + 9]! << 16);
      } else if (
        chunk === "VP8 " &&
        size >= 10 &&
        text(start + 3, 3) === "\x9d\x01\x2a" &&
        !width
      ) {
        width = view.getUint16(start + 6, true) & 0x3fff;
        height = view.getUint16(start + 8, true) & 0x3fff;
      } else if (
        chunk === "VP8L" &&
        size >= 5 &&
        bytes[start] === 0x2f &&
        !width
      ) {
        const bits = view.getUint32(start + 1, true);
        width = (bits & 0x3fff) + 1;
        height = ((bits >>> 14) & 0x3fff) + 1;
      }
      pos = end + (size % 2);
      if (pos === bytes.length) break;
      if (pos + 8 > bytes.length) return fail();
    }
    if (!width || !height) return fail();
    return { animated, width, height };
  }
  if (type === "image/jpeg" && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let pos = 2;
    while (pos + 4 <= bytes.length) {
      if (bytes[pos++] !== 0xff) return fail();
      while (bytes[pos] === 0xff) pos++;
      const marker = bytes[pos++]!;
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (pos + 2 > bytes.length) return fail();
      const size = view.getUint16(pos);
      if (size < 2 || pos + size > bytes.length) return fail();
      if (
        [
          0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd,
          0xce, 0xcf,
        ].includes(marker)
      ) {
        if (size < 8) return fail();
        return {
          animated: false,
          width: view.getUint16(pos + 5),
          height: view.getUint16(pos + 3),
        };
      }
      pos += size;
    }
  }
  return fail();
}

async function encodePhoto(
  file: File,
  width: number,
  height: number,
): Promise<Blob> {
  if (
    !width ||
    !height ||
    width > MAX_DECODE_SIDE ||
    height > MAX_DECODE_SIDE ||
    width * height > MAX_DECODE_PIXELS
  )
    throw new Error("图片尺寸过大，无法处理。");
  // from-image is explicit: the returned dimensions include EXIF orientation.
  const image = await createImageBitmap(file, {
    imageOrientation: "from-image",
  });
  try {
    const scale = Math.min(1, 1200 / Math.max(image.width, image.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Photo processing is unavailable.");
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/webp", 0.8),
    );
    if (blob?.type === "image/webp") return blob;
    return await encodeWebpFallback(context, canvas.width, canvas.height);
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
    drafts.some((d) => !d.file.size)
  )
    throw new Error("图片不符合当前发送限制，请检查选择。");
  try {
    const images: ImageUpload["images"] = [];
    // One decode at a time bounds memory for a multi-photo selection.
    for (const [order, draft] of drafts.entries()) {
      const source = new Uint8Array(await draft.file.arrayBuffer());
      const info = inspectPhoto(source, draft.file.type);
      let bytes = source;
      let name = draft.file.name || `photo-${order + 1}`;
      let mediaType = draft.file
        .type as ImageUpload["images"][number]["mediaType"];
      if (!info.animated) {
        if (!limits.mediaTypes.includes("image/webp"))
          throw new Error("WebP 图片暂不可用。");
        const blob = await encodePhoto(draft.file, info.width, info.height);
        if (blob.size > limits.maxImageBytes)
          throw new Error("图片超过当前发送限制。");
        bytes = new Uint8Array(await blob.arrayBuffer());
        name = webpName(name, order);
        mediaType = "image/webp";
      }
      images.push({
        id: draft.id,
        order,
        name,
        mediaType,
        original: base64(bytes),
      });
    }
    return validateUpload({ sessionId, operationId, images }, limits);
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotReadableError")
      throw new Error("图片暂时无法读取，请重试；仍失败时请移除后重新选择。", {
        cause: error,
      });
    throw error;
  }
}
