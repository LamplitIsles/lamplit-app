export * from "./appearance.ts";
export * from "./search.ts";
import type { SearchBackend } from "./search.ts";
import { ReminderSourceSchema, type PanelBackend } from "./panels.ts";
export * from "./panels.ts";
export * from "./images.ts";
export * from "./files.ts";
import { FileRefSchema, FileLimitsSchema, type FileRef } from "./files.ts";
export * from "./stickers.ts";
export * from "./workspace-images.ts";
export * from "./compact.ts";
import {
  ContextUsageSchema,
  CompactionSchema,
  type CompactInput,
  type CompactResult,
} from "./compact.ts";
import {
  OperationIdSchema,
  ImageRefSchema,
  ImageLimitsSchema,
  RecoverySchema,
  MediaIdSchema,
  type ImageRef,
} from "./images.ts";
import { Type, type Static } from "typebox";
import { Format } from "typebox/format";
import { validate } from "./validation.ts";
export { validate } from "./validation.ts";
import {
  defineService,
  type ReplicatedState,
  type Context,
} from "@earendil-works/chord";

export const PROTOCOL_VERSION = 2;
export const CHAT_PATH = "/api/chat/socket";
export const PAGE_SIZE = 30;
const Id = Type.String({ minLength: 1, maxLength: 300 });
const NullableId = Type.Union([Id, Type.Null()]);
export const SubmissionSchema = Type.Object(
  {
    operationId: OperationIdSchema,
    text: Type.String({ maxLength: 16000 }),
    images: Type.Optional(Type.Array(ImageRefSchema, { maxItems: 6 })),
    files: Type.Optional(Type.Array(FileRefSchema, { maxItems: 6 })),
    replacementSourceIds: Type.Optional(
      Type.Array(Id, { maxItems: 20, uniqueItems: true }),
    ),
  },
  { additionalProperties: false },
);
export const RetryFailedSchema = Type.Object(
  {
    sessionId: Id,
    operationId: OperationIdSchema,
    attemptId: OperationIdSchema,
  },
  { additionalProperties: false },
);
export const FinalizeSubmissionSchema = Type.Union([
  Type.Object(
    { sessionId: Id, submission: SubmissionSchema },
    { additionalProperties: false },
  ),
  Type.Object(
    { sessionId: Id, retry: RetryFailedSchema },
    { additionalProperties: false },
  ),
]);
export const DeleteFailedSchema = Type.Object(
  { sessionId: Id, operationId: OperationIdSchema },
  { additionalProperties: false },
);
export const DeleteFailedResultSchema = Type.Object(
  { sessionId: Id, operationId: OperationIdSchema, deleted: Type.Boolean() },
  { additionalProperties: false },
);
export type FinalizeSubmission = Static<typeof FinalizeSubmissionSchema>;
export type RetryFailed = Static<typeof RetryFailedSchema>;
export type DeleteFailed = Static<typeof DeleteFailedSchema>;
export type DeleteFailedResult = Static<typeof DeleteFailedResultSchema>;
export const RetryImageMappingSchema = Type.Object(
  {
    sessionId: Id,
    sourceOperationId: OperationIdSchema,
    images: Type.Array(
      Type.Object(
        { sourceAttachmentId: MediaIdSchema, ref: ImageRefSchema },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: 6 },
    ),
  },
  { additionalProperties: false },
);
export type RetryImageMapping = Static<typeof RetryImageMappingSchema>;
export function validateRetryImageMapping(
  value: unknown,
  sessionId: string,
  sourceOperationId: string,
  originals: readonly ImageRef[],
): RetryImageMapping {
  const mapping = validate(RetryImageMappingSchema, value);
  const sourceIds = new Set(originals.map((image) => image.attachmentId));
  const mappedIds = new Set(
    mapping.images.map((image) => image.sourceAttachmentId),
  );
  if (
    mapping.sessionId !== sessionId ||
    mapping.sourceOperationId !== sourceOperationId ||
    sourceIds.size !== originals.length ||
    mapping.images.length !== originals.length ||
    mappedIds.size !== originals.length ||
    mapping.images.some(
      (image) =>
        !sourceIds.has(image.sourceAttachmentId) ||
        image.ref.availability !== "available",
    ) ||
    new Set(mapping.images.map((image) => image.ref.attachmentId)).size !==
      originals.length
  )
    throw new Error("Invalid retry image mapping");
  return mapping;
}
export const RetryFileMappingSchema = Type.Object(
  {
    sessionId: Id,
    sourceOperationId: OperationIdSchema,
    files: Type.Array(
      Type.Object(
        { sourceAttachmentId: MediaIdSchema, ref: FileRefSchema },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: 6 },
    ),
  },
  { additionalProperties: false },
);
export type RetryFileMapping = Static<typeof RetryFileMappingSchema>;
export function validateRetryFileMapping(
  value: unknown,
  sessionId: string,
  sourceOperationId: string,
  originals: readonly FileRef[],
): RetryFileMapping {
  const mapping = validate(RetryFileMappingSchema, value);
  const sources = new Map(originals.map((file) => [file.attachmentId, file]));
  if (
    mapping.sessionId !== sessionId ||
    mapping.sourceOperationId !== sourceOperationId ||
    sources.size !== originals.length ||
    mapping.files.length !== originals.length ||
    new Set(mapping.files.map((file) => file.sourceAttachmentId)).size !==
      originals.length ||
    new Set(mapping.files.map((file) => file.ref.attachmentId)).size !==
      originals.length ||
    mapping.files.some((file) => {
      const original = sources.get(file.sourceAttachmentId);
      return (
        !original ||
        file.ref.availability !== "available" ||
        file.ref.name !== original.name ||
        file.ref.mediaType !== original.mediaType ||
        file.ref.size !== original.size
      );
    })
  )
    throw new Error("Invalid retry file mapping");
  return mapping;
}
export const ReceiptSchema = Type.Object(
  {
    operationId: Id,
    state: Type.Union([Type.Literal("submitted"), Type.Literal("failed")]),
    messageId: NullableId,
    turnId: NullableId,
    error: Type.Union([Type.String(), Type.Null()]),
    retryImages: Type.Optional(RetryImageMappingSchema),
    retryFiles: Type.Optional(RetryFileMappingSchema),
  },
  { additionalProperties: false },
);
export function validateReceipt(value: unknown): Static<typeof ReceiptSchema> {
  const receipt = validate(ReceiptSchema, value);
  const mapping = receipt.retryImages;
  if (
    mapping &&
    (mapping.sourceOperationId === receipt.operationId ||
      new Set(mapping.images.map((image) => image.sourceAttachmentId)).size !==
        mapping.images.length ||
      new Set(mapping.images.map((image) => image.ref.attachmentId)).size !==
        mapping.images.length ||
      mapping.images.some((image) => image.ref.availability !== "available"))
  )
    throw new Error("Invalid retry receipt");
  const files = receipt.retryFiles;
  if (
    files &&
    (files.sourceOperationId === receipt.operationId ||
      new Set(files.files.map((file) => file.sourceAttachmentId)).size !==
        files.files.length ||
      new Set(files.files.map((file) => file.ref.attachmentId)).size !==
        files.files.length ||
      files.files.some((file) => file.ref.availability !== "available"))
  )
    throw new Error("Invalid retry file receipt");
  return receipt;
}
export function validateLookup(
  value: unknown,
): Static<typeof ReceiptSchema> | null {
  return value === null ? null : validateReceipt(value);
}
// Native Keet labels are single-line names bounded to 512 Unicode code points.
const KeetLabelSchema = Type.String({
  minLength: 1,
  maxLength: 512,
  pattern: "^(?!.*[\\r\\n\\u2028\\u2029])(?=.*\\S).+$",
});
export const KeetSourceSchema = Type.Object(
  {
    kind: Type.Literal("keet"),
    channel: Type.Union([Type.Literal("dm"), Type.Literal("group")]),
    senderLabel: KeetLabelSchema,
    destination: KeetLabelSchema,
  },
  { additionalProperties: false },
);
// JSON Schema length counts code points; the gateway capacity counts UTF-16 units.
Format.Set("matrix-label", (value) => value.length <= 255);
const MatrixLabelSchema = Type.String({
  maxLength: 255,
  format: "matrix-label",
});
export const MatrixSourceSchema = Type.Object(
  {
    kind: Type.Literal("matrix"),
    senderId: Type.String({ ...MatrixLabelSchema, minLength: 1 }),
    senderDisplayName: MatrixLabelSchema,
    roomId: Type.String({ ...MatrixLabelSchema, minLength: 1 }),
  },
  { additionalProperties: false },
);
export type MatrixSource = Static<typeof MatrixSourceSchema>;
// Post IDs match the canonical producer's 256 UTF-16-unit capacity.
Format.Set("post-native-id", (value) => value.length <= 256);
const PostNativeIdSchema = Type.String({
  minLength: 1,
  maxLength: 256,
  format: "post-native-id",
});
// JSON Schema length counts Unicode code points. Producers normalize names.
const PostDisplayNameSchema = Type.String({
  minLength: 1,
  maxLength: 256,
  pattern: "\\S",
});
export const PostSourceSchema = Type.Object(
  {
    kind: Type.Literal("post"),
    platform: Type.Union([Type.Literal("qq"), Type.Literal("matrix")]),
    conversationType: Type.Union([
      Type.Literal("group"),
      Type.Literal("direct"),
    ]),
    conversationId: PostNativeIdSchema,
    conversationName: Type.Optional(PostDisplayNameSchema),
    senderId: PostNativeIdSchema,
    senderDisplayName: Type.Optional(PostDisplayNameSchema),
  },
  { additionalProperties: false },
);
export type PostSource = Static<typeof PostSourceSchema>;
export const MessageSourceSchema = Type.Union([
  ReminderSourceSchema,
  KeetSourceSchema,
  MatrixSourceSchema,
  PostSourceSchema,
]);
export type KeetSource = Static<typeof KeetSourceSchema>;
export type MessageSource = Static<typeof MessageSourceSchema>;

