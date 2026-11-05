import type { KeetSource, MatrixSource, PostSource } from "@lamplit/contracts";
import type { ImageAttachmentRef } from "./client/contracts.js";
import type { ContinuityRecord } from "./continuity.js";
import type { FileRef } from "@lamplit/contracts";
export type MessageSide = "incoming" | "outgoing";
export interface TimelineText {
  id: string;
  projectionKey?: string;
  /** Stable source contribution key used to form one 消息单元. */
  messageKey: string;
  kind: "text";
  side: MessageSide;
  /** Durable source kind used by the Chat target. */
  origin?: "user" | "steering";
  text: string;
  /** UTF-16 ends of the reply segments published by the Chat host. */
  ends?: readonly number[];
  pending?: boolean;
  /** Whether this submission was admitted while an earlier reply was active. */
  waitsForCurrentReply?: boolean;
  time?: number;
  replyTo?: string;
}

/** Present the host's segments without deriving new boundaries in the client. */
export function replySegments(item: TimelineText, sessionId: string): TimelineText[] {
  let start = 0;
  return (item.ends ?? []).map((end, ordinal) => {
    const text = item.text.slice(start, end);
    start = end;
    return { ...item, id: JSON.stringify([sessionId, item.id, ordinal]), text };
  });
}

export interface TimelineImage {
  id: string;
  /** Stable source key used when a durable ImageGen call settles into its attachment. */
  projectionKey?: string;
  /** Stable source contribution key used to form one 消息单元. */
  messageKey: string;
  kind: "image";
  side: MessageSide;
  /** Durable source kind used by the Chat target. */
  origin?: "user" | "steering";
  state: "loading" | "ready" | "failed" | "running";
  attachment?: ImageAttachmentRef;
  /** Page-local preview owned by the Session submission controller. */
  previewUrl?: string;
  alt: string;
  error?: string;
  time?: number;
}

export interface TimelineVoice {
  id: string;
  projectionKey?: string;
  /** Stable source contribution key used to form one 消息单元. */
  messageKey: string;
  kind: "voice";
  side: "incoming";
  url: string;
  time?: number;
}

export interface TimelineFile {
  id: string;
  messageKey: string;
  kind: "file";
  side: MessageSide;
  name: string;
  size: number;
  attachment?: FileRef;
}

export interface TimelineNotice {
  id: string;
  projectionKey?: string;
  /** Stable source contribution key; notices normally remain standalone. */
  messageKey: string;
  kind: "notice";
  side: "incoming";
  tone: "info" | "error";
  text: string;
  time?: number;
}

/** A quiet, durable completion marker for automatic conversation organization. */
export interface TimelineContinuityRecord extends ContinuityRecord {}

export type TimelineItem =
  | TimelineText
  | TimelineImage
  | TimelineFile
  | TimelineVoice
  | TimelineNotice
  | TimelineContinuityRecord;

/** One speaker contribution as presented in the Companion transcript. */
export interface TimelineMessageUnit {
  /** Stable render identity. */
  id: string;
  /** Original source identity, including when a local preview owns the row ID. */
  sourceId?: string;
  side: MessageSide;
  /** Source-order content; consecutive images are collapsed by the view. */
  items: readonly TimelineItem[];
  pending?: boolean;
  pendingLabel?: string;
  failed?: boolean;
  /** Submission identity used by retry/delete when render identity differs. */
  actionId?: string;
  origin?: "user" | "steering";
  time?: number;
  thinking?: string;
  /** Only ordinary companion answers participate in sentence display. */
  answer?: boolean;
  /** In-progress answer source; only complete source lines are displayed. */
  streaming?: boolean;
  keet?: KeetSource;
  matrix?: MatrixSource;
  post?: PostSource;
  alarm?: boolean;
}

export interface CompanionProjection {
  items: readonly TimelineItem[];
  /** Canonical grouped presentation projection for the Companion transcript. */
  messageUnits: readonly TimelineMessageUnit[];
  historyGaps?: readonly { id: number; afterId: string; beforeId: string; status: "pending" | "loading" | "error" | "unavailable" }[];
  pendingCount: number;
  running: boolean;
  /** Final reply body is known complete while execution may still be running. */
  replyCompleted?: boolean;
  canSubmit?: boolean;
  status: "ready" | "working" | "offline";
  openState: "cold" | "loading" | "open" | "error";
  hasMore: boolean;
  loadingOlder: boolean;
  historySyncFailed?: boolean;
  promptError?: string;
  /** Stable identity for a prompt result, used to distinguish a new rejection. */
  promptErrorKey?: string;
  /** Original prompt operation, when the runtime provides it. */
  promptErrorOp?: string;
  /** Public prompt error code, retained so admission failures can be distinguished from carrier internals. */
  promptErrorCode?: string;
  lastAgentError?: string;
}
