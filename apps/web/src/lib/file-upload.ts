import {
  validateFileUpload,
  type FileLimits,
  type FileUpload,
} from "@lamplit/contracts";

export interface ChatFileDraft {
  id: string;
  file: File;
}
export type FileIntakeError =
  | "unavailable"
  | "count"
  | "size"
  | "total"
  | "name";
export function fileIntakeError(
  current: readonly ChatFileDraft[],
  incoming: readonly File[],
  limits: FileLimits | false | undefined,
): FileIntakeError | undefined {
  if (!incoming.length) return;
  if (!limits) return "unavailable";
  if (current.length + incoming.length > limits.maxFilesPerMessage)
    return "count";
  if (incoming.some((file) => Array.from(file.name).length > 200))
    return "name";
  if (incoming.some((file) => file.size > limits.maxFileBytes)) return "size";
  if (
    current.reduce((sum, draft) => sum + draft.file.size, 0) +
      incoming.reduce((sum, file) => sum + file.size, 0) >
    limits.maxMessageFileBytes
  )
    return "total";
}
export function createFileDrafts(files: readonly File[]): ChatFileDraft[] {
  return files.map((file) => ({ id: crypto.randomUUID(), file }));
}
export async function prepareFileUploads(
  sessionId: string,
  operationId: string,
  drafts: readonly ChatFileDraft[],
  limits: FileLimits,
): Promise<FileUpload> {
  const error = fileIntakeError(
    [],
    drafts.map((draft) => draft.file),
    limits,
  );
  if (error) throw new Error(`file-${error}`);
  const files = await Promise.all(
    drafts.map(async ({ id, file }, order) => {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = "";
      for (let offset = 0; offset < bytes.length; offset += 0x8000)
        binary += String.fromCharCode(
          ...bytes.subarray(offset, offset + 0x8000),
        );
      return {
        id,
        order,
        name: file.name || `file-${order + 1}`,
        mediaType: file.type,
        size: file.size,
        data: btoa(binary),
      };
    }),
  );
  return validateFileUpload({ sessionId, operationId, files }, limits);
}

/** Fetch a recovery reference with owner credentials; discard bytes if the session changed. */
export async function restoreFileDraft(
  ref: import("@lamplit/contracts").FileRef,
  current: () => boolean,
  fetchFile: (url: URL, init?: RequestInit) => Promise<Response> = fetch,
): Promise<ChatFileDraft> {
  const { fileDownloadUrl } = await import("@lamplit/contracts");
  if (!current() || ref.availability !== "available")
    throw new Error("file-unavailable");
  const response = await fetchFile(
    new URL(fileDownloadUrl(ref.attachmentId), location.href),
    { credentials: "same-origin", redirect: "error" },
  );
  if (!response.ok || !current()) throw new Error("file-unavailable");
  if (Number(response.headers.get("content-length")) > ref.size)
    throw new Error("file-unavailable");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("file-unavailable");
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (!current() || size > ref.size || size > 8_000_000) {
        await reader.cancel();
        throw new Error("file-unavailable");
      }
      chunks.push(new Uint8Array(value));
    }
  } finally {
    reader.releaseLock();
  }
  if (!current() || size !== ref.size) throw new Error("file-unavailable");
  return {
    id: crypto.randomUUID(),
    file: new File(chunks, ref.name, { type: ref.mediaType }),
  };
}