export const VoiceRefSchema = Type.Object(
  {
    id: Type.String({
      minLength: 64,
      maxLength: 64,
      pattern: "^[0-9a-f]{64}$",
    }),
  },
  { additionalProperties: false },
);
export type VoiceRef = Static<typeof VoiceRefSchema>;

export const MessageSchema = Type.Object(
  {
    images: Type.Optional(Type.Array(ImageRefSchema)),
    files: Type.Optional(Type.Array(FileRefSchema, { maxItems: 6 })),
    imageState: Type.Optional(
      Type.Union([
        Type.Literal("preparing"),
        Type.Literal("ready"),
        Type.Literal("failed"),
        Type.Literal("unknown"),
      ]),
    ),
    textState: Type.Optional(
      Type.Union([Type.Literal("streaming"), Type.Literal("complete")]),
    ),
    voice: Type.Optional(VoiceRefSchema),
    source: Type.Optional(MessageSourceSchema),
    id: Id,
    role: Type.Union([
      Type.Literal("user"),
      Type.Literal("agent"),
      Type.Literal("notice"),
    ]),
    text: Type.String(),
    /** Required on delivered ordinary replies; raw backend input may omit these UTF-16 ends. */
    ends: Type.Optional(Type.Array(Type.Integer({ minimum: 1 }))),
    thinking: Type.Optional(Type.String()),
    createdAt: Type.Number(),
    operationId: NullableId,
    turnId: NullableId,
  },
  {
    additionalProperties: false,
    allOf: [
      {
        if: { required: ["imageState"] },
        then: {
          properties: { role: { const: "agent" } },
          allOf: [
            {
              if: { properties: { imageState: { const: "ready" } } },
              then: {
                required: ["images"],
                properties: {
                  images: {
                    minItems: 1,
                    maxItems: 1,
                    items: {
                      properties: { availability: { const: "available" } },
                    },
                  },
                },
              },
              else: { not: { required: ["images"] } },
            },
          ],
        },
      },
    ],
  },
);
export const PageSchema = Type.Object(
  {
    messages: Type.Array(MessageSchema, { maxItems: PAGE_SIZE }),
    before: NullableId,
  },
  { additionalProperties: false },
);
/** Transient answer-only preview; the host supplies its UTF-16 segment ends. */
export const StreamingReplySchema = Type.Object(
  { id: Id, turnId: NullableId, createdAt: Type.Number(), text: Type.String(), ends: Type.Optional(Type.Array(Type.Integer({ minimum: 1 }))) },
  { additionalProperties: false },
);
export type StreamingReply = Static<typeof StreamingReplySchema>;
export const ViewSchema = Type.Object(
  {
    version: Type.Literal(PROTOCOL_VERSION),
    sessionId: Id,
    name: Type.String(),
    activeTurnId: NullableId,
    streamingReply: Type.Optional(StreamingReplySchema),
    /** Explicit final-body evidence for the active turn, independent of execution. */
    replyCompletedTurnId: Type.Optional(Id),
    contextUsage: ContextUsageSchema,
    compaction: CompactionSchema,
    messages: Type.Array(MessageSchema, { maxItems: PAGE_SIZE }),
    before: NullableId,
    recovery: Type.Array(RecoverySchema, { maxItems: 20 }),
    capabilities: Type.Object(
      {
        text: Type.Literal(true),
        steer: Type.Literal(true),
        stop: Type.Literal(true),
        images: Type.Union([Type.Literal(false), ImageLimitsSchema]),
        files: Type.Optional(
          Type.Union([Type.Literal(false), FileLimitsSchema]),
        ),
        workspaceImages: Type.Optional(Type.Literal(true)),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
export type Submission = Static<typeof SubmissionSchema>;
export const LookupSchema = Type.Union([ReceiptSchema, Type.Null()]);
export type Receipt = Static<typeof ReceiptSchema>;
export type ChatMessage = Static<typeof MessageSchema>;
export type HistoryPage = Static<typeof PageSchema>;
export type ChatView = Static<typeof ViewSchema>;
type PanelService = {
  [K in keyof PanelBackend]: (
    input: Parameters<PanelBackend[K]>[0],
    context: Context,
  ) => ReturnType<PanelBackend[K]>;
};
type SearchService = {
  [K in keyof SearchBackend]: (
    input: Parameters<SearchBackend[K]>[0],
    context: Context,
  ) => ReturnType<SearchBackend[K]>;
};
export interface ChatService extends PanelService, SearchService {
  view: ReplicatedState<ChatView>;
  compact(input: CompactInput, context: Context): Promise<CompactResult>;
  history(before: string, context: Context): Promise<HistoryPage>;
  submit(input: Submission, context: Context): Promise<Receipt>;
  lookup(operationId: string, context: Context): Promise<Receipt | null>;
  finalizeSubmission(
    input: FinalizeSubmission,
    context: Context,
  ): Promise<Receipt | null>;
  retryFailed(input: RetryFailed, context: Context): Promise<Receipt>;
  deleteFailed(
    input: DeleteFailed,
    context: Context,
  ): Promise<DeleteFailedResult>;
  stop(turnId: string, context: Context): Promise<{ stopped: boolean }>;
}
export const Chat = defineService<ChatService>("lamplit.chat.v2");
export function validateId(value: unknown): string {
  return validate(Id, value);
}
export const capabilities: ChatView["capabilities"] = {
  text: true,
  steer: true,
  stop: true,
  images: false,
};

/** Optional image/replacement fields are omitted for ordinary text, not a second submission path. */
export function validateSubmission(value: unknown): Submission {
  const input = validate(SubmissionSchema, value);
  if (!input.text.trim() && !input.images?.length && !input.files?.length)
    throw new Error("Empty message");
  if (
    input.images &&
    (new Set(input.images.map((r) => r.attachmentId)).size !==
      input.images.length ||
      input.images.some((r) => r.availability !== "available"))
  )
    throw new Error("Invalid submitted images");
  if (
    input.files &&
    (new Set(input.files.map((file) => file.attachmentId)).size !==
      input.files.length ||
      input.files.some((file) => file.availability !== "available") ||
      input.files.reduce((sum, file) => sum + file.size, 0) > 24_000_000)
  )
    throw new Error("Invalid submitted files");
  if (
    input.text === "/compact" &&
    !input.images?.length &&
    !input.files?.length
  )
    throw new Error("Use native compact command");
  return input;
}
