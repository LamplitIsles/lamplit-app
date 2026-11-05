import { createHash } from "node:crypto";
import {
  sameFileManifest,
  type FileLimits,
  type FileManifest,
} from "../packages/contracts/src/index.ts";
import type {
  FileBackend,
  FileStreamBackend,
  FileStreamStatus,
} from "../packages/contracts/src/server.ts";

export const fileLimits: FileLimits = {
  maxFilesPerMessage: 6,
  maxFileBytes: 100_000_000,
  maxMessageFileBytes: 200_000_000,
};
/** Isolated small-byte fake; large boundary tests use the digest-only fake. */
export function filesFixture() {
  const contents = new Map<string, Uint8Array>();
  const uploads = new Map<
    string,
    {
      status: FileStreamStatus;
      bytes: Map<string, Uint8Array>;
      digests: Map<string, string>;
    }
  >();
  let next = 0;
  const key = (owner: { ownerId: string; sessionId: string }, id: string) =>
    JSON.stringify([owner.ownerId, owner.sessionId, id]);
  const backend: FileBackend & FileStreamBackend = {
    async reserve(manifest, owner, check) {
      await check();
      const k = key(owner, manifest.operationId);
      const previous = uploads.get(k);
      if (previous) {
        if (!sameFileManifest(previous.status.manifest, manifest))
          throw Error("operation conflict");
        return previous.status;
      }
      const status: FileStreamStatus = { manifest, uploaded: [] };
      uploads.set(k, { status, bytes: new Map(), digests: new Map() });
      return status;
    },
    async status(operationId, owner) {
      return uploads.get(key(owner, operationId))?.status ?? null;
    },
    async receive(manifest, id, bytes, owner, check) {
      const upload = uploads.get(key(owner, manifest.operationId));
      if (!upload || !sameFileManifest(upload.status.manifest, manifest))
        throw Error("missing reservation");
      const chunks: Uint8Array[] = [];
      let size = 0;
      const hash = createHash("sha256");
      for await (const chunk of bytes) {
        size += chunk.length;
        if (size > 1_000_000) throw Error("small fixture only");
        hash.update(chunk);
        chunks.push(chunk.slice());
      }
      const digest = hash.digest("hex");
      await check();
      const prior = upload.digests.get(id);
      if (prior && prior !== digest) throw Error("bytes conflict");
      if (!prior) {
        const combined = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          combined.set(chunk, offset);
          offset += chunk.length;
        }
        upload.bytes.set(id, combined);
        upload.digests.set(id, digest);
        upload.status.uploaded.push(id);
      }
    },
    async complete(manifest: FileManifest, owner, check) {
      const upload = uploads.get(key(owner, manifest.operationId));
      if (!upload || upload.status.uploaded.length !== manifest.files.length)
        throw Error("incomplete");
      await check();
      if (upload.status.result) return upload.status.result;
      const result = {
        sessionId: manifest.sessionId,
        operationId: manifest.operationId,
        files: manifest.files.map((file, order) => {
          const attachmentId = `file_${++next}`;
          contents.set(key(owner, attachmentId), upload.bytes.get(file.id)!);
          return {
            id: file.id,
            order,
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
      upload.status.result = result;
      return result;
    },
    async fileStream(id, owner) {
      const bytes = contents.get(key(owner, id));
      if (!bytes) return null;
      return {
        size: bytes.length,
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        }),
      };
    },
  };
  return { backend, streamBackend: backend, uploads, contents };
}
