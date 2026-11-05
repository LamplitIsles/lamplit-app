import type { FileLimits } from "@lamplit/contracts";

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
/** Stage raw File bodies once; failures require an explicit new attempt. */
export async function streamFileUploads(
  sessionId: string,
  operationId: string,
  drafts: readonly ChatFileDraft[],
  limits: FileLimits,
  current: () => boolean,
  signal?: AbortSignal,
  fetchFile: typeof fetch = fetch,
): Promise<import("@lamplit/contracts").FileUploadResult> {
  const {
    FILE_OPERATIONS_PATH,
    fileOperationUrl,
    fileOperationFileUrl,
    validateFileManifest,
    validateFileUploadResult,
    sameFileManifest,
  } = await import("@lamplit/contracts");
  const error = fileIntakeError(
    [],
    drafts.map((d) => d.file),
    limits,
  );
  if (error) throw new Error(`file-${error}`);
  const manifest = validateFileManifest(
    {
      sessionId,
      operationId,
      files: drafts.map(({ id, file }, order) => ({
        id,
        name: file.name || `file-${order + 1}`,
        mediaType: file.type,
        size: file.size,
      })),
    },
    limits,
  );
  const url = (path: string) => new URL(path, location.href);
  const check = () => {
    if (!current() || signal?.aborted) throw new Error("file-unavailable");
  };
  const ensureResponse = (response: Response) => {
    if (!response.ok) throw new Error("file-unavailable");
  };
  check();
  const reservation = await fetchFile(url(FILE_OPERATIONS_PATH), {
    method: "POST",
    credentials: "same-origin",
    redirect: "error",
    signal,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(manifest),
  });
  ensureResponse(reservation);
  const status: unknown = await reservation.json();
  if (!status || typeof status !== "object")
    throw new Error("file-unavailable");
  const value = status as {
    manifest?: unknown;
    uploaded?: unknown;
    result?: unknown;
  };
  if (
    !sameFileManifest(validateFileManifest(value.manifest, limits), manifest) ||
    !Array.isArray(value.uploaded) ||
    value.uploaded.length !== 0 ||
    value.result !== undefined
  )
    throw new Error("file-unavailable");
  check();
  for (const draft of drafts) {
    check();
    const response = await fetchFile(
      url(fileOperationFileUrl(operationId, draft.id)),
      {
        method: "PUT",
        credentials: "same-origin",
        redirect: "error",
        signal,
        headers: { "Content-Type": "application/octet-stream" },
        body: draft.file,
      },
    );
    if (response.status !== 204) throw new Error("file-unavailable");
    check();
  }
  check();
  const response = await fetchFile(
    url(`${fileOperationUrl(operationId)}/complete`),
    { method: "POST", credentials: "same-origin", redirect: "error", signal },
  );
  ensureResponse(response);
  const result = validateFileUploadResult(await response.json(), manifest);
  check();
  return result;
}
