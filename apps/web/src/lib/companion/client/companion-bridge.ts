import type { PanelBackend, SearchBackend } from "@lamplit/contracts";
import type { CompanionTranslate } from "./locale.js";
import type { CompanionProjection } from "../projection.js";
import type {
  CompactionLifecycleState,
  ContextPressureProjection,
} from "../continuity.js";
import type { ImageAttachmentLimits } from "./contracts.js";
import type { CompanionImageDraft } from "./image-drafts.js";
import type { CompanionReadiness } from "./readiness.js";
import type { CompanionStateRecord } from "../domain.js";
import type { StickerClient } from "../../sticker-client.js";
import type { StickerIdentity, FileLimits } from "@lamplit/contracts";
import type { ChatFileDraft } from "../../file-upload.js";

export interface CompanionIdentityView {
  companionName: string;
  companionAvatar?: string;
  userName: string;
  userAvatar?: string;
  preferredAddress: string;
  signature: string;
  moodLabel: string;
  mood: string;
  moodNote?: string;
  affinity?: number;
  affinityStage?: string;
}
export interface CompanionActions {
  openStickers?: () => StickerClient;
  sendSticker?: (sticker: StickerIdentity) => Promise<void>;
  search?: SearchBackend["search"];
  searchRead?: SearchBackend["searchRead"];
  send: (
    text: string,
    images: readonly CompanionImageDraft[],
    onRetire?: () => void,
    files?: readonly ChatFileDraft[],
  ) => Promise<void>;
  retryFailed?: (key: string) => Promise<void>;
  deleteFailed?: (key: string) => Promise<void>;
  discardPending?: (key: string) => void;
  readPanel?: <K extends keyof PanelBackend>(
    method: K,
    input: Omit<Parameters<PanelBackend[K]>[0], "sessionId">,
  ) => Promise<Awaited<ReturnType<PanelBackend[K]>>>;
  refreshRelationship?: (history?: boolean) => Promise<void>;
  stop?: () => Promise<void>;
  loadOlder?: () => Promise<void>;
  fillHistoryGap?: (id: number) => Promise<void>;
  attachmentUrl?: (attachment: unknown) => Promise<string>;
  loadEarlierHistory?: () => Promise<void>;
  retryHistory?: () => void;
  retryChatHistory?: () => void;
}
export interface CompanionSessionView {
  id: string;
  title: string;
  updatedAt: number;
  running: boolean;
  selected: boolean;
}

export interface CompanionContinuityView {
  /** Host-projected context pressure; absent means the meter is unavailable. */
  contextPressure?: ContextPressureProjection;
  /** Session-scoped compaction lifecycle facts from the public view registry. */
  lifecycle?: CompactionLifecycleState | null;
}

export interface CompanionHistoryView {
  status: "loading" | "ready" | "error";
  sourceWorkspaceId?: string;
  records: readonly CompanionStateRecord[];
  hasEarlier: boolean;
  nextCursor?: string;
  predecessor?: CompanionStateRecord;
  loadingEarlier?: boolean;
}

export interface CompanionBridgeProps {
  t?: CompanionTranslate;
  locale?: string;
  projection: CompanionProjection;
  identity: CompanionIdentityView;
  scheme: "light" | "dark";
  actions: CompanionActions;
  sessions: CompanionSessionView[];
  /** Explicit presentation lifecycle; unknown data remains neutral until settled. */
  workspaceReadiness: CompanionReadiness;
  sessionReadiness: CompanionReadiness;
  /** Browser-only draft images must not cross an active Session switch. */
  sessionId?: string;
  /** Host-advertised image capability and intake limits; absent means unavailable. */
  imageLimits?: ImageAttachmentLimits;
  fileLimits?: FileLimits;
  continuity?: CompanionContinuityView;
  history?: CompanionHistoryView;
  onHistoryOpenChange?: (open: boolean) => void;
  onAdvanced?: () => void;
  onRecovery?: () => void;
}
