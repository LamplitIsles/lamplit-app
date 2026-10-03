import type { PanelBackend, SearchBackend } from "@lamplit/contracts";
import type { CompanionTranslate } from "./locale.js";
import type { CompanionProjection } from "../projection.js";
import type {
  CompactionLifecycleState,
  ContextPressureProjection,
} from "../continuity.js";
import type { ImageAttachmentLimits } from "./contracts.js";
import type { CompanionImageDraft } from "./image-drafts.js";
import type { PendingSubmissionRetirement } from "./contracts.js";
import type { CompanionReadiness } from "./readiness.js";
import type { CompanionStateRecord } from "../domain.js";

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
  search?: SearchBackend["search"];
  searchRead?: SearchBackend["searchRead"];
  send: (
    text: string,
    images: readonly CompanionImageDraft[],
    onRetire?: (retirement: PendingSubmissionRetirement) => void,
    replacementSourceIds?: readonly string[],
  ) => Promise<void>;
  dismissRecovery?: (key: string) => void;
  readPanel?: <K extends keyof PanelBackend>(
    method: K,
    input: Omit<Parameters<PanelBackend[K]>[0], "sessionId">,
  ) => Promise<Awaited<ReturnType<PanelBackend[K]>>>;
  refreshRelationship?: (history?: boolean) => Promise<void>;
  stop?: () => Promise<void>;
  loadOlder?: () => Promise<void>;
  attachmentUrl?: (attachment: unknown) => Promise<string>;
  loadEarlierHistory?: () => Promise<void>;
  retryHistory?: () => void;
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

export interface CompanionRecoveredDraft {
  key: string;
  /** Local pending record retired when this restored draft is intentionally submitted. */
  localPendingKey?: string;
  sourceIds: readonly string[];
  input: string;
  state: "rejected" | "unconsumed" | "uncertain";
  replacementEligible: boolean;
  images: readonly { id: string; name: string; url: string }[];
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
  /** Recording availability from the same-origin voice capability endpoint. */
  voiceCapability?: "loading" | "available" | "unavailable";
  continuity?: CompanionContinuityView;
  recoveredDraft?: CompanionRecoveredDraft;
  history?: CompanionHistoryView;
  onHistoryOpenChange?: (open: boolean) => void;
  onAdvanced?: () => void;
  onRecovery?: () => void;
}
