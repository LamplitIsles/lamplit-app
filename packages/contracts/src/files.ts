import { Type, type Static } from "typebox";
import { Format } from "typebox/format";
const MediaIdSchema = Type.String({ pattern: "^[A-Za-z0-9_-]{1,100}$" });
const OperationIdSchema = Type.String({
  pattern:
    "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
});
import { validate } from "./validation.ts";

export const FILE_UPLOAD_PATH = "/api/chat/files";
export const FILE_DOWNLOAD_PATH = "/api/chat/files/";
export const MAX_FILE_UPLOAD_BODY_BYTES = 33_000_000;
const object = { additionalProperties: false } as const;
export const FileLimitsSchema = Type.Object(
  {
    maxFilesPerMessage: Type.Integer({ minimum: 1, maximum: 6 }),
    maxFileBytes: Type.Integer({ minimum: 1, maximum: 8_000_000 }),
    maxMessageFileBytes: Type.Integer({ minimum: 1, maximum: 24_000_000 }),
  },
  object,
);
export const FileRefSchema = Type.Object(
  {
    attachmentId: MediaIdSchema,
    name: Type.String({ minLength: 1, maxLength: 200 }),
    mediaType: Type.String({ maxLength: 255 }),
    size: Type.Integer({ minimum: 0, maximum: 8_000_000 }),
    availability: Type.Union([
      Type.Literal("available"),
      Type.Literal("missing"),
    ]),
  },
  object,
);
// The old nested-quantifier pattern overflowed V8's regexp stack for valid
// maximum-size payloads. Scan once without decoding or recursive backtracking.
Format.Set("chat-file-base64", (value) => {
  if (value.length % 4 !== 0) return false;
  let padding = false;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code === 61) {
      if (index < value.length - 2) return false;
      padding = true;
    } else if (
      padding ||
      !(
        (code >= 65 && code <= 90) ||
        (code >= 97 && code <= 122) ||
        (code >= 48 && code <= 57) ||
        code === 43 ||
        code === 47
      )
    )
      return false;
  }
  return true;
});
export const FileUploadSchema = Type.Object(
  {
    sessionId: Type.String({ minLength: 1, maxLength: 300 }),
    operationId: OperationIdSchema,
    files: Type.Array(
      Type.Object(
        {
          id: MediaIdSchema,
          order: Type.Integer({ minimum: 0, maximum: 5 }),
          name: Type.String({ minLength: 1, maxLength: 200 }),
          mediaType: Type.String({ maxLength: 255 }),
          size: Type.Integer({ minimum: 0, maximum: 8_000_000 }),
          data: Type.String({
            maxLength: 4 * Math.ceil(8_000_000 / 3),
            format: "chat-file-base64",
          }),
        },
        object,
      ),
      { minItems: 1, maxItems: 6 },
    ),
  },
  object,
);
export const FileUploadResultSchema = Type.Object(
  {
    sessionId: Type.String({ minLength: 1, maxLength: 300 }),
    operationId: OperationIdSchema,
    files: Type.Array(
      Type.Object(
        {
          id: MediaIdSchema,
          order: Type.Integer({ minimum: 0, maximum: 5 }),
          ref: FileRefSchema,
        },
        object,
      ),
      { minItems: 1, maxItems: 6 },
    ),
  },
  object,
);
export type FileLimits = Static<typeof FileLimitsSchema>;
export type FileRef = Static<typeof FileRefSchema>;
export type FileUpload = Static<typeof FileUploadSchema>;
export type FileUploadResult = Static<typeof FileUploadResultSchema>;
export function fileDownloadUrl(id: string): string {
  return `${FILE_DOWNLOAD_PATH}${validate(MediaIdSchema, id)}`;
}
export function validateFileUpload(
  value: unknown,
  limits: FileLimits,
): FileUpload {
  const input = validate(FileUploadSchema, value);
  validate(FileLimitsSchema, limits);
  if (input.files.length > limits.maxFilesPerMessage)
    throw new Error("Too many files");
  const ids = new Set<string>();
  let total = 0;
  input.files.forEach((file, order) => {
    const size =
      (file.data.length / 4) * 3 -
      (file.data.endsWith("==") ? 2 : file.data.endsWith("=") ? 1 : 0);
    // Reject non-canonical padding bits so a logical payload has one representation.
    const last = file.data.slice(-4);
    if (last && btoa(atob(last)) !== last) throw new Error("Invalid base64");
    if (
      file.order !== order ||
      ids.has(file.id) ||
      size !== file.size ||
      size > limits.maxFileBytes
    )
      throw new Error("Invalid file limits/order");
    ids.add(file.id);
    total += size;
  });
  if (
    total > limits.maxMessageFileBytes ||
    new TextEncoder().encode(JSON.stringify(input)).length >
      MAX_FILE_UPLOAD_BODY_BYTES
  )
    throw new Error("Files too large");
  return input;
}
export function validateFileUploadResult(
  value: unknown,
  input: FileUpload,
): FileUploadResult {
  const result = validate(FileUploadResultSchema, value);
  if (
    result.sessionId !== input.sessionId ||
    result.operationId !== input.operationId ||
    result.files.length !== input.files.length ||
    new Set(result.files.map((f) => f.ref.attachmentId)).size !==
      result.files.length ||
    result.files.some((file, index) => {
      const source = input.files[index];
      return (
        !source ||
        file.id !== source.id ||
        file.order !== source.order ||
        file.ref.name !== source.name ||
        file.ref.mediaType !== source.mediaType ||
        file.ref.size !== source.size ||
        file.ref.availability !== "available"
      );
    })
  )
    throw new Error("Invalid file upload result");
  return result;
}
