import { ReminderSourceSchema, type PanelBackend } from "./panels.ts";
export * from "./panels.ts";
import { Type, type Static } from "typebox";
import { validate } from "./validation.ts";
export { validate } from "./validation.ts";
import {
  defineService,
  type ReplicatedState,
  type Context,
} from "@earendil-works/chord";

export const PROTOCOL_VERSION = 1;
export const CHAT_PATH = "/api/chat/socket";
export const PAGE_SIZE = 30;
const Id = Type.String({ minLength: 1, maxLength: 300 });
const NullableId = Type.Union([Id, Type.Null()]);
export const SubmissionSchema = Type.Object(
  {
    operationId: Type.String({
      pattern:
        "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
    }),
    text: Type.String({ minLength: 1, maxLength: 16000 }),
  },
  { additionalProperties: false },
);
export const ReceiptSchema = Type.Object(
  {
    operationId: Id,
    state: Type.Union([
      Type.Literal("accepted"),
      Type.Literal("unconsumed"),
      Type.Literal("consumed"),
      Type.Literal("uncertain"),
      Type.Literal("missing"),
      Type.Literal("rejected"),
    ]),
    messageId: NullableId,
    turnId: NullableId,
    error: Type.Union([Type.String(), Type.Null()]),
  },
  { additionalProperties: false },
);
export const MessageSchema = Type.Object(
  {
    source: Type.Optional(ReminderSourceSchema),
    delivery: Type.Optional(
      Type.Union([
        Type.Literal("pending"),
        Type.Literal("unconsumed"),
        Type.Literal("consumed"),
        Type.Literal("uncertain"),
        Type.Literal("rejected"),
      ]),
    ),
    id: Id,
    role: Type.Union([
      Type.Literal("user"),
      Type.Literal("agent"),
      Type.Literal("notice"),
    ]),
    text: Type.String(),
    createdAt: Type.Number(),
    operationId: NullableId,
    turnId: NullableId,
  },
  { additionalProperties: false },
);
export const PageSchema = Type.Object(
  {
    messages: Type.Array(MessageSchema, { maxItems: PAGE_SIZE }),
    before: NullableId,
  },
  { additionalProperties: false },
);
export const ViewSchema = Type.Object(
  {
    version: Type.Literal(PROTOCOL_VERSION),
    sessionId: Id,
    name: Type.String(),
    activeTurnId: NullableId,
    messages: Type.Array(MessageSchema, { maxItems: PAGE_SIZE }),
    before: NullableId,
    capabilities: Type.Object(
      {
        text: Type.Literal(true),
        steer: Type.Literal(true),
        stop: Type.Literal(true),
        images: Type.Literal(false),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
export type Submission = Static<typeof SubmissionSchema>;
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
export interface ChatService extends PanelService {
  view: ReplicatedState<ChatView>;
  history(before: string, context: Context): Promise<HistoryPage>;
  submit(input: Submission, context: Context): Promise<Receipt>;
  lookup(operationId: string, context: Context): Promise<Receipt>;
  stop(turnId: string, context: Context): Promise<{ stopped: boolean }>;
}
export const Chat = defineService<ChatService>("lamplit.chat.v1");
export function validateId(value: unknown): string {
  return validate(Id, value);
}
export const capabilities: ChatView["capabilities"] = {
  text: true,
  steer: true,
  stop: true,
  images: false,
};
