import type { FileBackend } from "../packages/contracts/src/server.ts";
import type {
  FileLimits,
  FileUpload,
} from "../packages/contracts/src/index.ts";

export const fileLimits: FileLimits = {
  maxFilesPerMessage: 6,
  maxFileBytes: 8_000_000,
  maxMessageFileBytes: 24_000_000,
};
/** Isolated fake owner/session storage; no native service or shared workspace. */
export function filesFixture() {
  const contents = new Map<string, Uint8Array>();
  const uploads = new Map<string, { body: string; result: unknown }>();
  let next = 0;
  const backend: FileBackend = {
    async upload(input: FileUpload, owner) {
      const key = `${owner.ownerId}:${input.sessionId}:${input.operationId}`;
      const body = JSON.stringify(input);
      const prior = uploads.get(key);
      if (prior) {
        if (prior.body !== body) throw new Error("operation conflict");
        return prior.result;
      }
      const result = {
        sessionId: input.sessionId,
        operationId: input.operationId,
        files: input.files.map((file) => {
          const attachmentId = `file_${++next}`;
          contents.set(
            `${owner.ownerId}:${input.sessionId}:${attachmentId}`,
            Uint8Array.from(atob(file.data), (c) => c.charCodeAt(0)),
          );
          return {
            id: file.id,
            order: file.order,
            ref: {
              attachmentId,
              name: file.name,
              mediaType: file.mediaType,
              size: file.size,
              availability: "available" as const,
            },
          };
        }),
      };
      uploads.set(key, { body, result });
      return result;
    },
    async file(id, owner) {
      return contents.get(`${owner.ownerId}:${owner.sessionId}:${id}`) ?? null;
    },
  };
  return { backend, uploads, contents };
}
