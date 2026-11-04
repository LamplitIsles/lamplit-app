import {
  FILE_UPLOAD_PATH,
  FILE_DOWNLOAD_PATH,
  MAX_FILE_UPLOAD_BODY_BYTES,
  validateFileUpload,
  validateFileUploadResult,
  type FileLimits,
  type FileUpload,
} from "./files.ts";
import { MediaIdSchema } from "./images.ts";
import { validate } from "./validation.ts";

export interface FileOwner {
  ownerId: string;
  sessionId: string;
}
export interface FileBackend {
  /** Scoped to the authenticated owner/session; operation and payload are immutable. */
  upload(input: FileUpload, owner: FileOwner): Promise<unknown>;
  /** Return only files the authenticated owner/session may read. */
  file(id: string, owner: FileOwner): Promise<Uint8Array | null>;
}
/** Mount before static assets. Resolve authorization and session on each request. */
export async function fileHttp(
  request: Request,
  backend: FileBackend,
  authorize: () => Promise<{
    ownerId: string;
    sessionId: string;
    limits: FileLimits | false;
  } | null>,
): Promise<Response | undefined> {
  const url = new URL(request.url);
  if (
    url.pathname !== FILE_UPLOAD_PATH &&
    !url.pathname.startsWith(FILE_DOWNLOAD_PATH)
  )
    return;
  const owner = await authorize();
  if (
    !owner ||
    typeof owner.ownerId !== "string" ||
    !owner.ownerId ||
    typeof owner.sessionId !== "string" ||
    !owner.sessionId
  )
    return new Response("Unauthorized", { status: 401 });
  const headers = {
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "sandbox; default-src 'none'",
  };
  try {
    if (url.pathname === FILE_UPLOAD_PATH) {
      if (request.method !== "POST")
        return new Response(null, { status: 405, headers });
      if (request.headers.get("origin") !== url.origin)
        return new Response(null, { status: 403, headers });
      if (!owner.limits)
        return new Response("Files unavailable", { status: 503, headers });
      if (request.headers.get("content-type") !== "application/json")
        return new Response(null, { status: 415, headers });
      if (
        Number(request.headers.get("content-length")) >
        MAX_FILE_UPLOAD_BODY_BYTES
      )
        return new Response(null, { status: 413, headers });
      const reader = request.body?.getReader();
      if (!reader) throw new Error("Missing body");
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          length += value.byteLength;
          if (length > MAX_FILE_UPLOAD_BODY_BYTES) {
            await reader.cancel();
            return new Response(null, { status: 413, headers });
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      const input = validateFileUpload(
        JSON.parse(new TextDecoder().decode(bytes)),
        owner.limits,
      );
      if (input.sessionId !== owner.sessionId)
        return new Response(null, { status: 403, headers });
      const current = await authorize();
      if (
        !current ||
        current.ownerId !== owner.ownerId ||
        current.sessionId !== owner.sessionId
      )
        return new Response(null, { status: 403, headers });
      if (!current.limits) return new Response(null, { status: 503, headers });
      validateFileUpload(input, current.limits);
      const result = validateFileUploadResult(
        await backend.upload(input, {
          ownerId: owner.ownerId,
          sessionId: owner.sessionId,
        }),
        input,
      );
      const final = await authorize();
      if (
        !final ||
        final.ownerId !== owner.ownerId ||
        final.sessionId !== owner.sessionId
      )
        return new Response(null, { status: 403, headers });
      return Response.json(result, { headers });
    }
    if (request.method !== "GET")
      return new Response(null, { status: 405, headers });
    const id = validate(
      MediaIdSchema,
      url.pathname.slice(FILE_DOWNLOAD_PATH.length),
    );
    const bytes = await backend.file(id, {
      ownerId: owner.ownerId,
      sessionId: owner.sessionId,
    });
    if (
      bytes &&
      (!(bytes instanceof Uint8Array) || bytes.byteLength > 8_000_000)
    )
      throw new Error("Invalid file result");
    const current = await authorize();
    if (
      !current ||
      current.ownerId !== owner.ownerId ||
      current.sessionId !== owner.sessionId
    )
      return new Response(null, { status: 403, headers });
    if (!bytes) return new Response("Missing file", { status: 404, headers });
    return new Response(bytes as BodyInit, {
      headers: {
        ...headers,
        "Content-Type": "application/octet-stream",
        "Content-Disposition": 'attachment; filename="download"',
      },
    });
  } catch {
    return new Response("File request failed", { status: 400, headers });
  }
}
